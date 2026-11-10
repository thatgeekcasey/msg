import type { Directory } from "@ember/protocol";
import { listDurableObjectIds } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { KEYS_MISSING } from "../src/push/keys";
import { api, apiWith, cookieOf, openWorkspaceSocket, signIn, upgrade } from "./support";

const bindings = env as unknown as Env;
const withCookie = (cookie: string) => ({ headers: { Cookie: cookie } });
/** A well-formed token that no session has. */
const unknownSession = `__Host-session_token=${"A".repeat(43)}`;

describe("Sign in with a display name", () => {
  it("signs in with a trimmed display name and a session cookie", async () => {
    const response = await api("/api/session", { method: "POST", body: JSON.stringify({ name: "  Ada Lovelace  " }) });
    expect(response.status).toBe(201);
    const { user } = (await response.json()) as { user: { id: string; name: string } };
    expect(user.name).toBe("Ada Lovelace");
    expect(user.id).toMatch(/^[0-9a-z]{16}$/);

    const me = await api("/api/me", withCookie(cookieOf(response)));
    expect(await me.json()).toEqual({ user });
  });

  it("tells everyone's workspace sockets of someone who signs in with just a name, as the people directory lists them", async () => {
    const ada = await signIn("Ada");
    const workspace = await openWorkspaceSocket(ada);

    const grace = await signIn("Grace");
    const { users } = (await (await api("/api/users", withCookie(ada.cookie))).json()) as Directory;
    const listed = users.find((person) => person.id === grace.user.id);
    expect(listed).toMatchObject({ name: "Grace", role: "member", status: "active" });
    expect(await workspace.next()).toEqual({ type: "user.updated", user: listed });
  });

  it("gives everyone who signs in a distinct identity, even with the same name", async () => {
    const [first, second] = await Promise.all([signIn("Ada"), signIn("Ada")]);
    expect(first.user.id).not.toBe(second.user.id);
  });

  // A body without a name is an email sign-in (auth.sign-in).
  it.each([
    ["a blank name", { name: "   " }],
    ["a name that isn't text", { name: 42 }],
    ["a name that's null", { name: null }],
    ["a name over 48 characters", { name: "x".repeat(49) }],
  ])("refuses %s with 422 and says why", async (_, body) => {
    const response = await api("/api/session", { method: "POST", body: JSON.stringify(body) });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Name must be 1 to 48 characters" });
  });

  it("accepts a name of exactly 48 characters", async () => {
    const response = await api("/api/session", { method: "POST", body: JSON.stringify({ name: "x".repeat(48) }) });
    expect(response.status).toBe(201);
  });

  it('is turned off unless EMBER_GUEST_SIGN_IN is "true"', async () => {
    for (const setting of [undefined, "", "false", "1"]) {
      const response = await apiWith({ EMBER_GUEST_SIGN_IN: setting }, "/api/session", { method: "POST", body: JSON.stringify({ name: "Ada" }) });
      expect(response.status, setting).toBe(403);
      expect(response.headers.has("Set-Cookie")).toBe(false);
    }
  });

  it("keeps guests out while it's off, and lets them back in once it's on", async () => {
    const { cookie } = await signIn("Ada");
    expect((await apiWith({ EMBER_GUEST_SIGN_IN: undefined }, "/api/me", withCookie(cookie))).status).toBe(401);
    expect((await apiWith({ EMBER_GUEST_SIGN_IN: undefined }, "/api/rooms/general/socket", upgrade(cookie))).status).toBe(401);
    expect((await api("/api/me", withCookie(cookie))).status).toBe(200);
  });
});

describe("Pages need a signed-in person", () => {
  it("answers 401 to requests without a valid session", async () => {
    expect((await api("/api/me")).status).toBe(401);
    expect((await api("/api/sidebar")).status).toBe(401);
    for (const cookie of ["__Host-session_token=forged", unknownSession, "__Host-session_token="]) {
      expect((await api("/api/me", withCookie(cookie))).status, cookie).toBe(401);
      expect((await api("/api/sidebar", withCookie(cookie))).status, cookie).toBe(401);
    }
  });
});

describe("Connection sign-in and revocation", () => {
  it("refuses room sockets without a valid session", async () => {
    expect((await api("/api/rooms/general/socket", upgrade())).status).toBe(401);
    expect((await api("/api/rooms/general/socket", upgrade(unknownSession))).status).toBe(401);
  });

  it("answers 404 at the socket's address unless it's an upgrade from the app's own pages", async () => {
    const { cookie } = await signIn("Ada");
    expect((await api("/api/rooms/general/socket", withCookie(cookie))).status).toBe(404);
    // Another site, a sandboxed page, and something that isn't a browser.
    for (const from of ["https://evil.test", "null", undefined]) {
      const headers = { Upgrade: "websocket", Cookie: cookie, ...(from ? { Origin: from } : {}) };
      expect((await api("/api/rooms/general/socket", { headers })).status, from).toBe(404);
    }
  });
});

describe("Health check", () => {
  /** A recovery token the Worker can be given, and sent. */
  const TOKEN = "ab".repeat(32);
  const asRecovery = { headers: { Authorization: `Bearer ${TOKEN}` } };
  /** /api/health from a Worker whose bindings differ from this suite's by `changes`. */
  const healthWith = (changes: Partial<Env>, init: RequestInit<IncomingRequestCfProperties> = {}) => apiWith(changes, "/api/health", init);
  /** What it tells someone who may hear how the deployment is set up. */
  const detail = { ok: true, storage: bindings.STORAGE_BACKEND, push: { on: true }, files: { on: true } };
  /** Sets Ember up, answering its first administrator's cookie. */
  async function administrator(): Promise<{ headers: { Cookie: string } }> {
    const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
    expect(response.status).toBe(201);
    return withCookie(cookieOf(response));
  }

  it("tells anyone only that the Worker is up, guests included", async () => {
    const response = await api("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const { cookie } = await signIn("Ada");
    expect(await (await api("/api/health", withCookie(cookie))).json()).toEqual({ ok: true });
  });

  it("tells an administrator which storage it uses, and whether push notifications and files are on", async () => {
    const admin = await administrator();
    expect(await (await api("/api/health", admin)).json()).toEqual(detail);
    expect(await (await healthWith({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined }, admin)).json()).toMatchObject({ ok: true, push: { on: false, reason: KEYS_MISSING } });
    expect(await (await healthWith({ FILES: undefined }, admin)).json()).toMatchObject({ ok: true, files: { on: false } });
  });

  it("tells the same to whoever sends EMBER_RECOVERY_TOKEN, as the deploy check can, and nothing more for another token", async () => {
    expect(await (await healthWith({ EMBER_RECOVERY_TOKEN: TOKEN }, asRecovery)).json()).toEqual(detail);
    expect(await (await healthWith({ EMBER_RECOVERY_TOKEN: TOKEN }, { headers: { Authorization: `Bearer ${"cd".repeat(32)}` } })).json()).toEqual({ ok: true });
    // Nor while the Worker has no token to compare with.
    expect(await (await healthWith({ EMBER_RECOVERY_TOKEN: undefined }, asRecovery)).json()).toEqual({ ok: true });
  });

  it("reaches the Workspace and a room's object, so a deploy can be checked without signing in", async () => {
    expect((await api("/api/health")).status).toBe(200);
    const workspaces = await listDurableObjectIds(bindings.WORKSPACE);
    expect(workspaces.some((id) => id.equals(bindings.WORKSPACE.idFromName("workspace")))).toBe(true);
    const rooms = await listDurableObjectIds(bindings.CHAT_ROOM);
    expect(rooms.some((id) => id.equals(bindings.CHAT_ROOM.idFromName("_health")))).toBe(true);
  });

  it("answers 503 when SESSION_SECRET isn't set, saying so in the log and to whoever sends the recovery token", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await healthWith({ SESSION_SECRET: "" });
    const told = await healthWith({ SESSION_SECRET: "", EMBER_RECOVERY_TOKEN: TOKEN }, asRecovery);
    expect(logged).toHaveBeenCalledWith("Health check failed: SESSION_SECRET isn't set");
    logged.mockRestore();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
    expect(told.status).toBe(503);
    expect(await told.json()).toEqual({ ok: false, storage: bindings.STORAGE_BACKEND, error: "SESSION_SECRET isn't set" });
  });

  it("answers 503 when the Workspace can't read its storage, to someone signed in too, whose role it can't read either", async () => {
    const away = () => Promise.reject(new Error("No such table"));
    const failing = { getByName: () => ({ health: away, me: away }) };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await healthWith({ WORKSPACE: failing as unknown as Env["WORKSPACE"] });
    const signedIn = await healthWith({ WORKSPACE: failing as unknown as Env["WORKSPACE"] }, withCookie(unknownSession));
    const told = await healthWith({ WORKSPACE: failing as unknown as Env["WORKSPACE"], EMBER_RECOVERY_TOKEN: TOKEN }, asRecovery);
    expect(logged).toHaveBeenCalledWith("Health check failed: Storage isn't answering", expect.any(Error));
    logged.mockRestore();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
    expect(signedIn.status).toBe(503);
    expect(await signedIn.json()).toEqual({ ok: false });
    expect(await told.json()).toEqual({ ok: false, storage: bindings.STORAGE_BACKEND, error: "Storage isn't answering" });
  });

  it("answers unknown API paths with a JSON 404", async () => {
    const response = await api("/api/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
