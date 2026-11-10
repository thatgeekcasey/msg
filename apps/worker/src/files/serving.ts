import { toHex } from "../encoding";
import type { Env } from "../env";
import { urlOf } from "../request-url";
import { isFileSignature } from "./addresses";
import { objectKey, previewKey } from "./blobs";
import { forcedDisposition, typeForServing } from "./content-types";
import { contentDisposition, sanitizedFilename } from "./filename";
import { BINARY } from "./marcel";
import { byteRanges, type ByteRange } from "./ranges";

// Serving a room's files from R2 at the addresses addresses.ts makes: the whole file or the byte ranges
// asked for, 304 for a copy the browser has, and 416 for ranges the file doesn't have, each with its
// type for serving, how to show it, and an hour anyone may cache it for. Several ranges go as Active
// Storage's proxy route sends them, since the disk route sends them as the file's own type. A file's
// preview is served the same way.

/**
 * `/files/<key>/<signature>/<name>`, or `/previews/…` for the file's preview, where the name can be
 * anything, as Active Storage's route glob takes it.
 */
const FILE_PATH = /^\/(files|previews)\/([^/]+)\/([^/]+)\/./;

/** An Active Storage key: 28 lowercase letters and digits. */
const KEY = /^[0-9a-z]{28}$/;

/** What the disk route's `after_action` adds (Campfire's config/initializers/active_storage.rb). */
const CACHE_CONTROL = "max-age=3600, public";

/**
 * The most byte ranges sent one by one: each is a call to R2, of the 50 a request may make on the Free
 * plan, and finding the file takes one. Rack serves up to 99, so more get the whole file here.
 */
const MAX_RANGES = 49;

/** Rack::Files' answer to ranges the file doesn't have. */
const UNSATISFIABLE = "Byte range unsatisfiable\n";

const encoder = new TextEncoder();

/** What a file's address names. */
export interface FileAddress {
  key: string;
  signature: string;
  /** Whether it's the address of the file's preview rather than the file. */
  preview: boolean;
}

export function fileAddressOf(pathname: string): FileAddress | null {
  const match = FILE_PATH.exec(pathname);
  return match && { key: match[2]!, signature: match[3]!, preview: match[1] === "previews" };
}

/** `head :not_found`: an empty answer, as HTML. */
const notFound = () => new Response(null, { status: 404, headers: { "Content-Type": "text/html" } });

/** Whether R2 sent the file's bytes along with what it knows of it. */
export const hasBody = (object: R2Object): object is R2ObjectBody => "body" in object;

/** What `?disposition=` asks for, the last one if there are several, as Rack reads the query. */
const dispositionOf = (request: Request) => urlOf(request).searchParams.getAll("disposition").at(-1) ?? "inline";

/**
 * What a GET or HEAD of a file's address answers. An address Ember didn't make, a file R2 doesn't have,
 * and a Worker with no bucket bound all answer an empty 404.
 */
export async function serveFile(request: Request, env: Env, { key, signature, preview }: FileAddress): Promise<Response> {
  const files = env.FILES;
  if (!files || !KEY.test(key) || !(await isFileSignature(env.SESSION_SECRET, key, signature))) return notFound();
  const stored = preview ? previewKey(key) : objectKey(key);
  const since = request.headers.get("If-Modified-Since");
  const range = request.headers.get("Range");
  // A plain GET reads the whole file at once. Anything else needs to know of it first.
  const read = request.method === "GET" && since === null && range === null;
  const object = read ? await files.get(stored) : await files.head(stored);
  if (!object) return notFound();

  const contentType = object.httpMetadata?.contentType ?? BINARY;
  const name = sanitizedFilename(object.customMetadata?.filename ?? "");
  const headers = new Headers({
    "Content-Type": typeForServing(contentType),
    "Content-Disposition": contentDisposition(forcedDisposition(contentType) ?? dispositionOf(request), name),
    "Cache-Control": CACHE_CONTROL,
  });
  const lastModified = object.uploaded.toUTCString();
  // Rack::Files' check: the very time it was last modified.
  if (since === lastModified) return new Response(null, { status: 304, headers });

  const { size } = object;
  const ranges = byteRanges(range, size);
  if (ranges?.length === 0) {
    headers.set("Content-Length", String(UNSATISFIABLE.length));
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(UNSATISFIABLE, { status: 416, headers });
  }
  headers.set("Last-Modified", lastModified);
  if (ranges && ranges.length <= MAX_RANGES) return partialContent(request, files, stored, ranges, size, headers);

  // Rack::ConditionalGet's check, for the whole file: no earlier than that, unless the browser names a
  // version it has, which these answers never do.
  if (since !== null && !request.headers.has("If-None-Match") && Date.parse(since) >= Date.parse(lastModified)) {
    headers.delete("Content-Type");
    return new Response(null, { status: 304, headers });
  }
  headers.set("Content-Length", String(size));
  if (request.method === "HEAD" || size === 0) return new Response(null, { headers });
  const whole = hasBody(object) ? object : await files.get(stored);
  return whole ? new Response(whole.body, { headers }) : notFound();
}

/**
 * 206 with `ranges` of the file R2 keeps as `stored`: one as it is, or several as a multipart/byteranges
 * body, each part with the file's type for serving and its range, read from R2 in turn as the body is sent.
 */
async function partialContent(request: Request, files: R2Bucket, stored: string, ranges: ByteRange[], size: number, headers: Headers): Promise<Response> {
  const head = request.method === "HEAD";
  const read = ([start, end]: ByteRange) => files.get(stored, { range: { offset: start, length: end - start + 1 } });
  if (ranges.length === 1) {
    const [start, end] = ranges[0]!;
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    if (head) return new Response(null, { status: 206, headers });
    const part = await read(ranges[0]!);
    return part ? new Response(part.body, { status: 206, headers }) : notFound();
  }

  // `SecureRandom.hex`: 16 random bytes.
  const boundary = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const type = headers.get("Content-Type");
  const parts = ranges.map((range) => ({ range, heading: encoder.encode(`\r\n--${boundary}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${range[0]}-${range[1]}/${size}\r\n\r\n`) }));
  const closing = encoder.encode(`\r\n--${boundary}--\r\n`);
  const length = parts.reduce((total, { range: [start, end], heading }) => total + heading.length + end - start + 1, closing.length);
  headers.set("Content-Type", `multipart/byteranges; boundary=${boundary}`);
  headers.set("Content-Length", String(length));
  if (head) return new Response(null, { status: 206, headers });

  const { readable, writable } = new FixedLengthStream(length);
  void (async () => {
    const write = async (bytes: Uint8Array) => {
      const writer = writable.getWriter();
      await writer.write(bytes);
      writer.releaseLock();
    };
    try {
      for (const { range, heading } of parts) {
        await write(heading);
        const part = await read(range);
        if (!part) throw new Error("The file is gone");
        await part.body.pipeTo(writable, { preventClose: true });
      }
      await write(closing);
      await writable.close();
    } catch (error) {
      await writable.abort(error).catch(() => {});
    }
  })();
  return new Response(readable, { status: 206, headers });
}
