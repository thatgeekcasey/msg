import { LONGEST_PAUSE_MS, type Directory, type DirectoryUser, type NotificationsPaused, type UserId } from "@ember/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { api, freshDeploy, openWorkspaceSocket, signIn, workspaceSql, type Session, type WorkspaceSocket } from "./support";

// Pausing notifications, as Slack's Do Not Disturb pauses them: someone pauses theirs until a time, and
// the people directory lists them paused until then. pushes.test.ts and huddle-invitations.test.ts check
// that nothing is pushed to them meanwhile.

/** Pauses `session`'s notifications until `until`, or resumes them with null, as the rail's Pause notifications does. */
const pause = (session: Session, until: unknown) =>
  api("/api/users/me/notifications-pause", { method: "PUT", headers: { Cookie: session.cookie }, body: JSON.stringify({ until }) });

/** `ms` from now, as an ISO time. */
const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Someone as the people directory lists them to `viewer`. */
async function listed(viewer: Session, userId: UserId): Promise<DirectoryUser> {
  const { users } = (await (await api("/api/users", { headers: { Cookie: viewer.cookie } })).json()) as Directory;
  return users.find((user) => user.id === userId)!;
}

/** The next change to someone that `tab` hears, past what else it hears of. */
async function nextChange(tab: WorkspaceSocket) {
  for (;;) {
    const frame = await tab.next();
    if (frame.type === "user.updated") return frame;
  }
}

beforeEach(freshDeploy);

describe("Pause notifications", () => {
  it("pauses your notifications until the time you give, which the directory lists and everyone's tabs hear, until you resume them", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const [adasTab, gracesTab] = [await openWorkspaceSocket(ada), await openWorkspaceSocket(grace)];
    const until = fromNow(60 * 60_000);

    const response = await pause(ada, until);
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as NotificationsPaused;
    expect(user).toMatchObject({ id: ada.user.id, name: "Ada", pausedUntil: until });
    for (const tab of [adasTab, gracesTab]) expect(await nextChange(tab)).toEqual({ type: "user.updated", user });
    expect(await listed(grace, ada.user.id)).toEqual(user);
    expect(await workspaceSql("SELECT notifications_paused_until FROM users WHERE id = ?", ada.user.id)).toEqual([{ notifications_paused_until: until }]);

    const resumed = await pause(ada, null);
    expect(resumed.status).toBe(200);
    const { user: after } = (await resumed.json()) as NotificationsPaused;
    expect(after).not.toHaveProperty("pausedUntil");
    expect(after).toEqual({ ...user, pausedUntil: undefined });
    for (const tab of [adasTab, gracesTab]) expect(await nextChange(tab)).toEqual({ type: "user.updated", user: after });
    expect(await listed(grace, ada.user.id)).toEqual(after);
  });

  it("lists a pause no more once its time has passed, nor of someone deactivated", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    expect((await pause(ada, fromNow(60_000))).status).toBe(200);
    expect((await pause(grace, fromNow(60_000))).status).toBe(200);

    await workspaceSql("UPDATE users SET notifications_paused_until = ? WHERE id = ?", fromNow(-1_000), ada.user.id);
    expect(await listed(grace, ada.user.id)).not.toHaveProperty("pausedUntil");
    await workspaceSql("UPDATE users SET status = 1 WHERE id = ?", grace.user.id);
    expect(await listed(ada, grace.user.id)).not.toHaveProperty("pausedUntil");
  });

  it("refuses a time that has passed, is more than a week on, or isn't written as toISOString writes one, and anyone not signed in", async () => {
    const ada = await signIn("Ada");
    for (const until of [fromNow(-60_000), fromNow(LONGEST_PAUSE_MS + 60_000), "tomorrow", fromNow(60_000).slice(0, 10), Date.now() + 60_000, true, undefined]) {
      expect((await pause(ada, until)).status, String(until)).toBe(422);
    }
    expect(await workspaceSql("SELECT notifications_paused_until FROM users WHERE id = ?", ada.user.id)).toEqual([{ notifications_paused_until: null }]);

    const signedOut = await api("/api/users/me/notifications-pause", { method: "PUT", body: JSON.stringify({ until: fromNow(60_000) }) });
    expect(signedOut.status).toBe(401);
  });
});
