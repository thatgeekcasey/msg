// Where a push subscription may send pushes, but for its check that the endpoint resolves to a public
// address: a Worker can't resolve a name before fetching it, and can't reach a private network anyway.
// Pushes go wherever `fetch` reads the endpoint as going, so `URL` must agree with `parseEndpoint` on
// its port and host: that parser reads on past a "\", where `URL` ends the host, and takes a port such
// as "+443", which `URL` refuses.

/** Campfire's `Push::Subscription::PERMITTED_ENDPOINT_HOSTS`: the push services of Chrome, Firefox, Safari and Edge. */
const PERMITTED_HOSTS = ["jmt17.google.com", "fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "notify.windows.com"];

/** Rust's `char::is_whitespace`, Unicode's White_Space, which differs from JavaScript's `\s` at U+0085 and U+FEFF. */
const WHITESPACE = /[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const BLANK = new RegExp(`^${WHITESPACE.source}*$`, "u");

/**
 * What's wrong with `endpoint`, in Campfire's words: "can't be blank", which comes with "is not a valid URL",
 * or one of "is not a valid URL", "must use HTTPS", "must use the default HTTPS port" and "is not a
 * permitted push service". Nothing, when pushes may go there.
 */
export function endpointErrors(endpoint: string): string[] {
  const errors = BLANK.test(endpoint) ? ["can't be blank"] : [];
  const uri = parseEndpoint(endpoint);
  const url = URL.parse(endpoint);
  if (!uri || !url) errors.push("is not a valid URL");
  else if (uri.scheme !== "https") errors.push("must use HTTPS");
  else if (uri.port !== 443 || url.port !== "") errors.push("must use the default HTTPS port");
  else if (!isPermittedHost(uri.host) || !isPermittedHost(url.hostname)) errors.push("is not a permitted push service");
  return errors;
}

const isPermittedHost = (host: string) => {
  const lowercase = host.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return lowercase !== "" && PERMITTED_HOSTS.some((permitted) => lowercase === permitted || lowercase.endsWith(`.${permitted}`));
};

/**
 * The parts of an endpoint that are checked: the scheme, lowercased, and the host and port of what
 * follows "://", up to its path, query or fragment and after any user info, the port defaulting to the
 * scheme's. Null for no scheme, any whitespace, or a port that isn't a number up to 65535.
 */
function parseEndpoint(endpoint: string): { scheme: string; host: string; port: number | null } | null {
  if (endpoint === "" || WHITESPACE.test(endpoint)) return null;
  const separator = endpoint.indexOf("://");
  if (separator < 0) return null;
  const scheme = endpoint.slice(0, separator).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const rest = endpoint.slice(separator + 3);
  const authority = rest.split(/[/?#]/, 1)[0]!.split("@").at(-1)!;
  const colon = authority.lastIndexOf(":");
  let host = authority;
  let port: number | null = null;
  if (colon >= 0 && !authority.endsWith("]")) {
    // Rust's `u16::from_str`: digits, with an optional leading "+".
    const digits = authority.slice(colon + 1);
    if (!/^\+?\d+$/.test(digits) || Number(digits) > 65_535) return null;
    host = authority.slice(0, colon);
    port = Number(digits);
  }
  return { scheme, host, port: port ?? (scheme === "https" ? 443 : scheme === "http" ? 80 : null) };
}
