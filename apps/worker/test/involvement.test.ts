import { INVOLVEMENTS, type Favorites, type Involvement, type RoomId, type Sidebar, type WorkspaceServerFrame } from "@ember/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { api, createRoom, direct, freshDeploy, openWorkspaceSocket, signIn, type Session } from "./support";

/** Gives `session`'s person `involvement` in room `roomId`, as its bell does, or sends `body` instead. */
const involve = (session: Session, roomId: RoomId, involvement: unknown, body = JSON.stringify({ involvement })) =>
  api(`/api/rooms/${roomId}/involvement`, { method: "PUT", headers: { Cookie: session.cookie }, body });

/** What `session`'s sidebar lists: each of their rooms' levels, by id, and their stars. */
async function sidebarOf(session: Session): Promise<{ levels: Record<RoomId, Involvement>; favorites: Favorites }> {
  const sidebar = (await (await api("/api/sidebar", { headers: { Cookie: session.cookie } })).json()) as Sidebar;
  return { levels: Object.fromEntries(sidebar.rooms.map((room) => [room.id, room.involvement])), favorites: sidebar.favorites };
}

const star = (session: Session, roomId: RoomId) =>
  api(`/api/rooms/${roomId}/favorite`, { method: "PUT", headers: { Cookie: session.cookie }, body: JSON.stringify({ favorite: true }) });

const leveled = (roomId: RoomId, involvement: Involvement): WorkspaceServerFrame => ({ type: "room.involvement", roomId, involvement });

beforeEach(freshDeploy);

describe("Notification levels", () => {
  it("starts you at @mentions in a room and all messages in a DM, as your sidebar lists them", async () => {
    const ada = await signIn("Ada");
    const grace = await signIn("Grace");
    const design = await createRoom("Design");
    const dm = await direct(ada, grace);

    const { levels } = await sidebarOf(ada);
    expect(levels[design.id]).toBe("mentions");
    expect(levels[dm.id]).toBe("everything");
  });

  it("changes your own level alone, answering it, and tells every tab of yours and nobody else", async () => {
    const ada = await signIn("Ada");
    const grace = await signIn("Grace");
    const design = await createRoom("Design");
    const tabs = [await openWorkspaceSocket(ada), await openWorkspaceSocket(ada)];
    const gracesTab = await openWorkspaceSocket(grace);

    const response = await involve(ada, design.id, "everything");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ involvement: "everything" });
    for (const tab of tabs) expect(await tab.next()).toEqual(leveled(design.id, "everything"));
    expect(await gracesTab.answers()).toBe(true);
    expect((await sidebarOf(ada)).levels[design.id]).toBe("everything");
    expect((await sidebarOf(grace)).levels[design.id]).toBe("mentions");
  });

  it("takes any level in a room or a DM", async () => {
    const ada = await signIn("Ada");
    const grace = await signIn("Grace");
    const design = await createRoom("Design");
    const dm = await direct(ada, grace);

    for (const roomId of [design.id, dm.id]) {
      for (const involvement of [...INVOLVEMENTS].reverse()) {
        expect(await (await involve(ada, roomId, involvement)).json(), `${roomId}, ${involvement}`).toEqual({ involvement });
        expect((await sidebarOf(ada)).levels[roomId]).toBe(involvement);
      }
    }
  });

  it("changes the sidebar's ETag", async () => {
    const ada = await signIn("Ada");
    const design = await createRoom("Design");
    const before = await api("/api/sidebar", { headers: { Cookie: ada.cookie } });

    await involve(ada, design.id, "nothing");
    const after = await api("/api/sidebar", { headers: { Cookie: ada.cookie, "If-None-Match": before.headers.get("ETag")! } });
    expect(after.status).toBe(200);
    expect(((await after.json()) as Sidebar).rooms.find((room) => room.id === design.id)?.involvement).toBe("nothing");
  });

  it("answers 404 for a room you aren't in or that doesn't exist, whatever's sent, changing nothing", async () => {
    const ada = await signIn("Ada");
    const grace = await signIn("Grace");
    const secret = await createRoom("Secret", { closedTo: [grace.user.id] });

    for (const roomId of [secret.id, "no-such-room", "Not%20a%20room"]) {
      for (const involvement of ["everything", "loud", ""]) {
        const response = await involve(ada, roomId, involvement);
        expect(response.status, `${roomId}, ${involvement}`).toBe(404);
        expect(await response.json()).toEqual({ error: "Room not found or inaccessible" });
      }
    }
    expect((await sidebarOf(grace)).levels[secret.id]).toBe("mentions");
  });

  it("answers 422 for anything but a level, blank included, changing nothing", async () => {
    const ada = await signIn("Ada");
    const design = await createRoom("Design");
    const tab = await openWorkspaceSocket(ada);

    const bodies = [JSON.stringify({ involvement: "" }), JSON.stringify({ involvement: "Everything" }), JSON.stringify({ involvement: "all" }), JSON.stringify({}), "null", "everything"];
    for (const body of bodies) {
      const response = await involve(ada, design.id, null, body);
      expect(response.status, body).toBe(422);
      expect(await response.json()).toEqual({ error: "Notification level must be mentions, everything, nothing or invisible" });
    }
    expect((await sidebarOf(ada)).levels[design.id]).toBe("mentions");
    expect(await tab.answers()).toBe(true);
  });

  it("answers 401 without a session", async () => {
    const design = await createRoom("Design");
    const response = await api(`/api/rooms/${design.id}/involvement`, { method: "PUT", body: JSON.stringify({ involvement: "everything" }) });
    expect(response.status).toBe(401);
  });
});

describe("Hide a room", () => {
  it("keeps a room you hide in your sidebar's list, for the app to leave out, and leaves it out of your stars until you show it again", async () => {
    const ada = await signIn("Ada");
    const design = await createRoom("Design");
    const ops = await createRoom("Ops");
    await star(ada, design.id);
    await star(ada, ops.id);
    const tabs = [await openWorkspaceSocket(ada), await openWorkspaceSocket(ada)];

    await involve(ada, design.id, "invisible");
    for (const tab of tabs) {
      expect(await tab.next()).toEqual(leveled(design.id, "invisible"));
      expect(await tab.next()).toEqual({ type: "favorites.changed", favorites: { rooms: [ops.id], version: 3 } });
    }
    expect(await sidebarOf(ada)).toMatchObject({ levels: { [design.id]: "invisible" }, favorites: { rooms: [ops.id], version: 3 } });

    // Its star comes back with it, in its place.
    await involve(ada, design.id, "mentions");
    for (const tab of tabs) {
      expect(await tab.next()).toEqual(leveled(design.id, "mentions"));
      expect(await tab.next()).toEqual({ type: "favorites.changed", favorites: { rooms: [design.id, ops.id], version: 4 } });
    }
    expect((await sidebarOf(ada)).favorites).toEqual({ rooms: [design.id, ops.id], version: 4 });
  });

  it("leaves your stars alone when a level neither hides a room nor shows it again", async () => {
    const ada = await signIn("Ada");
    const design = await createRoom("Design");
    await star(ada, design.id);
    const tab = await openWorkspaceSocket(ada);

    for (const involvement of ["everything", "nothing", "nothing", "mentions"] as const) {
      await involve(ada, design.id, involvement);
      expect(await tab.next()).toEqual(leveled(design.id, involvement));
    }
    await involve(ada, design.id, "invisible");
    await involve(ada, design.id, "invisible");
    expect(await tab.next()).toEqual(leveled(design.id, "invisible"));
    expect(await tab.next()).toEqual({ type: "favorites.changed", favorites: { rooms: [], version: 2 } });
    expect(await tab.next()).toEqual(leveled(design.id, "invisible"));
    expect((await sidebarOf(ada)).favorites).toEqual({ rooms: [], version: 2 });
  });
});
