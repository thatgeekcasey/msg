import { uploadPartPath, uploadPreviewPath, type RoomId, type Upload } from "@ember/protocol";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNFINISHED_UPLOAD_KEPT_MS, type ChatRoom } from "../src/chat-room";
import type { Env } from "../src/env";
import { DELETE_FILES_OF, DELETE_UNFINISHED, DELETED_FILES, FORGET_FILES, objectKey, OLDEST_UNFINISHED, previewKey } from "../src/files/blobs";
import { UPLOAD_PART_SIZE } from "../src/files/uploads";
import { api, apiWith, connect, createRoom, freshDeploy, freshRoom, post, recordedImage, roomSql, roomStub, sendPart, signIn, startUpload, upload, type FileMessage, type Session } from "./support";

// Files leaving R2 with their messages.

const bindings = env as unknown as Env;
const files = bindings.FILES!;

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the room keeps of upload `id`, if anything. */
const blobOf = async (room: RoomId, id: string) => ((await roomSql(room, "SELECT * FROM blobs WHERE id = ?", id)) as Array<Record<string, unknown>>)[0];

/** The keys of the files the room keeps. */
const blobsIn = async (room: RoomId) => ((await roomSql(room, "SELECT id FROM blobs WHERE room_id = ? ORDER BY id", room)) as Array<{ id: string }>).map(({ id }) => id);

/** Whether R2 has anything at `key`. */
const stored = async (key: string) => (await files.head(key)) !== null;

/** When the room's alarm goes off, or null when it's not set. */
const alarmOf = (room: RoomId) => runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => state.storage.getAlarm());

/** The keys the room's object stores, which none are once it has erased itself. */
const keysOf = (room: RoomId) => runInDurableObject(roomStub(room), async (_room, state: DurableObjectState) => [...(await state.storage.list()).keys()]);

/** Deletes `room` as `session`, who made it. */
const deleteRoom = async (room: RoomId, session: Session) =>
  expect((await api(`/api/rooms/${room}`, { method: "DELETE", headers: { Cookie: session.cookie } })).status).toBe(204);

/** Waits for the room to have R2 delete the files it has marked deleted, and to forget them. */
const purged = (room: RoomId) =>
  vi.waitFor(async () => expect(await roomSql(room, "SELECT id FROM blobs WHERE room_id = ? AND deleted_at IS NOT NULL", room)).toEqual([]), { timeout: 5_000 });

/** Starts uploading `bytes` to `room` as `session`, named `name`, answering where its parts go. */
async function started(session: Session, room: RoomId, name: string, bytes: Uint8Array, type = ""): Promise<Upload> {
  const response = await startUpload(session, room, { name, type, size: bytes.length, clientMessageId: crypto.randomUUID() });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as Upload;
}

/** Sends a thumbnail as upload `id`'s preview, as the app sends one. */
async function sendPreview(session: Session, room: RoomId, id: string): Promise<void> {
  const thumbnail = recordedImage("moon-avatar.webp");
  const headers = { Cookie: session.cookie, "Content-Length": String(thumbnail.length) };
  const response = await api(uploadPreviewPath(room, id), { method: "PUT", headers, body: thumbnail });
  expect(response.status, await response.clone().text()).toBe(204);
}

/** Uploads a picture to `room` as `session`, with its thumbnail, answering the message the room posts it as. */
async function picture(session: Session, room: RoomId): Promise<FileMessage> {
  const moon = recordedImage("moon-thumb.jpg");
  const upload = await started(session, room, "moon.jpg", moon, "image/jpeg");
  await sendPreview(session, room, upload.id);
  const last = await sendPart(session, room, upload.id, 1, moon);
  expect(last.status, await last.clone().text()).toBe(201);
  return (await last.json()) as FileMessage;
}

/** Whether R2 has `message`'s file and its preview. */
const storedFileOf = async ({ attachment }: FileMessage) => [await stored(objectKey(attachment.id)), await stored(previewKey(attachment.id))];

/**
 * A bucket whose `put` deletes `room` as `session` and waits until R2 has deleted its files before it
 * stores anything, as a deletion overtakes a request that's still storing a file.
 */
const overtakenBy = (room: RoomId, session: Session) =>
  ({
    put: async (...args: Parameters<R2Bucket["put"]>) => {
      await deleteRoom(room, session);
      await vi.waitFor(async () => expect(await blobsIn(room)).toEqual([]), { timeout: 5_000 });
      return files.put(...args);
    },
    delete: (keys: string | string[]) => files.delete(keys),
  }) as unknown as R2Bucket;

/** Has `room`'s object find R2 failing to delete anything, until what this answers is called. */
async function breakDeletes(room: RoomId): Promise<() => Promise<void>> {
  const failing = {
    delete: () => Promise.reject(new Error("R2 is unreachable")),
    resumeMultipartUpload: (key: string, uploadId: string) => files.resumeMultipartUpload(key, uploadId),
  } as unknown as R2Bucket;
  let original: Env | undefined;
  await runInDurableObject(roomStub(room), (instance: ChatRoom) => {
    const object = instance as unknown as { env: Env };
    original = object.env;
    object.env = { ...original, FILES: failing };
  });
  return () => runInDurableObject(roomStub(room), (instance: ChatRoom) => void ((instance as unknown as { env: Env }).env = original!));
}

describe("Files leave with their messages", () => {
  it("has R2 delete a file message's file and preview a moment after the message goes, after which its links answer 404", async () => {
    const room = await freshRoom("lobby");
    const ada = await connect(room, "Ada");
    const moon = await picture(ada.session, room);
    const notes = await upload(ada.session, room, "notes.txt", new TextEncoder().encode("Still here"));
    const hello = await post(ada, "Hello");
    expect(await storedFileOf(moon)).toEqual([true, true]);
    // The room looks for files to delete a moment after its first socket opens, as it has by now, so only
    // the deletion has it look again.
    await sleep(500);

    ada.send({ type: "message.delete", messageId: moon.id });
    await ada.next("message.deleted");
    await purged(room);
    expect(await blobOf(room, moon.attachment.id)).toBeUndefined();
    expect(await storedFileOf(moon)).toEqual([false, false]);
    expect((await api(moon.attachment.url)).status).toBe(404);
    expect((await api(moon.attachment.previewUrl!)).status).toBe(404);

    // A text message has no file to delete, and every other file stays.
    ada.send({ type: "message.delete", messageId: hello.id });
    await ada.next("message.deleted");
    expect(await blobOf(room, notes.attachment.id)).toMatchObject({ deleted_at: null, message_id: notes.id });
    expect(await (await api(notes.attachment.url)).text()).toBe("Still here");
  });

  it("has R2 delete the files of a banned person's messages as the room removes them, and no one else's", async () => {
    const room = await freshRoom("lobby");
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const graces = [await picture(grace, room), await upload(grace, room, "spam.txt", new TextEncoder().encode("Spam"))];
    const adas = await picture(ada, room);

    expect(await roomStub(room).removeMessagesBy(room, grace.user.id, 100, null)).toBe(false);
    await purged(room);
    expect(await blobsIn(room)).toEqual([adas.attachment.id]);
    expect(await storedFileOf(graces[0]!)).toEqual([false, false]);
    expect(await stored(objectKey(graces[1]!.attachment.id))).toBe(false);
    expect(await storedFileOf(adas)).toEqual([true, true]);
  });

  it("has R2 delete every file of a deleted room, aborting uploads under way, before the room erases the rest", async () => {
    const ada = await signIn("Ada");
    const room = (await createRoom("Design", { as: ada })).id;
    const moon = await picture(ada, room);
    const earth = new Uint8Array(UPLOAD_PART_SIZE + 10);
    const underWay = await started(ada, room, "earth.png", earth);
    expect((await sendPart(ada, room, underWay.id, 1, earth.subarray(0, UPLOAD_PART_SIZE))).status).toBe(204);
    const { multipart_upload_id: uploadId } = (await blobOf(room, underWay.id)) as { multipart_upload_id: string };

    await deleteRoom(room, ada);
    await vi.waitFor(async () => expect(await blobsIn(room)).toEqual([]), { timeout: 5_000 });
    expect(await storedFileOf(moon)).toEqual([false, false]);
    expect(await stored(objectKey(underWay.id))).toBe(false);
    // R2 takes no more parts of it.
    await expect(files.resumeMultipartUpload(objectKey(underWay.id), uploadId).uploadPart(2, earth.subarray(UPLOAD_PART_SIZE))).rejects.toThrow();

    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    expect(await keysOf(room)).toEqual([]);
  });

  it("keeps a deleted room until R2 has deleted its files, trying again later", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ada = await signIn("Ada");
    const room = (await createRoom("Design", { as: ada })).id;
    const moon = await picture(ada, room);
    const mend = await breakDeletes(room);

    await deleteRoom(room, ada);
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(expect.stringContaining("deleted files to R2"), expect.any(Error)), { timeout: 5_000 });
    // The alarm that erases the room finds R2 failing still, and goes off again five minutes later.
    const alarmAt = Date.now();
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    expect(await alarmOf(room)).toBeGreaterThanOrEqual(alarmAt + 5 * 60 * 1000);
    expect(await blobOf(room, moon.attachment.id)).toMatchObject({ deleted_at: expect.any(String) });
    expect(await storedFileOf(moon)).toEqual([true, true]);

    await mend();
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    expect(await storedFileOf(moon)).toEqual([false, false]);
    expect(await keysOf(room)).toEqual([]);
    expect(await alarmOf(room)).toBeNull();
    // Where every room's tables are shared, and the room's records of its files outlive its object.
    if (bindings.STORAGE_BACKEND === "d1") expect(await blobsIn(room)).toEqual([]);
  });

  it("has R2 delete an upload still unfinished a day after it started, with its preview, aborting it, and comes back for the next", async () => {
    const ada = await signIn("Ada");
    const room = await freshRoom("lobby");
    const before = Date.now();
    const earth = new Uint8Array(UPLOAD_PART_SIZE + 10);
    const abandoned = await started(ada, room, "earth.png", earth);
    // The room comes back once it's a day old.
    expect(await alarmOf(room)).toBeGreaterThanOrEqual(before + UNFINISHED_UPLOAD_KEPT_MS);
    expect(await alarmOf(room)).toBeLessThanOrEqual(Date.now() + UNFINISHED_UPLOAD_KEPT_MS);
    expect((await sendPart(ada, room, abandoned.id, 1, earth.subarray(0, UPLOAD_PART_SIZE))).status).toBe(204);
    await sendPreview(ada, room, abandoned.id);
    const { multipart_upload_id: uploadId } = (await blobOf(room, abandoned.id)) as { multipart_upload_id: string };
    const younger = await started(ada, room, "moon.jpg", new Uint8Array(10));
    const posted = await picture(ada, room);

    // As a day later: the first upload started a day ago, the second an hour ago, and the posted file two days ago.
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms).toISOString();
    await roomSql(room, "UPDATE blobs SET created_at = ? WHERE id = ?", ago(UNFINISHED_UPLOAD_KEPT_MS), abandoned.id);
    await roomSql(room, "UPDATE blobs SET created_at = ? WHERE id = ?", ago(60 * 60 * 1000), younger.id);
    await roomSql(room, "UPDATE blobs SET created_at = ? WHERE id = ?", ago(2 * UNFINISHED_UPLOAD_KEPT_MS), posted.attachment.id);
    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);

    expect(await blobsIn(room)).toEqual([younger.id, posted.attachment.id].sort());
    expect([await stored(objectKey(abandoned.id)), await stored(previewKey(abandoned.id))]).toEqual([false, false]);
    await expect(files.resumeMultipartUpload(objectKey(abandoned.id), uploadId).uploadPart(2, earth.subarray(UPLOAD_PART_SIZE))).rejects.toThrow();
    expect((await sendPart(ada, room, abandoned.id, 2, earth.subarray(UPLOAD_PART_SIZE))).status).toBe(404);
    expect(await storedFileOf(posted)).toEqual([true, true]);
    expect(await alarmOf(room)).toBe(now - 60 * 60 * 1000 + UNFINISHED_UPLOAD_KEPT_MS);
  });

  it("has R2 delete a file that a part finishes once the room has deleted its upload", async () => {
    const ada = await signIn("Ada");
    const room = (await createRoom("Design", { as: ada })).id;
    const moon = recordedImage("moon-thumb.jpg");
    const upload = await started(ada, room, "moon.jpg", moon);

    const headers = { Cookie: ada.cookie, "Content-Length": String(moon.length) };
    const last = await apiWith({ FILES: overtakenBy(room, ada) }, uploadPartPath(room, upload.id, 1), { method: "PUT", headers, body: moon });
    expect(last.status).toBe(404);
    expect(await stored(objectKey(upload.id))).toBe(false);
  });

  it("marks, finds and forgets files by their keys and the room's indexes, never reading every file the room has", async () => {
    const room = await freshRoom("plans");
    // Which makes the room's tables, on Durable Object SQLite.
    await connect(room, "Ada");
    const planOf = async (query: string, ...params: Array<string | number>) =>
      (await roomSql(room, `EXPLAIN QUERY PLAN ${query}`, ...params)).map((row) => (row as { detail: string }).detail).join("; ");
    const byKey = "SEARCH blobs USING INDEX sqlite_autoindex_blobs_1 (id=?)";

    const ofMessages = await planOf(DELETE_FILES_OF, "now", room, room, "[]");
    expect(ofMessages).toContain(byKey);
    expect(ofMessages).toContain("SEARCH messages USING INDEX index_messages_on_room_id_and_id (room_id=? AND id=?)");
    expect(await planOf(FORGET_FILES, room, "[]")).toContain(byKey);
    expect(await planOf(DELETED_FILES, room, 50)).toBe("SEARCH blobs USING INDEX index_blobs_on_deleted (room_id=?)");
    expect(await planOf(DELETE_UNFINISHED, "now", room, "then")).toBe("SEARCH blobs USING INDEX index_blobs_on_unfinished (room_id=? AND created_at<?)");
    expect(await planOf(OLDEST_UNFINISHED, room)).toBe("SEARCH blobs USING INDEX index_blobs_on_unfinished (room_id=?)");
  });

  it("has R2 delete a preview that arrives once the room has deleted its upload", async () => {
    const ada = await signIn("Ada");
    const room = (await createRoom("Design", { as: ada })).id;
    const upload = await started(ada, room, "moon.jpg", recordedImage("moon-thumb.jpg"), "image/jpeg");

    const thumbnail = recordedImage("moon-avatar.webp");
    const headers = { Cookie: ada.cookie, "Content-Length": String(thumbnail.length) };
    const late = await apiWith({ FILES: overtakenBy(room, ada) }, uploadPreviewPath(room, upload.id), { method: "PUT", headers, body: thumbnail });
    expect(late.status).toBe(404);
    expect(await stored(previewKey(upload.id))).toBe(false);
  });
});
