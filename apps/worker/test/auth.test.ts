import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_IDLE_MS, SESSION_REFRESH_MS } from "../src/workspace";
import { api, apiWith, origin, signIn, upgrade, workspaceSql } from "./support";

const withCookie = (cookie: string) => ({ headers: { Cookie: cookie } });
/** The same app served over plain HTTP, as `wrangler dev` serves it, which needn't redirect to HTTPS. */
const insecureOrigin = "http://localhost:8787";
const tokenOf = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);

interface SessionRow {
  last_active_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

const sessionsOf = (userId: string) =>
  workspaceSql("SELECT last_active_at, ip_address, user_agent FROM sessions WHERE user_id = ?", userId) as Promise<SessionRow[]>;

describe("Stay signed in, per device", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the session in an HttpOnly cookie for 400 days, which only this origin can set over HTTPS", async () => {
    const response = await api("/api/session", { method: "POST", body: JSON.stringify({ name: "Ada" }) });
    expect(response.headers.get("Set-Cookie")).toMatch(/^__Host-session_token=[\w-]{43}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$/);
  });

  it("names the cookie without the prefix on plain HTTP, and each scheme reads only its own", async () => {
    const response = await exports.default.fetch(`${insecureOrigin}/api/session`, { method: "POST", body: JSON.stringify({ name: "Ada" }) });
    expect(response.status).toBe(201);
    const cookie = response.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^session_token=[\w-]{43}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax$/);

    const token = tokenOf(cookie.split(";")[0]!);
    expect((await exports.default.fetch(`${insecureOrigin}/api/me`, withCookie(`session_token=${token}`))).status).toBe(200);
    // Over HTTPS only a __Host- cookie counts, so a site sharing the domain can't plant one.
    expect((await api("/api/me", withCookie(`session_token=${token}`))).status).toBe(401);
    expect((await exports.default.fetch(`${insecureOrigin}/api/me`, withCookie(`__Host-session_token=${token}`))).status).toBe(401);
  });

  it("finds the session cookie among the browser's others", async () => {
    const { cookie } = await signIn("Ada");
    expect((await api("/api/me", withCookie(`theme=dark; ${cookie}; tz=UTC`))).status).toBe(200);
  });

  it("records the browser and IP of each sign-in, and keeps only a digest of the token", async () => {
    const response = await api("/api/session", {
      method: "POST",
      headers: { "User-Agent": "Laptop", "CF-Connecting-IP": "203.0.113.7" },
      body: JSON.stringify({ name: "Ada" }),
    });
    const { user } = (await response.json()) as { user: { id: string } };
    expect(await sessionsOf(user.id)).toEqual([expect.objectContaining({ ip_address: "203.0.113.7", user_agent: "Laptop" })]);

    const token = tokenOf(response.headers.get("Set-Cookie")!.split(";")[0]!);
    const stored = await workspaceSql("SELECT * FROM sessions WHERE user_id = ?", user.id);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("refreshes the session's last activity, browser and IP at most once an hour", async () => {
    const { user, cookie } = await signIn("Ada");
    const fromPhone = { headers: { Cookie: cookie, "User-Agent": "Phone", "CF-Connecting-IP": "198.51.100.4" } };
    const [signedIn] = await sessionsOf(user.id);
    const signedInAt = Date.parse(signedIn!.last_active_at);

    // The Workspace runs in this isolate, so it sees the faked clock too.
    vi.useFakeTimers({ toFake: ["Date"], now: signedInAt + SESSION_REFRESH_MS - 1 });
    expect((await api("/api/me", fromPhone)).status).toBe(200);
    expect(await sessionsOf(user.id)).toEqual([signedIn]);

    vi.setSystemTime(signedInAt + SESSION_REFRESH_MS);
    expect((await api("/api/me", fromPhone)).status).toBe(200);
    const refreshed = { last_active_at: new Date(signedInAt + SESSION_REFRESH_MS).toISOString(), ip_address: "198.51.100.4", user_agent: "Phone" };
    expect(await sessionsOf(user.id)).toEqual([refreshed]);

    vi.setSystemTime(signedInAt + 2 * SESSION_REFRESH_MS - 1);
    expect((await api("/api/me", withCookie(cookie))).status).toBe(200);
    expect(await sessionsOf(user.id)).toEqual([refreshed]);
  });

  it("sends the cookie again whenever the app asks who's signed in, so it lasts as long as it's used", async () => {
    const { cookie } = await signIn("Ada");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + SESSION_REFRESH_MS });
    // Something else, such as opening a room, may be what refreshes the session.
    expect((await api("/api/sidebar", withCookie(cookie))).status).toBe(200);
    for (let load = 0; load < 2; load++) {
      const response = await api("/api/me", withCookie(cookie));
      expect(response.headers.get("Set-Cookie")).toBe(`${cookie}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure`);
    }
  });

  it("ends a session unused for as long as its cookie lasts, so a token kept from a browser long gone stops working too", async () => {
    const { user, cookie } = await signIn("Ada");
    const [signedIn] = await sessionsOf(user.id);
    const signedInAt = Date.parse(signedIn!.last_active_at);

    vi.useFakeTimers({ toFake: ["Date"], now: signedInAt + SESSION_IDLE_MS - 1 });
    expect((await api("/api/me", withCookie(cookie))).status).toBe(200);
    // Used, it lasts as long again from then.
    vi.setSystemTime(signedInAt + 2 * SESSION_IDLE_MS - 2);
    expect((await api("/api/me", withCookie(cookie))).status).toBe(200);

    vi.setSystemTime(signedInAt + 3 * SESSION_IDLE_MS - 2);
    expect((await api("/api/me", withCookie(cookie))).status).toBe(401);
    expect((await api("/api/socket", upgrade(cookie))).status).toBe(401);
  });

  it("signs everyone out when SESSION_SECRET changes", async () => {
    const { cookie } = await signIn("Ada");
    expect((await apiWith({ SESSION_SECRET: "a-new-secret" }, "/api/me", withCookie(cookie))).status).toBe(401);
    expect((await api("/api/me", withCookie(cookie))).status).toBe(200);
  });
});

describe("Sign out", () => {
  it("ends this browser's session and makes it forget the cookie", async () => {
    const ada = await signIn("Ada");
    const grace = await signIn("Grace");

    const response = await api("/api/session", { method: "DELETE", ...withCookie(ada.cookie) });
    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toBe("__Host-session_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure");
    expect(await sessionsOf(ada.user.id)).toEqual([]);
    expect((await api("/api/me", withCookie(ada.cookie))).status).toBe(401);
    expect((await api("/api/rooms/general/socket", upgrade(ada.cookie))).status).toBe(401);

    expect((await api("/api/me", withCookie(grace.cookie))).status).toBe(200);
  });

  it("answers the same without a session", async () => {
    const response = await api("/api/session", { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toMatch(/^__Host-session_token=; .*Max-Age=0/);
  });
});

describe("Forgery protection without tokens", () => {
  /** A sign-in sent with exactly `headers`, without the `Sec-Fetch-Site` that `api` adds. */
  const signInWith = (headers: Record<string, string>, url = `${origin}/api/session`) =>
    exports.default.fetch(url, { method: "POST", headers, body: JSON.stringify({ name: "Ada" }) });

  it("accepts writes from the app's own pages", async () => {
    expect((await signInWith({ "Sec-Fetch-Site": "same-origin", Origin: origin })).status).toBe(201);
    expect((await signInWith({ "Sec-Fetch-Site": "same-origin" })).status).toBe(201);
  });

  it.each(["cross-site", "same-site", "none", "nonsense"])("refuses writes with Sec-Fetch-Site: %s, setting no cookie", async (site) => {
    const response = await signInWith({ "Sec-Fetch-Site": site });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Requests from other sites are refused" });
    expect(response.headers.has("Set-Cookie")).toBe(false);
  });

  it("refuses writes without Sec-Fetch-Site over HTTPS, and accepts them on plain HTTP", async () => {
    expect((await signInWith({})).status).toBe(422);
    expect((await signInWith({}, `${insecureOrigin}/api/session`)).status).toBe(201);
  });

  it.each(["null", "https://evil.test", insecureOrigin, "https://ember.test:8443"])("refuses writes from Origin %s", async (from) => {
    expect((await signInWith({ "Sec-Fetch-Site": "same-origin", Origin: from })).status).toBe(422);
  });

  it("refuses a forged sign-out, leaving the session alone", async () => {
    const { cookie } = await signIn("Ada");
    const forged = await exports.default.fetch(`${origin}/api/session`, { method: "DELETE", headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } });
    expect(forged.status).toBe(422);
    expect(forged.headers.has("Set-Cookie")).toBe(false);
    expect((await api("/api/me", withCookie(cookie))).status).toBe(200);
  });

  it("leaves reads alone", async () => {
    const { cookie } = await signIn("Ada");
    expect((await api("/api/me", { headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } })).status).toBe(200);
  });
});
