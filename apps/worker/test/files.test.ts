import { describe, expect, it } from "vitest";
import { basename, contentDisposition, escapePath, extname, sanitizedFilename } from "../src/files/filename";
import { identify } from "../src/files/marcel";
import { byteRanges } from "../src/files/ranges";
import { metadataOf } from "../src/files/uploads";
import rubyCore from "./fixtures/ruby_core.json";
import recorded from "./fixtures/storage.json";
import { recordedImage } from "./support";

// What Active Storage makes of a file and its name, and the byte ranges Rack serves of it, against what
// was recorded from Campfire (fixtures/README.md).

/** The bytes `hex` spells. */
const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

/** The text whose UTF-8 bytes `hex` spells. */
const textOf = (hex: string) => new TextDecoder().decode(bytesOf(hex));

/** A blob, and the file it recorded with it, if it kept one. */
interface RecordedBlob {
  file?: string;
  blob: { filename: string; content_type: string; metadata: string; byte_size: number };
}

/** Every blob recorded with its file: the thumbnails, posters, avatars and logos Rails made. */
function recordedBlobs(value: unknown, found: RecordedBlob[] = []): RecordedBlob[] {
  if (Array.isArray(value)) for (const item of value) recordedBlobs(item, found);
  else if (value && typeof value === "object") {
    if ("file" in value && "blob" in value) found.push(value as RecordedBlob);
    for (const item of Object.values(value)) recordedBlobs(item, found);
  }
  return found;
}

/**
 * The files Marcel's cases name. Marcel reads only a file's first bytes, so each stands in with a file
 * of the same kind: a thumbnail of the photo, and the first bytes a 1×1 BMP and a QuickTime movie start
 * with.
 */
function fixture(name: string): Uint8Array {
  if (name === ".keep") return new Uint8Array();
  if (name === "pixel.bmp") {
    // Its 14-byte file header, 40-byte info header and one row, padded to 4 bytes.
    const bmp = new Uint8Array(58);
    const view = new DataView(bmp.buffer);
    bmp.set([0x42, 0x4d]);
    view.setUint32(2, 58, true);
    view.setUint32(10, 54, true);
    view.setUint32(14, 40, true);
    view.setInt32(18, 1, true);
    view.setInt32(22, 1, true);
    view.setUint16(26, 1, true);
    view.setUint16(28, 24, true);
    view.setUint32(34, 4, true);
    return bmp;
  }
  // The file type box a movie from a Mac starts with.
  if (name === "alpha-centuri.mov") return new Uint8Array([0, 0, 0, 0x14, ...new TextEncoder().encode("ftypqt  "), 0, 0, 0x02, 0, ...new TextEncoder().encode("qt  ")]);
  return recordedImage({ "moon.jpg": "moon-thumb.jpg", "black_hole.jpg": "black_hole-thumb.jpg", "earth.png": "earth-thumb.png" }[name]!);
}

describe("How files are recognized", () => {
  it("identifies each recorded file as Marcel did, from its bytes, the type the browser declared and its name", () => {
    expect(recorded.marcel).toHaveLength(51);
    for (const { name, data_hex, fixture: file, declared_type, content_type } of recorded.marcel) {
      const data = file === null ? bytesOf(data_hex ?? "") : fixture(file);
      expect(identify(data, sanitizedFilename(name), declared_type ?? ""), JSON.stringify({ name, file, declared_type })).toBe(content_type);
    }
  });

  it("records each recorded image's metadata as Active Storage wrote it, its width and height included", () => {
    const blobs = recordedBlobs(recorded);
    expect(blobs.map(({ file }) => file).sort()).toEqual([
      "alpha-centuri-poster-from-key.webp",
      "alpha-centuri-poster.webp",
      "alpha-centuri-preview-webp.webp",
      "alpha-centuri-preview_image.jpg",
      "black_hole-logo-large.png",
      "black_hole-logo-small.png",
      "black_hole-thumb.jpg",
      "earth-avatar.webp",
      "earth-thumb.png",
      "moon-avatar.webp",
      "moon-thumb.jpg",
    ]);
    for (const { file, blob } of blobs) {
      const bytes = recordedImage(file!);
      expect(bytes.length, file).toBe(blob.byte_size);
      expect(metadataOf(bytes, blob.content_type), file).toBe(blob.metadata);
    }
  });

  it("records only that a file was identified and analyzed when it isn't an image it can read", () => {
    const [bmp] = recorded.messages.filter((message) => message.fixture === "pixel.bmp") as Array<{ blob: RecordedBlob["blob"] }>;
    expect(metadataOf(fixture("pixel.bmp"), bmp!.blob.content_type)).toBe(bmp!.blob.metadata);
    expect(metadataOf(new TextEncoder().encode("hello world"), "text/plain")).toBe('{"identified":true,"analyzed":true}');
    // A JPEG that ends before its size.
    expect(metadataOf(recordedImage("moon-thumb.jpg").subarray(0, 100), "image/jpeg")).toBe('{"identified":true,"analyzed":true}');
  });
});

describe("File links", () => {
  it("names each recorded file as Active Storage keeps it, sends it and puts it in an address", () => {
    expect(recorded.filenames).toHaveLength(16);
    for (const vector of recorded.filenames) {
      const name = textOf(vector.input_hex);
      const extension = extname(name);
      const sanitized = sanitizedFilename(name);
      expect(sanitized, name).toBe(vector.sanitized);
      expect(basename(name).slice(0, basename(name).length - extension.length), name).toBe(textOf(vector.base_hex));
      expect(extension.slice(1), name).toBe(textOf(vector.extension_hex));
      expect(contentDisposition("inline", sanitized), name).toBe(vector.inline);
      expect(contentDisposition("attachment", sanitized), name).toBe(vector.attachment);
      expect(escapePath(sanitized), name).toBe(vector.escaped_path);
    }
  });

  it("names a file in a moment, however long a run of spaces or slashes its name holds", () => {
    const [spaces, slashes] = [" ".repeat(300_000), "/".repeat(300_000)];
    const started = Date.now();
    expect(sanitizedFilename(`a${spaces}b.png`)).toBe(`a${spaces}b.png`);
    expect(basename(`a${slashes}b.png`)).toBe("b.png");
    // Patterns for the run at the name's end would try to end each run inside it there: some 6 seconds each for these.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reads each recorded Range header as Rack did", () => {
    expect(rubyCore.byte_ranges).toHaveLength(200);
    for (const { header, size, ranges } of rubyCore.byte_ranges) expect(byteRanges(header, size), `${JSON.stringify(header)} of ${size} bytes`).toEqual(ranges);
    expect(byteRanges(null, 10)).toBeNull();
  });
});
