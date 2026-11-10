import { MAX_PUSH_SUBSCRIPTIONS, type Involvement, type NewWorkspace, type RoomId } from "@ember/protocol";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNDELIVERED_EVENTS, type RoomEvent } from "../src/room-log";
import type { Workspace } from "../src/workspace";
import { MESSAGE_PUSHES, type MessagePush, type WorkspaceStore } from "../src/workspace-store";
import {
  api,
  connect,
  cookieOf,
  createRoom,
  cutOff,
  direct,
  freshDeploy,
  freshRoom,
  post,
  pushBrowser,
  recordedImage,
  roomSql,
  roomStub,
  shown,
  signIn,
  upload,
  withWorkspaceEnv,
  workspaceSql,
  workspaceStub,
  type PushBrowser,
  type Session,
} from "./support";

// Who a new message is pushed to, and what it says. web-push.test.ts checks how each push is sent.

/** Saves a subscription for `session` at Chrome's push service, at `/fcm/send/<label>`, for `browser`'s keys. */
async function subscribe(session: Session, label: string, browser?: PushBrowser): Promise<string> {
  const { p256dh, auth } = browser ?? (await pushBrowser());
  const endpoint = `https://fcm.googleapis.com/fcm/send/${label}`;
  const response = await api("/api/push-subscriptions", { method: "POST", headers: { Cookie: session.cookie }, body: JSON.stringify({ endpoint, p256dhKey: p256dh, authKey: auth }) });
  expect(response.status, await response.clone().text()).toBe(204);
  return endpoint;
}

/** Gives `session`'s person `involvement` in room `roomId`, as their bell does. */
async function involve(session: Session, roomId: RoomId, involvement: Involvement): Promise<void> {
  const response = await api(`/api/rooms/${roomId}/involvement`, { method: "PUT", headers: { Cookie: session.cookie }, body: JSON.stringify({ involvement }) });
  expect(response.status).toBe(200);
}

/** Signs in as each of `names`, in turn. */
async function people<Names extends string[]>(...names: Names): Promise<{ [K in keyof Names]: Session }> {
  const sessions: Session[] = [];
  for (const name of names) sessions.push(await signIn(name));
  return sessions as { [K in keyof Names]: Session };
}

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Bans `session`'s person, or lifts their ban, as `administrator`. */
async function ban(administrator: Session, session: Session, method: "POST" | "DELETE" = "POST"): Promise<void> {
  const response = await api(`/api/users/${session.user.id}/ban`, { method, headers: { Cookie: administrator.cookie } });
  expect(response.status).toBe(200);
}

/** How a message mentioning `session`'s person is written. */
const mention = (session: Session) => `<action-text-attachment sgid="${mentionSgid(session.user.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;

/** Each room's events are numbered from where the Workspace has applied them, which starts at 0. */
let seq = 0;

/** A new message by `author`, as its room's log sends it to the Workspace, mentioning `mentioned`. */
const message = (author: Session, text: string, ...mentioned: Session[]): RoomEvent => ({
  seq: ++seq,
  kind: "message",
  userId: author.user.id,
  at: new Date().toISOString(),
  message: { id: crypto.randomUUID(), plainText: text, mentionIds: mentioned.map(({ user }) => user.id) },
});

/** `reader` opening the room, as its room's log sends it to the Workspace. */
const read = (reader: Session): RoomEvent => ({ seq: ++seq, kind: "read", userId: reader.user.id, at: new Date().toISOString() });

/** What the Workspace answers room `room` sending it `events`, with `viewers` viewing the room: the pushes to send. */
const pushesFor = async (room: RoomId, events: RoomEvent[], viewers: Session[] = []): Promise<MessagePush[]> =>
  (await workspaceStub().applyRoomEvents(room, events, viewers.map(({ user }) => user.id))).pushes;

/** Where a message's pushes go, by the labels `subscribe` gave them. */
const labelsOf = (pushes: MessagePush[]) => pushes.flatMap(({ deliveries }) => deliveries.map(({ endpoint }) => endpoint.split("/").at(-1)));

/** How many subscriptions `session`'s person has. */
const subscriptionsOf = async (session: Session) => ((await workspaceSql("SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ?", session.user.id)) as [{ n: number }])[0].n;

/** Stands in for every push service, answering each push with `status`, and keeps what was pushed where, in the order it came. */
function pushServices(status: (endpoint: string) => number = () => 201) {
  const pushed: Array<{ endpoint: string; body: Uint8Array }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const endpoint = input instanceof Request ? input.url : String(input);
    pushed.push({ endpoint, body: init!.body as Uint8Array });
    return new Response(null, { status: status(endpoint) });
  });
  return pushed;
}

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Who gets a push", () => {
  it("pushes a new message to every subscription of its room's members who aren't viewing it: at all messages, then at @mentions if it mentions them", async () => {
    const room = await freshRoom("Designers");
    const [ada, grace, lin, hopper, joan, kay, max] = await people("Ada", "Grace", "Lin", "Hopper", "Joan", "Kay", "Max");
    // Lin subscribes before Grace, and is still pushed after her, at @mentions.
    for (const [session, label] of [[lin, "lin"], [grace, "grace-phone"], [grace, "grace-laptop"], [ada, "ada"], [hopper, "hopper"], [joan, "joan"], [kay, "kay"], [max, "max"]] as const) {
      await subscribe(session, label);
    }
    for (const session of [grace, joan]) await involve(session, room, "everything");
    await involve(kay, room, "nothing");
    await involve(max, room, "invisible");

    const pushes = await pushesFor(room, [message(ada, "Hey @Lin @Kay @Max", lin, kay, max)], [joan]);
    expect(pushes).toHaveLength(1);
    expect(labelsOf(pushes)).toEqual(["grace-phone", "grace-laptop", "lin"]);
  });

  it("pushes nobody a message mentions who isn't in its room", async () => {
    const [ada, grace, nina] = await people("Ada", "Grace", "Nina");
    const { id: room } = await createRoom("Board", { closedTo: [ada.user.id, grace.user.id], as: ada });
    await subscribe(grace, "grace");
    await subscribe(nina, "nina");

    expect(labelsOf(await pushesFor(room, [message(ada, "Hey @Grace @Nina", grace, nina)]))).toEqual(["grace"]);
  });

  it("pushes nothing for a read, nor a message nobody else is subscribed to", async () => {
    const room = await freshRoom("Quiet");
    const [ada, grace] = await people("Ada", "Grace");
    await subscribe(ada, "ada");
    await involve(ada, room, "everything");
    await involve(grace, room, "everything");

    expect(await pushesFor(room, [message(ada, "Anyone?"), read(grace)])).toEqual([]);
  });

  it("stops pushing someone banned, at all messages and at @mentions, though they keep their subscriptions and memberships, until the ban is lifted", async () => {
    for (const involvement of ["everything", "mentions"] as const) {
      await freshDeploy();
      const ada = await setUp();
      const room = await freshRoom("Designers");
      const kevin = await signIn("Kevin");
      await subscribe(kevin, "kevin");
      await involve(kevin, room, involvement);
      expect(labelsOf(await pushesFor(room, [message(ada, "Hey @Kevin", kevin)]))).toEqual(["kevin"]);

      await ban(ada, kevin);
      expect(await pushesFor(room, [message(ada, "Private after ban", kevin)])).toEqual([]);
      expect(await subscriptionsOf(kevin)).toBe(1);
      expect(await workspaceSql("SELECT involvement FROM memberships WHERE room_id = ? AND user_id = ?", room, kevin.user.id)).toEqual([{ involvement }]);

      await ban(ada, kevin, "DELETE");
      expect(labelsOf(await pushesFor(room, [message(ada, "Welcome back @Kevin", kevin)]))).toEqual(["kevin"]);
    }
  });

  it("pushes nobody inactive, should their subscriptions and memberships remain", async () => {
    for (const involvement of ["everything", "mentions"] as const) {
      await freshDeploy();
      const room = await freshRoom("Designers");
      const [ada, kevin] = await people("Ada", "Kevin");
      await subscribe(kevin, "kevin");
      await involve(kevin, room, involvement);
      await workspaceSql("UPDATE users SET status = 1 WHERE id = ?", kevin.user.id);

      expect(await pushesFor(room, [message(ada, "Hey @Kevin", kevin)])).toEqual([]);
    }
  });

  it("pushes each message once, however often its room sends it", async () => {
    const room = await freshRoom("Designers");
    const [ada, grace] = await people("Ada", "Grace");
    await subscribe(grace, "grace");
    await involve(grace, room, "everything");

    const events = [message(ada, "Once"), message(ada, "Twice")];
    expect((await pushesFor(room, events)).map(({ payload }) => payload.body)).toEqual(["Ada: Once", "Ada: Twice"]);
    expect(await pushesFor(room, events)).toEqual([]);
    expect(await pushesFor(room, events.slice(1))).toEqual([]);
  });

  it("pushes a message once to a browser that saved its subscription again with other keys, for those keys", async () => {
    const room = await freshRoom("Designers");
    const [ada, grace] = await people("Ada", "Grace");
    await involve(grace, room, "everything");
    const browser = await pushBrowser();
    const laptop = await subscribe(grace, "laptop");
    await subscribe(grace, "laptop", browser);

    const [push] = await pushesFor(room, [message(ada, "Hi")]);
    expect(push!.deliveries).toEqual([expect.objectContaining({ endpoint: laptop, p256dhKey: browser.p256dh, authKey: browser.auth })]);
  });

  it(`pushes a message to the ${MAX_PUSH_SUBSCRIPTIONS} browsers each person saved most recently, and no more, where Campfire pushes to every one`, async () => {
    const room = await freshRoom("Designers");
    const [ada, grace] = await people("Ada", "Grace");
    await involve(grace, room, "everything");
    const browser = await pushBrowser();
    const labels = Array.from({ length: MAX_PUSH_SUBSCRIPTIONS + 1 }, (_, i) => `browser-${i}`);
    for (const label of labels) await subscribe(grace, label, browser);

    expect(labelsOf(await pushesFor(room, [message(ada, "Hi")]))).toEqual(labels.slice(1));
    expect(await subscriptionsOf(grace)).toBe(MAX_PUSH_SUBSCRIPTIONS);
  });

  it("pushes nothing while Web Push is off, though messages still mark rooms unread", async () => {
    const room = await freshRoom("Designers");
    const [ada, grace] = await people("Ada", "Grace");
    await subscribe(grace, "grace");
    await involve(grace, room, "everything");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await withWorkspaceEnv({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined }, async () => {
      expect(await pushesFor(room, [message(ada, "Off")])).toEqual([]);
      expect(await workspaceSql("SELECT unread_at IS NOT NULL AS unread FROM memberships WHERE room_id = ? AND user_id = ?", room, grace.user.id)).toEqual([{ unread: 1 }]);
    });
  });

  it("pushes nobody who signed in with just a name while EMBER_GUEST_SIGN_IN doesn't let them stay signed in, though they keep their subscriptions", async () => {
    const ada = await setUp();
    const room = await freshRoom("Designers");
    const [grace, lin] = await people("Grace", "Lin");
    for (const [session, label] of [[ada, "ada"], [grace, "grace"]] as const) {
      await subscribe(session, label);
      await involve(session, room, "everything");
    }

    await withWorkspaceEnv({ EMBER_GUEST_SIGN_IN: undefined }, async () => {
      expect(labelsOf(await pushesFor(room, [message(lin, "Hey @Grace", grace)]))).toEqual(["ada"]);
    });
    expect(await subscriptionsOf(grace)).toBe(1);
    expect(labelsOf(await pushesFor(room, [message(lin, "Back")]))).toEqual(["ada", "grace"]);
  });

  it("finds a message's pushes through the memberships', people's and subscriptions' keys, and its text by the message's", async () => {
    const room = await freshRoom("plans");
    // Which makes the room's tables, on Durable Object SQLite.
    await connect(room, "Ada");
    const details = async (rows: Promise<unknown[]>) => (await rows).map((row) => (row as { detail: string }).detail).join("; ");

    const pushes = await details(workspaceSql(`EXPLAIN QUERY PLAN ${MESSAGE_PUSHES}`, room, "someone", "[]", "[]", 1, 1, 1, "[]"));
    expect(pushes).toContain("index_push_subscriptions_on_user_id_and_endpoint (user_id=?)");
    expect(pushes).toContain("SEARCH marked USING INDEX index_memberships_on_user_id_and_room_id (user_id=?)");
    expect(pushes).not.toMatch(/SCAN (rooms|memberships|users|push_subscriptions|marked|authors)\b/);
    const undelivered = await details(roomSql(room, `EXPLAIN QUERY PLAN ${UNDELIVERED_EVENTS}`, room, 50));
    expect(undelivered).not.toMatch(/SCAN|TEMP B-TREE/);
  });

  it("never numbers a subscription as one deleted before it, so a push service answering late that that one is gone can't forget it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const [grace, lin] = await people("Grace", "Lin");
    const gone = await subscribe(grace, "gone");
    const [{ id }] = (await workspaceSql("SELECT id FROM push_subscriptions WHERE endpoint = ?", gone)) as [{ id: number }];
    expect((await api(`/api/push-subscriptions/${id}`, { method: "DELETE", headers: { Cookie: grace.cookie } })).status).toBe(204);
    await subscribe(lin, "lin");

    await workspaceStub().forgetPushSubscriptions([id]);
    expect(await workspaceSql("SELECT id > ? AS later, endpoint FROM push_subscriptions", id)).toEqual([{ later: 1, endpoint: "https://fcm.googleapis.com/fcm/send/lin" }]);
  });
});

describe("What a push says", () => {
  it("titles a room's push with its name and a DM's with its sender's, reading the message's plain text, and opens the room", async () => {
    const [ada, grace] = await people("Ada", "Grace");
    const { id: room } = await createRoom("Designers", { as: ada });
    await subscribe(grace, "grace");
    await involve(grace, room, "everything");
    const dm = await direct(ada, grace);

    expect((await pushesFor(room, [message(ada, "Hi")]))[0]!.payload).toEqual({ title: "Designers", body: "Ada: Hi", path: `/rooms/${room}` });
    expect((await pushesFor(dm.id, [message(ada, "Hi")]))[0]!.payload).toEqual({ title: "Ada", body: "Hi", path: `/rooms/${dm.id}` });
  });

  it("counts in each push's badge its owner's conversations marked unread, hidden rooms and DMs included, as they are after its message", async () => {
    const [ada, grace] = await people("Ada", "Grace");
    const { id: room } = await createRoom("Designers", { as: ada });
    const { id: hidden } = await createRoom("Hidden", { as: ada });
    const { id: opened } = await createRoom("Opened", { as: ada });
    const dm = await direct(ada, grace);
    await subscribe(grace, "grace");
    await involve(grace, room, "everything");
    await pushesFor(hidden, [message(ada, "Before hiding")]);
    await involve(grace, hidden, "invisible");
    await pushesFor(dm.id, [message(ada, "In the DM")]);
    await pushesFor(opened, [message(ada, "Read straight away"), read(grace)]);

    // Grace opens the room right after the message, which the push's badge doesn't count.
    const pushes = await pushesFor(room, [message(ada, "Hi"), read(grace)]);
    expect(pushes[0]!.deliveries.map(({ badge }) => badge)).toEqual([3]);
  });
});

describe("Who gets a push", () => {
  describe("through the room", () => {
    /** Waits until room `room` has nothing left in its log, which it forgets once the Workspace has applied it. */
    const delivered = (room: RoomId) =>
      vi.waitFor(async () => expect(await roomSql(room, "SELECT seq FROM room_events WHERE room_id = ?", room)).toEqual([]), { timeout: 5_000 });

    /** When room `room`'s alarm is set for, if it is. */
    const alarmOf = (room: RoomId) => runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => state.storage.getAlarm());

    it("sends a new message's pushes as the room tells the Workspace of it, each encrypted for its browser", async () => {
      const pushed = pushServices();
      const room = await freshRoom("Designers");
      const [grace, lin] = await people("Grace", "Lin");
      const [gracesBrowser, linsBrowser] = [await pushBrowser(), await pushBrowser()];
      await subscribe(grace, "grace", gracesBrowser);
      await subscribe(lin, "lin", linsBrowser);
      await involve(grace, room, "everything");
      const ada = await connect(room, "Ada", { visible: true });

      await post(ada, `<p>Hi ${mention(lin)}</p>`);
      await vi.waitFor(() => expect(pushed).toHaveLength(2), { timeout: 5_000 });
      const opened = async (label: string, browser: PushBrowser) => JSON.parse(await browser.open(pushed.find(({ endpoint }) => endpoint.endsWith(`/${label}`))!.body));
      const shownAs = { title: "Designers", options: { body: "Ada: Hi @Lin", icon: "/account/logo", data: { path: `/rooms/${room}`, badge: 1 } } };
      expect(await opened("grace", gracesBrowser)).toEqual(shownAs);
      expect(await opened("lin", linsBrowser)).toEqual(shownAs);
    });

    it("pushes a file message as its sender and its file's name, and marks its room unread, as any new message", async () => {
      const pushed = pushServices();
      const room = await freshRoom("Designers");
      const [ada, grace] = await people("Ada", "Grace");
      const browser = await pushBrowser();
      await subscribe(grace, "grace", browser);
      await involve(grace, room, "everything");

      await upload(ada, room, "moon.jpg", recordedImage("moon-thumb.jpg"));
      await vi.waitFor(() => expect(pushed).toHaveLength(1), { timeout: 5_000 });
      expect(JSON.parse(await browser.open(pushed[0]!.body))).toMatchObject({ title: "Designers", options: { body: "Ada: moon.jpg" } });
      expect(await workspaceSql("SELECT unread_at IS NOT NULL AS unread FROM memberships WHERE room_id = ? AND user_id = ?", room, grace.user.id)).toEqual([{ unread: 1 }]);
    });

    it("pushes a message as it is when the room tells the Workspace of it, and nothing for one deleted by then, nor for edits and deletions", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const pushed = pushServices();
      const room = await freshRoom("Designers");
      const [grace] = await people("Grace");
      const browser = await pushBrowser();
      await subscribe(grace, "grace", browser);
      await involve(grace, room, "everything");
      const ada = await connect(room, "Ada", { visible: true });
      const bodies = () => Promise.all(pushed.map(async ({ body }) => (JSON.parse(await browser.open(body)) as { options: { body: string } }).options.body));
      const change = async (frame: { type: "message.update"; messageId: string; body: string } | { type: "message.delete"; messageId: string }) => {
        ada.send(frame);
        await ada.next(frame.type === "message.update" ? "message.updated" : "message.deleted");
      };

      const reconnect = await cutOff(room);
      const deleted = await post(ada, "<p>Oops</p>");
      await change({ type: "message.delete", messageId: deleted.id });
      const edited = await post(ada, "<p>Draft</p>");
      await change({ type: "message.update", messageId: edited.id, body: "<p>Final</p>" });
      await vi.waitFor(async () => expect(await alarmOf(room)).not.toBeNull(), { timeout: 5_000 });
      await reconnect();
      await runDurableObjectAlarm(roomStub(room));
      await delivered(room);
      await vi.waitFor(async () => expect(await bodies()).toEqual(["Ada: Final"]), { timeout: 5_000 });

      await change({ type: "message.update", messageId: edited.id, body: "<p>Edited again</p>" });
      await change({ type: "message.delete", messageId: edited.id });
      await post(ada, "<p>Last</p>");
      await vi.waitFor(async () => expect(await bodies()).toEqual(["Ada: Final", "Ada: Last"]), { timeout: 5_000 });
    });

    it("asks again whether a push may go once its turn comes, sending none to someone banned meanwhile, and keeps their subscription for when the ban is lifted", async () => {
      const pushed = pushServices();
      const ada = await setUp();
      const room = await freshRoom("Designers");
      const [kevin] = await people("Kevin");
      const browser = await pushBrowser();
      await subscribe(kevin, "kevin", browser);
      await involve(kevin, room, "everything");
      const adaThere = await connect(room, ada, { visible: true });
      // The Workspace answers whether Kevin's push may go once the test lets it.
      let asked = false;
      const answers: boolean[] = [];
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
        const store = (workspace as unknown as { store: WorkspaceStore }).store;
        const pushable = store.pushable.bind(store);
        store.pushable = async (id) => {
          store.pushable = pushable;
          asked = true;
          await released;
          answers.push(await pushable(id));
          return answers.at(-1)!;
        };
      });

      await post(adaThere, "<p>Before the ban</p>");
      await vi.waitFor(() => expect(asked).toBe(true), { timeout: 5_000 });
      await ban(ada, kevin);
      release();
      await vi.waitFor(() => expect(answers).toEqual([false]), { timeout: 5_000 });
      expect(pushed).toEqual([]);
      expect(await subscriptionsOf(kevin)).toBe(1);

      await ban(ada, kevin, "DELETE");
      await post(adaThere, "<p>After the ban</p>");
      await vi.waitFor(() => expect(pushed).toHaveLength(1), { timeout: 5_000 });
      expect(JSON.parse(await browser.open(pushed[0]!.body))).toMatchObject({ options: { body: "Ada: After the ban" } });
    });

    it("forgets a subscription its push service says is gone, and keeps one it couldn't reach", async () => {
      const logs = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const pushed = pushServices((endpoint) => (endpoint.endsWith("/gone") ? 410 : 503));
      const room = await freshRoom("Designers");
      const [grace] = await people("Grace");
      const gone = await subscribe(grace, "gone");
      await subscribe(grace, "busy");
      await involve(grace, room, "everything");
      const ada = await connect(room, "Ada", { visible: true });
      const [{ id }] = (await workspaceSql("SELECT id FROM push_subscriptions WHERE endpoint = ?", gone)) as [{ id: number }];

      await post(ada, "<p>Hi</p>");
      await vi.waitFor(async () => expect(await workspaceSql("SELECT endpoint FROM push_subscriptions")).toEqual([{ endpoint: "https://fcm.googleapis.com/fcm/send/busy" }]), {
        timeout: 5_000,
      });
      expect(pushed).toHaveLength(2);
      expect(logs).toHaveBeenCalledWith(`Destroying push subscription: ${id}`);
    });
  });
});
