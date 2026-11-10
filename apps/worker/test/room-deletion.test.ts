import { CloseCode, type RoomId, type Sidebar } from "@ember/protocol";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES_DELETED_AT_ONCE, type ChatRoom } from "../src/chat-room";
import type { Courier } from "../src/courier";
import type { Env } from "../src/env";
import { EVERYONE, REVOCATIONS_KEPT_MS } from "../src/revocations";
import { MessageStore } from "../src/store";
import type { Workspace } from "../src/workspace";
import type { WorkspaceStore } from "../src/workspace-store";
import {
  api,
  closeOf,
  connect,
  createRoom,
  forwardUpgrade,
  freshDeploy,
  post,
  recordedImage,
  roomSql,
  roomStub,
  settle,
  signIn,
  standInForRooms,
  upgrade,
  upload,
  workspaceSql,
  workspaceStub,
  type Access,
  type Session,
  type Socket,
} from "./support";

const bindings = env as unknown as Env;

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
});

const remove = (roomId: RoomId, session: Session) => api(`/api/rooms/${roomId}`, { method: "DELETE", headers: { Cookie: session.cookie } });

/** Makes someone an administrator, as only first run can yet. */
const promote = (session: Session) => workspaceSql("UPDATE users SET role = 1 WHERE id = ?", session.user.id);

/** The ids of the rooms `session`'s person sees listed. */
const listed = async (session: Session) => ((await (await api("/api/sidebar", { headers: { Cookie: session.cookie } })).json()) as Sidebar).rooms.map((room) => room.id);

/** Waits for the Workspace to deliver every revocation it queued, which the rooms have finished with by then. */
const delivered = () => vi.waitFor(async () => expect(await workspaceSql("SELECT count(*) AS n FROM pending_revocations")).toEqual([{ n: 0 }]), { timeout: 5_000 });

const countIn = async (roomId: RoomId, table: "messages" | "boosts" | "message_deletions" | "blobs") =>
  ((await roomSql(roomId, `SELECT count(*) AS n FROM ${table} WHERE room_id = ?`, roomId)) as Array<{ n: number }>)[0]!.n;

/** Posts a message as `client` and deletes it. */
async function deletePosted(client: Socket, body: string): Promise<void> {
  const message = await post(client, body);
  client.send({ type: "message.delete", messageId: message.id });
  await client.next("message.deleted");
}

/** What becomes of a new socket into a room as `session`'s person: let in, or the code it's closed with at once. */
async function reconnect(roomId: RoomId, session: Session): Promise<"welcome" | number> {
  const ws = (await api(`/api/rooms/${roomId}/socket`, upgrade(session.cookie))).webSocket!;
  ws.accept();
  return new Promise((resolve) => {
    ws.addEventListener("message", () => {
      resolve("welcome");
      ws.close(1000);
    });
    ws.addEventListener("close", (event) => resolve(event.code));
  });
}

/** What becomes of a socket the Worker sends on to the room, once the Workspace has let it through: let in, or the code it's closed with. */
async function outcome(roomId: RoomId, access: Access): Promise<"welcome" | number> {
  const ws = (await forwardUpgrade(roomId, access)).webSocket!;
  ws.accept();
  return new Promise((resolve) => {
    ws.addEventListener("message", () => {
      resolve("welcome");
      ws.close(1000);
    });
    ws.addEventListener("close", (event) => resolve(event.code));
  });
}

describe("Delete a room", () => {
  it("deletes a room for whoever made it, closing every socket in it, whose people find it gone", async () => {
    const [ada, grace, linus] = [await signIn("Ada"), await signIn("Grace"), await signIn("Linus")];
    const [room, annex] = [await createRoom("Design", { as: ada }), await createRoom("Annex", { as: ada })];
    const inRoom = [await connect(room.id, ada), await connect(room.id, ada), await connect(room.id, grace)];
    const linusInAnnex = await connect(annex.id, linus);
    const closes = inRoom.map((client) => closeOf(client.ws));

    const response = await remove(room.id, ada);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    for (const close of await Promise.all(closes)) expect(close).toMatchObject({ code: CloseCode.NotFound, reason: "NotFound" });
    expect(await reconnect(room.id, grace)).toBe(CloseCode.NotFound);
    expect(await workspaceSql("SELECT * FROM rooms WHERE id = ?", room.id)).toEqual([]);
    expect(await workspaceSql("SELECT * FROM memberships WHERE room_id = ?", room.id)).toEqual([]);
    expect(await listed(grace)).toEqual([annex.id]);

    // Everyone else carries on where they were.
    expect((await post(linusInAnnex, "Still in the annex")).body).toBe("Still in the annex");
    await delivered();
  });

  it("deletes the room's messages, their reactions, the deletions it kept for reconnecting tabs and its files' records, and no other room's", async () => {
    const ada = await signIn("Ada");
    const [room, annex] = [await createRoom("Design", { as: ada }), await createRoom("Annex", { as: ada })];
    for (const { id } of [room, annex]) await upload(ada, id, "moon.jpg", recordedImage("moon-thumb.jpg"));
    const inRoom = await connect(room.id, ada);
    const message = await post(inRoom, "Gone soon");
    inRoom.send({ type: "boost.create", messageId: message.id, content: "👍" });
    await inRoom.next("boost.created");
    await deletePosted(inRoom, "Me too");
    const inAnnex = await connect(annex.id, ada);
    await post(inAnnex, "Staying");
    await deletePosted(inAnnex, "Not staying");
    const closed = closeOf(inRoom.ws);

    expect((await remove(room.id, ada)).status).toBe(204);
    await closed;
    await delivered();
    expect(await countIn(room.id, "messages")).toBe(0);
    expect(await countIn(room.id, "boosts")).toBe(0);
    expect(await countIn(room.id, "message_deletions")).toBe(0);
    // Its files' records go once R2 has deleted the files (purge.test.ts).
    await vi.waitFor(async () => expect(await countIn(room.id, "blobs")).toBe(0), { timeout: 5_000 });
    // Its file's message, and "Staying".
    expect(await countIn(annex.id, "messages")).toBe(2);
    expect(await countIn(annex.id, "message_deletions")).toBe(1);
    expect(await countIn(annex.id, "blobs")).toBe(1);
    await settle(inAnnex);
  });

  it("deletes a large room's messages a batch at a time, going on from a batch that failed when the Workspace asks again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ada = await signIn("Ada");
    const room = await createRoom("Design", { as: ada });
    const inRoom = await connect(room.id, ada);
    await post(inRoom, "The newest");
    // Two batches' worth from before.
    const older = 2 * MESSAGES_DELETED_AT_ONCE;
    await roomSql(
      room.id,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${older})
       INSERT INTO messages (id, room_id, client_message_id, creator_id, creator_name, body, created_at, updated_at)
       SELECT printf('old-%04d', i), ?, 'c-old-' || i, ?, 'Ada', '<p>Before</p>', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z' FROM n`,
      room.id,
      ada.user.id,
    );
    // The second batch fails, as a write to D1 can when it's reset.
    const deleteMessages = MessageStore.prototype.deleteMessages;
    let batches = 0;
    vi.spyOn(MessageStore.prototype, "deleteMessages").mockImplementation(async function (this: MessageStore, limit) {
      if (++batches === 2) throw new Error("D1 DB exceeded its CPU time limit and was reset.");
      return deleteMessages.call(this, limit);
    });
    const closed = closeOf(inRoom.ws);

    expect((await remove(room.id, ada)).status).toBe(204);
    await closed;
    await vi.waitFor(() => expect(batches).toBe(2), { timeout: 5_000 });
    expect(await countIn(room.id, "messages")).toBe(older + 1 - MESSAGES_DELETED_AT_ONCE);
    await delivered();
    expect(batches).toBe(4);
    expect(await countIn(room.id, "messages")).toBe(0);
  });

  it("lets administrators delete the rooms they're in, and refuses other members, changing nothing", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Design", { as: ada });
    const graceInRoom = await connect(room.id, grace);
    await post(graceInRoom, "Mine to keep");

    const refused = await remove(room.id, grace);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "Only administrators and the room's creator can delete it" });
    expect(await workspaceSql("SELECT id FROM rooms WHERE id = ?", room.id)).toEqual([{ id: room.id }]);
    expect((await post(graceInRoom, "Still here")).body).toBe("Still here");

    await promote(grace);
    const closed = closeOf(graceInRoom.ws);
    expect((await remove(room.id, grace)).status).toBe(204);
    expect(await closed).toMatchObject({ code: CloseCode.NotFound });
    expect(await listed(ada)).toEqual([]);
  });

  it("answers 404 to people who aren't in the room, administrators included, and for missing rooms", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    await promote(grace);
    const room = await createRoom("Leads", { closedTo: [ada.user.id], as: ada });

    for (const [roomId, session] of [[room.id, grace], ["nowhere", ada], ["%FF", ada]] as const) {
      const response = await remove(roomId, session);
      expect(response.status, roomId).toBe(404);
      expect(await response.json()).toEqual({ error: "Room not found or inaccessible" });
    }
    expect(await workspaceSql("SELECT id FROM rooms WHERE id = ?", room.id)).toEqual([{ id: room.id }]);
  });

  it("asks who's signed in, and refuses deletions from other sites", async () => {
    const ada = await signIn("Ada");
    const room = await createRoom("Design", { as: ada });
    expect((await api(`/api/rooms/${room.id}`, { method: "DELETE" })).status).toBe(401);
    const crossSite = await api(`/api/rooms/${room.id}`, { method: "DELETE", headers: { Cookie: ada.cookie, Origin: "https://evil.test" } });
    expect(crossSite.status).toBe(422);
    expect(await listed(ada)).toEqual([room.id]);
  });

  it("still closes the room's sockets when the database saves the deletion but its answer is lost", async () => {
    const ada = await signIn("Ada");
    const room = await createRoom("Design", { as: ada });
    const closed = closeOf((await connect(room.id, ada)).ws);
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const deleteRoom = store.deleteRoom.bind(store);
      store.deleteRoom = async (...args) => {
        await deleteRoom(...args);
        throw new Error("The database's answer was lost");
      };
    });

    expect((await remove(room.id, ada)).status).toBe(500);
    expect(await closed).toMatchObject({ code: CloseCode.NotFound });
    await delivered();
  });

  it("waits for a change under way to finish before deleting the room", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    await promote(grace);
    const room = await createRoom("Leads", { as: ada });
    // Holds Grace's change between reading who may make it and writing, as D1 can, until Ada's
    // deletion has finished, or for a second if it's waiting for Grace's change.
    const race = { graceHasRead: false, adaIsDone: false };
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const roomToChange = store.roomToChange.bind(store);
      store.roomToChange = async (roomId, userId) => {
        const found = await roomToChange(roomId, userId);
        if (userId !== grace.user.id) return found;
        race.graceHasRead = true;
        for (let waited = 0; !race.adaIsDone && waited < 1_000; waited += 10) await scheduler.wait(10);
        return found;
      };
    });

    // Saved after the deletion, it would add members to a room that's gone, which the database refuses.
    const madePrivate = api(`/api/rooms/${room.id}`, {
      method: "PATCH",
      headers: { Cookie: grace.cookie },
      body: JSON.stringify({ kind: "closed", memberIds: [ada.user.id, grace.user.id] }),
    });
    await vi.waitFor(() => expect(race.graceHasRead).toBe(true));
    const deleted = await remove(room.id, ada);
    race.adaIsDone = true;
    expect((await madePrivate).status).toBe(200);
    expect(deleted.status).toBe(204);
    expect(await workspaceSql("SELECT * FROM rooms WHERE id = ?", room.id)).toEqual([]);
    await delivered();
  });

  it("still deletes the room when it's deleted while a revocation in it is on its way", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const room = await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada });
    const adaInRoom = await connect(room.id, ada);
    await post(adaInRoom, "Gone soon");
    const graceInRoom = await connect(room.id, grace);
    const closed = [closeOf(adaInRoom.ws), closeOf(graceInRoom.ws)];
    // Holds the room's taking of Grace's revocation, which the change that takes her out delivers
    // before it answers, until the room is deleted, or for a second; the deletion's own delivery waits
    // its turn behind it.
    const race = { roomIsCalled: false, roomIsDeleted: false };
    const giveBack = await standInForRooms({
      revoke: async (...call) => {
        if (call[1].some(({ tag }) => tag === grace.user.id)) {
          race.roomIsCalled = true;
          for (let waited = 0; !race.roomIsDeleted && waited < 1_000; waited += 10) await scheduler.wait(10);
        }
        await roomStub(call[0]).revoke(...call);
      },
    });

    const takeGraceOut = { kind: "closed", memberIds: [ada.user.id] };
    const changing = api(`/api/rooms/${room.id}`, { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify(takeGraceOut) });
    await vi.waitFor(() => expect(race.roomIsCalled).toBe(true));
    const removing = remove(room.id, ada);
    // Saved, with its delivery still waiting.
    await vi.waitFor(async () => expect(await workspaceSql("SELECT id FROM deleted_rooms WHERE id = ?", room.id)).toEqual([{ id: room.id }]));
    race.roomIsDeleted = true;
    expect((await removing).status).toBe(204);
    expect((await changing).status).toBe(200);

    // Grace's revocation reached a room deleted since it was read, closing her socket to reconnect,
    // and settled none of what the deletion had queued; the deletion's own then closed the rest.
    await delivered();
    expect(await countIn(room.id, "messages")).toBe(0);
    const [adaClosed, graceClosed] = await Promise.all(closed);
    expect(adaClosed).toMatchObject({ code: CloseCode.NotFound });
    expect(graceClosed).toMatchObject({ code: CloseCode.Reconnect });
    await giveBack();
  });

  it("turns away a socket let through at or before the room was deleted, telling it to reconnect", async () => {
    const ada = await signIn("Ada");
    const room = await createRoom("Design", { as: ada });
    const deletedAt = Date.now();
    await roomStub(room.id).revoke(room.id, [{ tag: EVERYONE, code: CloseCode.NotFound }], deletedAt);

    const laptop = (authorizedAt: number) => ({ user: ada.user, sessionId: "laptop", authorizedAt });
    expect(await outcome(room.id, laptop(deletedAt - 1))).toBe(CloseCode.Reconnect);
    expect(await outcome(room.id, laptop(deletedAt))).toBe(CloseCode.Reconnect);
  });

  it("erases what's left of the room once no socket let through before could still arrive", async () => {
    const ada = await signIn("Ada");
    const room = await createRoom("Design", { as: ada });
    const inRoom = await connect(room.id, ada);
    await post(inRoom, "Gone soon");
    const closed = closeOf(inRoom.ws);
    const deletedAt = Date.now();
    expect((await remove(room.id, ada)).status).toBe(204);
    await closed;
    await delivered();

    const alarm = await runInDurableObject(roomStub(room.id), (_room, state: DurableObjectState) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(deletedAt + REVOCATIONS_KEPT_MS);
    expect(await roomSql(room.id, "SELECT tag FROM revocations WHERE room_id = ?", room.id)).toEqual([{ tag: EVERYONE }]);

    expect(await runDurableObjectAlarm(roomStub(room.id))).toBe(true);
    const left = await runInDurableObject(roomStub(room.id), async (_room, state: DurableObjectState) => ({
      tables: state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`).toArray(),
      keys: [...(await state.storage.list()).keys()],
      alarm: await state.storage.getAlarm(),
    }));
    expect(left).toEqual({ tables: [], keys: [], alarm: null });
    if (bindings.STORAGE_BACKEND === "d1") {
      // Where every room's tables are shared.
      expect(await roomSql(room.id, "SELECT tag FROM revocations WHERE room_id = ?", room.id)).toEqual([]);
      expect(await countIn(room.id, "messages")).toBe(0);
    }
  });

  it.each([
    ["the Workspace", "workspace", "sendEvents"],
    ["the search index", "index", "sendMessages"],
  ] as const)("erases the room once its call to %s is done, which would make its tables again", async (_, courier, send) => {
    const ada = await signIn("Ada");
    const room = await createRoom("Design", { as: ada });
    const inRoom = await connect(room.id, ada);
    await post(inRoom, "Gone soon");
    const closed = closeOf(inRoom.ws);
    expect((await remove(room.id, ada)).status).toBe(204);
    await closed;
    await delivered();
    // Holds a call that goes as the alarm does until the alarm is done, or for a second if it's waiting for the call.
    const race = { alarmIsDone: false, called: false };
    await runInDurableObject(roomStub(room.id), (instance: ChatRoom) => {
      const object = instance as unknown as Record<typeof send, (roomId: RoomId) => Promise<number>> & { couriersFor(roomId: RoomId): Record<typeof courier, Courier> };
      const call = object[send].bind(object);
      object[send] = async (roomId) => {
        for (let waited = 0; !race.alarmIsDone && waited < 1_000; waited += 10) await scheduler.wait(10);
        const sent = await call(roomId);
        race.called = true;
        return sent;
      };
      object.couriersFor(room.id)[courier].deliver();
    });

    expect(await runDurableObjectAlarm(roomStub(room.id))).toBe(true);
    race.alarmIsDone = true;
    await vi.waitFor(() => expect(race.called).toBe(true));
    const tables = await runInDurableObject(roomStub(room.id), (_room, state: DurableObjectState) =>
      state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`).toArray(),
    );
    expect(tables).toEqual([]);
  });
});

describe("Rooms from before memberships", () => {
  it("doesn't bring back a room it registered once it's deleted", async () => {
    const ada = await signIn("Ada");
    await promote(ada);
    const id = `legacy-${crypto.randomUUID().slice(0, 8)}`;
    await workspaceStub().registerLegacyRooms([id]);
    expect(await listed(ada)).toEqual([id]);

    expect((await remove(id, ada)).status).toBe(204);
    await workspaceStub().registerLegacyRooms([id]);
    expect(await workspaceSql("SELECT * FROM rooms WHERE id = ?", id)).toEqual([]);
    expect(await workspaceSql("SELECT id FROM deleted_rooms")).toEqual([{ id }]);
    expect(await listed(ada)).toEqual([]);
  });
});
