import type { Bootstrap, ChangedPerson, Directory, DirectoryUser, NewWorkspace, UserId } from "@ember/protocol";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { credentialsFor, newSessionToken } from "../src/auth";
import type { Env } from "../src/env";
import { CREDENTIALS_HEADER, type Workspace } from "../src/workspace";
import type { WorkspaceStore } from "../src/workspace-store";
import { api, cookieOf, freshDeploy, openWorkspaceSocket, origin, shown, signIn, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Asks for `userId`'s role to change, as `session` if given. */
const changeRole = (session: Session | null, userId: UserId, body: unknown) =>
  api(`/api/account/users/${userId}`, {
    method: "PATCH",
    headers: session ? { Cookie: session.cookie } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** Someone as the directory lists them, as `viewer` sees it. */
async function listed(viewer: Session, userId: UserId): Promise<DirectoryUser> {
  const { users } = (await (await api("/api/users", { headers: { Cookie: viewer.cookie } })).json()) as Directory;
  return users.find((user) => user.id === userId)!;
}

const storedRole = async (userId: UserId) => ((await workspaceSql("SELECT role, updated_at FROM users WHERE id = ?", userId)) as Array<{ role: number; updated_at: string }>)[0]!;

const me = async (session: Session) => (await (await api("/api/me", { headers: { Cookie: session.cookie } })).json()) as { user: { administrator: boolean } };

beforeEach(freshDeploy);

describe("Make or revoke administrators", () => {
  it("makes someone an administrator, and a member again, answering them as the directory lists them", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");

    const response = await changeRole(administrator, grace.user.id, { role: "administrator" });
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as ChangedPerson;
    expect(user).toEqual({ ...(await listed(grace, grace.user.id)), role: "administrator" });
    expect(user).toMatchObject({ id: grace.user.id, name: "Grace Hopper", role: "administrator", status: "active" });
    expect((await storedRole(grace.user.id)).role).toBe(1);

    expect(await (await changeRole(administrator, grace.user.id, { role: "member" })).json()).toEqual({ user: { ...user, role: "member", avatarUrl: expect.any(String) } });
    expect((await storedRole(grace.user.id)).role).toBe(0);
    expect((await listed(administrator, grace.user.id)).role).toBe("member");
  });

  it("tells their pages at once", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    expect((await me(grace)).user.administrator).toBe(false);

    await changeRole(administrator, grace.user.id, { role: "administrator" });
    expect((await me(grace)).user.administrator).toBe(true);
    expect(((await (await api("/api/bootstrap", { headers: { Cookie: grace.cookie } })).json()) as Bootstrap).user).toMatchObject({ administrator: true });
    expect((await (await api("/api/account", { headers: { Cookie: grace.cookie } })).json()) as object).toMatchObject({ canAdminister: true });
    expect((await openWorkspaceSocket(grace)).welcome).toMatchObject({ type: "welcome", you: { ...grace.user, administrator: true } });

    await changeRole(administrator, grace.user.id, { role: "member" });
    expect((await me(grace)).user.administrator).toBe(false);
    expect((await openWorkspaceSocket(grace)).welcome).toMatchObject({ type: "welcome", you: { ...grace.user, administrator: false } });
  });

  it("doesn't remember a sign-in that read someone's role before it changed", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    // As if she had a password, which the sign-in checked.
    await workspaceSql("UPDATE users SET password_digest = ? WHERE id = ?", "checked", grace.user.id);
    const [ada, laptop] = await Promise.all(
      [administrator.cookie.split("=")[1]!, newSessionToken()].map((token) => credentialsFor(token, new Request(origin), env as unknown as Env)),
    );
    const [signedIn, signedInNow] = await runInDurableObject(workspaceStub(), async (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const startSession = store.startSession.bind(store);
      let read!: () => void;
      const reading = new Promise<void>((resolve) => (read = resolve));
      let answer!: () => void;
      const answering = new Promise<void>((resolve) => (answer = resolve));
      // On D1 a sign-in can read Grace as a member, and answer only once she's an administrator.
      vi.spyOn(store, "startSession").mockImplementationOnce(async (...args) => {
        const session = await startSession(...args);
        read();
        await answering;
        return session;
      });

      const signingIn = workspace.startSession(grace.user.id, "checked", null, laptop!.tokenDigest, laptop!.client);
      await reading;
      await workspace.changeRole(ada!, grace.user.id, "administrator");
      answer();
      return [await signingIn, await workspace.me(laptop!)];
    });
    expect(signedIn).toMatchObject({ administrator: false });
    expect(signedInNow).toMatchObject({ administrator: true });
  });

  it("welcomes a socket with someone as they are once it's among the sockets told when they change", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    const [ada, graces] = await Promise.all(
      [administrator, grace].map(({ cookie }) => credentialsFor(cookie.split("=")[1]!, new Request(origin), env as unknown as Env)),
    );
    // The Workspace starts afresh, so opening the socket has to read Grace's session rather than remember it.
    await evictDurableObject(workspaceStub());
    const welcome = await runInDurableObject(workspaceStub(), async (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const findSession = store.findSession.bind(store);
      let read!: () => void;
      const reading = new Promise<void>((resolve) => (read = resolve));
      let answer!: () => void;
      const answering = new Promise<void>((resolve) => (answer = resolve));
      // The first check reads Grace as a member, and answers only once she's an administrator, which
      // the sockets already in hear of, as an answer from D1 can.
      vi.spyOn(store, "findSession").mockImplementationOnce(async (digest) => {
        const session = await findSession(digest);
        read();
        await answering;
        return session;
      });

      const opening = workspace.fetch(new Request(`${origin}/api/socket`, { headers: { Upgrade: "websocket", [CREDENTIALS_HEADER]: JSON.stringify(graces) } }));
      await reading;
      await workspace.changeRole(ada!, grace.user.id, "administrator");
      answer();
      const ws = (await opening).webSocket!;
      const welcomed = new Promise<unknown>((resolve) => ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string))));
      ws.accept();
      return welcomed;
    });
    expect(welcome).toMatchObject({ type: "welcome", you: { id: grace.user.id, administrator: true } });
  });

  it("tells everyone's workspace sockets who changed, as the directory now lists them", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    const linus = await signIn("Linus Torvalds");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace), await openWorkspaceSocket(linus)];

    const { user } = (await (await changeRole(administrator, grace.user.id, { role: "administrator" })).json()) as ChangedPerson;
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "user.updated", user });
  });

  it("records when someone's role changed, so their avatar's address changes, but not when it's set unchanged", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    const long = "2026-01-01T00:00:00.000Z";
    await workspaceSql("UPDATE users SET updated_at = ? WHERE id = ?", long, grace.user.id);
    const before = await listed(grace, grace.user.id);
    const socket = await openWorkspaceSocket(administrator);

    const unchanged = await changeRole(administrator, grace.user.id, { role: "member" });
    expect(await unchanged.json()).toEqual({ user: before });
    expect(await storedRole(grace.user.id)).toEqual({ role: 0, updated_at: long });

    const { user } = (await (await changeRole(administrator, grace.user.id, { role: "administrator" })).json()) as ChangedPerson;
    expect((await storedRole(grace.user.id)).updated_at > long).toBe(true);
    expect(user.avatarUrl).not.toBe(before.avatarUrl);
    // Only the change was told.
    expect(await socket.next()).toEqual({ type: "user.updated", user });
  });

  it("makes someone an administrator only for exactly \"administrator\", and a member for anything else", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    for (const role of ["", "Administrator", "bot", null, 1]) {
      await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", grace.user.id);
      const response = await changeRole(administrator, grace.user.id, { role });
      expect(response.status, JSON.stringify(role)).toBe(200);
      expect((await storedRole(grace.user.id)).role, JSON.stringify(role)).toBe(0);
    }
  });

  it("answers 400 without a role, once it has found whom it's for", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    for (const body of [{}, "not JSON", ["administrator"], { name: "Grace" }]) {
      const response = await changeRole(administrator, grace.user.id, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "Expected a role" });
    }
    expect((await storedRole(grace.user.id)).role).toBe(0);
  });

  it("lets only administrators change roles, telling anyone else so before looking at whom or what they sent", async () => {
    await setUp();
    const grace = await signIn("Grace Hopper");
    const linus = await signIn("Linus Torvalds");
    for (const [userId, body] of [[linus.user.id, { role: "administrator" }], [grace.user.id, { role: "administrator" }], ["nobody", "not JSON"]] as const) {
      const response = await changeRole(grace, userId, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators can change people's roles" });
    }
    expect((await storedRole(linus.user.id)).role).toBe(0);
    expect((await storedRole(grace.user.id)).role).toBe(0);
  });

  it("checks who's an administrator as they are when they ask", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    const linus = await signIn("Linus Torvalds");
    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", grace.user.id);
    expect((await changeRole(grace, linus.user.id, { role: "administrator" })).status).toBe(200);

    await workspaceSql("UPDATE users SET role = 0 WHERE id = ?", administrator.user.id);
    expect((await changeRole(administrator, linus.user.id, { role: "member" })).status).toBe(403);
    expect((await storedRole(linus.user.id)).role).toBe(1);
  });

  it("finds only people who are active, before looking at what was sent", async () => {
    const administrator = await setUp();
    const now = new Date().toISOString();
    await workspaceSql("INSERT INTO users (id, name, status, created_at, updated_at) VALUES ('removed', 'Removed', 1, ?, ?), ('banned', 'Banned', 2, ?, ?)", now, now, now, now);
    for (const userId of ["removed", "banned", "nobody", "%61"]) {
      for (const body of [{ role: "administrator" }, "not JSON"]) {
        const response = await changeRole(administrator, userId, body);
        expect(response.status, userId).toBe(404);
        expect(await response.json()).toEqual({ error: "Not found" });
      }
    }
    expect(await workspaceSql("SELECT role FROM users WHERE id IN ('removed', 'banned')")).toEqual([{ role: 0 }, { role: 0 }]);
  });

  it("doesn't let administrators change their own role, so there's always one", async () => {
    const administrator = await setUp();
    for (const role of ["member", "administrator"]) {
      const response = await changeRole(administrator, administrator.user.id, { role });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Administrators can't change their own role" });
    }
    expect((await storedRole(administrator.user.id)).role).toBe(1);
  });

  it("doesn't change a bot's role", async () => {
    const administrator = await setUp();
    const now = new Date().toISOString();
    await workspaceSql("INSERT INTO users (id, name, role, created_at, updated_at) VALUES ('robot', 'Build Bot', 2, ?, ?)", now, now);
    const response = await changeRole(administrator, "robot", { role: "administrator" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Bots' roles can't be changed" });
    expect((await storedRole("robot")).role).toBe(2);
  });

  it("asks who's signed in", async () => {
    await setUp();
    const grace = await signIn("Grace Hopper");
    expect((await changeRole(null, grace.user.id, { role: "administrator" })).status).toBe(401);
  });

  it("answers only PATCH", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    for (const method of ["GET", "POST", "PUT"]) {
      const response = await api(`/api/account/users/${grace.user.id}`, { method, headers: { Cookie: administrator.cookie } });
      expect(response.status, method).toBe(404);
    }
  });
});
