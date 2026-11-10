import { CloseCode, type RoomId, type User, type UserId } from "@ember/protocol";
import {
  HUDDLE_FAILED,
  HuddleCloseCode,
  MAX_HUDDLE_PEOPLE,
  parseHuddleClientFrame,
  type HuddleClientFrame,
  type HuddlePerson,
  type HuddleServerFrame,
  type HuddleTrack,
  type HuddleTrackKind,
} from "@ember/protocol/huddles";
import type { Env } from "../env";
import { CLOSE_REASONS, closedAtOnce, closeTooLarge, isTooLarge, MAX_ROOM_FRAME_SIZE } from "../sockets";
import { workspace } from "../workspace";
import { acceptAnswer, closeTracks, publishTracks, pullTracks, SfuError, startSession, TRACKS_PER_REQUEST, type SfuApp } from "./sfu";

// A room's huddle, which the room's Durable Object keeps beside its own sockets (src/chat-room.ts): who's
// in it, and what each of them publishes and hears at Cloudflare's Realtime SFU, which carries what they
// say (./sfu.ts). Each tab in a huddle has a socket of its own here, tagged `HUDDLE_TAG`, which the
// room's revocations close as they close the room's own, and which doesn't count as viewing the room.
//
// A tab keeps two connections to the SFU, each a session there: one it sends its microphone on, and one
// it receives everyone else on. Only the room asks the SFU for anything, as the tab's frames have it do,
// and no session's ID reaches a tab or is taken from one, since the ID is all it takes to hear what a
// session publishes. A tab asks to hear whoever it doesn't hear yet (`huddle.listen`), rather than the
// room adding each newcomer to everyone's connection: an event then asks the SFU a few things however
// many are in the huddle, where Workers' free plan lets an event make 50 requests.
//
// What a socket publishes and hears is in its attachment, which outlives hibernation, so a huddle costs
// the room nothing between its frames but a check every `HUDDLE_CHECK_MS`. When someone leaves, or loses
// the room, the room has the SFU close their tracks: a tab that kept its connections open sends the
// others nothing more, and hears nothing more of them.
//
// The room tells the Workspace who's in the huddle as they join and leave, and the Workspace tells
// everyone in the room, in the huddle or not, so their sidebars and the room's header can show it.

/**
 * The tag on a huddle's sockets, besides the tags a room's own sockets carry. Nobody's id has a colon in
 * it, and a session's tag and an address's end in more than one.
 */
export const HUDDLE_TAG = "huddle:";

/** How often a room checks its huddle while one goes on. */
export const HUDDLE_CHECK_MS = 30_000;

/**
 * How long a huddle's socket can go unheard before the room takes its person out. A tab pings every 25
 * seconds, and a browser can hold a hidden tab's timers back to one a minute, so only a connection that
 * dropped without closing goes this long.
 */
export const HUDDLE_SILENT_MS = 90_000;

/** How long the room goes by what the Workspace last said of the SFU app huddles run through. */
const APP_KEPT_MS = 30_000;

/** How many of a socket's frames for one of its connections can wait behind the one the SFU is answering. */
const FRAMES_WAITING = 4;

/** The most people one check takes out for being unheard, each of whom the SFU is asked about twice. */
const REMOVED_PER_CHECK = 10;

/** The most sessions one check asks the SFU again to close tracks on. */
const RETRIED_PER_CHECK = 10;

/** How long the room goes on asking the SFU to close tracks it didn't, and how many sessions' worth it keeps. */
const UNCLOSED_KEPT_MS = 60 * 60 * 1000;
const UNCLOSED_KEPT = 200;

/** What the room's object keeps in its own storage while the SFU has tracks to close that it didn't: the sessions and their tracks. */
const UNCLOSED = "huddleUnclosed";

/**
 * What the room's object keeps in its own storage from before the Workspace hears of a huddle until it
 * has heard that the huddle is over: the room's id, which is otherwise only in its sockets' attachments,
 * so that the alarm can say so with nobody left in it.
 */
const REPORTED = "huddleRoom";

/**
 * How long after a tab's sending connection connects the SFU may take to find what it publishes. One it
 * can't find after that is gone, and the tab is told to publish again.
 */
export const PUBLICATION_SETTLES_MS = 10_000;

/** What the SFU answers of a track nobody publishes, or no longer does. */
const NOT_PUBLISHED = "not_found_track_error";

/** What a tab hears when it answers an offer it wasn't made. */
export const NO_OFFER = "There's no offer to answer.";
/** What a tab hears when it sends frames faster than the SFU answers them. */
export const TOO_FAST = "The huddle is still on what you asked before.";
const UNRECOGNIZED = "Unrecognized frame";

/** A connection of a tab's at the SFU, and the media sections of it that carry tracks. */
interface Session {
  sessionId: string;
  mids: string[];
}

/** Tracks the SFU was asked to close and didn't, for the room's alarm to ask about again. */
interface Unclosed extends Session {
  appId: string;
  /** When the room first asked. */
  since: number;
}

/** What a tab publishes, on its sending connection. */
interface Publishing {
  sessionId: string;
  tracks: HuddleTrack[];
  /** When the tab said the connection had connected, from when the others can listen to it. */
  connectedAt?: number;
}

/** A track a tab hears, or has been offered. */
interface Heard {
  /** The media section of the tab's receiving connection that carries it. */
  mid: string;
  /** The session that publishes it. */
  from: string;
  kind: HuddleTrackKind;
}

/** What a tab hears, on its receiving connection. */
interface Receiving {
  sessionId: string;
  heard: Heard[];
  /** What the SFU's latest offer adds, until the tab has answered it. */
  offered?: Heard[];
}

/** What each of a huddle's sockets remembers across hibernation. */
export interface HuddleAttachment {
  /** Tells a huddle's socket from one of the room's own. */
  huddle: true;
  user: User;
  roomId: RoomId;
  /** When the person joined the huddle, which a tab they move to keeps. */
  joinedAt: number;
  /** When this socket opened. */
  openedAt: number;
  /** When the huddle started. */
  startedAt: string;
  muted: boolean;
  /** The SFU app the tab's connections are with: a huddle runs through one. */
  appId: string;
  publishing?: Publishing;
  receiving?: Receiving;
  /** Set once the room has closed the socket itself, having told the others whatever they're to hear of it. */
  revoked?: true;
}

/** A socket in the huddle, with what it remembers. */
interface Member {
  socket: WebSocket;
  attachment: HuddleAttachment;
}

/** What a socket's frames for one of its connections wait behind, and how many of them are waiting, the one the SFU is answering included. */
interface Line {
  last: Promise<void>;
  waiting: number;
}

const attachmentOf = (ws: WebSocket) => ws.deserializeAttachment() as HuddleAttachment;

/** Changes what `ws` remembers, from what it remembers now, so nothing read before an await is written back. */
function change(ws: WebSocket, changed: (attachment: HuddleAttachment) => HuddleAttachment): HuddleAttachment {
  const attachment = changed(attachmentOf(ws));
  ws.serializeAttachment(attachment);
  return attachment;
}

const personOf = ({ user, muted, publishing }: HuddleAttachment): HuddlePerson => ({ user, muted, audio: publishing?.connectedAt !== undefined });

const midsOf = (tracks: Array<{ mid: string }>) => tracks.map(({ mid }) => mid);

/** Every track of a tab's the SFU carries: what it publishes, and what it hears or has been offered. */
function sessionsOf({ publishing, receiving }: Pick<HuddleAttachment, "publishing" | "receiving">): Session[] {
  const sessions: Session[] = [];
  if (publishing) sessions.push({ sessionId: publishing.sessionId, mids: midsOf(publishing.tracks) });
  if (receiving) sessions.push({ sessionId: receiving.sessionId, mids: midsOf([...receiving.heard, ...(receiving.offered ?? [])]) });
  return sessions.filter(({ mids }) => mids.length > 0);
}

function send(ws: WebSocket, frame: HuddleServerFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // The socket closed between lookup and send; its close handler cleans up.
  }
}

/** What's logged of a failure: the SFU's status and error code, or the kind of error, and never what was sent. */
const logged = (error: unknown) => (error instanceof SfuError ? error.message : error instanceof Error ? error.name : "unknown error");

export class Huddle {
  /** The SFU app huddles run through, as the Workspace last said, and when it did. */
  private known: { app: SfuApp | null; at: number } | null = null;
  /** What each socket's frames for its sending connection wait behind, and those for its receiving connection. */
  private readonly sending = new WeakMap<WebSocket, Line>();
  private readonly receiving = new WeakMap<WebSocket, Line>();
  /** The tracks the SFU didn't close, once read from the object's storage. */
  private kept: Promise<Unclosed[]> | null = null;
  /** The room whose huddle the Workspace has heard of, and not yet the end of, once read from the object's storage. */
  private reported: Promise<RoomId | undefined> | null = null;
  /** The reports to the Workspace that are on their way, and whether who's in the huddle may have changed since the latest was made. */
  private reporting: Promise<boolean> | null = null;
  private unreported = false;
  /** The time the room gave its latest report, which the next is later than. */
  private reportedAt = 0;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    /** Sets the room's alarm to check the huddle by a time, unless it's set for sooner, once the room's events before it are done. */
    private readonly wakeBy: (time: number) => Promise<void>,
  ) {}

  /** Whether `ws` is one of the huddle's sockets, rather than one of the room's own. */
  has(ws: WebSocket): boolean {
    return (ws.deserializeAttachment() as Partial<HuddleAttachment> | null)?.huddle === true;
  }

  /** Whether anyone is in the huddle. */
  get live(): boolean {
    return this.ctx.getWebSockets(HUDDLE_TAG).some((socket) => socket.readyState === WebSocket.OPEN);
  }

  /**
   * Lets `user` into room `roomId`'s huddle, on a socket carrying `tags`, once the room has checked the
   * Workspace's word for them. A huddle that's full, or huddles being off, closes the socket at once
   * with the code that says so. Someone already in the huddle moves to this tab: their other socket
   * closes, and the others hear that they changed rather than that they left and joined. The room,
   * which lets people in one at a time, sets its alarm to check the huddle once someone's in it.
   */
  async join(user: User, roomId: RoomId, tags: string[], muted: boolean): Promise<Response> {
    const app = await this.appNow();
    if (!app) return closedAtOnce(HuddleCloseCode.Off);
    let members = this.members();
    // Whoever joined through an app huddles no longer run through connects again, through this one, to
    // a huddle that starts with whoever is first.
    if (members.some(({ attachment }) => attachment.appId !== app.appId)) {
      this.end(CloseCode.Reconnect);
      members = [];
    }
    const startedAt = members[0]?.attachment.startedAt ?? new Date().toISOString();
    const earlier = members.filter(({ attachment }) => attachment.user.id === user.id);
    if (members.length - earlier.length >= MAX_HUDDLE_PEOPLE) return closedAtOnce(HuddleCloseCode.Full);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [...tags, HUDDLE_TAG]);
    const now = Date.now();
    const attachment: HuddleAttachment = { huddle: true, user, roomId, joinedAt: earlier[0]?.attachment.joinedAt ?? now, openedAt: now, startedAt, muted, appId: app.appId };
    server.serializeAttachment(attachment);
    for (const { socket } of earlier) this.close(socket, HuddleCloseCode.Moved);
    send(server, { type: "huddle.welcome", you: user, people: this.people(), startedAt });
    this.broadcast({ type: earlier.length > 0 ? "huddle.changed" : "huddle.joined", person: personOf(attachment) }, server);
    if (earlier.length === 0) this.reportSoon();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Does what a frame from one of the huddle's sockets asks. */
  async message(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // A session description is the largest thing a tab sends, and fits a room's largest frame twice over.
    if (isTooLarge(raw, MAX_ROOM_FRAME_SIZE)) return closeTooLarge(ws);
    const frame = typeof raw === "string" ? parseHuddleClientFrame(raw) : null;
    if (!frame) return send(ws, { type: "error", message: UNRECOGNIZED });
    switch (frame.type) {
      case "ping":
        return send(ws, { type: "pong" });
      case "huddle.mute":
        return this.mute(ws, frame.muted);
      case "huddle.publish":
        return this.inTurn(this.sending, ws, frame.type, () => this.publish(ws, frame.sdp, frame.tracks));
      case "huddle.connected":
        // In its turn, so that it's about the connection the tab last published from.
        return this.inTurn(this.sending, ws, frame.type, async () => this.connected(ws));
      case "huddle.listen":
        return this.inTurn(this.receiving, ws, frame.type, () => this.listen(ws, frame.fresh === true));
      case "huddle.answer":
        return this.inTurn(this.receiving, ws, frame.type, () => this.answer(ws, frame.sdp));
    }
  }

  /** Tells the others that `ws`'s person left, as its tab closed it or its connection dropped, and has the SFU close their tracks. */
  left(ws: WebSocket): void {
    const attachment = attachmentOf(ws);
    if (attachment.revoked) return;
    this.broadcast({ type: "huddle.left", userId: attachment.user.id }, ws);
    this.ctx.waitUntil(this.cutOff(ws, attachment));
    this.reportSoon();
  }

  /** Takes `socket`'s person out of the huddle: closes it with `code`, tells the others they left, and has the SFU close their tracks. */
  remove(socket: WebSocket, code: CloseCode | HuddleCloseCode): void {
    const attachment = this.close(socket, code);
    if (!attachment) return;
    this.broadcast({ type: "huddle.left", userId: attachment.user.id });
    this.reportSoon();
  }

  /**
   * Ends the huddle for everyone in it, closing their sockets with `code`. Nobody is left to hear who
   * went, and every tab closes its own connections as its socket closes. Unless `silence` says to, the
   * SFU is asked nothing: with huddles off or their app changed there's no asking it as the app those
   * connections are with. A room that's deleted can ask, and has it close what everyone published, so
   * that a tab which kept its connections open is heard by nobody, and hears nobody.
   */
  end(code: CloseCode | HuddleCloseCode, silence = false): void {
    const members = this.members();
    if (members.length === 0) return;
    for (const { socket } of members) this.close(socket, code, false);
    if (silence) this.ctx.waitUntil(this.silence(members));
    this.reportSoon();
  }

  /**
   * Has the SFU close what each of `members` published, as it was when their sockets closed. That's a
   * request each, so a full huddle's fit the 50 an event may make on Workers' free plan, which closing
   * what each heard as well wouldn't, and it's all it takes for nobody to hear anything. The SFU is
   * asked once: a deleted room's alarm erases the room, and checks no huddle.
   */
  private async silence(members: Member[]): Promise<void> {
    const app = await this.appNow().catch(() => undefined);
    if (!app) return;
    for (const { socket, attachment } of members) {
      // A tab publishing as its socket closed has what that made closed by the frame that made it.
      await this.sending.get(socket)?.last;
      if (attachment.appId !== app.appId) continue;
      for (const session of sessionsOf({ publishing: attachment.publishing })) await this.closeOn(app, session);
    }
  }

  /**
   * Checks the huddle, as the room's alarm has it do every `HUDDLE_CHECK_MS` while one goes on: ends it
   * once huddles are off or run through another app, takes out whoever's socket has gone unheard, tells
   * the Workspace who's in it again, which is what makes up for a report that failed, and asks the SFU
   * again to close the tracks it didn't. Answers when to check next, or null once there's nobody in the
   * huddle, the Workspace has heard so, and nothing is left to close.
   */
  async check(now = Date.now()): Promise<number | null> {
    const members = this.members();
    if (members.length > 0) {
      // Asked afresh, so turning huddles off ends one within a check. Unanswered, the huddle goes on.
      const app = await this.appNow(true).catch(() => undefined);
      if (app === null || (app && members.some(({ attachment }) => attachment.appId !== app.appId))) this.end(app ? CloseCode.Reconnect : HuddleCloseCode.Off);
      else for (const { socket } of members.filter((member) => this.isSilent(member, now)).slice(0, REMOVED_PER_CHECK)) this.remove(socket, CloseCode.Reconnect);
    }
    const reported = await this.report();
    const unclosed = await this.retry(now);
    return this.live || unclosed || !reported ? now + HUDDLE_CHECK_MS : null;
  }

  /** Whether the room last heard from a socket, as it opened or as the runtime answered its ping, longer ago than a live tab leaves it. */
  private isSilent({ socket, attachment }: Member, now: number): boolean {
    return now - Math.max(attachment.openedAt, this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0) > HUDDLE_SILENT_MS;
  }

  /**
   * Runs what a frame asks of the SFU once the socket's frames before it, for the same connection of
   * its tab's, have had their answers: the SFU takes one change to a session at a time, and each
   * change here reads what the last one left. A socket's two connections don't wait on each other, nor
   * do other sockets. Whatever fails, the tab hears that its frame did.
   */
  private inTurn(lines: WeakMap<WebSocket, Line>, ws: WebSocket, type: HuddleClientFrame["type"], work: () => Promise<void>): Promise<void> {
    const line = lines.get(ws) ?? { last: Promise.resolve(), waiting: 0 };
    lines.set(ws, line);
    if (line.waiting > FRAMES_WAITING) return Promise.resolve(send(ws, { type: "error", message: TOO_FAST }));
    line.waiting++;
    line.last = line.last.then(async () => {
      try {
        if (ws.readyState === WebSocket.OPEN) await work();
      } catch (error) {
        console.warn(`A huddle's ${type} failed:`, logged(error));
        send(ws, { type: "error", message: HUDDLE_FAILED, failed: type });
      } finally {
        line.waiting--;
      }
    });
    return line.last;
  }

  private mute(ws: WebSocket, muted: boolean): void {
    if (attachmentOf(ws).muted === muted) return;
    this.broadcast({ type: "huddle.changed", person: personOf(change(ws, (attachment) => ({ ...attachment, muted }))) }, ws);
  }

  /**
   * Publishes a tab's tracks on a new session, with the offer its sending connection made for them,
   * and sends it the SFU's answer. Each track goes by its kind, which is how the others' sessions ask
   * for it. What the tab published before, on a connection it has given up, is closed.
   */
  private async publish(ws: WebSocket, offer: string, tracks: HuddleTrack[]): Promise<void> {
    const app = await this.appOf(ws);
    if (!app) return;
    const sessionId = await startSession(this.env, app);
    const answer = await publishTracks(
      this.env,
      app,
      sessionId,
      offer,
      tracks.map(({ mid, kind }) => ({ mid, trackName: kind })),
    );
    // They left while the SFU answered, so nothing of theirs stays published.
    if (ws.readyState !== WebSocket.OPEN) return this.cut(app.appId, [{ sessionId, mids: midsOf(tracks) }]);
    const earlier = attachmentOf(ws).publishing;
    const attachment = change(ws, (attachment) => ({ ...attachment, publishing: { sessionId, tracks } }));
    send(ws, { type: "huddle.published", sdp: answer });
    if (!earlier) return;
    // Nobody can listen to them until the new connection has connected.
    if (earlier.connectedAt !== undefined) this.broadcast({ type: "huddle.changed", person: personOf(attachment) }, ws);
    this.ctx.waitUntil(this.cut(app.appId, sessionsOf({ publishing: earlier })));
  }

  /** Has the others hear that they can listen to `ws`'s person, whose sending connection has connected. */
  private connected(ws: WebSocket): void {
    const { publishing } = attachmentOf(ws);
    if (!publishing || publishing.connectedAt !== undefined) return;
    const attachment = change(ws, (attachment) => ({ ...attachment, publishing: { ...publishing, connectedAt: Date.now() } }));
    this.broadcast({ type: "huddle.changed", person: personOf(attachment) }, ws);
  }

  /**
   * Has the SFU offer a tab everyone it can listen to and doesn't hear yet, on its receiving
   * connection's session, which is started for the first of them, and sends the tab the offer to
   * answer. With nobody new, or nobody the SFU can offer yet, the tab hears that it's listening to
   * whoever it was offered. Tracks it heard of people who've left, or who publish anew, are closed
   * first. Someone can do either while the SFU makes the offer, too, and the offer then names nobody
   * for the track it carries of them, which is of what they published before: named, the tab would
   * take it for what they publish now, and never ask for that. Should the SFU refuse, the room lets
   * go of the connection, since it can't tell what the session then carries.
   */
  private async listen(ws: WebSocket, fresh: boolean): Promise<void> {
    const app = await this.appOf(ws);
    if (!app) return;
    if (fresh) this.letGo(ws);
    const before = attachmentOf(ws).receiving;
    // The tab answers the offer it has before it's made another.
    if (before?.offered) return;
    const publications = this.publications(ws);
    const heard = (before?.heard ?? []).filter(({ from }) => publications.has(from));
    try {
      if (before && heard.length < before.heard.length) {
        const stale = before.heard.filter(({ from }) => !publications.has(from));
        await this.cut(app.appId, [{ sessionId: before.sessionId, mids: midsOf(stale) }]);
        if (ws.readyState !== WebSocket.OPEN) return;
        change(ws, (attachment) => ({ ...attachment, receiving: { sessionId: before.sessionId, heard } }));
      }
      const wanted = [...publications].flatMap(([from, { tracks }]) => tracks.filter(({ kind }) => !heard.some((track) => track.from === from && track.kind === kind)).map(({ kind }) => ({ from, kind })));
      if (wanted.length === 0) return send(ws, { type: "huddle.listening" });

      const asked = wanted.slice(0, TRACKS_PER_REQUEST);
      const sessionId = before?.sessionId ?? (await startSession(this.env, app));
      const pulled = await pullTracks(
        this.env,
        app,
        sessionId,
        asked.map(({ from, kind }) => ({ sessionId: from, trackName: kind })),
      );
      const offered = pulled.tracks.flatMap(({ sessionId: from, trackName, mid }) => asked.filter((track) => track.from === from && track.kind === trackName).map(({ kind }) => ({ mid, from, kind })));
      // They left while the SFU answered, so it sends them nothing of this.
      if (ws.readyState !== WebSocket.OPEN) return this.cut(app.appId, [{ sessionId, mids: midsOf(offered) }]);
      this.republish(pulled.missing.filter(({ code }) => code === NOT_PUBLISHED).map(({ sessionId }) => sessionId));
      // The session waits for the tab's answer to whatever it offers, even an offer of nobody.
      change(ws, (attachment) => ({ ...attachment, receiving: pulled.offer === null ? { sessionId, heard } : { sessionId, heard, offered } }));
      if (pulled.offer === null) return send(ws, { type: "huddle.listening" });
      // As the others publish now, which the SFU's answer may have taken long enough to change.
      const current = this.publications(ws);
      const tracks = offered.filter(({ from }) => current.has(from)).map(({ mid, from, kind }) => ({ mid, kind, userId: current.get(from)!.userId }));
      send(ws, { type: "huddle.offer", sdp: pulled.offer, tracks });
    } catch (error) {
      this.letGo(ws);
      throw error;
    }
  }

  /**
   * Gives the SFU a tab's answer to the offer it was made, after which the tab hears those the offer
   * added. Should the SFU refuse the answer, the room lets go of the connection.
   */
  private async answer(ws: WebSocket, sdp: string): Promise<void> {
    const app = await this.appOf(ws);
    if (!app) return;
    const receiving = attachmentOf(ws).receiving;
    if (!receiving?.offered) return send(ws, { type: "error", message: NO_OFFER });
    const { sessionId, heard, offered } = receiving;
    try {
      await acceptAnswer(this.env, app, sessionId, sdp);
    } catch (error) {
      this.letGo(ws);
      throw error;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    change(ws, (attachment) => ({ ...attachment, receiving: { sessionId, heard: [...heard, ...offered] } }));
    send(ws, { type: "huddle.listening" });
  }

  /** Forgets `ws`'s receiving connection, having the SFU close what it heard on it, for its tab to start a fresh one. */
  private letGo(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const { receiving, appId } = attachmentOf(ws);
    if (!receiving) return;
    change(ws, ({ receiving: _, ...attachment }) => attachment);
    this.ctx.waitUntil(this.cut(appId, sessionsOf({ receiving })));
  }

  /**
   * Has the tabs that publish on `sessionIds`, which the SFU no longer finds anything on, publish again,
   * and the others hear that they can't be listened to meanwhile. A session that connected a moment ago
   * is left alone: the SFU may not have found it yet.
   */
  private republish(sessionIds: string[]): void {
    const now = Date.now();
    for (const { socket, attachment } of this.members()) {
      const { publishing } = attachment;
      if (publishing?.connectedAt === undefined || !sessionIds.includes(publishing.sessionId) || now - publishing.connectedAt < PUBLICATION_SETTLES_MS) continue;
      const { connectedAt: _, ...unconnected } = publishing;
      this.broadcast({ type: "huddle.changed", person: personOf(change(socket, (attachment) => ({ ...attachment, publishing: unconnected }))) }, socket);
      send(socket, { type: "huddle.unpublished" });
    }
  }

  /** What the others in the huddle publish that can be listened to, by the session each publishes it on. */
  private publications(except: WebSocket): Map<string, { userId: UserId; tracks: HuddleTrack[] }> {
    const publications = new Map<string, { userId: UserId; tracks: HuddleTrack[] }>();
    for (const { socket, attachment } of this.members()) {
      const { publishing, user } = attachment;
      if (socket !== except && publishing?.connectedAt !== undefined) publications.set(publishing.sessionId, { userId: user.id, tracks: publishing.tracks });
    }
    return publications;
  }

  /**
   * The SFU app `ws`'s huddle runs through, for a frame to ask the SFU as. Once huddles are off, or run
   * through another app than the huddle's, the huddle ends, and this answers null.
   */
  private async appOf(ws: WebSocket): Promise<SfuApp | null> {
    const app = await this.appNow();
    if (ws.readyState !== WebSocket.OPEN) return null;
    if (app?.appId === attachmentOf(ws).appId) return app;
    this.end(app ? CloseCode.Reconnect : HuddleCloseCode.Off);
    return null;
  }

  /** The SFU app huddles run through, or null while they're off, as the Workspace said within `APP_KEPT_MS`, or says now. */
  private async appNow(fresh = false): Promise<SfuApp | null> {
    if (!fresh && this.known && Date.now() - this.known.at < APP_KEPT_MS) return this.known.app;
    const app = await workspace(this.env).huddleApp();
    this.known = { app, at: Date.now() };
    return app;
  }

  /**
   * Closes `socket` itself, with `code`, if it's open, and answers what it remembered. Unless `cut` says
   * not to, the SFU closes its tab's tracks.
   */
  private close(socket: WebSocket, code: CloseCode | HuddleCloseCode, cut = true): HuddleAttachment | null {
    if (socket.readyState !== WebSocket.OPEN) return null;
    const attachment = change(socket, (attachment) => ({ ...attachment, revoked: true }));
    socket.close(code, CLOSE_REASONS[code]);
    if (cut) this.ctx.waitUntil(this.cutOff(socket, attachment));
    return attachment;
  }

  /**
   * Has the SFU close everything a closed socket's tab published and heard, as `attachment` has it,
   * once the frames the SFU was still answering for it are done: each of those closes what it made
   * itself, on finding the socket closed.
   */
  private async cutOff(socket: WebSocket, attachment: HuddleAttachment): Promise<void> {
    await Promise.all([this.sending.get(socket)?.last, this.receiving.get(socket)?.last]);
    await this.cut(attachment.appId, sessionsOf(attachment));
  }

  /**
   * Has the SFU close tracks, as the app whose ID is `appId`, and keeps the ones it didn't for the alarm
   * to ask about again. An app Ember no longer has the secret of can't be asked, and no huddle runs
   * through it again.
   */
  private async cut(appId: string, sessions: Session[]): Promise<void> {
    if (sessions.length === 0) return;
    const app = await this.appNow().catch(() => undefined);
    if (app === null || (app && app.appId !== appId)) return;
    const unclosed: Unclosed[] = [];
    for (const session of sessions) {
      const mids = app ? await this.closeOn(app, session) : session.mids;
      if (mids.length > 0) unclosed.push({ appId, sessionId: session.sessionId, mids, since: Date.now() });
    }
    if (unclosed.length > 0) await this.keep(unclosed).catch((error: unknown) => console.error("Could not keep a huddle's tracks to close:", logged(error)));
  }

  /** Has the SFU close `mids` on a session, and answers the ones it didn't. */
  private async closeOn(app: SfuApp, { sessionId, mids }: Session): Promise<string[]> {
    try {
      return await closeTracks(this.env, app, sessionId, mids);
    } catch (error) {
      console.warn("Closing a huddle's tracks failed:", logged(error));
      return mids;
    }
  }

  /** The tracks the SFU was asked to close and didn't. */
  private unclosed(): Promise<Unclosed[]> {
    return (this.kept ??= this.ctx.storage.get<Unclosed[]>(UNCLOSED).then((kept) => kept ?? []));
  }

  /** Keeps tracks the SFU didn't close, in the object's storage, and has the alarm ask about them again. */
  private async keep(unclosed: Unclosed[]): Promise<void> {
    const kept = await this.unclosed();
    kept.push(...unclosed);
    if (kept.length > UNCLOSED_KEPT) kept.splice(0, kept.length - UNCLOSED_KEPT);
    await this.ctx.storage.put(UNCLOSED, kept);
    await this.wakeBy(Date.now() + HUDDLE_CHECK_MS);
  }

  /**
   * Asks the SFU again to close the tracks it didn't, a few sessions at a time, and answers whether
   * any are left to ask about. Those of an app huddles no longer run through are dropped, as are those
   * it has been asked about for `UNCLOSED_KEPT_MS`. A session stays among those kept until the SFU has
   * answered for it, since tracks kept meanwhile store the list as it is then.
   */
  private async retry(now: number): Promise<boolean> {
    const kept = await this.unclosed();
    if (kept.length === 0) return false;
    const app = await this.appNow().catch(() => undefined);
    if (app === undefined) return true;
    for (const session of kept.slice(0, RETRIED_PER_CHECK)) {
      const mids = app?.appId === session.appId && !this.givenUpOn(session, now) ? await this.closeOn(app, session) : [];
      // Unless the list has dropped it meanwhile, as it does its oldest once it's full.
      const at = kept.indexOf(session);
      if (at >= 0) kept.splice(at, 1);
      if (mids.length > 0) kept.push({ ...session, mids });
    }
    if (kept.length > 0) await this.ctx.storage.put(UNCLOSED, kept);
    else await this.ctx.storage.delete(UNCLOSED);
    return kept.length > 0;
  }

  /** Whether the SFU has been asked to close `session`'s tracks for as long as the room goes on asking, which it says once. */
  private givenUpOn(session: Unclosed, now: number): boolean {
    if (now - session.since <= UNCLOSED_KEPT_MS) return false;
    console.error("Gave up closing a huddle's tracks at the Realtime SFU.");
    return true;
  }

  /** Tells the Workspace who's in the huddle now, which has changed, without anything waiting on it. */
  private reportSoon(): void {
    this.ctx.waitUntil(this.report());
  }

  /**
   * Tells the Workspace who's in the huddle, for everyone in the room to hear. Reports go one at a time,
   * each saying who's in the huddle as it's made, so the changes made while one is on its way go
   * together in the next. Answers whether the Workspace has heard: when it hasn't, the room's next check
   * tells it again.
   */
  private report(): Promise<boolean> {
    this.unreported = true;
    return (this.reporting ??= this.sendReports());
  }

  private async sendReports(): Promise<boolean> {
    try {
      while (this.unreported) {
        this.unreported = false;
        await this.sendReport();
      }
      return true;
    } catch (error) {
      console.warn("Telling the Workspace who's in a huddle failed:", logged(error));
      return false;
    } finally {
      this.reporting = null;
    }
  }

  /**
   * Tells the Workspace who's in the huddle as this is called, at a later time than the report before.
   * The room's id is kept before the Workspace hears of anyone, so that it hears of the huddle's end
   * whatever becomes of the room's object meanwhile, and forgotten once it has heard that.
   */
  private async sendReport(): Promise<void> {
    const members = this.members();
    const roomId = members[0]?.attachment.roomId ?? (await this.reportedRoom());
    // Nobody has been in a huddle here since the Workspace heard that the last one was over.
    if (roomId === undefined) return;
    const huddle = members[0] ? { startedAt: members[0].attachment.startedAt, userIds: members.map(({ attachment }) => attachment.user.id) } : null;
    if (huddle) await this.keepReported(roomId);
    const at = Math.max(this.reportedAt + 1, Date.now());
    this.reportedAt = at;
    const outdatedBy = await workspace(this.env).reportHuddle(roomId, at, huddle);
    if (outdatedBy !== null) {
      // The Workspace has a report from a later time, as a clock that went back makes an earlier one: said again, after it.
      this.reportedAt = Math.max(this.reportedAt, outdatedBy);
      this.unreported = true;
    } else if (!huddle && !this.unreported) await this.forgetReported();
  }

  /** The room whose huddle the Workspace has heard of, and not yet the end of. */
  private reportedRoom(): Promise<RoomId | undefined> {
    return (this.reported ??= this.ctx.storage.get<RoomId>(REPORTED));
  }

  private async keepReported(roomId: RoomId): Promise<void> {
    if ((await this.reportedRoom()) === roomId) return;
    await this.ctx.storage.put(REPORTED, roomId);
    this.reported = Promise.resolve(roomId);
  }

  private async forgetReported(): Promise<void> {
    await this.ctx.storage.delete(REPORTED);
    this.reported = Promise.resolve(undefined);
  }

  /** Everyone in the huddle, in the order they joined. */
  private people(): HuddlePerson[] {
    return this.members().map(({ attachment }) => personOf(attachment));
  }

  /** The huddle's open sockets, in the order their people joined, with what each remembers. */
  private members(): Member[] {
    return this.ctx
      .getWebSockets(HUDDLE_TAG)
      .filter((socket) => socket.readyState === WebSocket.OPEN)
      .map((socket) => ({ socket, attachment: attachmentOf(socket) }))
      .sort((a, b) => a.attachment.joinedAt - b.attachment.joinedAt);
  }

  private broadcast(frame: HuddleServerFrame, except?: WebSocket): void {
    const data = JSON.stringify(frame);
    for (const { socket } of this.members()) {
      if (socket === except) continue;
      try {
        socket.send(data);
      } catch {
        // As in `send`.
      }
    }
  }
}
