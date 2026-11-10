import { MAX_SHARED_ORDER, type NewWorkspace, type RoomId, type Sidebar, type UserId, type WorkspaceServerFrame } from "@ember/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { mergedSharedOrder } from "../src/workspace-store";
import { api, cookieOf, createRoom, direct, freshDeploy, openWorkspaceSocket, shown, signIn, workspaceSql, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Saves the shared order as `session`, as Save order on workspace settings does. */
const order = (session: Session, roomIds: unknown) =>
  api("/api/account/room_order", { method: "PUT", headers: { Cookie: session.cookie }, body: typeof roomIds === "string" ? roomIds : JSON.stringify({ roomIds }) });

/** What saving the order answers: the rooms the administrator is in that it ranks, in its order. */
const answered = async (response: Promise<Response>) => {
  const settled = await response;
  expect(settled.status, await settled.clone().text()).toBe(200);
  return ((await settled.json()) as { sharedOrder: RoomId[] }).sharedOrder;
};

/** The sidebar `GET /api/sidebar` gives `session`'s person. */
const sidebarOf = async (session: Session) => (await (await api("/api/sidebar", { headers: { Cookie: session.cookie } })).json()) as Sidebar;

/** The shared order as stored, every room it ranks, in order. */
const stored = async () =>
  ((await workspaceSql("SELECT id FROM rooms WHERE shared_position IS NOT NULL ORDER BY shared_position")) as Array<{ id: RoomId }>).map((row) => row.id);

/** Changes room `roomId` as `session`, as its settings' Save does. */
const change = (roomId: RoomId, session: Session, body: unknown) =>
  api(`/api/rooms/${roomId}`, { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify(body) });

/** Makes `userId` an administrator, as `administrator`'s crown does. */
const promote = (administrator: Session, userId: UserId, role = "administrator") =>
  api(`/api/account/users/${userId}`, { method: "PATCH", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ role }) });

/** Hides room `roomId` from `session`'s person, as its bell does at off and hidden. */
const hide = (session: Session, roomId: RoomId) =>
  workspaceSql("UPDATE memberships SET involvement = 'invisible' WHERE room_id = ? AND user_id = ?", roomId, session.user.id);

/** The 403 someone gets for an order they can't save. */
const FORBIDDEN = { error: "Only administrators can put rooms in order for everyone, and only the rooms in their sidebar" };

beforeEach(freshDeploy);

describe("Shared room order", () => {
  it("puts the rooms in an administrator's sidebar in order for everyone, answering their order", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const [design, ops, sales] = [await createRoom("Design"), await createRoom("Ops"), await createRoom("Sales")];

    expect(await answered(order(administrator, [sales.id, design.id, ops.id]))).toEqual([sales.id, design.id, ops.id]);
    expect(await stored()).toEqual([sales.id, design.id, ops.id]);
    for (const session of [administrator, grace]) expect((await sidebarOf(session)).sharedOrder).toEqual([sales.id, design.id, ops.id]);
  });

  it("changes the sidebar's ETag with the order", async () => {
    const administrator = await setUp();
    const design = await createRoom("Design");
    const before = await api("/api/sidebar", { headers: { Cookie: administrator.cookie } });
    expect(((await before.json()) as Sidebar).sharedOrder).toEqual([]);

    await order(administrator, [design.id]);
    const after = await api("/api/sidebar", { headers: { Cookie: administrator.cookie, "If-None-Match": before.headers.get("ETag")! } });
    expect(after.status).toBe(200);
    expect(((await after.json()) as Sidebar).sharedOrder).toEqual([design.id]);
  });

  it("leaves out of each sidebar the rooms its person isn't in, so their ids never reach them", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const design = await createRoom("Design");
    const secret = await createRoom("Secret", { closedTo: [administrator.user.id] });

    await order(administrator, [secret.id, design.id]);
    expect((await sidebarOf(administrator)).sharedOrder).toEqual([secret.id, design.id]);
    expect((await sidebarOf(grace)).sharedOrder).toEqual([design.id]);
  });

  it("keeps the places of rooms outside the administrator's sidebar, which another administrator ordered", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    await promote(administrator, grace.user.id);
    const [design, ops] = [await createRoom("Design"), await createRoom("Ops")];
    const secret = await createRoom("Secret", { closedTo: [grace.user.id] });
    await order(grace, [secret.id, design.id, ops.id]);

    expect(await answered(order(administrator, [ops.id, design.id]))).toEqual([ops.id, design.id]);
    expect(await stored()).toEqual([secret.id, ops.id, design.id]);
    expect((await sidebarOf(grace)).sharedOrder).toEqual([secret.id, ops.id, design.id]);
  });

  it("drops the rank of rooms a shorter list leaves out, and puts rooms new to the order last", async () => {
    const administrator = await setUp();
    const [design, ops, sales] = [await createRoom("Design"), await createRoom("Ops"), await createRoom("Sales")];
    await order(administrator, [design.id, ops.id, sales.id]);

    expect(await answered(order(administrator, [sales.id, design.id]))).toEqual([sales.id, design.id]);
    expect(await answered(order(administrator, [ops.id, sales.id, design.id]))).toEqual([ops.id, sales.id, design.id]);
  });

  it("clears the order with an empty list, the rooms outside the administrator's sidebar included", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    await promote(administrator, grace.user.id);
    const design = await createRoom("Design");
    const secret = await createRoom("Secret", { closedTo: [grace.user.id] });
    await order(grace, [secret.id, design.id]);

    expect(await answered(order(administrator, []))).toEqual([]);
    expect(await stored()).toEqual([]);
    expect((await sidebarOf(grace)).sharedOrder).toEqual([]);
  });

  it("drops a deleted room from the order", async () => {
    const administrator = await setUp();
    const [design, ops] = [await createRoom("Design", { as: administrator }), await createRoom("Ops")];
    await order(administrator, [design.id, ops.id]);

    expect((await api(`/api/rooms/${design.id}`, { method: "DELETE", headers: { Cookie: administrator.cookie } })).status).toBe(204);
    expect((await sidebarOf(administrator)).sharedOrder).toEqual([ops.id]);
  });

  it("has every sidebar load again, naming no rooms", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const design = await createRoom("Design");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace)];

    await order(administrator, [design.id]);
    for (const socket of sockets) expect(await socket.next()).toEqual({ type: "rooms.reordered" } satisfies WorkspaceServerFrame);
  });

  it("has the sidebars of the people a ranked room takes in load again, as the order they have left it out", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const [plans, design, ops] = [
      await createRoom("Plans", { closedTo: [administrator.user.id], as: administrator }),
      await createRoom("Design", { closedTo: [administrator.user.id], as: administrator }),
      await createRoom("Ops", { closedTo: [administrator.user.id], as: administrator }),
    ];
    await answered(order(administrator, [plans.id, design.id]));
    const [adasTab, gracesTab] = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace)];

    expect((await change(plans.id, administrator, { kind: "closed", memberIds: [administrator.user.id, grace.user.id] })).status).toBe(200);
    expect(await gracesTab.next()).toEqual({ type: "room.saved", room: plans });
    expect(await gracesTab.next()).toEqual({ type: "rooms.reordered" } satisfies WorkspaceServerFrame);
    expect((await sidebarOf(grace)).sharedOrder).toEqual([plans.id]);

    // Opened to everyone, it's shown as it is now to the people already in it, who hear nothing more.
    expect((await change(design.id, administrator, { kind: "open" })).status).toBe(200);
    expect(await gracesTab.next()).toEqual({ type: "room.saved", room: { ...design, kind: "open" } });
    expect(await gracesTab.next()).toEqual({ type: "rooms.reordered" });
    expect(await adasTab.next()).toEqual({ type: "room.saved", room: { ...design, kind: "open" } });
    expect(await adasTab.answers()).toBe(true);

    // A room the order doesn't rank takes people in without it.
    expect((await change(ops.id, administrator, { kind: "open" })).status).toBe(200);
    expect(await gracesTab.next()).toEqual({ type: "room.saved", room: { ...ops, kind: "open" } });
    expect(await gracesTab.answers()).toBe(true);
  });

  it("keeps everyone's stars, and their order", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const [design, ops] = [await createRoom("Design"), await createRoom("Ops")];
    for (const roomId of [ops.id, design.id]) await api(`/api/rooms/${roomId}/favorite`, { method: "PUT", headers: { Cookie: grace.cookie }, body: '{"favorite":true}' });

    await order(administrator, [design.id, ops.id]);
    expect((await sidebarOf(grace)).favorites).toEqual({ rooms: [ops.id, design.id], version: 2 });
  });

  it("answers 403, changing nothing, to anyone but an administrator, whatever they send", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const design = await createRoom("Design");
    await order(administrator, [design.id]);

    for (const body of [[design.id], [], "not JSON", { roomIds: "all" }]) {
      const response = await order(grace, body);
      expect(response.status, JSON.stringify(body)).toBe(403);
      expect(await response.json()).toEqual(FORBIDDEN);
    }
    expect(await stored()).toEqual([design.id]);
  });

  it("answers 403, changing nothing, for a DM, a room outside the administrator's sidebar, or one that doesn't exist", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const design = await createRoom("Design");
    const secret = await createRoom("Secret", { closedTo: [grace.user.id] });
    const hidden = await createRoom("Hidden");
    await hide(administrator, hidden.id);
    const dm = await direct(administrator, grace);
    await order(administrator, [design.id]);

    for (const roomId of [dm.id, secret.id, hidden.id, "no-such-room"]) {
      const response = await order(administrator, [roomId, design.id]);
      expect(response.status, roomId).toBe(403);
      expect(await response.json()).toEqual(FORBIDDEN);
    }
    expect(await stored()).toEqual([design.id]);
  });

  it("checks who's an administrator as they are when they save it", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const design = await createRoom("Design");
    await promote(administrator, grace.user.id);
    expect((await order(grace, [design.id])).status).toBe(200);

    await promote(administrator, grace.user.id, "member");
    expect((await order(grace, [])).status).toBe(403);
    expect(await stored()).toEqual([design.id]);
  });

  it("refuses an order that would rank more rooms than it can hold", async () => {
    const administrator = await setUp();
    const design = await createRoom("Design");
    // Rooms the administrator isn't in, which another administrator could have ordered, fill it.
    await workspaceSql(`WITH RECURSIVE n (i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_SHARED_ORDER - 1})
      INSERT INTO rooms (id, kind, name, created_at, updated_at, shared_position) SELECT 'filler-' || i, 'closed', 'Filler', 'now', 'now', i FROM n`);

    expect((await order(administrator, [design.id])).status).toBe(403);
    expect((await stored()).length).toBe(MAX_SHARED_ORDER);
    expect(await answered(order(administrator, []))).toEqual([]);
  });

  it.each([
    ["a body that isn't JSON", "not JSON", "roomIds must be an array"],
    ["a list that isn't one", { roomIds: "all" }, "roomIds must be an array"],
    ["a room twice", { roomIds: ["general", "general"] }, "room IDs must be unique and valid"],
    ["an id that isn't a room's", { roomIds: ["Not a room"] }, "room IDs must be unique and valid"],
    ["more rooms than it can hold", { roomIds: Array.from({ length: MAX_SHARED_ORDER + 1 }, (_, i) => `room-${i}`) }, "too many rooms"],
  ])("answers 400 to an administrator for %s, changing nothing", async (_, body, error) => {
    const administrator = await setUp();
    const response = await api("/api/account/room_order", {
      method: "PUT",
      headers: { Cookie: administrator.cookie },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(await stored()).toEqual([]);
  });

  it("answers 401 to someone signed out, whatever they send", async () => {
    for (const body of [JSON.stringify({ roomIds: [] }), "not JSON"]) {
      expect((await api("/api/account/room_order", { method: "PUT", body })).status).toBe(401);
    }
  });
});

describe("Shared room order", () => {
  it("merges an order", () => {
    const saved = (ids: string, orderable: string) => [...ids].map((id) => ({ id, orderable: orderable.includes(id) }));
    // Each place a room the administrator could order holds goes to the next listed, in turn.
    expect(mergedSharedOrder(saved("abc", "abc"), ["c", "a", "b"])).toEqual(["c", "a", "b"]);
    // Rooms they couldn't order keep their places.
    expect(mergedSharedOrder(saved("xaybz", "ab"), ["b", "a"])).toEqual(["x", "b", "y", "a", "z"]);
    // Places left over once the list runs out go, and the rest of the list follows.
    expect(mergedSharedOrder(saved("axb", "ab"), ["b"])).toEqual(["b", "x"]);
    expect(mergedSharedOrder(saved("xa", "a"), ["c", "a", "d"])).toEqual(["x", "c", "a", "d"]);
    expect(mergedSharedOrder([], ["a", "b"])).toEqual(["a", "b"]);
  });
});
