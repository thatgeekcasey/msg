import { strip } from "@ember/richtext";
import { checkHost, type Resolve } from "./guard";
import { parseHttpUri, requestTarget, type HttpUri } from "./uri";

// Reading a page, or an image's content type, for a link preview: Campfire's `Opengraph::Location` and
// `Opengraph::Fetch`, with the parts of Net::HTTP they rely on. Every host, the first and each
// redirect's, passes the guard first.

/** The most a page may be, by its Content-Length and by what's read of it, after decompression. */
export const MAX_BODY_SIZE = 5 * 1024 * 1024;
/** Responses read for one fetch: the first and up to nine redirects. */
const MAX_RESPONSES = 10;
/** 5 seconds for a response's headers and for each read of its body. */
const IDLE_TIMEOUT_MS = 5_000;
/**
 * The subrequests one unfurl may make, of the 50 a Worker on the Free plan gets for a request, leaving
 * a few for the rest of the request. A lookup is two, and each response one.
 */
const MAX_SUBREQUESTS = 45;
const LOOKUP_SUBREQUESTS = 2;

/** Campfire sends Ruby's. This one says what's asking, with "bot" in it, which sites that serve tags only to bots look for. */
export const USER_AGENT = "Mozilla/5.0 (compatible; Emberbot; +https://github.com/NYLLON-SOFTWARE/ember-cloudflare)";

/** `FILES_AND_MEDIA_URL_REGEX`'s extensions, after the URL's `\bhttps?://\S+`. */
const FILE_OR_MEDIA_EXTENSION =
  /\.(?:zip|tar|tar\.gz|tar\.bz2|tar\.xz|gz|bz2|rar|7z|dmg|exe|msi|pkg|deb|iso|jpg|jpeg|png|gif|bmp|mp4|mov|avi|mkv|wmv|flv|heic|heif|mp3|wav|ogg|aac|wma|webm|ogv|mpg|mpeg)\b/;

/** What an unfurl reaches the Internet through: the Worker's `fetch` and DNS over HTTPS, or fakes in tests. */
export interface Network {
  fetch(request: Request): Promise<Response>;
  /** A host's IPv4 and IPv6 addresses. */
  resolve(host: string, signal: AbortSignal): Promise<string[]>;
}

/** One unfurl's way out: its network, its deadline, the subrequests it has made, and the hosts it has checked, once each. */
export class Outbound {
  private subrequests = 0;
  private readonly checkedHosts = new Map<string, Promise<void>>();

  constructor(
    private readonly network: Network,
    readonly deadline: AbortSignal,
  ) {}

  fetch(request: Request): Promise<Response> {
    this.spend(1);
    return this.network.fetch(request);
  }

  /** `checkHost`, asked once per host, so a page, its og:url and its image share their lookups. */
  checkHost(host: string): Promise<void> {
    let checked = this.checkedHosts.get(host);
    if (!checked) {
      const resolve: Resolve = async (name) => {
        this.spend(LOOKUP_SUBREQUESTS);
        return this.network.resolve(name, this.deadline);
      };
      checked = checkHost(host, resolve);
      this.checkedHosts.set(host, checked);
    }
    return checked;
  }

  private spend(subrequests: number): void {
    this.subrequests += subrequests;
    if (this.subrequests > MAX_SUBREQUESTS) throw new Error("Out of subrequests");
  }
}

/** `Location#valid?`: whether `url` is an http(s) URL whose host passes the guard. */
export async function isValidLocation(outbound: Outbound, url: string): Promise<boolean> {
  const uri = parseHttpUri(url);
  return uri !== null && (await passesGuard(outbound, uri));
}

/** `Location#read_html`: the page at `url`, unless the URL isn't valid, looks like a file or media, or can't be read. */
export async function readHtml(outbound: Outbound, url: string): Promise<Uint8Array | null> {
  const uri = parseHttpUri(url);
  if (!uri || looksLikeFileOrMedia(url) || !(await passesGuard(outbound, uri))) return null;
  return fetchDocument(outbound, uri).catch((error: unknown) => failed(url, error));
}

/** `Location#fetch_content_type`: the Content-Type of the last response to a HEAD that follows redirects, whatever its status. */
export async function fetchContentType(outbound: Outbound, url: string): Promise<string | null> {
  const uri = parseHttpUri(url);
  if (!uri || !(await passesGuard(outbound, uri))) return null;
  try {
    const { response } = await request(outbound, uri, "HEAD");
    discard(response);
    return response.headers.get("Content-Type");
  } catch (error) {
    return failed(url, error);
  }
}

const passesGuard = (outbound: Outbound, uri: HttpUri) =>
  outbound.checkHost(uri.host).then(
    () => true,
    () => false,
  );

function failed(url: string, error: unknown): null {
  console.warn(`Failed to fetch from ${hostOf(url)} (${error instanceof Error ? error.message : String(error)})`);
  return null;
}

/** How the logs name `url`: by its host alone, as its path and query can hold what someone wrote. */
export function hostOf(url: string): string {
  return parseHttpUri(url)?.host ?? "an address it can't read";
}

/**
 * `FILES_AND_MEDIA_URL_REGEX` (`\bhttps?://\S+\.(?:zip|…|mpeg)\b`), case-sensitive, anywhere in the URL.
 * The earliest `http(s)://` of a run without whitespace leaves the most room after it, so it's the only
 * one to try, and the check takes a single pass where the regex could backtrack from every one.
 */
export function looksLikeFileOrMedia(url: string): boolean {
  return url.split(/\s+/).some((run) => {
    const scheme = /(?<![A-Za-z0-9_])https?:\/\//.exec(run);
    // `\S+` needs at least one character before the extension's dot.
    return scheme !== null && FILE_OR_MEDIA_EXTENSION.test(run.slice(scheme.index + scheme[0].length + 1));
  });
}

/** `Fetch#fetch_document`: a 200 `text/html` response's body, at most `MAX_BODY_SIZE`, or null. */
async function fetchDocument(outbound: Outbound, uri: HttpUri): Promise<Uint8Array | null> {
  const { response, exchange } = await request(outbound, uri, "GET");
  try {
    const acceptable = response.status === 200 && mediaType(response.headers) === "text/html" && (contentLength(response.headers) ?? 0) <= MAX_BODY_SIZE;
    return acceptable ? await readBody(response, exchange) : null;
  } finally {
    if (!response.bodyUsed) discard(response);
  }
}

/** Sends `method` to `uri`, following redirects (any 3xx, 304 included) to absolute http(s) URLs that pass the guard. */
async function request(outbound: Outbound, uri: HttpUri, method: "GET" | "HEAD"): Promise<{ response: Response; exchange: Exchange }> {
  for (let responses = 0; responses < MAX_RESPONSES; responses++) {
    if (uri.port > 65_535) throw new Error("bad URI");
    // Net::HTTP sends neither the userinfo nor the fragment.
    const port = uri.port === (uri.scheme === "https" ? 443 : 80) ? "" : `:${uri.port}`;
    const exchange = new Exchange(outbound.deadline);
    const sent = new Request(`${uri.scheme}://${uri.host}${port}${requestTarget(uri)}`, {
      method,
      headers: { Accept: "*/*", "User-Agent": USER_AGENT },
      redirect: "manual",
      signal: exchange.signal,
    });
    const response = await exchange.within(outbound.fetch(sent));
    if (response.status < 300 || response.status >= 400) return { response, exchange };
    discard(response);
    uri = await redirectTarget(outbound, response.headers.get("Location"));
  }
  throw new Error("Opengraph::Fetch::TooManyRedirectsError");
}

async function redirectTarget(outbound: Outbound, location: string | null): Promise<HttpUri> {
  // A relative Location parses, but isn't an http(s) URL.
  const uri = location === null ? null : parseHttpUri(location);
  if (!uri) throw new Error("Opengraph::Fetch::RedirectDeniedError");
  await outbound.checkHost(uri.host);
  return uri;
}

/** Reads a body, giving up once it's more than `MAX_BODY_SIZE`. */
async function readBody(response: Response, exchange: Exchange): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await exchange.within(reader.read());
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_SIZE) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * `Net::HTTPHeader#content_type`: the media type before any ";", its type and subtype each stripped but
 * not lowercased, so `Text/HTML` isn't `text/html`.
 */
function mediaType(headers: Headers): string | null {
  const header = headers.get("Content-Type");
  if (header === null) return null;
  const [type = "", subtype] = header.split(";")[0]!.split("/");
  return subtype === undefined ? strip(type) : `${strip(type)}/${strip(subtype)}`;
}

/** `Net::HTTPHeader#content_length`: the first run of digits, which a header without any is an error for. */
function contentLength(headers: Headers): number | null {
  const header = headers.get("Content-Length");
  if (header === null) return null;
  const digits = /\d+/.exec(header);
  if (!digits) throw new Error("wrong Content-Length format");
  return Number(digits[0]);
}

/** Stops reading a response nobody needs, so its connection is let go. */
const discard = (response: Response) => void response.body?.cancel().catch(() => {});

/** One request's time limits: within the unfurl's deadline, its response must start, and each read of its body end, within `IDLE_TIMEOUT_MS`. */
class Exchange {
  private readonly timedOut = new AbortController();
  readonly signal: AbortSignal;

  constructor(deadline: AbortSignal) {
    this.signal = AbortSignal.any([deadline, this.timedOut.signal]);
  }

  /** Waits for `pending`, aborting the request if it takes longer than `IDLE_TIMEOUT_MS`. */
  async within<T>(pending: Promise<T>): Promise<T> {
    const timer = setTimeout(() => this.timedOut.abort(new DOMException("No answer in time", "TimeoutError")), IDLE_TIMEOUT_MS);
    try {
      return await pending;
    } finally {
      clearTimeout(timer);
    }
  }
}
