import type { ClientFrame } from "@ember/protocol";

/**
 * How long the page goes without a connection before it counts as offline, which stops sending, as
 * Campfire's refresh_room_controller.js waits (`OFFLINE_AFTER_DISCONNECTED_TIMEOUT`).
 */
export const OFFLINE_AFTER_MS = 5_000;
/** How often an open socket checks it's still connected. The runtime answers without waking the room. */
const HEARTBEAT_MS = 25_000;
const MAX_BACKOFF_MS = 15_000;
/** How long a socket has to open before it's tried again: a network that hangs can leave it connecting for minutes. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long after the tab is shown, or the network comes back, the socket is checked, as ActionCable waits. */
const PROBE_DELAY_MS = 200;
/** How long a socket that's checked has to hear something from the server before it counts as dead. */
const PROBE_TIMEOUT_MS = 3_000;
/**
 * A socket open longer than this that the network or the server closes most likely went in a deploy,
 * which closes every socket at once, so the first try to connect again is spread wider.
 */
const LONG_LIVED_MS = 60_000;
/** How far the first try after a deploy is spread, unless the owner says otherwise. */
const DEPLOY_SPREAD_MS = [250, 2_000] as const;
/** How long a socket opened ahead waits for the reconnecting socket that asks for its address. */
const AHEAD_MS = 10_000;

/** Whether the socket is connecting for the first time, or again after one that closed. */
export type SocketStatus = "connecting" | "reconnecting";

export interface ReconnectingSocketOptions {
  /** Where to connect, asked again for each attempt. */
  url: () => string;
  /** Each frame from the server, as its text. */
  onMessage: (data: string) => void;
  /** As each attempt to connect begins, or once one is waited on. */
  onConnecting?: (status: SocketStatus) => void;
  /** Once the page has been without a connection the server let in for `OFFLINE_AFTER_MS`, and once it has one again. */
  onOffline?: (offline: boolean) => void;
  /**
   * A close this side didn't ask for, with its code and whether the socket had opened: true connects
   * again after the usual wait, and false leaves the owner to `retry()` or `close()`.
   */
  onClose: (code: number, opened: boolean) => boolean;
  /** The least and most the first try after a deploy waits, a quarter of a second to two unless given. */
  deploySpreadMs?: readonly [number, number];
}

/** A socket that sends `Frame`s: a room's or the workspace's, unless it's said to be another's, as a huddle's is. */
export interface ReconnectingSocket<Frame = ClientFrame> {
  /**
   * Sends `frame` once the server has let the socket in, saying whether it did. Until then a frame could
   * overtake those the owner is keeping to send once it's in, or go to a server about to refuse it.
   */
  send(frame: Frame): boolean;
  /**
   * Says the server has let the connection in, as a room's welcome does: the page is online again, the
   * socket sends, and the next close starts the back-off over. A server that closes a socket as soon as
   * it opens doesn't say so, and keeps being backed off from.
   */
  connected(): void;
  /** Connects again after the usual wait, after a close the owner held on to. */
  retry(): void;
  /**
   * Closes a connection the owner can't use, such as one the server let in as someone else, and holds
   * on to it as it would a close: connecting again waits for `retry()`.
   */
  hold(): void;
  /** Closes the socket for good. */
  close(): void;
}

/** The socket opened ahead, and what it has heard, in order, until a reconnecting socket takes it. */
let ahead: { url: string; socket: WebSocket; heard: Event[]; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * Opens a socket to `url` ahead of the reconnecting socket that will ask for that address, as the app
 * opens a room's while the page that shows the room loads: the first to ask for it within 10 seconds
 * takes it, and hears what it has heard by then. One waits at a time, so opening another closes it, as
 * does the function returned, unless it's been taken.
 */
export function openAhead(url: string): () => void {
  letGoAhead();
  const socket = new WebSocket(url);
  const heard: Event[] = [];
  const hear = (event: Event) => void heard.push(event);
  socket.onopen = hear;
  socket.onmessage = hear;
  socket.onclose = hear;
  const waiting = { url, socket, heard, timer: setTimeout(letGoAhead, AHEAD_MS) };
  ahead = waiting;
  return () => {
    if (ahead === waiting) letGoAhead();
  };
}

/** Closes the socket opened ahead, if one is waiting. */
function letGoAhead() {
  if (!ahead) return;
  clearTimeout(ahead.timer);
  ahead.socket.onclose = null;
  ahead.socket.close(1000);
  ahead = null;
}

/** Whether a socket opened ahead to `url` is waiting to be taken. */
export const waitingAhead = (url: string) => ahead?.url === url;

/** The socket opened ahead to `url`, and what it has heard, if one is waiting. */
function takeAhead(url: string) {
  if (ahead?.url !== url) return null;
  const taken = ahead;
  clearTimeout(taken.timer);
  ahead = null;
  return taken;
}

/**
 * Hands `socket`'s handlers what it heard before they were set, in order, as they would have heard it:
 * nothing more once it's closed from this side, as `hold` closes it, clearing its onclose first.
 */
function replay(socket: WebSocket, heard: Event[]) {
  for (const event of heard) {
    if (socket.onclose === null) return;
    if (event.type === "open") socket.onopen?.(event);
    else if (event.type === "message") socket.onmessage?.(event as MessageEvent);
    else socket.onclose(event as CloseEvent);
  }
}

/**
 * A WebSocket that connects again whenever it closes, waiting half a second, doubling to fifteen, give
 * or take a quarter. ActionCable waits longer, 6 seconds growing 15% a try. An open socket pings every
 * 25 seconds and reconnects when a ping goes unanswered, and it's checked again when the tab is shown or
 * the network comes back, as ActionCable's ConnectionMonitor checks for a stale one.
 */
export function reconnectingSocket<Frame = ClientFrame>(options: ReconnectingSocketOptions): ReconnectingSocket<Frame> {
  let stopped = false;
  let ws: WebSocket | null = null;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let probeDelay: ReturnType<typeof setTimeout> | undefined;
  let offlineTimer: ReturnType<typeof setTimeout> | undefined;
  let offline = false;
  // Whether the server has let in the socket now open.
  let admitted = false;
  // Whether anything has come from the server since the last ping.
  let heard = true;

  const backoff = () => Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt++) * (0.75 + Math.random() / 2);
  // The first try after a deploy is spread, so that the sockets it closed don't all come back at once.
  const [deployFrom, deployTo] = options.deploySpreadMs ?? DEPLOY_SPREAD_MS;
  const afterDeploy = () => {
    if (attempt > 0) return backoff();
    attempt++;
    return deployFrom + Math.random() * (deployTo - deployFrom);
  };

  const startOfflineClock = () => {
    if (offline || offlineTimer !== undefined) return;
    offlineTimer = setTimeout(() => {
      offlineTimer = undefined;
      offline = true;
      options.onOffline?.(true);
    }, OFFLINE_AFTER_MS);
  };

  const stopChecking = () => {
    clearTimeout(connectTimer);
    clearInterval(heartbeat);
    clearTimeout(probeTimer);
    probeTimer = undefined;
  };

  const reconnect = (delay: number) => {
    stopChecking();
    startOfflineClock();
    options.onConnecting?.("reconnecting");
    retryTimer = setTimeout(open, delay);
  };

  // The network dropped without closing the socket, which never opened or stopped answering.
  const dropped = (socket: WebSocket, delay: number) => {
    socket.onclose = null;
    socket.close();
    reconnect(delay);
  };

  const open = () => {
    retryTimer = undefined;
    admitted = false;
    options.onConnecting?.(ws === null ? "connecting" : "reconnecting");
    const url = options.url();
    const taken = takeAhead(url);
    const socket = taken?.socket ?? new WebSocket(url);
    ws = socket;
    let openedAt: number | undefined;
    connectTimer = setTimeout(() => dropped(socket, backoff()), CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      clearTimeout(connectTimer);
      openedAt = Date.now();
      heard = true;
      heartbeat = setInterval(() => {
        if (!heard) return dropped(socket, backoff());
        heard = false;
        socket.send('{"type":"ping"}');
      }, HEARTBEAT_MS);
    };
    socket.onmessage = (event) => {
      heard = true;
      clearTimeout(probeTimer);
      probeTimer = undefined;
      options.onMessage(String(event.data));
    };
    socket.onclose = (event) => {
      stopChecking();
      startOfflineClock();
      // A deploy's close carries none of the app's codes, which start at 4000.
      const deployed = openedAt !== undefined && Date.now() - openedAt > LONG_LIVED_MS && event.code < 4000;
      if (!options.onClose(event.code, openedAt !== undefined)) return;
      reconnect(deployed ? afterDeploy() : backoff());
    };
    // One opened ahead may have opened, heard from the server, or closed already, which the owner hears
    // once it has the socket.
    if (taken) queueMicrotask(() => replay(socket, taken.heard));
  };

  // Checks the socket once the tab has been shown a moment: an open one is pinged and reopened unless the
  // server answers within 3 seconds, and one waiting to connect again does so now, starting the back-off over.
  const probe = () => {
    if (stopped || document.visibilityState !== "visible") return;
    if (ws?.readyState === WebSocket.OPEN) {
      if (probeTimer !== undefined) return;
      const socket = ws;
      socket.send('{"type":"ping"}');
      probeTimer = setTimeout(() => {
        probeTimer = undefined;
        attempt = 0;
        dropped(socket, 0);
      }, PROBE_TIMEOUT_MS);
    } else if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      attempt = 0;
      open();
    }
  };
  const probeSoon = () => {
    clearTimeout(probeDelay);
    probeDelay = setTimeout(probe, PROBE_DELAY_MS);
  };
  const shown = () => document.visibilityState === "visible" && probeSoon();
  const restored = (event: PageTransitionEvent) => event.persisted && probeSoon();
  document.addEventListener("visibilitychange", shown);
  window.addEventListener("online", probeSoon);
  window.addEventListener("pageshow", restored);

  startOfflineClock();
  open();

  return {
    send(frame) {
      if (!admitted || ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    },
    connected() {
      admitted = true;
      attempt = 0;
      clearTimeout(offlineTimer);
      offlineTimer = undefined;
      if (!offline) return;
      offline = false;
      options.onOffline?.(false);
    },
    retry() {
      if (!stopped) reconnect(backoff());
    },
    hold() {
      if (stopped || !ws) return;
      stopChecking();
      startOfflineClock();
      admitted = false;
      ws.onclose = null;
      ws.close(1000);
    },
    close() {
      if (stopped) return;
      stopped = true;
      stopChecking();
      clearTimeout(retryTimer);
      clearTimeout(offlineTimer);
      clearTimeout(probeDelay);
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("online", probeSoon);
      window.removeEventListener("pageshow", restored);
      if (!ws) return;
      ws.onclose = null;
      ws.close(1000);
    },
  };
}
