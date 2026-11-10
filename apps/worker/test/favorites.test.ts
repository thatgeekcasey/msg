import { MAX_FAVORITES, type Favorites, type RoomId, type Sidebar, type WorkspaceServerFrame } from "@ember/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { api, createRoom, direct, freshDeploy, openWorkspaceSocket, signIn, workspaceSql, type Session } from "./support";

/** Stars room `roomId` for `session`'s person, or unstars it, as the star in its header does. */
const star = (session: Session, roomId: RoomId, favorite = true) =>
  api(`/api/rooms/${roomId}/favorite`, { method: "PUT", headers: { Cookie: session.cookie }, body: JSON.stringify({ favorite }) });

/** Puts the stars of `session`'s person in the order `roomIds` lists them, as dragging one in their sidebar does. */
const reorder = (session: Session, roomIds: unknown) =>
  api("/api/sidebar/order", { method: "PUT", headers: { Cookie: session.cookie }, body: JSON.stringify({ roomIds }) });

/** What a star, an unstar or a new order answers: the person's stars as they are then. */
const answered = async (response: Promise<Response>) => {
  const settled = await response;
  expect(settled.status, await settled.clone().text()).toBe(200);
  return ((await settled.json()) as { favorites: Favorites }).favorites;
};

/** The stars `GET /api/sidebar` gives `session`'s person. */
const favoritesOf = async (session: Session) => ((await (await api("/api/sidebar", { headers: { Cookie: session.cookie } })).json()) as Sidebar).favorites;

/** The rooms `session`'s person has stars on, whether or not they can star them now, in order. */
const storedStars = async (session: Session) =>
  (await workspaceSql("SELECT room_id FROM favorites WHERE user_id = ? ORDER BY position", session.user.id)).map((row) => (row as { room_id: RoomId }).room_id);

/** Hides room `roomId` from `session`'s person, as its bell does at off and hidden, or shows it again. */
const hide = (session: Session, roomId: RoomId, hidden = true) =>
  workspaceSql("UPDATE memberships SET involvement = ? WHERE room_id = ? AND user_id = ?", hidden ? "invisible" : "mentions", roomId, session.user.id);

beforeEach(freshDeploy);

describe("Star rooms", () => {
  it("stars a room for you alone, after your other stars, answering your stars in order", async () => {
    const ada = await signIn("Ada");
    const grace = await signIn("Grace");
    const design = await createRoom("Design");
    const ops = await createRoom("Ops");

    expect(await answered(star(ada, ops.id))).toEqual({ rooms: [ops.id], version: 1 });
    expect(await answered(star(ada, design.id))).toEqual({ rooms: [ops.id, design.id], version: 2 });
    expect(await favoritesOf(ada)).toEqual({ rooms: [ops.id, design.id], version: 2 });
    expect(await favoritesOf(grace)).toEqual({ rooms: [], version: 0 });
  });

  it("keeps a starred room's place when it's starred again, and unstars it", async () => {
    const ada = await signIn("Ada");
    const design = await createRoom("Design");
    const ops = await createRoom("Ops");
    await star(ada, ops.id);
    await star(ada, design.id);

    expect(await answered(star(ada, ops.id))).toEqual({ rooms: [ops.id, design.id], version: 3 });
    expect(await answered(star(ada, ops.id, false))).toEqual({ rooms: [design.id], version: 4 });
    // Unstarring it again is answered the same.
    expect(await answered(star(ada, ops.id, false))).toEqual({ rooms: [design.id], version: 5 });
    expect(await answered(star(ada, ops.id))).toEqual({ rooms: [design.id, ops.id], version: 6 });
  });

  it("tells every tab of yours what your stars are now, and nobody else", async () => {
    const ada = await signIn("Ada");
    const grace = await signIn("Grace");
    const design = await createRoom("Design");
    const tabs = [await openWorkspaceSocket(ada), await openWorkspaceSocket(ada)];
    const gracesTab = await openWorkspaceSocket(grace);

    await star(ada, design.id);
    const changed: WorkspaceServerFrame = { type: "favorites.changed", favorites: { rooms: [design.id], version: 1 } };
    for (const tab of tabs) expect(await tab.next()).toEqual(changed);
    expect(await gracesTab.answers()).toBe(true);
  });

  it("lists your stars in your sidebar, whose ETag changes with them", async () => {
    const ada = await signIn("Ada");
    const design = await createRoom("Design");
    const before = await api("/api/sidebar", { headers: { Cookie: ada.cookie } });

    await star(ada, design.id);
    const after = await api("/api/sidebar", { headers: { Cookie: ada.cookie, "If-None-Match": before.headers.get("ETag")! } });
    expect(after.status).toBe(200);
    expect(((await after.json()) as Sidebar).favorites).toEqual({ rooms: [design.id], version: 1 });
  });

  it("answers 403, changing nothing, for a DM, a room you've hidden or aren't in, or one that doesn't exist", async () => {
    const ada = await signIn("Ada");
    const grace = await signIn("Grace");
    const secret = await createRoom("Secret", { closedTo: [grace.user.id] });
    const hidden = await createRoom("Hidden");
    await hide(ada, hidden.id);
    const dm = await direct(ada, grace);

    for (const roomId of [dm.id, hidden.id, secret.id, "no-such-room"]) {
      for (const favorite of [true, false]) expect((await star(ada, roomId, favorite)).status, `${roomId}, ${favorite}`).toBe(403);
    }
    expect(await favoritesOf(ada)).toEqual({ rooms: [], version: 0 });
    expect(await storedStars(ada)).toEqual([]);
  });

  it("answers 400 for an id that isn't a room's, or a favorite that isn't true or false", async () => {
    const ada = await signIn("Ada");
    const design = await createRoom("Design");
    const put = (roomId: string, body: string) => api(`/api/rooms/${roomId}/favorite`, { method: "PUT", headers: { Cookie: ada.cookie }, body });

    const unreadable = await put("Not%20a%20room", JSON.stringify({ favorite: true }));
    expect(unreadable.status).toBe(400);
    expect(await unreadable.json()).toEqual({ error: "invalid room ID" });
    for (const body of [JSON.stringify({ favorite: "true" }), JSON.stringify({ favorite: 1 }), "{}", "null", "[true]", "true", "not JSON"]) {
      const response = await put(design.id, body);
      expect(response.status, body).toBe(400);
      expect(await response.json()).toEqual({ error: "favorite must be true or false" });
    }
    expect(await favoritesOf(ada)).toEqual({ rooms: [], version: 0 });
  });

  it("answers 401 to someone signed out, whatever they send", async () => {
    for (const roomId of [(await createRoom("Design")).id, "Not%20a%20room"]) {
      const response = await api(`/api/rooms/${roomId}/favorite`, { method: "PUT", body: "not JSON" });
      expect(response.status).toBe(401);
    }
  });

  it("leaves out stars on rooms you've since left or hidden, or that were deleted, and drops them at your next star", async () => {
    const ada = await signIn("Ada");
    const grace = await signIn("Grace");
    const design = await createRoom("Design");
    const secret = await createRoom("Secret", { closedTo: [ada.user.id, grace.user.id], as: grace });
    const hidden = await createRoom("Hidden");
    const gone = await createRoom("Gone", { as: grace });
    for (const room of [secret, hidden, gone]) await star(ada, room.id);

    const takeAdaOut = await api(`/api/rooms/${secret.id}`, {
      method: "PATCH",
      headers: { Cookie: grace.cookie },
      body: JSON.stringify({ kind: "closed", memberIds: [grace.user.id] }),
    });
    expect(takeAdaOut.status).toBe(200);
    await hide(ada, hidden.id);
    expect((await api(`/api/rooms/${gone.id}`, { method: "DELETE", headers: { Cookie: grace.cookie } })).status).toBe(204);

    expect(await favoritesOf(ada)).toEqual({ rooms: [], version: 3 });
    // They're kept until then, so a room shown again is starred again.
    await hide(ada, hidden.id, false);
    expect(await favoritesOf(ada)).toEqual({ rooms: [hidden.id], version: 3 });
    await hide(ada, hidden.id);
    // A star that's refused drops nothing.
    expect((await star(ada, secret.id)).status).toBe(403);
    expect(await storedStars(ada)).toEqual([secret.id, hidden.id, gone.id]);

    expect(await answered(star(ada, design.id))).toEqual({ rooms: [design.id], version: 4 });
    expect(await storedStars(ada)).toEqual([design.id]);
  });

  it(`refuses a new star past ${MAX_FAVORITES.toLocaleString("en")}, counting only rooms you can star, but stars again one you've starred`, async () => {
    const ada = await signIn("Ada");
    const extra = await createRoom("Extra");
    // As many starred rooms as anyone can have, written at once.
    const starred = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_FAVORITES})`;
    await workspaceSql(`${starred} INSERT INTO rooms (id, kind, name, created_at, updated_at) SELECT 'many-' || i, 'open', 'Many ' || i, 'now', 'now' FROM n`);
    await workspaceSql(`${starred} INSERT INTO memberships (room_id, user_id, created_at, updated_at) SELECT 'many-' || i, ?, 'now', 'now' FROM n`, ada.user.id);
    await workspaceSql(`${starred} INSERT INTO favorites (user_id, room_id, position) SELECT ?, 'many-' || i, i FROM n`, ada.user.id);

    expect((await star(ada, extra.id)).status).toBe(403);
    expect((await answered(star(ada, "many-1"))).rooms).toHaveLength(MAX_FAVORITES);

    await hide(ada, "many-2");
    const favorites = await answered(star(ada, extra.id));
    expect(favorites.rooms).toHaveLength(MAX_FAVORITES);
    expect(favorites.rooms).not.toContain("many-2");
    expect(favorites.rooms.at(-1)).toBe(extra.id);
  });
});

describe("Reorder starred rooms", () => {
  it("puts your stars in the order you list, answering it, and tells every tab of yours and nobody else", async () => {
    const ada = await signIn("Ada");
    const grace = await signIn("Grace");
    const [design, ops, sales] = [await createRoom("Design"), await createRoom("Ops"), await createRoom("Sales")];
    for (const room of [design, ops, sales]) await star(ada, room.id);
    const tabs = [await openWorkspaceSocket(ada), await openWorkspaceSocket(ada)];
    const gracesTab = await openWorkspaceSocket(grace);

    const reordered = { rooms: [sales.id, design.id, ops.id], version: 4 };
    expect(await answered(reorder(ada, [sales.id, design.id, ops.id]))).toEqual(reordered);
    for (const tab of tabs) expect(await tab.next()).toEqual({ type: "favorites.changed", favorites: reordered } satisfies WorkspaceServerFrame);
    expect(await gracesTab.answers()).toBe(true);
    expect(await favoritesOf(ada)).toEqual(reordered);
    // A new star still goes last.
    const crm = await createRoom("CRM");
    expect((await answered(star(ada, crm.id))).rooms).toEqual([sales.id, design.id, ops.id, crm.id]);
  });

  it("answers 403, changing nothing, for any list but exactly the rooms you've starred and can star", async () => {
    const ada = await signIn("Ada");
    const grace = await signIn("Grace");
    const [design, ops, hidden, other] = [await createRoom("Design"), await createRoom("Ops"), await createRoom("Hidden"), await createRoom("Other")];
    for (const room of [design, ops, hidden]) await star(ada, room.id);
    await star(grace, other.id);
    await hide(ada, hidden.id);

    for (const roomIds of [[ops.id], [ops.id, design.id, hidden.id], [ops.id, design.id, other.id], [ops.id, other.id], [other.id], []]) {
      expect((await reorder(ada, roomIds)).status, JSON.stringify(roomIds)).toBe(403);
    }
    expect(await favoritesOf(ada)).toEqual({ rooms: [design.id, ops.id], version: 3 });
    expect(await storedStars(ada)).toEqual([design.id, ops.id, hidden.id]);
  });

  it("drops your stars on rooms you can't star now, which the list leaves out", async () => {
    const ada = await signIn("Ada");
    const [design, ops, hidden] = [await createRoom("Design"), await createRoom("Ops"), await createRoom("Hidden")];
    for (const room of [design, hidden, ops]) await star(ada, room.id);
    await hide(ada, hidden.id);

    expect(await answered(reorder(ada, [ops.id, design.id]))).toEqual({ rooms: [ops.id, design.id], version: 4 });
    expect(await storedStars(ada)).toEqual([ops.id, design.id]);
    // Shown again, the room isn't starred.
    await hide(ada, hidden.id, false);
    expect(await favoritesOf(ada)).toEqual({ rooms: [ops.id, design.id], version: 4 });
  });

  it("takes an empty list from someone with no stars, and the order of as many stars as anyone can have", async () => {
    const ada = await signIn("Ada");
    expect(await answered(reorder(ada, []))).toEqual({ rooms: [], version: 1 });

    const starred = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_FAVORITES})`;
    await workspaceSql(`${starred} INSERT INTO rooms (id, kind, name, created_at, updated_at) SELECT 'many-' || i, 'open', 'Many ' || i, 'now', 'now' FROM n`);
    await workspaceSql(`${starred} INSERT INTO memberships (room_id, user_id, created_at, updated_at) SELECT 'many-' || i, ?, 'now', 'now' FROM n`, ada.user.id);
    await workspaceSql(`${starred} INSERT INTO favorites (user_id, room_id, position) SELECT ?, 'many-' || i, i FROM n`, ada.user.id);
    const reversed = Array.from({ length: MAX_FAVORITES }, (_, i) => `many-${MAX_FAVORITES - i}`);
    expect(await answered(reorder(ada, reversed))).toEqual({ rooms: reversed, version: 2 });
  });

  it("answers 400 for a list it can't read, before looking at your stars", async () => {
    const ada = await signIn("Ada");
    const design = await createRoom("Design");
    await star(ada, design.id);
    const put = (body: string) => api("/api/sidebar/order", { method: "PUT", headers: { Cookie: ada.cookie }, body });
    const refusals = {
      "roomIds must be an array": ["{}", JSON.stringify({ roomIds: design.id }), JSON.stringify({ roomIds: null }), JSON.stringify([design.id]), "null", "not JSON"],
      "too many rooms": [JSON.stringify({ roomIds: Array.from({ length: MAX_FAVORITES + 1 }, (_, i) => `room-${i}`) })],
      "room IDs must be unique and valid": [[design.id, design.id], [1], [design.id, "Not a room"], [""], [null]].map((roomIds) => JSON.stringify({ roomIds })),
    };
    for (const [error, bodies] of Object.entries(refusals)) {
      for (const body of bodies) {
        const response = await put(body);
        expect(response.status, body.slice(0, 80)).toBe(400);
        expect(await response.json()).toEqual({ error });
      }
    }
    expect(await favoritesOf(ada)).toEqual({ rooms: [design.id], version: 1 });
  });

  it("answers 401 to someone signed out, whatever they send", async () => {
    for (const body of [JSON.stringify({ roomIds: [] }), "not JSON"]) {
      expect((await api("/api/sidebar/order", { method: "PUT", body })).status).toBe(401);
    }
  });
});
