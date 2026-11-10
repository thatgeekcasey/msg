import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { storeArriving, type ArrivingFile } from "../src/files/streamed";
import { UPLOAD_PART_SIZE } from "../src/files/uploads";
import { recordedImage } from "./support";

// Storing a file in R2 as it arrives, where nothing says first how large it is, as a bot's form and a
// webhook's answer bring one.

/** What R2 was asked to do with a file: put it, or upload it in parts of the sizes listed, then complete or abort it. */
type Stored = { put: true } | { parts: number[]; ended?: "completed" | "aborted" };

/** R2, recording what it's asked to do with each file. */
function recordingBucket(): { bucket: R2Bucket; stored: Stored[] } {
  const files = (env as unknown as Env).FILES!;
  const stored: Stored[] = [];
  const bucket = {
    put: (...args: Parameters<R2Bucket["put"]>) => (stored.push({ put: true }), files.put(...args)),
    createMultipartUpload: async (...args: Parameters<R2Bucket["createMultipartUpload"]>) => {
      const upload = await files.createMultipartUpload(...args);
      const recorded: Stored & { parts: number[] } = { parts: [] };
      stored.push(recorded);
      return {
        key: upload.key,
        uploadId: upload.uploadId,
        uploadPart: (number: number, part: Uint8Array) => (recorded.parts.push(part.byteLength), upload.uploadPart(number, part)),
        complete: (parts: R2UploadedPart[]) => ((recorded.ended = "completed"), upload.complete(parts)),
        abort: () => ((recorded.ended = "aborted"), upload.abort()),
      };
    },
  } as unknown as R2Bucket;
  return { bucket, stored };
}

/** `bytes` as a file arriving `size` bytes at a time, named `filename`, counting how often it's read. */
function arriving(bytes: Uint8Array, { size = bytes.length, filename = "notes.txt", declaredType = "", limit = Number.MAX_SAFE_INTEGER } = {}) {
  let at = 0;
  const file = {
    filename,
    declaredType,
    limit,
    reads: 0,
    read: async () => {
      file.reads++;
      if (at >= bytes.length) return null;
      const chunk = bytes.slice(at, at + size);
      at += size;
      return chunk;
    },
  } satisfies ArrivingFile & { reads: number };
  return file;
}

/** `length` bytes that go on counting, so any range of them is told apart. */
const counting = (length: number) => Uint8Array.from({ length }, (_, i) => i % 251);

/** What R2 keeps at `key`, as bytes, or null. */
const keptAt = async (key: string) => {
  const object = await (env as unknown as Env).FILES!.get(key);
  return object && new Uint8Array(await object.arrayBuffer());
};

describe("Bots post messages", () => {
  it("keeps a file that fits in a part in one put, identified by its bytes and kept under its name", async () => {
    const { bucket, stored } = recordingBucket();
    const moon = recordedImage("moon-thumb.jpg");
    const key = crypto.randomUUID();

    expect(await storeArriving(bucket, key, arriving(moon, { size: 1000, filename: "moon.jpg", declaredType: "application/octet-stream" }))).toEqual({
      byteSize: moon.length,
      identified: { contentType: "image/jpeg", metadata: '{"identified":true,"width":640,"height":640,"analyzed":true}' },
    });
    expect(stored).toEqual([{ put: true }]);
    expect(await keptAt(key)).toEqual(moon);
    expect(await (env as unknown as Env).FILES!.head(key)).toMatchObject({ httpMetadata: { contentType: "image/jpeg" }, customMetadata: { filename: "moon.jpg" } });
  });

  it("keeps a larger file in parts as they fill, however its bytes arrive", async () => {
    const { bucket, stored } = recordingBucket();
    const bytes = counting(2 * UPLOAD_PART_SIZE + 5);
    const key = crypto.randomUUID();

    expect(await storeArriving(bucket, key, arriving(bytes, { size: 3_000_017, filename: "counting.bin" }))).toEqual({
      byteSize: bytes.length,
      identified: { contentType: "application/octet-stream", metadata: '{"identified":true,"analyzed":true}' },
    });
    expect(stored).toEqual([{ parts: [UPLOAD_PART_SIZE, UPLOAD_PART_SIZE, 5], ended: "completed" }]);
    const kept = await keptAt(key);
    expect(kept?.length).toBe(bytes.length);
    expect(kept!.every((byte, i) => byte === bytes[i])).toBe(true);
  });

  it("keeps an empty file", async () => {
    const { bucket, stored } = recordingBucket();
    const key = crypto.randomUUID();

    expect(await storeArriving(bucket, key, arriving(new Uint8Array(), { filename: "empty.txt", declaredType: "text/plain" }))).toMatchObject({
      byteSize: 0,
      identified: { contentType: "text/plain" },
    });
    expect(stored).toEqual([{ put: true }]);
    expect(await keptAt(key)).toEqual(new Uint8Array());
  });

  it("stops reading a file once it's more than its limit, keeping none of it", async () => {
    const { bucket, stored } = recordingBucket();
    const small = arriving(counting(101), { size: 10, limit: 100 });
    const key = crypto.randomUUID();
    expect(await storeArriving(bucket, key, small)).toBeNull();
    expect(small.reads).toBe(11);
    expect(stored).toEqual([]);
    expect(await keptAt(key)).toBeNull();

    // One whose first part R2 has.
    const large = arriving(counting(2 * UPLOAD_PART_SIZE), { size: UPLOAD_PART_SIZE / 2, limit: UPLOAD_PART_SIZE + 1 });
    expect(await storeArriving(bucket, key, large)).toBeNull();
    expect(large.reads).toBe(3);
    expect(stored).toEqual([{ parts: [UPLOAD_PART_SIZE], ended: "aborted" }]);
    expect(await keptAt(key)).toBeNull();
  });

  it("keeps none of a file that can't be read to its end, and says why", async () => {
    const { bucket, stored } = recordingBucket();
    const failing = arriving(counting(UPLOAD_PART_SIZE + 1));
    const read = failing.read;
    failing.read = async () => {
      if (failing.reads === 1) throw new Error("The webhook stopped answering");
      return read();
    };
    const key = crypto.randomUUID();

    await expect(storeArriving(bucket, key, failing)).rejects.toThrow("The webhook stopped answering");
    expect(stored).toEqual([{ parts: [UPLOAD_PART_SIZE], ended: "aborted" }]);
    expect(await keptAt(key)).toBeNull();
  });
});
