import type { User } from "@ember/protocol";
import { toBase64url } from "./encoding";
import { guestSignIn, type Env } from "./env";
import { hmacKey } from "./hmac";
import { urlOf } from "./request-url";
import { workspace, type Credentials } from "./workspace";
import type { Client } from "./workspace-store";

// Sessions ride an HttpOnly cookie holding a random token, and the Workspace keeps only its digest. This
// is Campfire's session cookie, with the secret that signs Campfire's cookie keying the digest instead.

/** As long as browsers keep a cookie, 400 days, standing in for Campfire's 20 years. */
const SESSION_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
/** 32 random bytes in base64url. */
const SESSION_TOKEN = /^[\w-]{43}$/;

const encoder = new TextEncoder();

export const isHttps = (request: Request) => urlOf(request).protocol === "https:";

/**
 * Over HTTPS the `__Host-` prefix makes browsers refuse the cookie from any other origin, such as
 * another Worker on workers.dev. Plain HTTP, where `wrangler dev` and the browser tests run, can't
 * use it.
 */
export const hostCookieName = (request: Request, name: string) => (isHttps(request) ? `__Host-${name}` : name);

/** The `Set-Cookie` that keeps `value` as the cookie `name` for `maxAge` seconds, out of reach of scripts and other sites' requests. */
export function hostCookie(request: Request, name: string, value: string, maxAge: number): string {
  const secure = isHttps(request) ? "; Secure" : "";
  return `${hostCookieName(request, name)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

const SESSION_COOKIE = "session_token";

/** The `Set-Cookie` that signs this browser in with `token`, or refreshes how long it stays signed in. */
export const sessionCookie = (request: Request, token: string) => hostCookie(request, SESSION_COOKIE, token, SESSION_MAX_AGE_SECONDS);

/** The `Set-Cookie` that makes this browser forget its session. */
export const expiredSessionCookie = (request: Request) => hostCookie(request, SESSION_COOKIE, "", 0);

/** The values of the request's cookies named `name`, in the order it sent them. */
export function cookieValues(request: Request, name: string): string[] {
  const values: string[] = [];
  for (const pair of request.headers.get("Cookie")?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator).trim() === name) values.push(pair.slice(separator + 1).trim());
  }
  return values;
}

/** The session token the request's cookie carries, if it looks like one. */
export const sessionToken = (request: Request) =>
  cookieValues(request, hostCookieName(request, SESSION_COOKIE)).find((value) => SESSION_TOKEN.test(value)) ?? null;

export const newSessionToken = () => toBase64url(crypto.getRandomValues(new Uint8Array(32)));

/**
 * What the Workspace stores in place of a token: its HMAC under SESSION_SECRET. A leaked database holds
 * no sessions, and changing the secret signs everyone out, as changing Campfire's does.
 */
export async function tokenDigest(token: string, secret: string): Promise<string> {
  if (!secret) throw new Error("SESSION_SECRET isn't set. `pnpm dev` and `pnpm run deploy` set it.");
  return toBase64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(token))));
}

/** The browser and IP a session records. */
export const clientOf = (request: Request): Client => ({
  ip: request.headers.get("CF-Connecting-IP"),
  userAgent: request.headers.get("User-Agent"),
});

/** What a request whose cookie carries `token` brings to say who it's from. */
export const credentialsFor = async (token: string, request: Request, env: Env): Promise<Credentials> => ({
  tokenDigest: await tokenDigest(token, env.SESSION_SECRET),
  client: clientOf(request),
  guests: guestSignIn(env),
});

/**
 * What the request brings to say who it's from, for a Workspace call that checks the session and
 * acts in one go, if its cookie carries a session token at all.
 */
export async function credentialsOf(request: Request, env: Env): Promise<Credentials | null> {
  const token = sessionToken(request);
  return token ? credentialsFor(token, request, env) : null;
}

/** The person whose session the request's cookie names, if it names one that's still valid, and its token. */
export async function authenticate(request: Request, env: Env): Promise<{ user: User; token: string } | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const user = await workspace(env).authenticate(await credentialsFor(token, request, env));
  return user && { user, token };
}

/**
 * Ends the session the request's cookie names, if any, and forgets its person's push subscriptions
 * with `pushEndpoint`, the endpoint of the subscription this browser just ended, if it had one.
 */
export async function signOut(request: Request, env: Env, pushEndpoint: string | null): Promise<void> {
  const token = sessionToken(request);
  if (token) await workspace(env).signOut(await tokenDigest(token, env.SESSION_SECRET), pushEndpoint);
}

/**
 * Whether a write comes from another site, by its headers alone: no tokens, just `Origin` and
 * `Sec-Fetch-Site`. It refuses `same-site` too, since on workers.dev every other Worker on the account
 * is the same site.
 */
export function isCrossSite(request: Request): boolean {
  const url = urlOf(request);
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== url.origin) return true;
  const site = request.headers.get("Sec-Fetch-Site");
  // Browsers only send the header to secure origins, so plain HTTP relies on SameSite=Lax instead.
  return !(site === "same-origin" || (site === null && url.protocol === "http:"));
}

/** Whether a WebSocket upgrade comes from the app's own pages, as Action Cable insists. */
export const isSameOriginUpgrade = (request: Request) => request.headers.get("Origin") === urlOf(request).origin;
