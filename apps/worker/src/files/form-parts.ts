// Reading a multipart/form-data body (RFC 7578) a part at a time, as it arrives, as Rack's multipart
// parser reads the form `curl -F` sends a bot's file in. `Request#formData` would hold all of it, and a
// request can bring 100 MB to a Worker that has 128 MB, so a file's bytes go on to R2 as they come.

/** The most a part's headers may take. */
const MAX_HEADER_BYTES = 16 * 1024;

/** The most a delimiter's line may have after it before its line break: room for transport padding. */
const MAX_PADDING_BYTES = 1024;

const CRLF = new Uint8Array([13, 10]);
const HEADERS_END = new Uint8Array([13, 10, 13, 10]);
const DASHES = new Uint8Array([45, 45]);
const SPACE = 32;
const TAB = 9;

/** Why a body can't be read as the form its type says it is, as Rack raises `EOFError` and its kin. */
export class FormError extends Error {}

/** A part of a form, as its headers describe it. */
export interface FormPart {
  /** The name of its field. */
  name: string;
  /** The name of the file it sends, or null for a field that sends text. */
  filename: string | null;
  /** The type its sender gave it, or null when it gave none. */
  contentType: string | null;
}

/**
 * The boundary of the form a request's `Content-Type` says its body is, or null when it isn't
 * multipart/form-data or names no boundary of 1 to 70 characters, as RFC 2046 has them.
 */
export function formBoundaryOf(contentType: string | null): string | null {
  const match = contentType?.match(/^\s*multipart\/form-data\s*;(?:.*;)?\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))\s*(?:;|$)/i);
  return match ? (match[1] ?? match[2]!) : null;
}

/** Whether a request's `Content-Type` says its body is multipart/form-data, whether or not it names a boundary. */
export const isFormType = (contentType: string | null): boolean => /^\s*multipart\/form-data\s*(?:;|$)/i.test(contentType ?? "");

/**
 * A form's parts, read from `body` as they arrive: `next` reads the next part's headers, skipping what
 * was left of the one before, and `read` its bytes, a chunk at a time.
 */
export class FormReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array> | null;
  private readonly delimiter: Uint8Array;
  /** What's arrived and hasn't been read. Before the first delimiter, it starts with a line break, which a delimiter has before it. */
  private buffer: Uint8Array = CRLF;
  private ended: boolean;
  private state: "preamble" | "part" | "between" | "done" = "preamble";

  /** Reads the form `body` brings, whose parts `boundary` divides; a request without a body has none. */
  constructor(body: ReadableStream<Uint8Array> | null, boundary: string) {
    this.reader = body?.getReader() ?? null;
    this.ended = this.reader === null;
    this.delimiter = new TextEncoder().encode(`\r\n--${boundary}`);
  }

  /** The next part's headers, or null after the last part. Throws a `FormError` when the form is malformed or ends early. */
  async next(): Promise<FormPart | null> {
    if (this.state === "part") while ((await this.read()) !== null);
    if (this.state === "preamble") await this.skipPreamble();
    if (this.state === "done") return null;
    // A delimiter that ends the form has two dashes after it; otherwise a line break follows it.
    if (startsWith(await this.fill(DASHES.length), DASHES)) {
      this.state = "done";
      return null;
    }
    await this.skipLine();
    const part = partOf(await this.headers());
    this.state = "part";
    return part;
  }

  /**
   * The next bytes of the part `next` read last, or null at its end. Throws a `FormError` when the form
   * ends early. The bytes are the reader's no longer, so they can be kept.
   */
  async read(): Promise<Uint8Array | null> {
    if (this.state !== "part") return null;
    for (;;) {
      const at = indexOf(this.buffer, this.delimiter);
      if (at === 0) {
        // Bytes that only look like a delimiter are the part's.
        if (!(await this.isDelimiter())) return this.take(this.delimiter.length);
        this.buffer = this.buffer.subarray(this.delimiter.length);
        this.state = "between";
        return null;
      }
      // Up to the delimiter, or all but what could be the start of one.
      const end = at > 0 ? at : this.buffer.length - this.delimiter.length + 1;
      if (end > 0) return this.take(end);
      if (!(await this.pull())) throw new FormError("The form ends before its last part does");
    }
  }

  /** Stops reading the body. */
  cancel(): void {
    this.reader?.cancel().catch(() => {});
  }

  /** Reads up to and past the form's first delimiter. */
  private async skipPreamble(): Promise<void> {
    for (;;) {
      const at = indexOf(this.buffer, this.delimiter);
      if (at >= 0) {
        this.buffer = this.buffer.subarray(at + this.delimiter.length);
        this.state = "between";
        return;
      }
      // Only what could be the start of the delimiter is kept, as the rest of a preamble means nothing.
      this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - this.delimiter.length + 1));
      if (!(await this.pull())) throw new FormError("The form has no parts");
    }
  }

  /**
   * Whether the delimiter at the start of what's arrived is one: it is when two dashes follow it, which
   * end the form, or a line break after any transport padding, as RFC 2046 has them. Otherwise it's the
   * part's bytes, as Rack's multipart parser reads a line of a file that starts with the boundary.
   */
  private async isDelimiter(): Promise<boolean> {
    const after = this.delimiter.length;
    if (startsWith((await this.fill(after + DASHES.length)).subarray(after), DASHES)) return true;
    for (let at = after; at <= after + MAX_PADDING_BYTES; at++) {
      const rest = (await this.fill(at + CRLF.length)).subarray(at);
      if (startsWith(rest, CRLF)) return true;
      if (rest[0] !== SPACE && rest[0] !== TAB) return false;
    }
    return false;
  }

  /** Reads past the rest of a delimiter's line: any transport padding, and its line break. */
  private async skipLine(): Promise<void> {
    for (;;) {
      const at = indexOf(this.buffer, CRLF);
      if (at >= 0 && at <= MAX_PADDING_BYTES) {
        this.buffer = this.buffer.subarray(at + CRLF.length);
        return;
      }
      if (this.buffer.length > MAX_PADDING_BYTES + CRLF.length) throw new FormError("A delimiter has no line break after it");
      if (!(await this.pull())) throw new FormError("The form ends after a delimiter");
    }
  }

  /** A part's headers, up to and past the empty line that ends them, which is all there is of them when there are none. */
  private async headers(): Promise<string> {
    if (startsWith(await this.fill(CRLF.length), CRLF)) {
      this.buffer = this.buffer.subarray(CRLF.length);
      return "";
    }
    for (;;) {
      const at = indexOf(this.buffer, HEADERS_END);
      if (at > MAX_HEADER_BYTES) throw new FormError("A part's headers are too long");
      if (at >= 0) {
        const headers = new TextDecoder().decode(this.buffer.subarray(0, at));
        this.buffer = this.buffer.subarray(at + HEADERS_END.length);
        return headers;
      }
      if (this.buffer.length > MAX_HEADER_BYTES) throw new FormError("A part's headers are too long");
      if (!(await this.pull())) throw new FormError("The form ends in a part's headers");
    }
  }

  /** The next `length` bytes that have arrived, which are read then. */
  private take(length: number): Uint8Array {
    // `pull` always makes a new buffer, so these bytes are never written again.
    const bytes = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return bytes;
  }

  /** What's arrived, once it's at least `length` bytes or the body has ended. */
  private async fill(length: number): Promise<Uint8Array> {
    while (this.buffer.length < length && (await this.pull()));
    return this.buffer;
  }

  /** Adds the body's next chunk to what's arrived, answering false once the body has ended. */
  private async pull(): Promise<boolean> {
    if (this.ended || !this.reader) return false;
    const { done, value } = await this.reader.read();
    if (done) {
      this.ended = true;
      return false;
    }
    const joined = new Uint8Array(this.buffer.length + value.length);
    joined.set(this.buffer);
    joined.set(value, this.buffer.length);
    this.buffer = joined;
    return true;
  }
}

/** A part as its headers describe it, as Rack's multipart parser reads its Content-Disposition and Content-Type. */
function partOf(headers: string): FormPart {
  const fields = new Map<string, string>();
  for (const line of headers.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) fields.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const disposition = parametersOf(fields.get("content-disposition") ?? "");
  // RFC 5987's `filename*=UTF-8''name`, which takes the place of `filename`.
  const extended = disposition.get("filename*")?.match(/^[^']*'[^']*'(.*)$/s)?.[1];
  const filename = extended ?? disposition.get("filename");
  return {
    name: disposition.get("name") ?? "",
    filename: filename === undefined ? null : filenameOf(filename),
    contentType: fields.get("content-type") || null,
  };
}

/** The parameters of a header such as Content-Disposition, by lowercase name: tokens, and quoted strings without their quotes. */
function parametersOf(header: string): Map<string, string> {
  const parameters = new Map<string, string>();
  for (const [, name, quoted, token] of header.matchAll(/;\s*([^\s=;]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g)) {
    parameters.set(name!.toLowerCase(), quoted ?? token!.trim());
  }
  return parameters;
}

/**
 * A file's name as a form sends it, as Rack's `get_filename` reads it: its percent-encoding undone when
 * every `%` in it starts an escape, as browsers escape quotes and line breaks, and its backslash escapes,
 * as curl escapes them, unless it has a backslash before anything else, as a Windows path has.
 */
function filenameOf(sent: string): string {
  let filename = sent;
  if (/%/.test(filename) && !/%(?![0-9a-f]{2})/i.test(filename)) {
    try {
      filename = decodeURIComponent(filename);
    } catch {
      // Escapes that aren't UTF-8 stay as they came.
    }
  }
  return /\\[^\\"]/.test(filename) ? filename : filename.replace(/\\(.)/g, "$1");
}

const startsWith = (bytes: Uint8Array, prefix: Uint8Array) => bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);

/** Where `needle` first appears in `haystack`, or -1. */
function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  const last = haystack.length - needle.length;
  for (let at = haystack.indexOf(needle[0]!); at >= 0 && at <= last; at = haystack.indexOf(needle[0]!, at + 1)) {
    let matched = 1;
    while (matched < needle.length && haystack[at + matched] === needle[matched]) matched++;
    if (matched === needle.length) return at;
  }
  return -1;
}
