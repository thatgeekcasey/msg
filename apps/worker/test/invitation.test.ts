import type { NewWorkspace, Sidebar, User, UserId, WorkspaceServerFrame } from "@ember/protocol";
import { evictDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { api, cookieOf, freshDeploy, openWorkspaceSocket, shown, signIn, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Signs in as Ada from another browser, in a session of its own. */
async function signInAsAda(): Promise<Session> {
  const response = await api("/api/session", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.7" }, body: JSON.stringify({ emailAddress: ada.emailAddress, password: ada.password }) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: User }).user), cookie: cookieOf(response) };
}

/** Gives `userId` the role `role`, as `administrator` does on their profile. */
async function giveRole(administrator: Session, userId: UserId, role: "administrator" | "member") {
  const response = await api(`/api/account/users/${userId}`, { method: "PATCH", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ role }) });
  expect(response.status).toBe(200);
}

const sidebarOf = async (session: Session) => (await (await api("/api/sidebar", { headers: { Cookie: session.cookie } })).json()) as Sidebar;

/** Dismisses the welcome card as `session`'s person, as its × does, or with no session. */
const dismiss = (session: Session | null) => api("/api/sidebar/invitation", { method: "DELETE", headers: session ? { Cookie: session.cookie } : {} });

/** When `userId` dismissed the card, as stored, or null while they haven't. */
const dismissedAt = async (userId: UserId) =>
  ((await workspaceSql("SELECT invitation_dismissed_at FROM users WHERE id = ?", userId)) as Array<{ invitation_dismissed_at: string | null }>)[0]!.invitation_dismissed_at;

beforeEach(freshDeploy);

describe("Welcome card for administrators, until they dismiss it", () => {
  it("gives the invitation to administrators alone", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    const { invitation } = await sidebarOf(administrator);
    expect(invitation).not.toBeNull();

    const sidebar = await sidebarOf(grace);
    expect(sidebar.rooms.map((room) => room.id)).toContain(invitation!.roomId);
    expect(sidebar.invitation).toBeNull();
  });

  it("brings it to someone made an administrator, changing their sidebar's ETag, and takes it from them when they're a member again", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    const before = await api("/api/sidebar", { headers: { Cookie: grace.cookie } });

    await giveRole(administrator, grace.user.id, "administrator");
    const promoted = await api("/api/sidebar", { headers: { Cookie: grace.cookie, "If-None-Match": before.headers.get("ETag")! } });
    expect(promoted.status).toBe(200);
    expect(((await promoted.json()) as Sidebar).invitation).toEqual((await sidebarOf(administrator)).invitation);

    await giveRole(administrator, grace.user.id, "member");
    expect((await sidebarOf(grace)).invitation).toBeNull();
  });

  it("dismisses it for good, answering 204, on every device they sign in on", async () => {
    const administrator = await setUp();
    const before = await api("/api/sidebar", { headers: { Cookie: administrator.cookie } });

    expect((await dismiss(administrator)).status).toBe(204);
    const after = await api("/api/sidebar", { headers: { Cookie: administrator.cookie, "If-None-Match": before.headers.get("ETag")! } });
    expect(after.status).toBe(200);
    expect(((await after.json()) as Sidebar).invitation).toBeNull();
    expect(await dismissedAt(administrator.user.id)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    // In another browser, once the Workspace has started again.
    const laptop = await signInAsAda();
    await evictDurableObject(workspaceStub());
    expect((await sidebarOf(laptop)).invitation).toBeNull();
  });

  it("dismisses it for them alone: other administrators keep theirs", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    await giveRole(administrator, grace.user.id, "administrator");

    await dismiss(grace);
    expect((await sidebarOf(grace)).invitation).toBeNull();
    expect((await sidebarOf(administrator)).invitation).not.toBeNull();
  });

  it("keeps it dismissed when they're made a member and an administrator again, and a second dismissal changes nothing", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    await giveRole(administrator, grace.user.id, "administrator");
    await dismiss(grace);
    const dismissed = await dismissedAt(grace.user.id);
    expect(dismissed).not.toBeNull();

    await giveRole(administrator, grace.user.id, "member");
    await giveRole(administrator, grace.user.id, "administrator");
    expect((await sidebarOf(grace)).invitation).toBeNull();
    expect((await dismiss(grace)).status).toBe(204);
    expect(await dismissedAt(grace.user.id)).toBe(dismissed);
  });

  it("tells every tab of theirs, and nobody else's", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    await giveRole(administrator, grace.user.id, "administrator");
    const tabs = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(administrator)];
    const gracesTab = await openWorkspaceSocket(grace);

    await dismiss(administrator);
    for (const tab of tabs) expect(await tab.next()).toEqual({ type: "invitation.dismissed" } satisfies WorkspaceServerFrame);
    expect(await gracesTab.answers()).toBe(true);
  });

  it("refuses without a session", async () => {
    const administrator = await setUp();
    expect((await dismiss(null)).status).toBe(401);
    expect((await dismiss({ ...administrator, cookie: administrator.cookie.replace(/=.*/, "=nonsense") })).status).toBe(401);
    expect((await sidebarOf(administrator)).invitation).not.toBeNull();
  });
});
