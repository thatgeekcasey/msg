import { CloseCode, type ChangedPerson, type Directory, type DirectoryUser, type Me, type NewWorkspace, type ProfileAnswer, type UserId } from "@ember/protocol";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../src/workspace";
import type { WorkspaceStore } from "../src/workspace-store";
import {
  api,
  closeOf,
  connect,
  cookieOf,
  createRoom,
  direct,
  freshDeploy,
  freshRoom,
  openWorkspaceSocket,
  post,
  roomSql,
  settle,
  shown,
  signIn,
  upgrade,
  workspaceSql,
  workspaceStub,
  type Session,
} from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Someone joins with the join link, setting an email address and password, signed in. */
async function join(person: typeof grace): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify(person) });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

let signIns = 0;

/** Signs in with an email address and password, each time from an IP address of its own, so no limit is reached. */
const signInWith = ({ emailAddress, password }: typeof grace) =>
  api("/api/session", { method: "POST", headers: { "CF-Connecting-IP": `203.0.113.${++signIns % 250}` }, body: JSON.stringify({ emailAddress, password }) });

/** Signs in as Grace again, in a session of its own. */
async function signInAsGrace(): Promise<Session> {
  const response = await signInWith(grace);
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** Asks for `userId` to be removed from the workspace, as `session` if given. */
const remove = (session: Session | null, userId: UserId) =>
  api(`/api/account/users/${userId}`, { method: "DELETE", headers: session ? { Cookie: session.cookie } : {} });

/** Someone as the directory lists them, as `viewer` sees it. */
async function listed(viewer: Session, userId: UserId): Promise<DirectoryUser> {
  const { users } = (await (await api("/api/users", { headers: { Cookie: viewer.cookie } })).json()) as Directory;
  return users.find((user) => user.id === userId)!;
}

const stored = async (userId: UserId) =>
  ((await workspaceSql("SELECT email_address, role, status, updated_at FROM users WHERE id = ?", userId)) as Array<{
    email_address: string | null;
    role: number;
    status: number;
    updated_at: string;
  }>)[0]!;

const sessionsOf = async (userId: UserId) => ((await workspaceSql("SELECT count(*) AS n FROM sessions WHERE user_id = ?", userId)) as Array<{ n: number }>)[0]!.n;

const roomsOf = async (userId: UserId) =>
  ((await workspaceSql("SELECT room_id FROM memberships WHERE user_id = ? ORDER BY room_id", userId)) as Array<{ room_id: string }>).map(({ room_id }) => room_id);

const signedIn = async (session: Session) => (await api("/api/me", { headers: { Cookie: session.cookie } })).status === 200;

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Remove someone from the workspace", () => {
  it("removes someone active, answering them as the directory then lists them, removed", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const long = "2026-01-01T00:00:00.000Z";
    await workspaceSql("UPDATE users SET updated_at = ? WHERE id = ?", long, member.user.id);
    const before = await listed(administrator, member.user.id);

    const response = await remove(administrator, member.user.id);
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as ChangedPerson;
    expect(user).toEqual(await listed(administrator, member.user.id));
    expect(user).toMatchObject({ id: member.user.id, name: "Grace Hopper", role: "member", status: "deactivated" });
    // Its time changed, and the avatar's address with it.
    expect(user.avatarUrl).not.toBe(before.avatarUrl);
    expect(await stored(member.user.id)).toMatchObject({ status: 1, role: 0 });
    expect((await stored(member.user.id)).updated_at > long).toBe(true);
  });

  it("ends all their sessions and nobody else's, closing their sockets for good in every room, their DMs too, and the workspace's", async () => {
    const administrator = await setUp();
    const laptop = await join(grace);
    const phone = await signInAsGrace();
    const lobby = await freshRoom("lobby");
    const annex = await freshRoom("annex");
    const { id: dm } = await direct(laptop, administrator);
    const rooms = [await connect(lobby, laptop), await connect(annex, laptop), await connect(lobby, phone), await connect(dm, phone)];
    const workspaces = [await openWorkspaceSocket(laptop), await openWorkspaceSocket(phone)];
    const adaInLobby = await connect(lobby, administrator);
    const adasWorkspace = await openWorkspaceSocket(administrator);
    const closes = [...rooms.map((tab) => closeOf(tab.ws)), ...workspaces.map((tab) => tab.closed)];

    expect((await remove(administrator, laptop.user.id)).status).toBe(200);
    for (const close of await Promise.all(closes)) expect(close).toMatchObject({ code: CloseCode.Revoked, reason: "Revoked" });
    // Rooms she has no tab in hear too, and then nothing waits to be told again.
    await vi.waitFor(async () => expect(await workspaceSql("SELECT * FROM pending_revocations")).toEqual([]), { timeout: 5_000 });
    for (const session of [laptop, phone]) {
      expect(await signedIn(session)).toBe(false);
      expect((await api(`/api/rooms/${dm}/socket`, upgrade(session.cookie))).status).toBe(401);
      expect((await api("/api/socket", upgrade(session.cookie))).status).toBe(401);
    }
    expect(await sessionsOf(laptop.user.id)).toBe(0);

    // Ada is still signed in and connected.
    expect(await signedIn(administrator)).toBe(true);
    await settle(adaInLobby);
    expect(await adasWorkspace.next()).toMatchObject({ type: "user.updated", user: { id: laptop.user.id, status: "deactivated" } });
    expect(await adasWorkspace.answers()).toBe(true);
  });

  it("takes them out of every room but their DMs, keeping what they wrote", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const lobby = await freshRoom("lobby");
    const { id: closed } = await createRoom("closed", { closedTo: [administrator.user.id, member.user.id], as: administrator });
    const { id: dm } = await direct(member, administrator);
    const { id: group } = await direct(member, administrator, await signIn("Linus Torvalds"));
    const { id: own } = await direct(member);
    const message = await post(await connect(lobby, member), "Hello, lobby");
    const shared = (await workspaceSql("SELECT id FROM rooms WHERE kind <> 'direct'")) as Array<{ id: string }>;
    expect(await roomsOf(member.user.id)).toEqual([...shared.map(({ id }) => id), dm, group, own].sort());
    expect(shared.map(({ id }) => id)).toEqual(expect.arrayContaining([lobby, closed]));

    await remove(administrator, member.user.id);
    expect(await roomsOf(member.user.id)).toEqual([dm, group, own].sort());
    expect(await roomSql(lobby, "SELECT id FROM messages WHERE creator_id = ?", member.user.id)).toEqual([{ id: message.id }]);
    expect((await connect(lobby, administrator)).welcome.messages).toContainEqual(expect.objectContaining({ id: message.id, body: message.body }));
  });

  it("frees their email address, writing -deactivated-<uuid> before its @, so it can join again", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const linus = await signIn("Linus Torvalds");

    await remove(administrator, member.user.id);
    expect((await stored(member.user.id)).email_address).toMatch(/^grace-deactivated-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@example\.com$/);
    expect((await signInWith(grace)).status).toBe(401);
    const again = await join(grace);
    expect(again.user.id).not.toBe(member.user.id);

    // Someone with no email address keeps none.
    await remove(administrator, linus.user.id);
    expect((await stored(linus.user.id)).email_address).toBeNull();
  });

  it("writes it before every @, where Campfire's Ruby writes it before the first", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    await workspaceSql("UPDATE users SET email_address = ? WHERE id = ?", '"a@b"@example.com', member.user.id);
    await remove(administrator, member.user.id);
    expect((await stored(member.user.id)).email_address).toMatch(/^"a-deactivated-([\w-]{36})@b"-deactivated-\1@example\.com$/);
  });

  it("keeps their role, so a removed administrator stays one, and their avatar", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", member.user.id);

    const { user } = (await (await remove(administrator, member.user.id)).json()) as ChangedPerson;
    expect(user).toMatchObject({ role: "administrator", status: "deactivated" });
    expect((await stored(member.user.id)).role).toBe(1);
    expect((await api(user.avatarUrl, { headers: { Cookie: administrator.cookie } })).status).toBe(200);
  });

  it("refuses their sign-in links from then on", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const { transferId } = (await (await api("/api/users/me/profile", { headers: { Cookie: member.cookie } })).json()) as ProfileAnswer;

    await remove(administrator, member.user.id);
    expect((await api("/api/session/transfers", { method: "POST", body: JSON.stringify({ transferId }) })).status).toBe(400);
  });

  it("tells everyone's workspace sockets they're removed, as the directory now lists them", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const linus = await signIn("Linus Torvalds");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(linus)];

    const { user } = (await (await remove(administrator, member.user.id)).json()) as ChangedPerson;
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "user.updated", user });
  });

  it("removes bots too", async () => {
    const administrator = await setUp();
    const now = new Date().toISOString();
    await workspaceSql("INSERT INTO users (id, name, role, created_at, updated_at) VALUES ('robot', 'Build Bot', 2, ?, ?)", now, now);
    const response = await remove(administrator, "robot");
    expect(response.status).toBe(200);
    expect(await stored("robot")).toMatchObject({ role: 2, status: 1 });
  });

  it("lets only administrators remove people, telling anyone else so before looking at whom", async () => {
    await setUp();
    const member = await join(grace);
    const linus = await signIn("Linus Torvalds");
    for (const userId of [linus.user.id, member.user.id, "nobody"]) {
      const response = await remove(member, userId);
      expect(response.status, userId).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators can remove people" });
    }
    expect((await stored(linus.user.id)).status).toBe(0);
  });

  it("finds only people who are active", async () => {
    const administrator = await setUp();
    const now = new Date().toISOString();
    await workspaceSql("INSERT INTO users (id, name, status, created_at, updated_at) VALUES ('removed', 'Removed', 1, ?, ?), ('banned', 'Banned', 2, ?, ?)", now, now, now, now);
    for (const userId of ["removed", "banned", "nobody", "%61"]) {
      const response = await remove(administrator, userId);
      expect(response.status, userId).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    }
    expect(await workspaceSql("SELECT status FROM users WHERE id IN ('removed', 'banned') ORDER BY id")).toEqual([{ status: 2 }, { status: 1 }]);
  });

  it("doesn't let administrators remove themselves, so there's always one", async () => {
    const administrator = await setUp();
    const response = await remove(administrator, administrator.user.id);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Administrators can't remove themselves" });
    expect(await signedIn(administrator)).toBe(true);
  });

  it("asks who's signed in", async () => {
    await setUp();
    const member = await join(grace);
    expect((await remove(null, member.user.id)).status).toBe(401);
    expect(await signedIn(member)).toBe(true);
  });

  it("still closes their sockets when the database saves the removal but its answer is lost", async () => {
    const administrator = await setUp();
    const member = await join(grace);
    const lobby = await freshRoom("lobby");
    const closes = [closeOf((await connect(lobby, member)).ws), (await openWorkspaceSocket(member)).closed];
    await runInDurableObject(workspaceStub(), (workspace: Workspace) => {
      const store = (workspace as unknown as { store: WorkspaceStore }).store;
      const removePerson = store.removePerson.bind(store);
      store.removePerson = async (...args) => {
        await removePerson(...args);
        throw new Error("The database's answer was lost");
      };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await remove(administrator, member.user.id)).status).toBe(500);
    for (const close of await Promise.all(closes)) expect(close).toMatchObject({ code: CloseCode.Revoked });
    expect(await signedIn(member)).toBe(false);
    expect((await api(`/api/rooms/${lobby}/socket`, upgrade(member.cookie))).status).toBe(401);
  });
});
