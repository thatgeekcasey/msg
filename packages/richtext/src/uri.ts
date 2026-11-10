// The slice of Ruby's `URI.parse` (uri 1.1, its RFC 3986 parser) that link previews read their addresses
// with, and that reads a message as a tweet's address: which strings parse, into which parts, and which
// raise. Ruby's patterns are written out as JavaScript's, whose backtracking finds the same matches:
// nothing Ruby matches possessively could give back a character that what follows it would take.

/** A URI's parts, as `URI::Generic` keeps them once it's parsed. */
export interface Uri {
  /** Lowercase, as `URI::Generic` sets it. */
  scheme?: string;
  userinfo?: string;
  host?: string;
  port?: bigint;
  path?: string;
  opaque?: string;
  query?: string;
  fragment?: string;
}

/**
 * `URI::InvalidComponentError`, which a malformed mailto: URL raises as it parses, and nothing that
 * reads link previews rescues. `URI::InvalidURIError` is rescued, so `parseUri` answers nothing for it.
 */
export class InvalidComponentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidComponentError";
  }
}

const HEX = "[0-9A-Fa-f]";
const H16 = `${HEX}{1,4}`;
const PCT = `%${HEX}${HEX}`;
const DEC_OCTET = "(?:[1-9]\\d|1\\d{2}|2[0-4]\\d|25[0-5]|\\d)";
const IPV4 = `${DEC_OCTET}\\.${DEC_OCTET}\\.${DEC_OCTET}\\.${DEC_OCTET}`;
const LS32 = `(?:${H16}:${H16}|${IPV4})`;
// Ruby's third form wants hex digits before its "::", which RFC 3986 makes optional
const IPV6 = [
  `(?:${H16}:){6}${LS32}`,
  `::(?:${H16}:){5}${LS32}`,
  `${HEX}{1,4}?::(?:${H16}:){4}${LS32}`,
  `(?:(?:${H16}:)?${H16})?::(?:${H16}:){3}${LS32}`,
  `(?:(?:${H16}:){0,2}${H16})?::(?:${H16}:){2}${LS32}`,
  `(?:(?:${H16}:){0,3}${H16})?::${H16}:${LS32}`,
  `(?:(?:${H16}:){0,4}${H16})?::${LS32}`,
  `(?:(?:${H16}:){0,5}${H16})?::${H16}`,
  `(?:(?:${H16}:){0,6}${H16})?::`,
].join("|");
const IP_LITERAL = `\\[(?:${IPV6}|v${HEX}+\\.[!$&-.0-9:;=A-Z_a-z~]+)\\]`;
const HOST = `(?:${IP_LITERAL}|${IPV4}|(?:${PCT}|[!$&-.0-9;=A-Z_a-z~])*)`;
const USERINFO = `(?:${PCT}|[!$&-.0-9:;=A-Z_a-z~])*`;
const SEG = `(?:${PCT}|[!$&-.0-9:;=@A-Z_a-z~/])`;
const SEG_NC = `(?:${PCT}|[!$&-.0-9;=@A-Z_a-z~])`;
const QUERY_AND_FRAGMENT = `(?:\\?(?<query>[^#]*))?(?:#(?<fragment>(?:${PCT}|[!$&-.0-9:;=@A-Z_a-z~/?])*))?$`;

/** `RFC3986_Parser::RFC3986_URI` */
const ABSOLUTE = new RegExp(
  `^(?<scheme>[A-Za-z][+\\-.0-9A-Za-z]*):` +
    `(?://(?:(?<userinfo>${USERINFO})@)?(?<host>${HOST})(?::(?<port>\\d*))?(?<abempty>(?:/${SEG}*)?)` +
    `|(?<absolute>/(?:(?!/)${SEG}+)?)|(?<rootless>(?!/)${SEG}+)|(?<empty>))${QUERY_AND_FRAGMENT}`,
);

/** `RFC3986_Parser::RFC3986_relative_ref` */
const RELATIVE = new RegExp(
  `^(?://(?:(?<userinfo>${USERINFO})@)?(?<host>${HOST}(?<!/))?(?::(?<port>\\d*))?(?<abempty>(?:/${SEG}*)?)` +
    `|(?<absolute>/${SEG}*)|(?<noscheme>${SEG_NC}+(?:/${SEG}*)?)|(?<empty>))${QUERY_AND_FRAGMENT}`,
);

/** The `DEFAULT_PORT`s of the classes `URI.for` picks by scheme. */
const DEFAULT_PORTS = new Map<string | undefined, bigint>([
  ["http", 80n],
  ["https", 443n],
  ["ws", 80n],
  ["wss", 443n],
  ["ftp", 21n],
  ["ldap", 389n],
  ["ldaps", 636n],
]);

/**
 * `URI.parse(value)`: the parts `RFC3986_Parser#split` finds, as `URI::Generic` and the class for
 * the scheme set them up, or nothing where Ruby raises `URI::InvalidURIError`. Throws
 * `InvalidComponentError` where Ruby raises it. Only what link previews read is set up: an FTP
 * URL's path keeps its type code, and its leading slash, which Ruby moves.
 */
export function parseUri(value: string): Uri | undefined {
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(value)) return undefined;
  const uri = split(value);
  if (uri === undefined) return undefined;
  if (uri.query !== undefined) {
    // `query=` takes out tabs and newlines, refuses a `%` before two characters that aren't hex digits, and escapes the rest
    const query = uri.query.replace(/[\t\r\n]/g, "");
    if (/%[^0-9A-Fa-f][^0-9A-Fa-f]/.test(query)) return undefined;
    uri.query = query.replace(/[^!$-&(-;=?-_a-~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  }
  uri.port ??= DEFAULT_PORTS.get(uri.scheme);
  return setUpForScheme(uri);
}

function split(value: string): Uri | undefined {
  const absolute = ABSOLUTE.exec(value)?.groups;
  if (absolute) {
    const { scheme, rootless, query, fragment } = absolute;
    // `set_scheme` lowercases it; a path with no slash before it is opaque, its query and all
    if (rootless !== undefined) return { scheme: scheme!.toLowerCase(), opaque: query === undefined ? rootless : `${rootless}?${query}`, fragment };
    return { ...authority(absolute), scheme: scheme!.toLowerCase(), path: absolute.abempty ?? absolute.absolute ?? absolute.empty, query, fragment };
  }
  const relative = RELATIVE.exec(value)?.groups;
  if (!relative) return undefined;
  const path = relative.abempty ?? relative.absolute ?? relative.noscheme ?? relative.empty;
  // Ruby's optional host matches nothing after a userinfo's "@", which JavaScript's `?` won't capture
  const host = relative.host ?? (relative.userinfo === undefined ? undefined : "");
  return { ...authority({ ...relative, host }), path, query: relative.query, fragment: relative.fragment };
}

/** The authority's parts as `URI::Generic` keeps them: userinfo split at its first colon and joined again, and the port a number. */
function authority({ userinfo, host, port }: Record<string, string | undefined>): Pick<Uri, "userinfo" | "host" | "port"> {
  // `"".split(":", 2)` names no user, and then there's no userinfo
  return { userinfo: userinfo === "" ? undefined : userinfo, host, port: port === undefined || port === "" ? undefined : BigInt(port) };
}

/** What the initializers of the classes `URI.for` picks by scheme check and change. */
function setUpForScheme(uri: Uri): Uri | undefined {
  switch (uri.scheme) {
    case "mailto": {
      const opaque = uri.opaque ?? (uri.query === undefined ? undefined : `?${uri.query}`);
      if (opaque === undefined) throw new InvalidComponentError("missing opaque part for mailto URL");
      const to = opaque.split("?", 1)[0]!;
      if (!/^(?:[^@,;]+@[^@,;]+(?:$|[,;]))*$/.test(to)) throw new InvalidComponentError(`unrecognised opaque part for mailtoURL: ${opaque}`);
      return { ...uri, opaque };
    }
    case "ldap":
    case "ldaps":
      return uri.fragment === undefined && uri.path !== undefined ? uri : undefined;
    case "ftp":
      return uri.path === undefined ? undefined : uri;
    case "file":
      // `URI::File` takes no userinfo or port, and its host is never missing or "localhost"
      return { ...uri, userinfo: undefined, port: undefined, host: uri.host === undefined || uri.host === "localhost" ? "" : uri.host };
    default:
      return uri;
  }
}

/** `uri.is_a?(URI::HTTP)`, which an `URI::HTTPS` is too. */
export const isHttp = (uri: Uri) => uri.scheme === "http" || uri.scheme === "https";

/** `URI::Generic#to_s` */
export function uriToString(uri: Uri): string {
  let out = uri.scheme === undefined ? "" : `${uri.scheme}:`;
  if (uri.opaque !== undefined) {
    out += uri.opaque;
  } else {
    const path = uri.path ?? "";
    if (uri.host !== undefined || uri.scheme === "file" || uri.scheme === "postgres") out += "//";
    if (uri.userinfo !== undefined) out += `${uri.userinfo}@`;
    out += uri.host ?? "";
    if (uri.port !== undefined && uri.port !== DEFAULT_PORTS.get(uri.scheme)) out += `:${uri.port}`;
    if ((uri.host !== undefined || uri.port !== undefined) && path !== "" && !path.startsWith("/")) out += "/";
    out += path;
    if (uri.query !== undefined) out += `?${uri.query}`;
  }
  return uri.fragment === undefined ? out : `${out}#${uri.fragment}`;
}
