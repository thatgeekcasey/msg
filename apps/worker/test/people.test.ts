import type { Directory, DirectoryUser, NewWorkspace, Person, PersonAnswer, UserId } from "@ember/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import notFoundPage from "../../web/public/404.html";
import { api, apiWith, builtPages, cookieOf, freshDeploy, shown, signIn, workspaceSql, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** What someone's page is told about the person `path` names, as `viewer` sees it. */
const personAt = (viewer: Session | null, path: string) => api(`/api/users/${path}`, { headers: as(viewer) });

const personOf = async (viewer: Session, userId: UserId): Promise<Person> =>
  ((await (await personAt(viewer, encodeURIComponent(userId))).json()) as PersonAnswer).person;

/** Someone as the directory lists them, as `viewer` sees it. */
async function listed(viewer: Session, userId: UserId): Promise<DirectoryUser> {
  const { users } = (await (await api("/api/users", { headers: as(viewer) })).json()) as Directory;
  return users.find((user) => user.id === userId)!;
}

/** Someone's page, `/users/<id>`, from a Worker whose built app answers each path with its own name. */
const page = (viewer: Session | null, path: string) => apiWith({ ASSETS: builtPages }, path, { headers: as(viewer), redirect: "manual" });

beforeEach(freshDeploy);

describe("Someone's profile page", () => {
  it("tells anyone about someone as the people directory lists them, with no copy kept", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");
    await workspaceSql("UPDATE users SET bio = ? WHERE id = ?", "Mathematician", administrator.user.id);

    const response = await personAt(grace, administrator.user.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ person: await listed(grace, administrator.user.id) } satisfies PersonAnswer);
    expect((await listed(grace, administrator.user.id)).bio).toBe("Mathematician");
    expect(await personOf(grace, grace.user.id)).toEqual(await listed(grace, grace.user.id));
  });

  it("tells administrators someone's email address too, or that they have none, their own included", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace Hopper");

    expect(await personOf(administrator, grace.user.id)).toEqual({ ...(await listed(administrator, grace.user.id)), emailAddress: null });
    await workspaceSql("UPDATE users SET email_address = ? WHERE id = ?", "grace@example.com", grace.user.id);
    expect((await personOf(administrator, grace.user.id)).emailAddress).toBe("grace@example.com");
    expect((await personOf(administrator, administrator.user.id)).emailAddress).toBe("ada@example.com");
    expect(await personOf(grace, administrator.user.id)).not.toHaveProperty("emailAddress");
  });

  it("tells about banned and removed people and bots too, whatever their status", async () => {
    const administrator = await setUp();
    const people = await Promise.all(["Grace Hopper", "Alan Turing", "Bender"].map((name) => signIn(name)));
    const [banned, removed, bot] = people.map((person) => person.user.id) as [UserId, UserId, UserId];
    await workspaceSql("UPDATE users SET status = 2 WHERE id = ?", banned);
    await workspaceSql("UPDATE users SET status = 1 WHERE id = ?", removed);
    await workspaceSql("UPDATE users SET role = 2 WHERE id = ?", bot);

    expect(await personOf(administrator, banned)).toMatchObject({ name: "Grace Hopper", status: "banned", role: "member" });
    expect(await personOf(administrator, removed)).toMatchObject({ name: "Alan Turing", status: "deactivated", role: "member" });
    expect(await personOf(administrator, bot)).toMatchObject({ name: "Bender", status: "active", role: "bot" });
  });

  it("answers 404 for an id nobody has, and 401 signed out", async () => {
    const administrator = await setUp();
    for (const path of ["nobody", "%FF", encodeURIComponent(`${administrator.user.id} `)]) expect((await personAt(administrator, path)).status, path).toBe(404);
    const signedOut = await personAt(null, administrator.user.id);
    expect(signedOut.status).toBe(401);
    expect(await signedOut.json()).toEqual({ error: "Not signed in" });
  });

  it("answers Campfire's 404 page for the page of someone nobody is, once signed in", async () => {
    const administrator = await setUp();
    const known = await page(administrator, `/users/${administrator.user.id}`);
    expect(known.status).toBe(200);
    expect(await known.text()).toBe("page /");

    const unknown = await page(administrator, "/users/nobody");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe(notFoundPage);
    // Signed out, the app sends them to sign in first, whoever the page is for.
    expect(await (await page(null, "/users/nobody")).text()).toBe("page /");
  });
});
