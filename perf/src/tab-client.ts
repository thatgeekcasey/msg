import { setTimeout as sleep } from "node:timers/promises";
import type { WorkspaceServerFrame } from "@ember/protocol";
import { RoomClient, type Session } from "./room-client.ts";

// A browser tab for load tests, opened as the web app opens one: a room's socket, the tab's
// workspace socket, and the sidebar and people directory, which it loads again on each of the
// workspace's welcomes, naming the copies it has.

/** Node's WebSocket, which, unlike a browser's, can send a handshake's headers. */
const NodeWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;

const CONNECT_TIMEOUT_MS = 30_000;

export function workspaceSocketUrl(baseUrl: string): string {
  const url = new URL("/api/socket", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Opens `session`'s workspace socket, as a tab does, and resolves with it once its welcome comes, and how long that took in milliseconds. */
export function connectWorkspace(baseUrl: string, session: Session): Promise<{ ws: WebSocket; ms: number }> {
  const started = performance.now();
  const ws = new NodeWebSocket(workspaceSocketUrl(baseUrl), { headers: { Cookie: session.cookie, Origin: new URL(baseUrl).origin } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`No welcome from the Workspace after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS);
    const fail = (error: Error) => {
      clearTimeout(timer);
      ws.onerror = ws.onclose = ws.onmessage = null;
      ws.close();
      reject(error);
    };
    ws.onerror = () => fail(new Error("Workspace socket failed"));
    ws.onclose = (event) => fail(new Error(`Workspace socket closed (${event.code}) before its welcome`));
    ws.onmessage = (event) => {
      if ((JSON.parse(event.data as string) as WorkspaceServerFrame).type !== "welcome") return;
      clearTimeout(timer);
      ws.onerror = ws.onclose = ws.onmessage = null;
      resolve({ ws, ms: performance.now() - started });
    };
  });
}

/** How long each socket waits before connecting again, in milliseconds. */
export interface Delays {
  room: number;
  workspace: number;
}

/** What a tab loads over HTTP, each with the copy it has: the sidebar, and the people its avatars come from. */
type Listing = "sidebar" | "directory";

const LISTINGS: Record<Listing, string> = { sidebar: "/api/sidebar", directory: "/api/users" };

/** How long one load of each listing took, asking to answer, whether a new copy or 304. */
type Loads = Record<Listing, number>;

/** How long each part of opening a tab took, in milliseconds. */
export interface TabTimings {
  /** Opening the workspace socket to its welcome. */
  welcome: number;
  /** Opening the room's socket to its welcome. */
  roomWelcome: number;
  /** Each load of the sidebar, asking to answer, whether a new copy or 304. */
  sidebar: number[];
  /** Each load of the people directory, alongside the sidebar's. */
  directory: number[];
}

export class TabClient {
  readonly session: Session;
  private readonly baseUrl: string;
  private readonly roomId: string;
  private workspace: WebSocket | null = null;
  private room: RoomClient | null = null;
  /** The ETag of each listing this tab has. */
  private readonly etags: Record<Listing, string | null> = { sidebar: null, directory: null };

  constructor(baseUrl: string, session: Session, roomId: string) {
    this.baseUrl = baseUrl;
    this.session = session;
    this.roomId = roomId;
  }

  /** Opens the tab as loading the page does: the sidebar, the people directory and both sockets at once. */
  open(): Promise<TabTimings> {
    return this.connect(this.loadListings(), { room: 0, workspace: 0 });
  }

  /**
   * Connects both sockets again once each has waited as long as `delays` says, as the app does once
   * they close, the room's naming the latest change the last one heard of.
   */
  reopen(delays: Delays): Promise<TabTimings> {
    return this.connect(null, delays);
  }

  /** Starts closing both sockets without waiting for the handshakes. */
  close(): void {
    this.workspace?.close(1000);
    this.room?.close();
  }

  /**
   * Opens both sockets, and loads the sidebar and people directory again on the workspace's welcome
   * once `loading`, the loads already on their way, if any, have come, as the app has one of each on
   * its way at a time. If anything fails, it closes whatever opened.
   */
  private async connect(loading: Promise<Loads> | null, delays: Delays): Promise<TabTimings> {
    // Awaited only after the welcome, so a failure before then mustn't count as unhandled.
    loading?.catch(() => {});
    const [workspace, room] = await Promise.allSettled([
      sleep(delays.workspace)
        .then(() => this.connectWorkspace())
        .then(async (welcome) => {
          const loads = loading ? [await loading] : [];
          loads.push(await this.loadListings());
          return { welcome, loads };
        }),
      sleep(delays.room).then(() => RoomClient.connect(this.baseUrl, this.roomId, this.session, this.room?.seq)),
    ]);
    if (room.status === "fulfilled") this.room = room.value.client;
    if (workspace.status === "rejected" || room.status === "rejected") {
      this.close();
      throw workspace.status === "rejected" ? workspace.reason : (room as PromiseRejectedResult).reason;
    }
    const { welcome, loads } = workspace.value;
    return { welcome, roomWelcome: room.value.ms, sidebar: loads.map((l) => l.sidebar), directory: loads.map((l) => l.directory) };
  }

  /** Opens the workspace socket and resolves with the milliseconds to its welcome. */
  private async connectWorkspace(): Promise<number> {
    const { ws, ms } = await connectWorkspace(this.baseUrl, this.session);
    this.workspace = ws;
    return ms;
  }

  /** Loads the sidebar and the people directory at once, as the app does, and resolves with how long each took. */
  private async loadListings(): Promise<Loads> {
    const [sidebar, directory] = await Promise.all([this.load("sidebar"), this.load("directory")]);
    return { sidebar, directory };
  }

  /** Loads a listing, naming the copy this tab has, and resolves with the milliseconds it took. */
  private async load(listing: Listing): Promise<number> {
    const started = performance.now();
    const etag = this.etags[listing];
    const response = await fetch(new URL(LISTINGS[listing], this.baseUrl), { headers: { Cookie: this.session.cookie, ...(etag ? { "If-None-Match": etag } : {}) } });
    if (response.status !== 304) {
      if (!response.ok) throw new Error(`Loading the ${listing} failed (${response.status}): ${await response.text()}`);
      await response.arrayBuffer();
      this.etags[listing] = response.headers.get("ETag");
    }
    return performance.now() - started;
  }
}
