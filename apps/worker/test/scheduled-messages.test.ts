import {
  MAX_SCHEDULED_MESSAGES,
  SCHEDULE_AHEAD_MS,
  SCHEDULE_TIME_REFUSED,
  SCHEDULED_GONE,
  THREAD_DELETED,
  TOO_MANY_SCHEDULED,
  type Message,
  type RoomId,
  type ScheduledMessage,
} from "@ember/protocol";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY, MESSAGE_GONE, type ChatRoom } from "../src/chat-room";
import type { Env } from "../src/env";
import { AUTHORIZATION_TTL_MS } from "../src/revocations";
import { SCHEDULED_SENT_AT_ONCE, type ScheduledMessages } from "../src/scheduled-messages";
import { api, connect, createRoom, freshDeploy, freshRoom, post, reconnect, roomSql, roomStub, settle, signIn, workspaceSql, type Socket } from "./support";

// Slack's Schedule for later: a message the room keeps for its writer alone, and sends as theirs once
// it's due, if they're in the room still, which they can edit, move, send now or delete until then.

const MINUTE = 60_000;

/** A time `ms` from now, as a frame names one. */
const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();

/** The next list of what `client`'s person has scheduled that `client` hears. */
const listed = async (client: Socket): Promise<ScheduledMessage[]> => (await client.next("scheduled")).messages;

/** Schedules `body` as `client` for `sendAt`, as a reply if `thread` says so, and waits for the room to list it. */
async function schedule(client: Socket, body: string, sendAt = fromNow(MINUTE), thread: { parentId?: string; alsoSend?: boolean } = {}): Promise<ScheduledMessage> {
  const clientMessageId = crypto.randomUUID();
  client.send({ type: "message.schedule", clientMessageId, body, sendAt, ...thread });
  for (;;) {
    const scheduled = (await listed(client)).find((message) => message.clientMessageId === clientMessageId);
    if (scheduled) return scheduled;
  }
}

/** Has every message scheduled in `room` that can be sent come due, as if its time had come. */
const comeDue = (room: RoomId) => roomSql(room, "UPDATE scheduled_messages SET send_at = ? WHERE room_id = ?", fromNow(-1000), room);

/** What room `room` keeps scheduled, by its text. */
const kept = async (room: RoomId) => ((await roomSql(room, "SELECT body FROM scheduled_messages WHERE room_id = ? ORDER BY send_at", room)) as Array<{ body: string }>).map(({ body }) => body);

/** When room `room`'s alarm is set for, if it is. */
const alarmOf = (room: RoomId) => runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => state.storage.getAlarm());

/** The next message `client` hears of that has `clientMessageId`. */
async function created(client: Socket, clientMessageId: string): Promise<Message> {
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.clientMessageId === clientMessageId) return message;
  }
}

/** The error `client` hears next. */
const refusal = (client: Socket) => client.next("error");

/** Who room `room` is marked unread for, by name. */
async function marked(room: RoomId): Promise<string[]> {
  const rows = await workspaceSql("SELECT users.name FROM memberships JOIN users ON users.id = memberships.user_id WHERE room_id = ? AND unread_at IS NOT NULL ORDER BY users.name", room);
  return rows.map((row) => (row as { name: string }).name);
}

/** How many due messages room `room`'s alarm finds each time it looks, from now on. */
async function batchesOf(room: RoomId): Promise<number[]> {
  const batches: number[] = [];
  await runInDurableObject(roomStub(room), (instance: ChatRoom) => {
    const scheduled = (instance as unknown as { scheduledFor(room: RoomId): ScheduledMessages }).scheduledFor(room);
    const due = scheduled.due.bind(scheduled);
    scheduled.due = async (now) => {
      const found = await due(now);
      batches.push(found.length);
      return found;
    };
  });
  return batches;
}

/**
 * Has room `room` hear the Workspace say whether a scheduled message's writer is in it as `answer` has it,
 * given what it would say, until the function this answers is called. Everything else it asks the
 * Workspace goes as before.
 */
async function answeringWhoIsIn(room: RoomId, answer: (asIs: () => Promise<unknown>) => Promise<unknown>): Promise<() => Promise<void>> {
  let original: Env | undefined;
  await runInDurableObject(roomStub(room), (instance: ChatRoom) => {
    const object = instance as unknown as { env: Env };
    original = object.env;
    const { WORKSPACE } = original;
    const answering = (stub: object) =>
      new Proxy(stub, {
        get: (target, key) => {
          const asked = (target as Record<PropertyKey, unknown>)[key];
          return key === "scheduledWriter" ? (...args: unknown[]) => answer(() => Reflect.apply(asked as (...args: unknown[]) => Promise<unknown>, target, args)) : asked;
        },
      });
    object.env = { ...original, WORKSPACE: { getByName: (name: string) => answering(WORKSPACE.getByName(name)) } as unknown as Env["WORKSPACE"] };
  });
  return () =>
    runInDurableObject(roomStub(room), (instance: ChatRoom) => {
      (instance as unknown as { env: Env }).env = original!;
    });
}

/** Has room `room` find the Workspace unable to say who's in it, as while it restarts, until the function this answers is called. */
const unsureWhoIsIn = (room: RoomId) => answeringWhoIsIn(room, () => Promise.reject(new Error("The Workspace is restarting")));

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Schedule a message", () => {
  it("keeps it for its writer alone, telling their tabs, and sends it as theirs once it's due, as if they'd sent it then", async () => {
    const room = await freshRoom("later");
    const ada = await connect(room, "Ada");
    const adasOtherTab = await connect(room, ada.session);
    const grace = await connect(room, "Grace");

    const sendAt = fromNow(MINUTE);
    const scheduled = await schedule(ada, "<p>Standup in five</p>", sendAt);
    expect(scheduled).toEqual({ id: expect.any(String), clientMessageId: scheduled.clientMessageId, body: "<p>Standup in five</p>", sendAt });
    expect(await listed(adasOtherTab)).toEqual([scheduled]);
    await settle(grace);
    expect(grace.pending("scheduled")).toEqual([]);
    expect(grace.pending("message.created")).toEqual([]);
    // The alarm comes for it.
    expect(await alarmOf(room)).toBeLessThanOrEqual(Date.parse(sendAt));

    await comeDue(room);
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    for (const client of [ada, adasOtherTab, grace]) {
      expect(await created(client, scheduled.clientMessageId)).toMatchObject({ body: "<p>Standup in five</p>", plainText: "Standup in five", creator: { id: ada.me.id, name: "Ada" } });
    }
    expect(await listed(ada)).toEqual([]);
    expect(await listed(adasOtherTab)).toEqual([]);
    expect(await kept(room)).toEqual([]);
    // It marks the room unread for whoever isn't looking at it, as any message does, but its writer.
    await vi.waitFor(async () => expect(await marked(room)).toContain("Host"));
    expect(await marked(room)).not.toContain("Ada");
    await settle(grace);
    expect(grace.pending("scheduled")).toEqual([]);
  });

  it("lists what its person has scheduled in a socket's welcome, and in what it resumes, soonest first", async () => {
    const room = await freshRoom("lists");
    const ada = await connect(room, "Ada");
    const later = await schedule(ada, "<p>Later</p>", fromNow(2 * MINUTE));
    const sooner = await schedule(ada, "<p>Sooner</p>", fromNow(MINUTE));

    expect((await connect(room, ada.session)).welcome.scheduled).toEqual([sooner, later]);
    expect((await connect(room, "Grace")).welcome.scheduled).toBeUndefined();
    const { opening } = await reconnect(room, ada.session, ada.welcome.seq);
    expect(opening).toMatchObject({ type: "resumed", scheduled: [sooner, later] });
  });

  it("sends a scheduled reply in its thread, and to the room too when it says so", async () => {
    const room = await freshRoom("replies");
    const ada = await connect(room, "Ada");
    const parent = await post(ada, "<p>Ship it Friday?</p>");
    const reply = await schedule(ada, "<p>Yes, first thing</p>", fromNow(MINUTE), { parentId: parent.id, alsoSend: true });
    expect(reply).toMatchObject({ parentId: parent.id, alsoSend: true });

    await comeDue(room);
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    expect(await created(ada, reply.clientMessageId)).toMatchObject({ parentId: parent.id, alsoSent: true, parentText: "Ship it Friday?" });
    expect((await ada.next("message.updated")).message).toMatchObject({ id: parent.id, thread: { count: 1 } });
  });

  it("refuses a time past or over 120 days ahead, an empty message, a reply in a thread the room doesn't have, and more than 30", async () => {
    const room = await freshRoom("refusals");
    const ada = await connect(room, "Ada");
    const refusedFor = async (frame: Record<string, unknown>) => {
      ada.send({ type: "message.schedule", clientMessageId: "refused", body: "<p>Hi</p>", sendAt: fromNow(MINUTE), ...frame });
      return refusal(ada);
    };
    for (const sendAt of [fromNow(-1000), fromNow(SCHEDULE_AHEAD_MS + MINUTE)]) {
      expect(await refusedFor({ sendAt })).toEqual({ type: "error", message: SCHEDULE_TIME_REFUSED, clientMessageId: "refused", failed: "message.schedule" });
    }
    expect((await refusedFor({ body: "<p> </p>" })).message).toBe(EMPTY);
    const parent = await post(ada, "<p>Hi</p>");
    ada.send({ type: "message.create", clientMessageId: "answer", body: "<p>Hello</p>", parentId: parent.id });
    const answer = await created(ada, "answer");
    // A reply has no thread of its own.
    for (const parentId of ["nothing-here", answer.id]) expect((await refusedFor({ parentId })).message).toBe(MESSAGE_GONE);

    for (let n = 0; n < MAX_SCHEDULED_MESSAGES; n++) await schedule(ada, `<p>Number ${n}</p>`);
    expect(await refusedFor({})).toEqual({ type: "error", message: TOO_MANY_SCHEDULED, clientMessageId: "refused", failed: "message.schedule" });
    // Someone else's count is their own.
    const grace = await connect(room, "Grace");
    expect(await schedule(grace, "<p>Mine</p>")).toMatchObject({ body: "<p>Mine</p>" });
    expect(await kept(room)).toHaveLength(MAX_SCHEDULED_MESSAGES + 1);
  });

  it("keeps a message scheduled twice, as by a frame sent again, once", async () => {
    const room = await freshRoom("twice");
    const ada = await connect(room, "Ada");
    const frame = { type: "message.schedule", clientMessageId: "once", body: "<p>Once</p>", sendAt: fromNow(MINUTE) } as const;
    ada.send(frame);
    ada.send(frame);
    expect(await listed(ada)).toHaveLength(1);
    expect(await listed(ada)).toHaveLength(1);
    expect(await kept(room)).toEqual(["<p>Once</p>"]);
  });
});

describe("Change a scheduled message", () => {
  it("edits it, keeping its time, moves it, sends it now and deletes it, telling its writer's tabs", async () => {
    const room = await freshRoom("changes");
    const adaSignedIn = await signIn("Ada");
    const ada = await connect(room, adaSignedIn);
    const grace = await connect(room, "Grace");
    const scheduled = await schedule(ada, "<p>Draft</p>");
    const adaElsewhere = await connect(room, adaSignedIn);

    ada.send({ type: "scheduled.edit", scheduledId: scheduled.id, body: "<p>Final</p>" });
    // The tab that asked hears which it edited, which it takes as the edit gone through.
    expect(await ada.next("scheduled")).toEqual({ type: "scheduled", messages: [{ ...scheduled, body: "<p>Final</p>" }], edited: scheduled.id });
    expect(await adaElsewhere.next("scheduled")).toEqual({ type: "scheduled", messages: [{ ...scheduled, body: "<p>Final</p>" }] });
    const sendAt = fromNow(10 * MINUTE);
    ada.send({ type: "scheduled.reschedule", scheduledId: scheduled.id, sendAt });
    // Only an edit's answer names the message, so a move isn't taken for the answer to an edit of it.
    expect(await ada.next("scheduled")).toEqual({ type: "scheduled", messages: [{ ...scheduled, body: "<p>Final</p>", sendAt }] });

    ada.send({ type: "scheduled.send", scheduledId: scheduled.id });
    for (const client of [ada, grace]) expect(await created(client, scheduled.clientMessageId)).toMatchObject({ body: "<p>Final</p>", creator: { id: ada.me.id } });
    expect(await listed(ada)).toEqual([]);

    const another = await schedule(ada, "<p>Never mind</p>");
    ada.send({ type: "scheduled.delete", scheduledId: another.id });
    expect(await listed(ada)).toEqual([]);
    expect(await kept(room)).toEqual([]);
    await settle(grace);
    expect(grace.pending("message.created")).toEqual([]);
  });

  it("lets nobody but its writer change it, answering as if it had gone, and refuses an edit that leaves it empty, or a time it can't keep", async () => {
    const room = await freshRoom("theirs");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const scheduled = await schedule(ada, "<p>Ada's</p>");

    const changes = [
      { type: "scheduled.edit", scheduledId: scheduled.id, body: "<p>Grace's</p>" },
      { type: "scheduled.reschedule", scheduledId: scheduled.id, sendAt: fromNow(5 * MINUTE) },
      { type: "scheduled.send", scheduledId: scheduled.id },
      { type: "scheduled.delete", scheduledId: scheduled.id },
    ] as const;
    for (const change of changes) {
      grace.send(change);
      expect(await refusal(grace)).toEqual({ type: "error", message: SCHEDULED_GONE, scheduledId: scheduled.id, failed: change.type });
      expect(await listed(grace)).toEqual([]);
    }
    expect(await kept(room)).toEqual(["<p>Ada's</p>"]);

    ada.send({ type: "scheduled.edit", scheduledId: scheduled.id, body: "<p></p>" });
    // What she has scheduled, without the one it would have changed, which her tab would take as the edit
    // gone through, then why not, last, so that nothing after it names the message, as the answer to her
    // next edit of it will.
    expect(await ada.next("scheduled")).toEqual({ type: "scheduled", messages: [scheduled] });
    expect(await refusal(ada)).toEqual({ type: "error", message: EMPTY, scheduledId: scheduled.id, failed: "scheduled.edit" });
    const [listing, refused] = [ada.log.findLastIndex((frame) => frame.type === "scheduled"), ada.log.findLastIndex((frame) => frame.type === "error")];
    expect(listing).toBeLessThan(refused);
    ada.send({ type: "scheduled.reschedule", scheduledId: scheduled.id, sendAt: fromNow(-MINUTE) });
    expect((await refusal(ada)).message).toBe(SCHEDULE_TIME_REFUSED);
    expect(await kept(room)).toEqual(["<p>Ada's</p>"]);
    // A message that's gone, sent from another tab, say.
    ada.send({ type: "scheduled.send", scheduledId: "gone" });
    expect(await refusal(ada)).toEqual({ type: "error", message: SCHEDULED_GONE, scheduledId: "gone", failed: "scheduled.send" });
  });
});

describe("Send what's due", () => {
  it("keeps a reply whose thread's message was deleted, saying why, until it's moved, sent or deleted", async () => {
    const room = await freshRoom("unthreaded");
    const ada = await connect(room, "Ada");
    const parent = await post(ada, "<p>Plans?</p>");
    const reply = await schedule(ada, "<p>Tomorrow</p>", fromNow(MINUTE), { parentId: parent.id });
    ada.send({ type: "message.delete", messageId: parent.id });
    await ada.next("message.deleted");

    await comeDue(room);
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    const [failed] = await listed(ada);
    expect(failed).toEqual({ ...reply, sendAt: failed!.sendAt, failure: THREAD_DELETED });
    // It isn't due any more, so the alarm doesn't come back for it.
    expect(await alarmOf(room)).toBeNull();

    ada.send({ type: "scheduled.send", scheduledId: reply.id });
    expect(await refusal(ada)).toEqual({ type: "error", message: THREAD_DELETED, scheduledId: reply.id, failed: "scheduled.send" });
    expect(await listed(ada)).toEqual([failed]);
    const sendAt = fromNow(MINUTE);
    ada.send({ type: "scheduled.reschedule", scheduledId: reply.id, sendAt });
    expect(await listed(ada)).toEqual([{ ...reply, sendAt }]);
  });

  it("forgets a message its writer has left the room by the time it's due, sending nothing", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const adaInRoom = await connect(room.id, ada);
    const graceInRoom = await connect(room.id, grace);
    await schedule(graceInRoom, "<p>Still here?</p>");
    expect((await api(`/api/rooms/${room.id}/membership`, { method: "DELETE", headers: { Cookie: grace.cookie } })).status).toBe(204);

    await comeDue(room.id);
    expect(await runDurableObjectAlarm(roomStub(room.id))).toBe(true);
    expect(await kept(room.id)).toEqual([]);
    await settle(adaInRoom);
    expect(adaInRoom.pending("message.created")).toEqual([]);
  });

  it(`sends ${SCHEDULED_SENT_AT_ONCE} at a time, soonest first, coming straight back for the rest`, async () => {
    const room = await freshRoom("many");
    const ada = await connect(room, "Ada");
    const count = SCHEDULED_SENT_AT_ONCE + 2;
    for (let n = 0; n < count; n++) await schedule(ada, `<p>Number ${n}</p>`, fromNow(MINUTE + n * 1000));
    await roomSql(room, "UPDATE scheduled_messages SET send_at = strftime('%Y-%m-%dT%H:%M:%fZ', send_at, '-1 day') WHERE room_id = ?", room);
    const batches = await batchesOf(room);

    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    const sent: string[] = [];
    while (sent.length < count) sent.push((await ada.next("message.created")).message.plainText);
    expect(sent).toEqual(Array.from({ length: count }, (_, n) => `Number ${n}`));
    // The alarm, set for a time that's past, rings again by itself.
    await vi.waitFor(async () => expect(await kept(room)).toEqual([]));
    expect(batches).toEqual([SCHEDULED_SENT_AT_ONCE, 2]);
  });

  it("tries again a minute later when the Workspace can't say who's in the room, sending each message once", async () => {
    const room = await freshRoom("unsure");
    const ada = await connect(room, "Ada");
    const scheduled = await schedule(ada, "<p>Soon</p>");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const restore = await unsureWhoIsIn(room);

    await comeDue(room);
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    expect(await kept(room)).toEqual(["<p>Soon</p>"]);
    expect(await alarmOf(room)).toBeGreaterThan(Date.now() + MINUTE - 5_000);

    await restore();
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    expect((await created(ada, scheduled.clientMessageId)).body).toBe("<p>Soon</p>");
    expect(await kept(room)).toEqual([]);
    // One posted already, as when an alarm was cut off before it forgot it, isn't posted again.
    const again = await schedule(ada, "<p>Once only</p>");
    await post(ada, "<p>Once only</p>", again.clientMessageId);
    await comeDue(room);
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    expect(await kept(room)).toEqual([]);
    expect(await roomSql(room, "SELECT count(*) AS posted FROM messages WHERE client_message_id = ?", again.clientMessageId)).toEqual([{ posted: 1 }]);
    await settle(ada);
    expect(ada.pending("message.created")).toEqual([]);
  });

  it("asks again a minute later where the Workspace's word on who's in the room comes too late to trust, rather than forgetting the message", async () => {
    const room = await freshRoom("held");
    const ada = await connect(room, "Ada");
    const scheduled = await schedule(ada, "<p>Soon</p>");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now");
    // The Workspace says as ever, but as if the room had been too busy to hear it for over the word's lifetime.
    const restore = await answeringWhoIsIn(room, async (asIs) => {
      const writer = await asIs();
      clock.mockImplementation(() => now() + AUTHORIZATION_TTL_MS + 1);
      return writer;
    });

    await comeDue(room);
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    expect(await kept(room)).toEqual(["<p>Soon</p>"]);
    expect(await alarmOf(room)).toBeGreaterThan(Date.now() + MINUTE - 5_000);

    await restore();
    clock.mockRestore();
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    expect((await created(ada, scheduled.clientMessageId)).body).toBe("<p>Soon</p>");
    expect(await kept(room)).toEqual([]);
  });
});
