import { EMAIL_ADDRESS_TOO_LONG, isAppPage, NAME_RESERVED, NAME_TOO_LONG, WORKSPACE_PRELOADS, workspacePageOf } from "@ember/protocol";
import { sessionToken } from "./auth";
import { contentSecurityPolicy, inlineScriptHashes } from "./csp";
import type { Env } from "./env";
import { notFound } from "./error-pages";
import { urlOf } from "./request-url";

// What the Worker answers for pages: the app's, those it serves itself, such as setup's, the join
// link's and open sign-up's, and their forms, which post to the API.

/**
 * One of the built app's pages, from its static assets, with headers this response can change. The
 * request's own headers go along, so a browser that has the page already hears it's unchanged. Its
 * policy names the page's inline script, which applies the saved appearance before first paint, and
 * with `turnstile` lets Turnstile's check load, as the open sign-up page shows it.
 */
export async function appPage(request: Request, env: Env, path: string, { turnstile = false } = {}): Promise<Response> {
  const page = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: request.method, headers: request.headers }));
  const response = new Response(page.body, page);
  response.headers.set("Link", preloadsFor(request));
  response.headers.append("Vary", "Cookie");
  response.headers.set("Content-Security-Policy", contentSecurityPolicy(request, await appScriptHashes(request, env, page.headers.get("ETag")), turnstile));
  return response;
}

/**
 * The hashes of the app page's inline scripts, read from the built page once per build, which its
 * ETag tells apart. A read that fails is forgotten, so the next page reads again, and the page it
 * failed for names no script, which costs it the saved appearance until the app applies it.
 */
let appScripts: { etag: string | null; hashes: Promise<string[]> } | undefined;

function appScriptHashes(request: Request, env: Env, etag: string | null): Promise<string[]> {
  if (!appScripts || appScripts.etag !== etag) {
    const hashes: Promise<string[]> = env.ASSETS.fetch(new URL("/", request.url))
      .then((page) => page.text())
      .then(inlineScriptHashes)
      .catch((error: unknown) => {
        console.error("Couldn't read the app's page for its scripts' hashes", error);
        if (appScripts?.hashes === hashes) appScripts = undefined;
        return [];
      });
    appScripts = { etag, hashes };
  }
  return appScripts.hashes;
}

/**
 * What the app asks for as it starts, for the browser to fetch with the page rather than once the app
 * has loaded, which the app's own first requests then take: on every page, whether Ember is set up and
 * who's signed in, and on a page with the sidebar, for a browser with a session, its rooms and the
 * people directory. Which depends on the session cookie, so the page varies with it.
 */
function preloadsFor(request: Request): string {
  const paths = ["/api/bootstrap"];
  if (workspacePageOf(urlOf(request).pathname) && sessionToken(request)) paths.push(...WORKSPACE_PRELOADS);
  return paths.map((path) => `<${path}>; rel=preload; as=fetch; crossorigin`).join(", ");
}

/** `pathname`: with runs of slashes squeezed and no trailing slash. */
const normalized = (pathname: string) => pathname.replace(/\/{2,}/g, "/").replace(/(.)\/$/, "$1");

/**
 * Any other path: the app's page where the app shows one, one of the built app's files, or Campfire's
 * 404 page, which the assets answer for a path they don't have (`not_found_handling`). A path with extra
 * slashes sends the browser to the page's own address, which the app reads.
 */
export async function anyOtherPage(request: Request, env: Env, pathname: string): Promise<Response> {
  // The assets answer 405 to anything else.
  if (request.method !== "GET" && request.method !== "HEAD") return notFound(request);
  if (isAppPage(pathname)) return appPage(request, env, "/");
  const path = normalized(pathname);
  if (path !== pathname && isAppPage(path)) {
    const { origin, search } = urlOf(request);
    return new Response(null, { status: 307, headers: { Location: `${origin}${path}${search}` } });
  }
  return env.ASSETS.fetch(request);
}

export const empty = (status: number) => new Response(null, { status });

export function withCookies(response: Response, ...cookies: Array<string | null>): Response {
  for (const cookie of cookies) if (cookie) response.headers.append("Set-Cookie", cookie);
  return response;
}

/** Sends the browser to the app's home page. */
export const home = (request: Request) => new Response(null, { status: 302, headers: { Location: new URL("/", request.url).href } });

/** Sends the browser to sign in. */
export const signInFirst = (request: Request) => new Response(null, { status: 302, headers: { Location: new URL("/session/new", request.url).href } });

/** A form's answer, which no cache keeps, since it can sign someone in. */
export const formAnswer = (data: unknown, status: number, ...cookies: Array<string | null>) =>
  withCookies(Response.json(data, { status, headers: { "Cache-Control": "no-store" } }), ...cookies);

/**
 * The answer to a sign-up form `parseSignUp` refused: a name or email address longer than Ember keeps,
 * or @ember's name, is unprocessable (422) on its field, as a password too long is, and a field missing
 * is a bad request.
 */
export function signUpRefusal(error: string): Response {
  if (error === NAME_TOO_LONG || error === NAME_RESERVED) return formAnswer({ error, field: "name" }, 422);
  if (error === EMAIL_ADDRESS_TOO_LONG) return formAnswer({ error, field: "emailAddress" }, 422);
  return formAnswer({ error }, 400);
}
