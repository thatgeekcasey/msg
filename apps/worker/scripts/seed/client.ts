// The seed does what it does as the app's pages and bots do it: through the Worker's API and the room
// sockets, over HTTP to a local `wrangler dev` or HTTPS to a deployment.

import {
  LOGO_PATH,
  roomSocketQuery,
  uploadPartPath,
  uploadPreviewPath,
  uploadsPath,
  type AccountChanges,
  type Bootstrap,
  type ClientFrame,
  type Me,
  type Message,
  type NewRoom,
  type ProfileChanges,
  type RoomId,
  type ServerFrame,
  type SharedRoom,
  type Sidebar,
  type Upload,
  type UserId,
  type WorkspaceSettings,
} from "@ember/protocol";
import { botSlackPath, type BotAnswer } from "@ember/protocol/bots";
import { paragraph, replyMarkup, type Markup, type Named } from "./markup.ts";

/** Someone signed in: who they are, and the `Cookie` header that carries their session. */
export interface Session {
  user: Me;
  cookie: string;
}

/** A bot, and the key its API takes. */
export interface BotKey extends Named {
  key: string;
}

/** A file as the seed sends it. */
export interface SeedFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** Someone's details, as the setup and join forms send them. */
export interface PersonForm {
  name: string;
  emailAddress: string;
  password: string;
}

/** A request to the Worker, as someone signed in when it names their session, which fails unless it answers one of `expected`. */
interface Ask extends RequestInit {
  session?: Session;
  expected?: number[];
}

/** Node's WebSocket, which, unlike a browser's, can send a handshake's headers. */
const NodeWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;

/** How long the seed waits for a room's answer, which can include a Durable Object's cold start. */
const ANSWER_TIMEOUT_MS = 15_000;

const asBlob = ({ bytes, type }: SeedFile) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type });

/**
 * Someone's fields as the setup, join and bot forms send them: JSON, or with a picture, a form whose
 * `user` part is that JSON and whose `avatar` and `variant` parts are the picture, which is small
 * enough to be its own variant, as the browser makes one.
 */
function userForm(fields: object, picture?: SeedFile): RequestInit {
  if (!picture) return { body: JSON.stringify(fields), headers: { "Content-Type": "application/json" } };
  const form = new FormData();
  form.set("user", JSON.stringify(fields));
  form.set("avatar", asBlob(picture), picture.name);
  form.set("variant", asBlob(picture), picture.name);
  return { body: form };
}

/** The session that signing in, setting up or joining began. */
async function sessionOf(response: Response): Promise<Session> {
  const { user } = (await response.json()) as { user: Me };
  const cookie = response.headers.getSetCookie()[0]?.split(";")[0];
  if (!cookie) throw new Error(`Signing ${user.name} in set no cookie`);
  return { user, cookie };
}

/** An Ember, at `origin`, which a deployment's setup password or token, if it's given, lets the seed set up. */
export class Ember {
  readonly origin: string;
  readonly #setupSecret: string | undefined;

  constructor(origin: string, setupSecret?: string) {
    this.origin = origin;
    this.#setupSecret = setupSecret;
  }

  /** Asks the Worker, as the app's own pages do, which a server over HTTPS asks of every change. */
  async request(path: string, { session, expected = [200], ...init }: Ask = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Origin", this.origin);
    headers.set("Sec-Fetch-Site", "same-origin");
    if (session) headers.set("Cookie", session.cookie);
    const response = await fetch(new URL(path, this.origin), { ...init, headers });
    if (!expected.includes(response.status)) throw new Error(`${init.method ?? "GET"} ${path} answered ${response.status}: ${await response.text()}`);
    return response;
  }

  /** Sends `body` as JSON. */
  json(path: string, method: string, body: unknown, ask: Ask = {}): Promise<Response> {
    return this.request(path, { ...ask, method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  }

  async isSetUp(): Promise<boolean> {
    const bootstrap = (await (await this.request("/api/bootstrap")).json()) as Bootstrap;
    return bootstrap.setup === "complete";
  }

  /** Sets Ember up with `person` as its first administrator, as the Set up Ember form does. */
  async setUp(person: PersonForm, avatar?: SeedFile): Promise<Session> {
    const { headers, ...form } = userForm(person, avatar);
    // Percent-encoded, as the page sends it, since a header can't hold every character a password can.
    const authorization = this.#setupSecret ? { Authorization: `Bearer ${encodeURIComponent(this.#setupSecret)}` } : {};
    return sessionOf(await this.request("/api/first_run", { method: "POST", ...form, headers: { ...headers, ...authorization }, expected: [201] }));
  }

  /** Adds `person` with the join link's `code`, as its form does. */
  async join(code: string, person: PersonForm, avatar?: SeedFile): Promise<Session> {
    return sessionOf(await this.request(`/api/join/${encodeURIComponent(code)}`, { method: "POST", ...userForm(person, avatar), expected: [201] }));
  }

  async settings(session: Session): Promise<WorkspaceSettings> {
    return (await (await this.request("/api/account", { session })).json()) as WorkspaceSettings;
  }

  async changeAccount(session: Session, changes: AccountChanges): Promise<void> {
    await this.json("/api/account", "PATCH", changes, { session });
  }

  /** Gives the workspace a logo, with the PNGs within 512×512 and 192×192 that the browser would make of it. */
  async changeLogo(session: Session, logo: SeedFile, large: SeedFile, small: SeedFile): Promise<void> {
    const form = new FormData();
    form.set("logo", asBlob(logo), logo.name);
    form.set("large", asBlob(large), large.name);
    form.set("small", asBlob(small), small.name);
    await this.request(LOGO_PATH, { method: "PUT", body: form, session });
  }

  async changeProfile(session: Session, changes: ProfileChanges): Promise<void> {
    await this.json("/api/users/me/profile", "PATCH", changes, { session });
  }

  async sidebar(session: Session): Promise<Sidebar> {
    return (await (await this.request("/api/sidebar", { session })).json()) as Sidebar;
  }

  /** Dismisses the welcome card, as its × does. */
  async dismissInvitation(session: Session): Promise<void> {
    await this.request("/api/sidebar/invitation", { method: "DELETE", session, expected: [204] });
  }

  async createRoom(session: Session, room: NewRoom): Promise<SharedRoom> {
    const response = await this.json("/api/rooms", "POST", room, { session, expected: [201] });
    return ((await response.json()) as { room: SharedRoom }).room;
  }

  /** Starts a DM between `session`'s person and `others`, answering its id. */
  async startDirect(session: Session, others: Session[]): Promise<RoomId> {
    const response = await this.json("/api/directs", "POST", { userIds: others.map(({ user }) => user.id) }, { session, expected: [200, 201] });
    return ((await response.json()) as { room: { id: RoomId } }).room.id;
  }

  async star(session: Session, roomId: RoomId): Promise<void> {
    await this.json(`/api/rooms/${encodeURIComponent(roomId)}/favorite`, "PUT", { favorite: true }, { session });
  }

  /** Adds a bot, as an administrator does on the Chat bots page. */
  async createBot(administrator: Session, name: string, avatar?: SeedFile): Promise<BotKey> {
    const response = await this.request("/api/account/bots", { method: "POST", ...userForm({ name }, avatar), session: administrator, expected: [201] });
    const { bot } = (await response.json()) as BotAnswer;
    return { id: bot.id, name: bot.name, key: bot.key };
  }

  /** Posts what a Slack incoming webhook is sent to `bot`'s webhook for `roomId`. */
  async postAsBot(bot: BotKey, roomId: RoomId, payload: object): Promise<void> {
    await this.json(botSlackPath(roomId, bot.key), "POST", payload);
  }

  /**
   * Uploads `file` to `roomId` as `session`'s person, in the parts the Worker asks for, as the composer
   * does, with `preview` as its thumbnail, and answers the message the room posts it as.
   */
  async upload(session: Session, roomId: RoomId, file: SeedFile, preview?: SeedFile): Promise<Message> {
    const clientMessageId = crypto.randomUUID();
    const upload = { name: file.name, type: file.type, size: file.bytes.length, clientMessageId };
    const { id, partSize, parts } = (await (await this.json(uploadsPath(roomId), "POST", upload, { session, expected: [201] })).json()) as Upload;
    const part = (n: number) => file.bytes.subarray((n - 1) * partSize, n === parts ? file.bytes.length : n * partSize);
    for (let n = 1; n < parts; n++) await this.request(uploadPartPath(roomId, id, n), { method: "PUT", body: part(n), session, expected: [204] });
    if (preview) await this.request(uploadPreviewPath(roomId, id), { method: "PUT", body: preview.bytes, session, expected: [204] });
    const posted = await this.request(uploadPartPath(roomId, id, parts), { method: "PUT", body: part(parts), session, expected: [200, 201] });
    return (await posted.json()) as Message;
  }
}

/** Someone's socket to a room, through which they write, edit and react as the app does. */
export class RoomSocket {
  readonly session: Session;
  /** Whether it's from a tab showing the room. */
  readonly visible: boolean;
  readonly #socket: WebSocket;
  readonly #waiters = new Set<(frame: ServerFrame) => boolean>();

  constructor(session: Session, socket: WebSocket, visible: boolean) {
    this.session = session;
    this.visible = visible;
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      for (const waiter of this.#waiters) if (waiter(frame)) this.#waiters.delete(waiter);
    });
  }

  /** Opens `session`'s socket to `roomId`, from a tab that's `visible` or not, once the room has welcomed it. */
  static async open(ember: Ember, session: Session, roomId: RoomId, visible: boolean): Promise<RoomSocket> {
    const url = new URL(`/api/rooms/${encodeURIComponent(roomId)}/socket${roomSocketQuery({ visible })}`, ember.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new RoomSocket(session, new NodeWebSocket(url.href, { headers: { Cookie: session.cookie, Origin: ember.origin } }), visible);
    await socket.next((frame) => (frame.type === "welcome" ? frame : undefined));
    return socket;
  }

  /**
   * Writes a message whose body is `body`, or a reply in the thread of `inThread.parentId`, answering it
   * once the room has stored it.
   */
  post(body: string, inThread?: { parentId: string; alsoSend: boolean }): Promise<Message> {
    const clientMessageId = crypto.randomUUID();
    return this.#ask({ type: "message.create", clientMessageId, body, ...inThread }, (frame) =>
      frame.type === "message.created" && frame.message.clientMessageId === clientMessageId ? frame.message : undefined,
    );
  }

  edit(messageId: string, body: string): Promise<Message> {
    return this.#ask({ type: "message.update", messageId, body }, (frame) => (frame.type === "message.updated" && frame.message.id === messageId ? frame.message : undefined));
  }

  boost(messageId: string, content: string): Promise<unknown> {
    return this.#ask({ type: "boost.create", messageId, content }, (frame) =>
      frame.type === "boost.created" && frame.boost.messageId === messageId && frame.boost.content === content ? frame : undefined,
    );
  }

  /**
   * Reads the room to its latest message, as coming back to a tab showing it does, once the room has
   * logged it: the room hears the frames in order, so its pong comes after. The ping carries a field the
   * room ignores, since the runtime answers the app's `{"type":"ping"}` itself, before the room hears
   * what came first.
   */
  async read(): Promise<void> {
    this.#socket.send(JSON.stringify({ type: "presence.visible", visible: true } satisfies ClientFrame));
    const ping = { type: "ping", by: "seed" } as const;
    await this.#ask(ping, (frame) => (frame.type === "pong" ? frame : undefined));
  }

  /** The first frame from now on that `pick` picks something of, which it answers, failing on an error from the room. */
  next<T>(pick: (frame: ServerFrame) => T | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`${this.session.user.name}'s socket heard nothing it was waiting for`));
      }, ANSWER_TIMEOUT_MS);
      const waiter = (frame: ServerFrame) => {
        const picked = frame.type === "error" ? undefined : pick(frame);
        if (frame.type !== "error" && picked === undefined) return false;
        clearTimeout(timer);
        if (frame.type === "error") reject(new Error(`The room refused ${this.session.user.name}: ${frame.message}`));
        else resolve(picked!);
        return true;
      };
      this.#waiters.add(waiter);
    });
  }

  close(): void {
    this.#socket.close(1000);
  }

  #ask<T>(frame: ClientFrame, pick: (frame: ServerFrame) => T | undefined): Promise<T> {
    const answer = this.next(pick);
    this.#socket.send(JSON.stringify(frame));
    return answer;
  }
}

/** What was said in a room: the message the room stored, the markup it was written as, and who wrote it. */
export interface Said {
  message: Message;
  markup: Markup;
  author: Named;
}

const markupOf = (written: Markup | string) => (typeof written === "string" ? paragraph(written) : written);

/**
 * A room's conversation, said in the order it's written: each person's socket to the room opens as they
 * first speak or watch, and all of them close with it.
 */
export class Conversation {
  readonly roomId: RoomId;
  readonly #ember: Ember;
  readonly #sockets = new Map<UserId, RoomSocket>();

  constructor(ember: Ember, roomId: RoomId) {
    this.#ember = ember;
    this.roomId = roomId;
  }

  /** Has `person` watch the room from a tab out of sight, so a bot's message can be seen to arrive before anyone speaks. */
  async watch(person: Session): Promise<void> {
    await this.#socketOf(person, false);
  }

  async say(person: Session, written: Markup | string): Promise<Said> {
    const markup = markupOf(written);
    const message = await (await this.#socketOf(person)).post(markup.body);
    return { message, markup, author: person.user };
  }

  /** Replies to what was said, as Quote has it: quoting it, citing its author with a link to it. */
  reply(person: Session, to: Said, written: Markup | string): Promise<Said> {
    const permalink = new URL(`/rooms/${encodeURIComponent(this.roomId)}/@${encodeURIComponent(to.message.id)}`, this.#ember.origin).href;
    return this.say(person, replyMarkup(to.markup, to.author, permalink, markupOf(written)));
  }

  /** Replies to what was said in its thread, as Reply in thread has it, sending the reply to the room too if `alsoSend`. */
  async replyInThread(person: Session, to: Said, written: Markup | string, { alsoSend = false } = {}): Promise<Said> {
    const markup = markupOf(written);
    const message = await (await this.#socketOf(person)).post(markup.body, { parentId: to.message.id, alsoSend });
    return { message, markup, author: person.user };
  }

  /** Changes what its author said to `written`, as Edit does. */
  async edit(said: Said, written: Markup | string): Promise<Said> {
    const socket = this.#sockets.get(said.author.id);
    if (!socket) throw new Error(`${said.author.name} has to speak in the room before editing`);
    const markup = markupOf(written);
    return { message: await socket.edit(said.message.id, markup.body), markup, author: said.author };
  }

  async react(person: Session, said: Said, content: string): Promise<void> {
    await (await this.#socketOf(person)).boost(said.message.id, content);
  }

  /** Shares a file, as the composer's paperclip does, with the preview the browser would make of a picture or video. */
  async share(person: Session, file: SeedFile, preview?: SeedFile): Promise<Said> {
    await this.#socketOf(person);
    const message = await this.#ember.upload(person, this.roomId, file, preview);
    return { message, markup: paragraph(file.name), author: person.user };
  }

  /** Posts a Slack-style payload as `bot`, answering the message once it arrives on someone's socket. */
  async post(bot: BotKey, payload: object): Promise<Said> {
    const [socket] = this.#sockets.values();
    if (!socket) throw new Error("Someone has to be in the room to see a bot's message arrive");
    const arrived = socket.next((frame) => (frame.type === "message.created" && frame.message.creator.id === bot.id ? frame.message : undefined));
    await this.#ember.postAsBot(bot, this.roomId, payload);
    const message = await arrived;
    return { message, markup: paragraph(message.plainText), author: bot };
  }

  /**
   * Has everyone with the room in sight read it to the end, as they would by staying. The room marks
   * someone unread once it tells the Workspace of a message, which can be after they've left.
   */
  async readToEnd(): Promise<void> {
    for (const socket of this.#sockets.values()) if (socket.visible) await socket.read();
  }

  close(): void {
    for (const socket of this.#sockets.values()) socket.close();
    this.#sockets.clear();
  }

  async #socketOf(person: Session, visible = true): Promise<RoomSocket> {
    const open = this.#sockets.get(person.user.id);
    if (open) return open;
    const socket = await RoomSocket.open(this.#ember, person, this.roomId, visible);
    this.#sockets.set(person.user.id, socket);
    return socket;
  }
}
