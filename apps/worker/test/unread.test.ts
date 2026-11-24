import type { RoomId, Sidebar, SpecialMention, WorkspaceServerFrame } from "@ember/protocol";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNDELIVERED_EVENTS, type RoomEvent } from "../src/room-log";
import { COUNT_MENTIONS, COUNT_ROOM_MENTION, MARK_READ, MARK_UNREAD } from "../src/workspace-store";
import {
  api,
  connect,
  createRoom,
  cutOff,
  direct,
  freshDeploy,
  freshRoom,
  holdNextCall,
  openWorkspaceSocket,
  post,
  roomSql,
  roomStub,
  settle,
  signIn,
  workspaceSql,
  workspaceStub,
  type Session,
  type WorkspaceSocket,
} from "./support";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The frame marking room `roomId` unread, as of when the message that marked it came, if that's given. */
const unread = (roomId: RoomId, at: string = expect.any(String)): WorkspaceServerFrame => ({ type: "room.unread", roomId, at });
const read = (roomId: RoomId): WorkspaceServerFrame => ({ type: "room.read", roomId });

/** Waits until room `room` has nothing left in its log, which it forgets once the Workspace has applied it. */
async function delivered(room: RoomId): Promise<void> {
  while ((await roomSql(room, "SELECT seq FROM room_events WHERE room_id = ?", room)).length > 0) await sleep(5);
}

/** What `socket` has heard once the Workspace has applied everything room `room` has logged: the frames that come before a pong. */
async function heard(socket: WorkspaceSocket, room: RoomId): Promise<WorkspaceServerFrame[]> {
  await delivered(room);
  socket.send(JSON.stringify({ type: "ping", nonce: crypto.randomUUID() }));
  const frames: WorkspaceServerFrame[] = [];
  for (let frame = await socket.next(); frame.type !== "pong"; frame = await socket.next()) frames.push(frame);
  return frames;
}

/** Who room `room` is marked unread for, by name. */
const marked = async (room: RoomId) =>
  (
    await workspaceSql(
      "SELECT users.name FROM memberships JOIN users ON users.id = memberships.user_id WHERE room_id = ? AND unread_at IS NOT NULL ORDER BY users.name",
      room,
    )
  ).map((row) => (row as { name: string }).name);

/** When `session`'s person was marked unread in room `room`, if they are. */
const unreadAt = async (room: RoomId, session: Session) =>
  ((await workspaceSql("SELECT unread_at FROM memberships WHERE room_id = ? AND user_id = ?", room, session.user.id))[0] as { unread_at: string | null }).unread_at;

/**
 * Whether room `room` shows as unread in the sidebar `GET /api/sidebar` gives `session`, and since when,
 * with the response's ETag.
 */
async function sidebarOf(session: Session, room: RoomId, etag?: string) {
  const response = await api("/api/sidebar", { headers: { Cookie: session.cookie, ...(etag && { "If-None-Match": etag }) } });
  if (response.status === 304) return { status: 304, etag };
  const sidebar = (await response.json()) as Sidebar;
  const listed = sidebar.rooms.find(({ id }) => id === room);
  return { status: response.status, etag: response.headers.get("ETag")!, unread: listed?.unread, unreadSince: listed?.unreadSince };
}

const alarmOf = (room: RoomId) => runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => state.storage.getAlarm());

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Unread rooms", () => {
  it("marks a room unread for the members who aren't viewing it, telling each of them alone", async () => {
    const room = await freshRoom("marking");
    const ada = await connect(room, "Ada", { visible: true });
    const grace = await connect(room, "Grace", { visible: true });
    const lin = await connect(room, "Lin", { visible: false });
    const hopper = await signIn("Hopper");
    const tabs = await Promise.all([ada.session, grace.session, lin.session, hopper].map((session) => openWorkspaceSocket(session)));
    await settle(ada, grace, lin);

    const message = await post(ada, "Anyone around?");
    const [adasTab, gracesTab, linsTab, hoppersTab] = tabs;
    expect(await heard(hoppersTab!, room)).toEqual([unread(room, message.createdAt)]);
    expect(await heard(linsTab!, room)).toEqual([unread(room, message.createdAt)]);
    expect(await heard(adasTab!, room)).toEqual([]);
    expect(await heard(gracesTab!, room)).toEqual([]);
    // Everyone is in an open room, its creator included.
    expect(await marked(room)).toEqual(["Hopper", "Host", "Lin"]);
    expect(await unreadAt(room, hopper)).toBe(message.createdAt);
  });

  it("marks a room once until it's read, in every tab, and again after", async () => {
    const room = await freshRoom("once");
    const ada = await connect(room, "Ada", { visible: true });
    const hopper = await signIn("Hopper");
    const [laptop, phone] = [await openWorkspaceSocket(hopper), await openWorkspaceSocket(hopper)];

    const first = await post(ada, "first");
    await post(ada, "second");
    expect(await heard(laptop, room)).toEqual([unread(room, first.createdAt)]);
    expect(await heard(phone, room)).toEqual([unread(room, first.createdAt)]);
    expect(await unreadAt(room, hopper)).toBe(first.createdAt);
    // His sidebar says since when, the first message's time, which the second doesn't move.
    expect(await sidebarOf(hopper, room)).toMatchObject({ unread: true, unreadSince: first.createdAt });

    // Opening the room in a shown tab reads it, in his other tabs too.
    const reading = await connect(room, hopper, { visible: true });
    await settle(reading);
    expect(await heard(laptop, room)).toEqual([read(room)]);
    expect(await heard(phone, room)).toEqual([read(room)]);
    expect(await sidebarOf(hopper, room)).toMatchObject({ unread: false, unreadSince: undefined });

    // Nothing marks it while he's viewing it, and the next message once he's gone does.
    await post(ada, "third");
    expect(await heard(laptop, room)).toEqual([]);
    reading.close();
    await ada.next("presence.left");
    await post(ada, "fourth");
    expect(await heard(laptop, room)).toEqual([unread(room)]);
  });

  it("reads a room when the tab showing it is shown again, but not when one opens it hidden", async () => {
    const room = await freshRoom("coming-back");
    const ada = await connect(room, "Ada", { visible: true });
    const lin = await connect(room, "Lin", { visible: false });
    const tab = await openWorkspaceSocket(lin.session);
    await post(ada, "while you were away");
    expect(await heard(tab, room)).toEqual([unread(room)]);

    const background = await connect(room, lin.session, { visible: false });
    await settle(background);
    expect(await heard(tab, room)).toEqual([]);

    lin.send({ type: "presence.visible", visible: true });
    await settle(lin);
    expect(await heard(tab, room)).toEqual([read(room)]);

    // Hidden again, she's away again.
    lin.send({ type: "presence.visible", visible: false });
    await settle(lin);
    await post(ada, "and again");
    expect(await heard(tab, room)).toEqual([unread(room)]);
  });

  it("logs no read for someone who has read the room since its latest message, which would change nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const room = await freshRoom("read-again");
    const ada = await connect(room, "Ada", { visible: true });
    const hopper = await signIn("Hopper");
    const tab = await openWorkspaceSocket(hopper);
    await settle(ada);
    await delivered(room);
    const reconnect = await cutOff(room);
    const logged = async () => (await roomSql(room, "SELECT kind FROM room_events WHERE room_id = ? ORDER BY seq", room)).map((row) => (row as RoomEvent).kind);

    // Hopper reads the room, then opens it again and shows it again with nothing new since.
    const reading = await connect(room, hopper, { visible: true });
    await settle(reading);
    reading.close();
    await ada.next("presence.left");
    const again = await connect(room, hopper, { visible: false });
    again.send({ type: "presence.visible", visible: true });
    await settle(again);
    expect(await logged()).toEqual(["read"]);

    // A message could mark the room for him, so the next time he shows it reads it.
    again.send({ type: "presence.visible", visible: false });
    await settle(again);
    await post(ada, "something new");
    again.send({ type: "presence.visible", visible: true });
    await settle(again);
    expect(await logged()).toEqual(["read", "message", "read"]);

    await vi.waitFor(async () => expect(await alarmOf(room)).not.toBeNull(), { timeout: 5_000 });
    await reconnect();
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    expect(await heard(tab, room)).toEqual([]);
    expect(await marked(room)).toEqual(["Host"]);
  });

  it("never marks a room for someone who has hidden it", async () => {
    const room = await freshRoom("hidden-room");
    const ada = await connect(room, "Ada", { visible: true });
    const hopper = await signIn("Hopper");
    await workspaceSql("UPDATE memberships SET involvement = 'invisible' WHERE room_id = ? AND user_id = ?", room, hopper.user.id);
    const tab = await openWorkspaceSocket(hopper);
    await post(ada, "unseen");
    expect(await heard(tab, room)).toEqual([]);
    expect(await marked(room)).toEqual(["Host"]);
  });

  it("marks nothing for edits, deletions or reactions", async () => {
    const room = await freshRoom("quiet-changes");
    const ada = await connect(room, "Ada", { visible: true });
    const message = await post(ada, "typo");
    // Hopper joins once the Workspace has heard of the message, so it hasn't marked the room for him.
    await delivered(room);
    const hopper = await signIn("Hopper");
    const tab = await openWorkspaceSocket(hopper);

    ada.send({ type: "message.update", messageId: message.id, body: "fixed" });
    await ada.next("message.updated");
    ada.send({ type: "boost.create", messageId: message.id, content: "👍" });
    await ada.next("boost.created");
    ada.send({ type: "message.delete", messageId: message.id });
    await ada.next("message.deleted");

    expect(await heard(tab, room)).toEqual([]);
    expect(await marked(room)).not.toContain("Hopper");
  });

  it("tells nobody outside the room", async () => {
    const [ada, grace, eve] = [await signIn("Ada"), await signIn("Grace"), await signIn("Eve")];
    const room = (await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada })).id;
    const adasSocket = await connect(room, ada, { visible: true });
    const [gracesTab, evesTab] = [await openWorkspaceSocket(grace), await openWorkspaceSocket(eve)];
    await post(adasSocket, "just us");
    expect(await heard(gracesTab, room)).toEqual([unread(room)]);
    expect(await heard(evesTab, room)).toEqual([]);
    expect(await marked(room)).toEqual(["Grace"]);
  });

  it("applies each event of a room's log once, however often the room sends it", async () => {
    const room = await freshRoom("again");
    // Opened in a hidden tab, the room logs nothing of its own.
    await connect(room, "Ada", { visible: false });
    const hopper = await signIn("Hopper");
    const tab = await openWorkspaceSocket(hopper);
    const apply = (...events: RoomEvent[]) => workspaceStub().applyRoomEvents(room, events, []);
    const message: RoomEvent = { seq: 1, kind: "message", userId: "someone", at: new Date().toISOString() };
    const reading: RoomEvent = { seq: 2, kind: "read", userId: hopper.user.id, at: new Date().toISOString() };

    await apply(message);
    expect(await heard(tab, room)).toEqual([unread(room)]);
    await apply(message);
    expect(await heard(tab, room)).toEqual([]);
    await apply(reading);
    expect(await heard(tab, room)).toEqual([read(room)]);

    // Sent again, as after a call whose answer was lost, the message marks nothing, and the read stands.
    await apply(message, reading);
    expect(await heard(tab, room)).toEqual([]);
    expect(await marked(room)).not.toContain("Hopper");
  });

  it("marks each of two authors for the other's message when one call brings both", async () => {
    const room = await freshRoom("two-authors");
    await connect(room, "Lin", { visible: false });
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const [adasTab, gracesTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace)];
    const now = Date.now();
    const messages: RoomEvent[] = [
      { seq: 1, kind: "message", userId: ada.user.id, at: new Date(now).toISOString() },
      { seq: 2, kind: "message", userId: grace.user.id, at: new Date(now + 1_000).toISOString() },
    ];
    await workspaceStub().applyRoomEvents(room, messages, []);
    expect(await heard(adasTab, room)).toEqual([unread(room)]);
    expect(await heard(gracesTab, room)).toEqual([unread(room)]);
    expect(await unreadAt(room, grace)).toBe(messages[0]!.at);
    expect(await unreadAt(room, ada)).toBe(messages[1]!.at);
  });

  it("takes everyone viewing a room as one value, however many there are", async () => {
    const room = await freshRoom("crowded");
    await connect(room, "Lin", { visible: false });
    const hopper = await signIn("Hopper");
    const tab = await openWorkspaceSocket(hopper);
    // More than the 100 values a statement can bind, with Hopper last.
    const viewers = [...Array.from({ length: 150 }, (_, i) => `viewer-${i}`), hopper.user.id];
    await workspaceStub().applyRoomEvents(room, [{ seq: 1, kind: "message", userId: "someone", at: new Date().toISOString() }], viewers);
    expect(await heard(tab, room)).toEqual([]);
    expect(await marked(room)).toEqual(["Host", "Lin"]);
  });

  it("keeps a room's log in order while the Workspace can't be reached, and sends it once it can", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const room = await freshRoom("unreachable");
    const ada = await connect(room, "Ada", { visible: true });
    const hopper = await signIn("Hopper");
    const tab = await openWorkspaceSocket(hopper);
    await settle(ada);
    await delivered(room);

    const reconnect = await cutOff(room);
    await post(ada, "while the Workspace is away");
    // Hopper reads the room after the message, and leaves it before the Workspace hears of either.
    const reading = await connect(room, hopper, { visible: true });
    await settle(reading);
    reading.close();
    await ada.next("presence.left");
    expect(await roomSql(room, "SELECT kind FROM room_events WHERE room_id = ? ORDER BY seq", room)).toEqual([{ kind: "message" }, { kind: "read" }]);
    // The room calls once the pause after its last call is over, and sets its alarm when that fails.
    await vi.waitFor(async () => expect(await alarmOf(room)).not.toBeNull(), { timeout: 5_000 });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("trying again later"), expect.any(Error));

    await reconnect();
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    // The message marked him, and his read, which came after it, cleared the mark.
    expect(await heard(tab, room)).toEqual([read(room)]);
    expect(await marked(room)).toEqual(["Host"]);
  });

  it("marks a room for nobody who saw its message come in, though they left before the Workspace heard of it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const room = await freshRoom("seen-then-gone");
    const ada = await connect(room, "Ada", { visible: true });
    const grace = await connect(room, "Grace", { visible: true });
    const hopper = await signIn("Hopper");
    const [gracesTab, hoppersTab] = await Promise.all([grace.session, hopper].map((session) => openWorkspaceSocket(session)));
    await settle(ada, grace);
    await delivered(room);

    // Grace sees the message come in and leaves before the Workspace hears of it, as she can within the
    // pause after a room's call, which here lasts until the room's alarm.
    const reconnect = await cutOff(room);
    await post(ada, "Did you catch that?");
    await grace.next("message.created");
    grace.close();
    await ada.next("presence.left");
    await vi.waitFor(async () => expect(await alarmOf(room)).not.toBeNull(), { timeout: 5_000 });

    await reconnect();
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    expect(await heard(gracesTab!, room)).toEqual([]);
    expect(await heard(hoppersTab!, room)).toEqual([unread(room)]);
    expect(await marked(room)).toEqual(["Hopper", "Host"]);
  });

  it("marks a room for nobody who joined it after its message, though the Workspace hears of the message once they have", async () => {
    const room = await freshRoom("joined-after");
    const ada = await connect(room, "Ada", { visible: true });
    await settle(ada);
    await delivered(room);
    const call = await holdNextCall(room);

    // Ada's messages wait for the Workspace while Hopper joins, as a busy room's wait for the calls before
    // theirs: the first in the call held, the second for the call after it.
    await post(ada, "Before anyone new");
    await call.called();
    await post(ada, `<p>Standup in 5 <action-text-attachment sgid="channel" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment></p>`);
    const hopper = await signIn("Hopper");
    const tab = await openWorkspaceSocket(hopper);
    call.release();

    // Host was in the room for both, and @channel counts for him, but neither is Hopper's to read.
    expect(await heard(tab, room)).toEqual([]);
    expect(await marked(room)).toEqual(["Host"]);
    const counted = "SELECT users.name, mention_count FROM memberships JOIN users ON users.id = memberships.user_id WHERE room_id = ? AND mention_count > 0";
    expect(await workspaceSql(counted, room)).toEqual([{ name: "Host", mention_count: 1 }]);
    expect(await sidebarOf(hopper, room)).toMatchObject({ unread: false, unreadSince: undefined });

    // The first message since he joined marks the room for him, as of it.
    const welcome = await post(ada, "Welcome, Hopper");
    expect(await heard(tab, room)).toEqual([unread(room, welcome.createdAt)]);
  });

  it("calls a Workspace it couldn't reach again only when its alarm goes off, however busy the room is", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const room = await freshRoom("backing-off");
    const ada = await connect(room, "Ada", { visible: true });
    const hopper = await signIn("Hopper");
    const tab = await openWorkspaceSocket(hopper);
    await settle(ada);
    await delivered(room);

    const calls: number[] = [];
    const reconnect = await cutOff(room, calls);
    // Messages keep coming for longer than the pause after a call.
    for (let i = 0; i < 8; i++) {
      await post(ada, `while the Workspace is away, ${i}`);
      await sleep(100);
    }
    expect(calls.length).toBeGreaterThan(0);
    // Each call after the first waits for the alarm, a second after the first failure and longer after the next.
    for (let i = 1; i < calls.length; i++) expect(calls[i]! - calls[i - 1]!).toBeGreaterThanOrEqual(1_000);

    await reconnect();
    await runDurableObjectAlarm(roomStub(room));
    expect(await heard(tab, room)).toEqual([unread(room)]);
    expect(await marked(room)).toEqual(["Hopper", "Host"]);
  });

  it("sends what a restart left in the log once the room next lets a socket in", async () => {
    const room = await freshRoom("restarted");
    await connect(room, "Ada", { visible: false });
    const hopper = await signIn("Hopper");
    // Signed in before the tab opens, as every open tab hears of someone new.
    const grace = await signIn("Grace");
    const tab = await openWorkspaceSocket(hopper);
    // As a deploy can leave it: a message logged, the room restarted in the middle of sending it, and no alarm set.
    await roomSql(room, "INSERT INTO room_events (room_id, kind, user_id, at) VALUES (?, 'message', 'someone', ?)", room, new Date().toISOString());
    await evictDurableObject(roomStub(room));
    expect(await alarmOf(room)).toBeNull();

    await connect(room, grace, { visible: false });
    expect(await heard(tab, room)).toEqual([unread(room)]);
  });

  it("lists each room's mark in the sidebar, whose ETag changes with it", async () => {
    const room = await freshRoom("listed");
    const ada = await connect(room, "Ada", { visible: true });
    const hopper = await signIn("Hopper");
    const before = await sidebarOf(hopper, room);
    expect(before).toMatchObject({ status: 200, unread: false });

    await post(ada, "hello");
    await delivered(room);
    expect(await sidebarOf(hopper, room, before.etag)).toMatchObject({ status: 200, unread: true });
  });

  it("finds marks through the memberships' key, and a room's log through its index", async () => {
    const room = await freshRoom("plans");
    await connect(room, "Ada");
    const plan = async (sql: typeof roomSql | typeof workspaceSql, query: string, ...params: Array<string | number>) =>
      (await (sql === roomSql ? roomSql(room, `EXPLAIN QUERY PLAN ${query}`, ...params) : workspaceSql(`EXPLAIN QUERY PLAN ${query}`, ...params)))
        .map((row) => (row as { detail: string }).detail)
        .join("; ");

    expect(await plan(workspaceSql, MARK_UNREAD, "2026-10-14T12:00:00.000Z", room, "someone", "[]", 1)).toMatch(/memberships USING (INDEX sqlite_autoindex_memberships_1|PRIMARY KEY) \(room_id=\?\)/);
    expect(await plan(workspaceSql, MARK_READ, room, "someone", 1)).toMatch(/memberships USING (INDEX sqlite_autoindex_memberships_1|PRIMARY KEY) \(room_id=\? AND user_id=\?\)/);
    const undelivered = await plan(roomSql, UNDELIVERED_EVENTS, room, 50);
    expect(undelivered).toContain("index_room_events_on_room_id_and_seq (room_id=?)");
    expect(undelivered).not.toContain("TEMP B-TREE");
  });
});

describe("Hibernating rooms", () => {
  it("marks rooms after the room hibernates, still counting its shown tabs as viewing it", async () => {
    const room = await freshRoom("hibernate-marks");
    const ada = await connect(room, "Ada", { visible: true });
    const grace = await connect(room, "Grace", { visible: true });
    const hopper = await signIn("Hopper");
    const [gracesTab, hoppersTab] = [await openWorkspaceSocket(grace.session), await openWorkspaceSocket(hopper)];
    await settle(ada, grace);
    await delivered(room);

    await evictDurableObject(roomStub(room));
    await post(ada, "after a nap");
    expect(await heard(hoppersTab, room)).toEqual([unread(room)]);
    expect(await heard(gracesTab, room)).toEqual([]);
  });
});

describe("Unread DMs", () => {
  /** The `room.unread` frames `socket` has heard once the Workspace has applied everything room `room` has logged. */
  const marksHeard = async (socket: WorkspaceSocket, room: RoomId) => (await heard(socket, room)).filter((frame) => frame.type === "room.unread" || frame.type === "room.read");

  it("counts each message in a DM for the people in it who aren't viewing it, telling them each time, until they read it", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const { id: room } = await direct(ada, grace);
    const adas = await connect(room, ada, { visible: true });
    const gracesTab = await openWorkspaceSocket(grace);

    const first = await post(adas, "one");
    expect(await marksHeard(gracesTab, room)).toEqual([{ type: "room.unread", roomId: room, at: first.createdAt, count: 1 }]);
    await post(adas, "two");
    expect(await marksHeard(gracesTab, room)).toEqual([{ type: "room.unread", roomId: room, at: first.createdAt, count: 2 }]);
    const listed = async () => (await (await api("/api/sidebar", { headers: { Cookie: grace.cookie } })).json() as Sidebar).rooms.find(({ id }) => id === room);
    expect(await listed()).toMatchObject({ unread: true, unreadSince: first.createdAt, unreadCount: 2 });

    // Reading it starts the count over.
    const reading = await connect(room, grace, { visible: true });
    await settle(reading);
    expect(await marksHeard(gracesTab, room)).toEqual([read(room)]);
    expect(await listed()).not.toHaveProperty("unreadCount");
    reading.close();
    await adas.next("presence.left");
    const third = await post(adas, "three");
    expect(await marksHeard(gracesTab, room)).toEqual([{ type: "room.unread", roomId: room, at: third.createdAt, count: 1 }]);
  });

  it("counts every message one call brings, and none applied before", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const { id: room } = await direct(ada, grace);
    const tab = await openWorkspaceSocket(grace);
    const now = Date.now();
    const event = (seq: number): RoomEvent => ({ seq, kind: "message", userId: ada.user.id, at: new Date(now + seq * 1_000).toISOString() });
    await workspaceStub().applyRoomEvents(room, [event(1), event(2), event(3)], []);
    await workspaceStub().applyRoomEvents(room, [event(2), event(3)], []);
    expect(await workspaceSql("SELECT unread_at, unread_count FROM memberships WHERE room_id = ? AND user_id = ?", room, grace.user.id)).toEqual([
      { unread_at: event(1).at, unread_count: 3 },
    ]);
    expect(await tab.next()).toEqual({ type: "room.unread", roomId: room, at: event(1).at, count: 3 });
  });

  it("doesn't count a room's messages, which mark it once", async () => {
    const room = await freshRoom("uncounted");
    const ada = await connect(room, "Ada", { visible: true });
    const hopper = await signIn("Hopper");
    const tab = await openWorkspaceSocket(hopper);
    const first = await post(ada, "first");
    await post(ada, "second");
    expect(await heard(tab, room)).toEqual([unread(room, first.createdAt)]);
    const { rooms } = (await (await api("/api/sidebar", { headers: { Cookie: hopper.cookie } })).json()) as Sidebar;
    expect(rooms.find(({ id }) => id === room)).not.toHaveProperty("unreadCount");
  });
});

describe("Mentions in an unread room", () => {
  /** How a message mentioning `session`'s person is written. */
  const mention = (session: Session) => `<action-text-attachment sgid="${mentionSgid(session.user.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;

  /** The frame marking room `roomId` unread as of `at`, with `mentions` of its messages mentioning whoever hears it. */
  const mentioned = (roomId: RoomId, at: string, mentions: number): WorkspaceServerFrame => ({ type: "room.unread", roomId, at, mentions });

  /** How many of the messages marking room `room` unread mention each of its members, by name, for those with any. */
  const mentionCounts = async (room: RoomId) =>
    Object.fromEntries(
      (
        (await workspaceSql(
          "SELECT users.name, mention_count FROM memberships JOIN users ON users.id = memberships.user_id WHERE room_id = ? AND mention_count > 0 ORDER BY users.name",
          room,
        )) as Array<{ name: string; mention_count: number }>
      ).map(({ name, mention_count }) => [name, mention_count]),
    );

  /** Room `room` as `session`'s sidebar lists it. */
  const listed = async (session: Session, room: RoomId) => ((await (await api("/api/sidebar", { headers: { Cookie: session.cookie } })).json()) as Sidebar).rooms.find(({ id }) => id === room);

  let seq = 0;
  /** A new message by `author`, as its room's log sends it, mentioning `mentioned` and notifying the room as `notifies` says. */
  const message = (author: Session, mentioned: Session[] = [], notifies?: SpecialMention): RoomEvent => ({
    seq: ++seq,
    kind: "message",
    userId: author.user.id,
    at: new Date().toISOString(),
    message: { id: crypto.randomUUID(), plainText: "Lunch?", mentionIds: mentioned.map(({ user }) => user.id), ...(notifies && { notifies }) },
  });

  it("counts each message that mentions someone in a room they aren't viewing, telling each of their tabs, until they read it", async () => {
    const room = await freshRoom("mentions");
    const ada = await connect(room, "Ada", { visible: true });
    const hopper = await signIn("Hopper");
    const [laptop, phone] = [await openWorkspaceSocket(hopper), await openWorkspaceSocket(hopper)];

    const first = await post(ada, "Standup soon");
    expect(await heard(laptop, room)).toEqual([unread(room, first.createdAt)]);
    await post(ada, `<p>Ready, ${mention(hopper)}?</p>`);
    expect(await heard(laptop, room)).toEqual([mentioned(room, first.createdAt, 1)]);
    await post(ada, `<p>${mention(hopper)}, now</p>`);
    expect(await heard(laptop, room)).toEqual([mentioned(room, first.createdAt, 2)]);
    // A message that mentions nobody changes neither the mark nor its count.
    await post(ada, "Starting");
    expect(await heard(laptop, room)).toEqual([]);
    expect(await heard(phone, room)).toEqual([unread(room, first.createdAt), mentioned(room, first.createdAt, 1), mentioned(room, first.createdAt, 2)]);
    expect(await listed(hopper, room)).toMatchObject({ unread: true, unreadSince: first.createdAt, mentionCount: 2 });

    // Opening the room reads it, in his other tabs too, and starts the count over.
    const reading = await connect(room, hopper, { visible: true });
    await settle(reading);
    expect(await heard(laptop, room)).toEqual([read(room)]);
    expect(await heard(phone, room)).toEqual([read(room)]);
    expect(await listed(hopper, room)).not.toHaveProperty("mentionCount");
    expect(await mentionCounts(room)).toEqual({});
  });

  it("counts @channel and @everyone for everyone in the room, and @here for those whose tabs are in use, at Nothing too, but for those viewing it, its author, and those who hid it or blocked its author", async () => {
    const room = await freshRoom("Designers");
    const [ada, grace, lin, hopper, joan, kay, max] = [await signIn("Ada"), await signIn("Grace"), await signIn("Lin"), await signIn("Hopper"), await signIn("Joan"), await signIn("Kay"), await signIn("Max")];
    await workspaceSql("UPDATE memberships SET involvement = 'nothing' WHERE room_id = ? AND user_id = ?", room, kay.user.id);
    await workspaceSql("UPDATE memberships SET involvement = 'invisible' WHERE room_id = ? AND user_id = ?", room, max.user.id);
    expect((await api(`/api/users/${ada.user.id}/block`, { method: "POST", headers: { Cookie: hopper.cookie } })).status).toBe(200);
    // Grace's tab is in use, and Lin's says it isn't.
    await openWorkspaceSocket(grace);
    const linsTab = await openWorkspaceSocket(lin);
    linsTab.send(JSON.stringify({ type: "presence.active", active: false }));
    while ((await linsTab.next()).type !== "presence");
    const apply = (event: RoomEvent) => workspaceStub().applyRoomEvents(room, [event], [joan.user.id]);

    await apply(message(ada, [], "channel"));
    expect(await mentionCounts(room)).toEqual({ Grace: 1, Host: 1, Kay: 1, Lin: 1 });
    await apply(message(ada, [lin], "here"));
    expect(await mentionCounts(room)).toEqual({ Grace: 2, Host: 1, Kay: 1, Lin: 2 });
    await apply(message(ada, [], "everyone"));
    expect(await mentionCounts(room)).toEqual({ Grace: 3, Host: 2, Kay: 2, Lin: 3 });
    // Joan, viewing it, Max, who hid it, and Hopper, who blocked Ada, have no mark to count on.
    expect(await marked(room)).toEqual(["Grace", "Host", "Kay", "Lin"]);
  });

  it("counts nothing for a reply sent only to its thread, which marks no room, nor in a DM, which counts all its messages", async () => {
    const room = await freshRoom("threads");
    const [ada, hopper] = [await signIn("Ada"), await signIn("Hopper")];
    await workspaceStub().applyRoomEvents(room, [{ ...message(ada, [hopper], "channel"), threadOnly: true }], []);
    expect(await mentionCounts(room)).toEqual({});
    expect(await marked(room)).toEqual([]);

    const { id: dm } = await direct(ada, hopper);
    await workspaceStub().applyRoomEvents(dm, [message(ada, [hopper])], []);
    expect(await workspaceSql("SELECT unread_count, mention_count FROM memberships WHERE room_id = ? AND user_id = ?", dm, hopper.user.id)).toEqual([{ unread_count: 1, mention_count: 0 }]);
  });

  it("counts each message once, however often the room sends it", async () => {
    const room = await freshRoom("again");
    const [ada, hopper] = [await signIn("Ada"), await signIn("Hopper")];
    const tab = await openWorkspaceSocket(hopper);
    const [first, second] = [message(ada, [hopper]), message(ada, [], "channel")];
    await workspaceStub().applyRoomEvents(room, [first, second], []);
    await workspaceStub().applyRoomEvents(room, [second], []);
    expect(await mentionCounts(room)).toMatchObject({ Hopper: 2 });
    // One call's messages tell of the mark they leave, once.
    expect(await tab.next()).toEqual(mentioned(room, first.at, 2));
  });

  it("finds the members a mention counts for through the memberships' key", async () => {
    const room = await freshRoom("plans");
    await connect(room, "Ada");
    const plan = async (query: string, ...params: Array<string | number>) =>
      ((await workspaceSql(`EXPLAIN QUERY PLAN ${query}`, ...params)) as Array<{ detail: string }>).map(({ detail }) => detail).join("; ");
    const byRoom = /memberships USING (INDEX sqlite_autoindex_memberships_1|PRIMARY KEY) \(room_id=\?/;
    expect(await plan(COUNT_ROOM_MENTION, room, "someone", "[]", 1, "2026-10-14T12:00:00.000Z")).toMatch(byRoom);
    expect(await plan(COUNT_MENTIONS, room, "someone", "[]", 1, '["someone else"]', "2026-10-14T12:00:00.000Z")).toMatch(byRoom);
  });
});
