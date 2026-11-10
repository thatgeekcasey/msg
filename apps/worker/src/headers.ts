import { isHttps } from "./auth";
import { contentSecurityPolicy } from "./csp";
import { escapeHtml } from "./encoding";
import type { Env } from "./env";
import { isLoopback } from "./loopback";
import { urlOf } from "./request-url";
import { versionOf } from "./version";

// What Campfire adds around everything it answers, for every answer the Worker makes: Rails' default
// headers, the version, and HTTPS, which its `force_ssl` insists on and pins with HSTS. Static files
// come straight from the assets with none of them.

/** `config.action_dispatch.default_headers`, as Rails 7.1 sets them. */
const DEFAULT_HEADERS: [string, string][] = [
  ["X-Frame-Options", "SAMEORIGIN"],
  ["X-XSS-Protection", "0"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Permitted-Cross-Domain-Policies", "none"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
];

/**
 * `ssl_options = { hsts: { subdomains: true } }`, but for its subdomains: two years. A custom domain
 * (custom-domain.ts) can be a domain's apex, where `includeSubDomains` would hold every other site under
 * it to HTTPS for as long.
 */
const HSTS = "max-age=63072000";

/** Whether the request came to localhost or a loopback address, where `wrangler dev` serves and nobody on the Internet can reach. */
export const isLoopbackHost = (request: Request) => isLoopback(urlOf(request));

/**
 * Whether the request's host has to be reached over HTTPS. A loopback host doesn't, wherever it's
 * served: browsers already treat plain HTTP there as secure, and HSTS on it would send every other
 * server on the machine to HTTPS for two years.
 */
export const requiresHttps = (request: Request, env: Env) => !env.DISABLE_SSL?.trim() && !isLoopbackHost(request);

/**
 * Sends plain HTTP to the same address over HTTPS, without its port: 301, with a link to follow when
 * it's a GET.
 */
export function redirectToHttps(request: Request): Response {
  const { hostname, pathname, search } = urlOf(request);
  const headers = new Headers();
  const location = `https://${hostname}${pathname}${search}`;
  headers.set("Location", location);
  if (request.method === "GET" || request.method === "HEAD") headers.set("Content-Type", "text/html; charset=utf-8");
  const body = request.method === "GET" ? `<a href="${escapeHtml(location)}">Moved Permanently</a>.\n\n` : null;
  return new Response(body, { status: 301, headers });
}

interface Additions {
  /** X-Version and X-Rev. */
  version: boolean;
  /**
   * The Content-Security-Policy (csp.ts), which a room's files go without: nothing served from
   * /files/ can run script, as HTML and SVG go as downloads, and Chrome's PDF viewer is particular
   * about a policy on what it shows.
   */
  policy?: boolean;
}

/**
 * `response` with the headers every answer carries: Rails' defaults, where it hasn't set its own; the
 * version, if asked; HSTS, wherever HTTPS is required; and the policy, where it hasn't set its own. A
 * socket's upgrade goes as it is.
 */
export function withHeaders(response: Response, request: Request, env: Env, { version, policy = true }: Additions): Response {
  if (response.webSocket) return response;
  const answer = changeable(response);
  for (const [name, value] of DEFAULT_HEADERS) {
    if (!answer.headers.has(name)) answer.headers.set(name, value);
  }
  if (policy && !answer.headers.has("Content-Security-Policy")) answer.headers.set("Content-Security-Policy", contentSecurityPolicy(request));
  if (version) {
    answer.headers.set("X-Version", versionOf(env));
    // Rails leaves out a header that's nil, but sends one that's blank.
    if (env.GIT_REVISION !== undefined) answer.headers.set("X-Rev", env.GIT_REVISION);
  }
  if (isHttps(request) && requiresHttps(request, env)) answer.headers.set("Strict-Transport-Security", HSTS);
  return answer;
}

/** A header nothing sets. */
const UNSET_HEADER = "X-Ember-Unset";

/**
 * `response` itself where its headers can change, as those of the Worker's own answers can, or else
 * a copy: the assets' and Durable Objects' answers can't be changed. Copying every answer showed in
 * profiles of cheap requests.
 */
function changeable(response: Response): Response {
  try {
    // Deleting a header that isn't there changes nothing, and throws where the headers are immutable.
    response.headers.delete(UNSET_HEADER);
    return response;
  } catch {
    return new Response(response.body, response);
  }
}
