import { parseIpv6 } from "./addresses";

// The slice of Ruby's `URI.parse` (uri 1.1, RFC 3986 parser) that link previews rely on: which strings
// parse as an absolute http(s) URL, and into what. A preview can't use anything else `URI.parse` might
// answer (another scheme, a relative reference, an http URL without a host, or an error), so all of that
// is null here.

export interface HttpUri {
  /** Lowercased, as `URI::Generic#set_scheme` does. */
  scheme: "http" | "https";
  userinfo: string | null;
  /** As written, with the brackets of an IP literal. */
  host: string;
  /** The URL's port, or else the scheme's. */
  port: number;
  /** Empty, or from the first "/". */
  path: string;
  /** Escaped as `URI::Generic#query=` escapes it. */
  query: string | null;
  fragment: string | null;
}

const DEFAULT_PORTS = { http: 80, https: 443 } as const;

const isAscii = (value: string) => /^[\x00-\x7f]*$/.test(value);
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isHexDigit = (c: string | undefined) => c !== undefined && /^[0-9A-Fa-f]$/.test(c);

/** RFC 3986's unreserved characters and sub-delims, as Ruby's `[!$&-.0-9;=A-Z_a-z~]`. */
const isUnreservedOrSubDelim = (c: string) => /^[!$&-.0-9;=A-Z_a-z~]$/.test(c);
const isUserinfoChar = (c: string) => isUnreservedOrSubDelim(c) || c === ":";
const isSegmentChar = (c: string) => isUnreservedOrSubDelim(c) || c === ":" || c === "@" || c === "/";
const isFragmentChar = (c: string) => isSegmentChar(c) || c === "?";

/** `URI.parse(value)`, when that's an http or https URL with a host. */
export function parseHttpUri(value: string): HttpUri | null {
  if (!isAscii(value)) return null;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(value)?.[0].slice(0, -1).toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;
  const hierStart = scheme.length + 1;
  const tail = splitQueryAndFragment(value, hierStart);
  // Only an authority gives a host: a path-absolute, rootless or empty hier-part has none.
  if (!tail || !value.startsWith("//", hierStart)) return null;
  const authority = parseAuthority(value, hierStart + 2, tail.hierEnd);
  if (!authority) return null;
  // path-abempty: (?:/segment)*
  if (authority.end < tail.hierEnd && (value[authority.end] !== "/" || takeWhile(value, authority.end, tail.hierEnd, isSegmentChar) !== tail.hierEnd)) return null;
  // URI::Generic#initialize assigns the query through `query=`, which refuses bad escapes.
  const query = tail.query === null ? null : escapeQuery(tail.query);
  if (query === undefined) return null;
  return {
    scheme,
    userinfo: authority.userinfo,
    host: authority.host,
    port: authority.port ?? DEFAULT_PORTS[scheme],
    path: value.slice(authority.end, tail.hierEnd),
    query,
    fragment: tail.fragment,
  };
}

/** `URI::Generic#to_s` */
export function uriToString(uri: HttpUri): string {
  const userinfo = uri.userinfo === null ? "" : `${uri.userinfo}@`;
  const port = uri.port === DEFAULT_PORTS[uri.scheme] ? "" : `:${uri.port}`;
  const query = uri.query === null ? "" : `?${uri.query}`;
  const fragment = uri.fragment === null ? "" : `#${uri.fragment}`;
  return `${uri.scheme}://${userinfo}${uri.host}${port}${uri.path}${query}${fragment}`;
}

/** `URI::HTTP#request_uri`: the path, at least "/", and the query. */
export function requestTarget(uri: HttpUri): string {
  const target = uri.query === null ? uri.path : `${uri.path}?${uri.query}`;
  return target.startsWith("/") ? target : `/${target}`;
}

/** Consumes `(?:%\h\h|[class])*` from `start`, up to `end`, and answers where it stopped. */
function takeWhile(value: string, start: number, end: number, isAllowed: (c: string) => boolean): number {
  let i = start;
  for (;;) {
    if (i + 2 < end && value[i] === "%" && isHexDigit(value[i + 1]) && isHexDigit(value[i + 2])) i += 3;
    else if (i < end && isAllowed(value[i]!)) i++;
    else return i;
  }
}

/** Splits `(?:\?(?<query>[^#]*+))?(?:\#(?<fragment>FRAGMENT))?\z` off the end of the hier-part. */
function splitQueryAndFragment(value: string, start: number): { hierEnd: number; query: string | null; fragment: string | null } | null {
  const hierEnd = indexOfEither(value, "?", "#", start);
  let i = hierEnd;
  let query: string | null = null;
  if (value[i] === "?") {
    const queryEnd = indexOfEither(value, "#", "#", i + 1);
    query = value.slice(i + 1, queryEnd);
    i = queryEnd;
  }
  let fragment: string | null = null;
  if (value[i] === "#") {
    if (takeWhile(value, i + 1, value.length, isFragmentChar) !== value.length) return null;
    fragment = value.slice(i + 1);
  }
  return { hierEnd, query, fragment };
}

/** Where `a` or `b` first appears from `start`, or the end of `value`. */
function indexOfEither(value: string, a: string, b: string, start: number): number {
  for (let i = start; i < value.length; i++) if (value[i] === a || value[i] === b) return i;
  return value.length;
}

/** The authority between `start` and `limit`: `(?:userinfo@)?host(?::port)?`, followed by "/" or nothing. */
function parseAuthority(value: string, start: number, limit: number): { userinfo: string | null; host: string; port: number | null; end: number } | null {
  let i = start;
  let userinfo: string | null = null;
  const userinfoEnd = takeWhile(value, i, limit, isUserinfoChar);
  if (userinfoEnd < limit && value[userinfoEnd] === "@") {
    userinfo = value.slice(i, userinfoEnd);
    i = userinfoEnd + 1;
  }
  const hostEnd = ipLiteralEnd(value, i, limit) ?? takeWhile(value, i, limit, isUnreservedOrSubDelim);
  let end = hostEnd;
  let port: number | null = null;
  if (end < limit && value[end] === ":") {
    let digitsEnd = end + 1;
    while (digitsEnd < limit && isDigit(value[digitsEnd])) digitsEnd++;
    const digits = value.slice(end + 1, digitsEnd);
    port = digits === "" ? null : Number(digits);
    end = digitsEnd;
  }
  if (end < limit && value[end] !== "/") return null;
  return { userinfo, host: value.slice(i, hostEnd), port, end };
}

/** The end of the IP literal (a bracketed IPv6 address or IPvFuture) at `start`, if there's one. */
function ipLiteralEnd(value: string, start: number, limit: number): number | null {
  if (value[start] !== "[") return null;
  const close = value.indexOf("]", start);
  if (close < 0 || close >= limit) return null;
  const inner = value.slice(start + 1, close);
  const future = /^[vV]([0-9A-Fa-f]+)\.(.+)$/.exec(inner);
  const valid = future ? [...future[2]!].every(isUserinfoChar) : parseIpv6(inner) !== null;
  return valid ? close + 1 : null;
}

/**
 * `URI::Generic#query=`: undefined for a "%" followed by two characters that aren't hex digits, else the
 * query without tabs and newlines, and with anything outside `[!$-&(-;=?-_a-~]` that isn't part of an
 * escape escaped.
 */
function escapeQuery(query: string): string | undefined {
  const cleaned = query.replace(/[\t\r\n]/g, "");
  for (let i = 0; i + 2 < cleaned.length; i++) {
    if (cleaned[i] === "%" && !isHexDigit(cleaned[i + 1]) && !isHexDigit(cleaned[i + 2])) return undefined;
  }
  let escaped = "";
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i]!;
    const isEscape = c === "%" && i + 2 < cleaned.length && isHexDigit(cleaned[i + 1]) && isHexDigit(cleaned[i + 2]);
    escaped += isEscape || /^[!$-&(-;=?-_a-~]$/.test(c) ? c : `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return escaped;
}
