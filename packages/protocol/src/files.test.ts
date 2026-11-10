import { describe, expect, it } from "vitest";
import {
  FILE_TOO_LARGE,
  isPreviewableSize,
  isPreviewed,
  isWebImage,
  MAX_FILE_NAME_LENGTH,
  MAX_FILE_SIZE,
  MAX_ID_LENGTH,
  parseNewUpload,
  uploadPartPath,
  uploadPreviewPath,
  uploadsPath,
  type RoomId,
} from "./index";

const clientMessageId = "5s1fw6nd9fk";

describe("250 MB file limit", () => {
  it("takes a file of up to 250,000,000 bytes, and an empty one", () => {
    const largest = { name: "earth.png", type: "image/png", size: MAX_FILE_SIZE, clientMessageId };
    expect(parseNewUpload(largest)).toEqual(largest);
    expect(parseNewUpload({ name: ".keep", type: "", size: 0, clientMessageId })).toEqual({ name: ".keep", type: "", size: 0, clientMessageId });
    expect(parseNewUpload({ ...largest, size: MAX_FILE_SIZE + 1 })).toBe(FILE_TOO_LARGE);
    expect(FILE_TOO_LARGE).toBe("Files must be 250 MB or smaller.");
  });
});

describe("Attach files", () => {
  it("takes the id the app gives the file's message", () => {
    const upload = { name: "notes.txt", type: "text/plain", size: 5, clientMessageId: "m".repeat(MAX_ID_LENGTH) };
    expect(parseNewUpload(upload)).toEqual(upload);
    expect(parseNewUpload({ ...upload, unexpected: true })).toEqual(upload);
  });

  it.each([
    ["no id", undefined],
    ["an id that isn't text", 7],
    ["an empty id", ""],
    ["an id longer than any", "m".repeat(MAX_ID_LENGTH + 1)],
  ])("refuses %s for the file's message", (_, id) => {
    expect(parseNewUpload({ name: "notes.txt", type: "text/plain", size: 5, clientMessageId: id })).toBe("A file needs an id for its message");
  });
});

describe("How files are recognized", () => {
  it("keeps the name and type as the browser gives them, whatever they are", () => {
    const upload = { name: "  weird & -name- ünï.png ", type: "application/x-anything; charset=utf-8", size: 42, clientMessageId };
    expect(parseNewUpload(upload)).toEqual(upload);
    const longest = { name: `${"n".repeat(MAX_FILE_NAME_LENGTH - 4)}.png`, type: "t".repeat(255), size: 1, clientMessageId };
    expect(parseNewUpload(longest)).toEqual(longest);
    expect(parseNewUpload({ ...upload, name: "🌍.png" })).toEqual({ ...upload, name: "🌍.png" });
  });

  it.each([
    ["no body", null, "Expected a JSON object"],
    ["a list", [{ name: "moon.jpg", type: "image/jpeg", size: 1 }], "Expected a JSON object"],
    ["a name that isn't text", { name: 7, type: "", size: 1 }, "A file needs a name"],
    ["a blank name", { name: " \t", type: "", size: 1 }, "A file needs a name"],
    ["a name longer than any file system's", { name: `${"n".repeat(MAX_FILE_NAME_LENGTH)}.png`, type: "", size: 1 }, "That file's name can't be kept"],
    ["half a character", { name: "\ud83cmoon.jpg", type: "", size: 1 }, "That file's name can't be kept"],
    ["a type that isn't text", { name: "moon.jpg", type: null, size: 1 }, "A file's type must be text"],
    ["a type longer than any", { name: "moon.jpg", type: "t".repeat(256), size: 1 }, "A file's type must be text"],
    ["a size that isn't a number", { name: "moon.jpg", type: "", size: "12794" }, "A file's size must be a number of bytes"],
    ["a size that isn't whole", { name: "moon.jpg", type: "", size: 1.5 }, "A file's size must be a number of bytes"],
    ["a negative size", { name: "moon.jpg", type: "", size: -1 }, "A file's size must be a number of bytes"],
  ])("refuses %s and says why", (_, body, error) => {
    expect(parseNewUpload(body)).toBe(error);
  });

  it("uploads to the room's address, a part at a time", () => {
    expect(uploadsPath("lobby" as RoomId)).toBe("/api/rooms/lobby/uploads");
    expect(uploadPartPath("lobby" as RoomId, "1ykrknnn9r4youv0f71wrntkzilx", 2)).toBe("/api/rooms/lobby/uploads/1ykrknnn9r4youv0f71wrntkzilx/parts/2");
  });
});

describe("Image, video and file previews", () => {
  it("previews the pictures Campfire makes thumbnails of and every video, and sends a preview beside the upload's parts", () => {
    const previewed = ["image/png", "image/gif", "image/jpeg", "image/tiff", "image/webp", "image/avif", "image/heic", "image/heif", "video/mp4", "video/quicktime", "video/webm"];
    expect(previewed.filter(isPreviewed)).toEqual(previewed);
    // Campfire leaves BMP, ICO and PSD out, and SVGs get previews of their own.
    expect(["image/bmp", "image/vnd.microsoft.icon", "image/vnd.adobe.photoshop", "image/svg+xml", "application/pdf", "audio/mpeg", "text/plain", ""].filter(isPreviewed)).toEqual([]);
    expect(uploadPreviewPath("lobby" as RoomId, "1ykrknnn9r4youv0f71wrntkzilx")).toBe("/api/rooms/lobby/uploads/1ykrknnn9r4youv0f71wrntkzilx/preview");
  });

  it("previews a picture or video of up to 250 megapixels, whose width and height are both known and above 0", () => {
    expect(isPreviewableSize({ width: 25_000, height: 10_000 })).toBe(true);
    expect(isPreviewableSize({ width: 1920, height: 1080 })).toBe(true);
    for (const [width, height] of [
      [25_001, 10_000],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      [0, 5],
      [-1, 5],
      [Infinity, 5],
      [NaN, 5],
      [5, NaN],
    ]) {
      expect(isPreviewableSize({ width, height }), `${width}×${height}`).toBe(false);
    }
    expect(isPreviewableSize({ width: 1920 })).toBe(false);
    expect(isPreviewableSize({ height: 1080 })).toBe(false);
    expect(isPreviewableSize({})).toBe(false);
  });

  it("knows the pictures every browser shows, as Active Storage's `web_image_content_types` lists them", () => {
    expect(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/heic", "image/tiff", "image/svg+xml"].filter(isWebImage)).toEqual([
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ]);
  });
});
