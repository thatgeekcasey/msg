import { MAX_PREVIEW_SIZE } from "@ember/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { svgDataUrl } from "./svg-preview";

// jsdom decodes no pictures, so this stands in for the browser's decoding, and e2e/ shows real SVGs.

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"><rect width="4" height="2"/></svg>';
const MEBIBYTE = 1024 * 1024;

/** The addresses of the pictures decoded. */
let decoded: string[];

beforeEach(() => {
  decoded = [];
  HTMLImageElement.prototype.decode = vi.fn(function (this: HTMLImageElement) {
    decoded.push(this.src);
    return Promise.resolve();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Has this site answer with `response`, as `fetch()` gives it. */
function answers(response: Response) {
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** A body of `count` chunks of a mebibyte, which counts those read and says whether the rest were cancelled. */
function mebibytes(count: number) {
  const body = { read: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (body.read === count) return controller.close();
        body.read++;
        controller.enqueue(new Uint8Array(MEBIBYTE));
      },
      cancel() {
        body.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, stream };
}

describe("Safe SVG previews", () => {
  it("fetches an SVG from this site and answers it as a data URL once it decodes as a picture", async () => {
    const fetch = answers(new Response(SVG, { headers: { "Content-Type": "application/octet-stream" } }));
    const { signal } = new AbortController();
    const url = await svgDataUrl("/files/k1/s1/logo.svg?disposition=attachment", signal);
    expect(url).toBe(`data:image/svg+xml;base64,${btoa(SVG)}`);
    expect(decoded).toEqual([url]);
    expect(fetch).toHaveBeenCalledWith(new URL("/files/k1/s1/logo.svg?disposition=attachment", location.href), { signal, credentials: "same-origin" });

    // Up to 5 MiB.
    answers(new Response(SVG, { headers: { "Content-Length": String(MAX_PREVIEW_SIZE) } }));
    expect(await svgDataUrl("/files/k1/s1/logo.svg", signal)).toBe(url);
  });

  it("answers null for an address on another site, without fetching it", async () => {
    const fetch = answers(new Response(SVG));
    expect(await svgDataUrl("https://elsewhere.example/logo.svg", new AbortController().signal)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers null for a file the site doesn't answer with, or that's over 5 MiB by its length or as it arrives, reading no more of it", async () => {
    const { signal } = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await svgDataUrl("/files/k1/s1/logo.svg", signal)).toBeNull();

    const missing = mebibytes(1);
    answers(new Response(missing.stream, { status: 404 }));
    expect(await svgDataUrl("/files/k1/s1/logo.svg", signal)).toBeNull();
    expect(missing.body).toEqual({ read: 0, cancelled: true });

    const told = mebibytes(6);
    answers(new Response(told.stream, { headers: { "Content-Length": String(MAX_PREVIEW_SIZE + 1) } }));
    expect(await svgDataUrl("/files/k1/s1/logo.svg", signal)).toBeNull();
    expect(told.body).toEqual({ read: 0, cancelled: true });

    // It reads 5 MiB, then stops at the sixth.
    const untold = mebibytes(10);
    answers(new Response(untold.stream));
    expect(await svgDataUrl("/files/k1/s1/logo.svg", signal)).toBeNull();
    expect(untold.body).toEqual({ read: 6, cancelled: true });
    expect(decoded).toEqual([]);
  });

  it("answers null for a file that doesn't decode as a picture", async () => {
    HTMLImageElement.prototype.decode = vi.fn().mockRejectedValue(new DOMException("The source image cannot be decoded.", "EncodingError"));
    answers(new Response("Not an SVG"));
    expect(await svgDataUrl("/files/k1/s1/notes.svg", new AbortController().signal)).toBeNull();
  });
});
