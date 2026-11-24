import {
  MAX_SECTIONS,
  type NewRoomForm,
  type NewWorkspace,
  type RoomId,
  type RoomSettings,
  type SavedRoomLayout,
  type Section,
  type SectionId,
  type SharedRoom,
  type Sidebar,
  type SidebarSection,
  type WorkspaceServerFrame,
} from "@ember/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { mergedSectionOrder, PLACE_ROOMS } from "../src/workspace-store";
import { api, cookieOf, createRoom, freshDeploy, openWorkspaceSocket, shown, signIn, workspaceSql, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

const as = (session: Session, method: string, body?: unknown) => ({
  method,
  headers: { Cookie: session.cookie },
  ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
});

/** Makes a section as `session`, as New section in Rooms and permissions does. */
const make = (session: Session, body: unknown) => api("/api/account/sections", as(session, "POST", body));

/** Makes a section named `name` as `session`, answering it. */
async function section(session: Session, name: string): Promise<Section> {
  const response = await make(session, { name });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { section: Section }).section;
}

const rename = (session: Session, id: SectionId, body: unknown) => api(`/api/account/sections/${id}`, as(session, "PATCH", body));
const remove = (session: Session, id: SectionId) => api(`/api/account/sections/${id}`, as(session, "DELETE"));

/** Changes room `roomId` as `session`, as its settings' Save does. */
const change = (roomId: RoomId, session: Session, body: unknown) => api(`/api/rooms/${roomId}`, as(session, "PATCH", body));

/** Creates a room as `session`, as New room does. */
const create = (session: Session, body: unknown) => api("/api/rooms", as(session, "POST", body));

/** Saves the room layout as `session`, as Save order in Rooms and permissions does. */
const lay = (session: Session, layout: unknown) => api("/api/account/room_order", as(session, "PUT", layout));

/** What saving the layout answers. */
async function laid(response: Promise<Response>): Promise<SavedRoomLayout> {
  const settled = await response;
  expect(settled.status, await settled.clone().text()).toBe(200);
  return (await settled.json()) as SavedRoomLayout;
}

/** The sidebar `GET /api/sidebar` gives `session`'s person. */
const sidebarOf = async (session: Session) => (await (await api("/api/sidebar", { headers: { Cookie: session.cookie } })).json()) as Sidebar;

/** The sections in `session`'s sidebar, each with its rooms, in order. */
const sectionsOf = async (session: Session) => (await sidebarOf(session)).sections ?? [];

const settingsOf = async (roomId: RoomId, session: Session) => (await (await api(`/api/rooms/${roomId}/settings`, { headers: { Cookie: session.cookie } })).json()) as RoomSettings;

/** Makes `session`'s person an administrator. */
const promote = (session: Session) => workspaceSql("UPDATE users SET role = 1 WHERE id = ?", session.user.id);

/** The section each of `rooms` is in as stored, by the room's name. */
async function storedSections(...rooms: SharedRoom[]): Promise<Record<string, SectionId | null>> {
  const ids = JSON.stringify(rooms.map((room) => room.id));
  const rows = (await workspaceSql("SELECT name, section_id FROM rooms WHERE id IN (SELECT value FROM json_each(?))", ids)) as Array<{ name: string; section_id: SectionId | null }>;
  return Object.fromEntries(rows.map((row) => [row.name, row.section_id]));
}

const SECTIONS_FORBIDDEN = { error: "Only administrators can make, rename and delete sections" };
const NOT_FOUND = { error: "Section not found" };
const TAKEN = { error: "There's a section with that name already" };

beforeEach(freshDeploy);

describe("Sidebar sections", () => {
  it("are made by administrators, after the others, and listed in their sidebars while empty", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");

    const response = await make(administrator, { name: "  Software engineering " });
    expect(response.status).toBe(201);
    const engineering = ((await response.json()) as { section: Section }).section;
    expect(engineering).toEqual({ id: expect.any(String), name: "Software engineering" });
    const sales = await section(administrator, "Sales");

    expect(await sectionsOf(administrator)).toEqual([
      { ...engineering, roomIds: [] },
      { ...sales, roomIds: [] },
    ] satisfies SidebarSection[]);
    // Nobody else hears of a section until a room of theirs is in it.
    expect((await sidebarOf(grace)).sections).toBeUndefined();
  });

  it("can't be made by anyone else, whose name isn't even checked", async () => {
    await setUp();
    const grace = await signIn("Grace");

    for (const body of [{ name: "Sales" }, { name: "" }, "not JSON"]) {
      const response = await make(grace, body);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(SECTIONS_FORBIDDEN);
    }
    expect(await workspaceSql("SELECT * FROM sections")).toEqual([]);
  });

  it("each have a name of their own, whatever its case", async () => {
    const administrator = await setUp();
    await section(administrator, "Sales");

    const response = await make(administrator, { name: "SALES" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(TAKEN);
    for (const name of ["", "   ", "x".repeat(101), 7]) expect((await make(administrator, { name })).status).toBe(422);
  });

  it("can be as many as a sidebar shows to any use", async () => {
    const administrator = await setUp();
    for (let i = 0; i < MAX_SECTIONS; i++) await workspaceSql("INSERT INTO sections (id, name, position, created_at, updated_at) VALUES (?, ?, ?, '', '')", `s${i}`, `Section ${i}`, i);

    const response = await make(administrator, { name: "One more" });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: `There can be at most ${MAX_SECTIONS} sections` });
  });

  it("are renamed by administrators, and every sidebar loads again", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const [sales, ops] = [await section(administrator, "Sales"), await section(administrator, "Ops")];
    const tabs = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace)];

    const response = await rename(administrator, sales.id, { name: "Revenue" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ section: { id: sales.id, name: "Revenue" } });
    for (const tab of tabs) expect(await tab.next()).toEqual({ type: "rooms.reordered" } satisfies WorkspaceServerFrame);
    expect((await sectionsOf(administrator)).map(({ name }) => name)).toEqual(["Revenue", "Ops"]);

    // Its own name in another case is its to take, the same name changes nothing, and another's isn't.
    expect((await rename(administrator, sales.id, { name: "REVENUE" })).status).toBe(200);
    for (const tab of tabs) expect(await tab.next()).toEqual({ type: "rooms.reordered" });
    expect((await rename(administrator, sales.id, { name: "REVENUE" })).status).toBe(200);
    for (const tab of tabs) expect(await tab.answers()).toBe(true);
    const taken = await rename(administrator, sales.id, { name: "ops" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual(TAKEN);

    expect(await (await rename(grace, ops.id, { name: "Operations" })).json()).toEqual(SECTIONS_FORBIDDEN);
    expect((await rename(administrator, "nowhere", { name: "Operations" })).status).toBe(404);
    expect((await rename(administrator, "Not an id", { name: "Operations" })).status).toBe(404);
    expect((await rename(administrator, ops.id, { name: "" })).status).toBe(422);
    expect((await rename(grace, ops.id, { name: "" })).status).toBe(403);
  });

  it("are deleted by administrators, leaving their rooms in none", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const sales = await section(administrator, "Sales");
    const leads = await createRoom("Leads", { as: administrator });
    expect((await change(leads.id, administrator, { section: sales.id })).status).toBe(200);
    const tabs = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace)];

    expect(await (await remove(grace, sales.id)).json()).toEqual(SECTIONS_FORBIDDEN);
    expect((await remove(administrator, sales.id)).status).toBe(204);
    for (const tab of tabs) expect(await tab.next()).toEqual({ type: "rooms.reordered" });
    expect(await storedSections(leads)).toEqual({ Leads: null });
    expect((await sidebarOf(grace)).sections).toBeUndefined();
    expect(await (await remove(administrator, sales.id)).json()).toEqual(NOT_FOUND);
  });

  it("are asked of whoever's signed in", async () => {
    expect((await api("/api/account/sections", { method: "POST", body: '{"name":"Sales"}' })).status).toBe(401);
    expect((await api("/api/account/sections/nowhere", { method: "DELETE" })).status).toBe(401);
  });
});

describe("A room's section", () => {
  it("is chosen in its settings by whoever can change it, and shown to everyone in it", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const [engineering, sales] = [await section(administrator, "Engineering"), await section(administrator, "Sales")];
    const backend = await createRoom("Backend", { as: grace });
    const gracesTab = await openWorkspaceSocket(grace);

    expect(await settingsOf(backend.id, grace)).toMatchObject({
      section: null,
      sections: [
        { ...engineering, rooms: 0 },
        { ...sales, rooms: 0 },
      ],
    } satisfies Partial<RoomSettings>);

    const response = await change(backend.id, grace, { name: backend.name, section: engineering.id });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ room: backend });
    expect(await gracesTab.next()).toEqual({ type: "room.saved", room: backend, section: engineering } satisfies WorkspaceServerFrame);
    expect(await sectionsOf(grace)).toEqual([{ ...engineering, roomIds: [backend.id] }]);
    expect(await sectionsOf(administrator)).toEqual([
      { ...engineering, roomIds: [backend.id] },
      { ...sales, roomIds: [] },
    ]);
    expect(await settingsOf(backend.id, grace)).toMatchObject({ section: engineering, sections: [{ ...engineering, rooms: 1 }, { ...sales, rooms: 0 }] });

    // Sent as it is, the section moves it nowhere, and nobody hears of it.
    expect((await change(backend.id, grace, { section: engineering.id })).status).toBe(200);
    expect(await gracesTab.answers()).toBe(true);

    expect((await change(backend.id, grace, { section: null })).status).toBe(200);
    expect(await gracesTab.next()).toEqual({ type: "room.saved", room: backend, section: null });
    expect((await sidebarOf(grace)).sections).toBeUndefined();
  });

  it("is shown, but not offered, to those who can't change the room", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const engineering = await section(administrator, "Engineering");
    const backend = await createRoom("Backend", { as: administrator });
    await change(backend.id, administrator, { section: engineering.id });

    expect(await settingsOf(backend.id, grace)).toMatchObject({ canAdminister: false, section: engineering, sections: [] });
    const response = await change(backend.id, grace, { section: null });
    expect(response.status).toBe(403);
    expect(await storedSections(backend)).toEqual({ Backend: engineering.id });
  });

  it("goes in the section with the name given, or one made for it last, which only an administrator can make", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const engineering = await section(administrator, "Engineering");
    const [backend, frontend] = [await createRoom("Backend", { as: grace }), await createRoom("Frontend", { as: grace })];
    const adasTab = await openWorkspaceSocket(administrator);

    expect((await change(backend.id, grace, { section: { name: "engineering" } })).status).toBe(200);
    expect(await adasTab.next()).toEqual({ type: "room.saved", room: backend, section: engineering });
    const refused = await change(frontend.id, grace, { section: { name: "Design" } });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(SECTIONS_FORBIDDEN);

    expect((await change(frontend.id, administrator, { section: { name: " Design " } })).status).toBe(200);
    const [saved, reordered] = [await adasTab.next(), await adasTab.next()];
    const design = { id: expect.any(String) as unknown as SectionId, name: "Design" };
    expect(saved).toEqual({ type: "room.saved", room: frontend, section: design });
    // Every administrator's sidebar has every section, so theirs load again.
    expect(reordered).toEqual({ type: "rooms.reordered" });
    expect(await sectionsOf(administrator)).toEqual([
      { ...engineering, roomIds: [backend.id] },
      { ...design, roomIds: [frontend.id] },
    ]);
  });

  it("must be a section that's there", async () => {
    const administrator = await setUp();
    const backend = await createRoom("Backend", { as: administrator });

    const response = await change(backend.id, administrator, { section: "nowhere" });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(NOT_FOUND);
    for (const section of [7, { name: "" }, { title: "Design" }]) expect((await change(backend.id, administrator, { section })).status).toBe(422);
    expect(await storedSections(backend)).toEqual({ Backend: null });
  });

  it("is chosen in New room too", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const engineering = await section(administrator, "Engineering");
    expect(await (await api("/api/rooms/new", { headers: { Cookie: grace.cookie } })).json()).toMatchObject({
      sections: [{ ...engineering, rooms: 0 }],
    } satisfies Partial<NewRoomForm>);
    const gracesTab = await openWorkspaceSocket(grace);

    const response = await create(grace, { kind: "open", name: "Backend", section: engineering.id });
    expect(response.status).toBe(201);
    const { room } = (await response.json()) as { room: SharedRoom };
    expect(await gracesTab.next()).toEqual({ type: "room.saved", room, section: engineering });
    expect(await sectionsOf(grace)).toEqual([{ ...engineering, roomIds: [room.id] }]);

    expect(await (await create(grace, { kind: "open", name: "Frontend", section: { name: "Design" } })).json()).toEqual(SECTIONS_FORBIDDEN);
    expect((await create(grace, { kind: "open", name: "Frontend", section: "nowhere" })).status).toBe(422);
    const made = await create(administrator, { kind: "closed", name: "Leads", memberIds: [administrator.user.id], section: { name: "Leadership" } });
    expect(made.status).toBe(201);
    const leads = ((await made.json()) as { room: SharedRoom }).room;
    expect((await sectionsOf(administrator)).map(({ name, roomIds }) => ({ name, roomIds }))).toEqual([
      { name: "Engineering", roomIds: [room.id] },
      { name: "Leadership", roomIds: [leads.id] },
    ]);
    // A section with only rooms someone isn't in stays out of their sidebar.
    expect(await sectionsOf(grace)).toEqual([{ ...engineering, roomIds: [room.id] }]);
  });
});

describe("Laying out the sidebar", () => {
  it("puts the sections in order, and the rooms in them, for everyone", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const [engineering, sales] = [await section(administrator, "Engineering"), await section(administrator, "Sales")];
    const [backend, leads, general] = [await createRoom("Backend"), await createRoom("Leads"), await createRoom("Lobby")];

    const saved = await laid(
      lay(administrator, {
        roomIds: [general.id, leads.id, backend.id],
        sections: [
          { id: sales.id, roomIds: [leads.id] },
          { id: engineering.id, roomIds: [backend.id] },
        ],
      }),
    );
    expect(saved).toEqual({
      sharedOrder: [general.id, leads.id, backend.id],
      sections: [
        { ...sales, roomIds: [leads.id] },
        { ...engineering, roomIds: [backend.id] },
      ],
    } satisfies SavedRoomLayout);
    expect(await storedSections(backend, leads, general)).toEqual({ Backend: engineering.id, Lobby: null, Leads: sales.id });
    expect(await sectionsOf(grace)).toEqual(saved.sections);

    // Left out of every section, a room goes in none.
    const sections = [
      { id: sales.id, roomIds: [leads.id] },
      { id: engineering.id, roomIds: [] },
    ];
    expect((await laid(lay(administrator, { roomIds: [general.id, leads.id, backend.id], sections }))).sections).toEqual([
      { ...sales, roomIds: [leads.id] },
      { ...engineering, roomIds: [] },
    ]);
    expect(await storedSections(backend, leads, general)).toEqual({ Backend: null, Lobby: null, Leads: sales.id });
  });

  it("leaves the sections as they are without them, as a tab from before sections sends it", async () => {
    const administrator = await setUp();
    const engineering = await section(administrator, "Engineering");
    const backend = await createRoom("Backend", { as: administrator });
    await change(backend.id, administrator, { section: engineering.id });

    expect((await laid(lay(administrator, { roomIds: [backend.id] }))).sections).toEqual([{ ...engineering, roomIds: [backend.id] }]);
    expect(await storedSections(backend)).toEqual({ Backend: engineering.id });
  });

  it("keeps the sections made since the layout was, after the rest, with their rooms, and the rooms the administrator isn't in where they are", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    await promote(grace);
    const [engineering, sales] = [await section(administrator, "Engineering"), await section(administrator, "Sales")];
    const secret = await createRoom("Secret", { closedTo: [grace.user.id], as: grace });
    expect((await change(secret.id, grace, { section: sales.id })).status).toBe(200);
    const backend = await createRoom("Backend", { as: administrator });
    const frontend = await createRoom("Frontend", { as: administrator });
    // Made, and a room put in it, after the layout was, which lists the room in none.
    const design = await section(grace, "Design");
    expect((await change(frontend.id, grace, { section: design.id })).status).toBe(200);

    const sections = [
      { id: sales.id, roomIds: [] },
      { id: engineering.id, roomIds: [backend.id] },
      { id: "gone", roomIds: [] },
    ];
    await laid(lay(administrator, { roomIds: [backend.id, frontend.id], sections }));
    expect((await sectionsOf(administrator)).map(({ name }) => name)).toEqual(["Sales", "Engineering", "Design"]);
    expect(await storedSections(backend, secret, frontend)).toEqual({ Backend: engineering.id, Secret: sales.id, Frontend: design.id });
  });

  it("refuses sections that aren't a layout of the rooms it orders", async () => {
    const administrator = await setUp();
    const engineering = await section(administrator, "Engineering");
    const [backend, frontend] = [await createRoom("Backend"), await createRoom("Frontend")];

    for (const sections of [
      "Engineering",
      [{ id: engineering.id }],
      [{ id: engineering.id, roomIds: [frontend.id] }],
      [
        { id: engineering.id, roomIds: [backend.id] },
        { id: engineering.id, roomIds: [] },
      ],
      [
        { id: engineering.id, roomIds: [backend.id] },
        { id: "other", roomIds: [backend.id] },
      ],
      Array.from({ length: MAX_SECTIONS + 1 }, (_, i) => ({ id: `s${i}`, roomIds: [] })),
    ])
      expect((await lay(administrator, { roomIds: [backend.id], sections })).status, JSON.stringify(sections).slice(0, 80)).toBe(400);
    expect(await storedSections(backend, frontend)).toEqual({ Backend: null, Frontend: null });
  });

  it("finds each room it places by its id, once, reading the sections listed once", async () => {
    const plan = (await workspaceSql(`EXPLAIN QUERY PLAN ${PLACE_ROOMS}`, "[]", "[]")).map((row) => (row as { detail: string }).detail).join("; ");
    expect(plan).toMatch(/^SCAN json_each VIRTUAL TABLE.*; SEARCH rooms USING INDEX sqlite_autoindex_rooms_1 \(id=\?\); LIST SUBQUERY \d+; SCAN json_each VIRTUAL TABLE/);
    expect(plan).not.toMatch(/CORRELATED|SCAN rooms|SCAN sections/);
  });
});

describe("mergedSectionOrder", () => {
  it("puts the sections listed first, in their order, then the rest as they were", () => {
    expect(mergedSectionOrder(["a", "b", "c", "d"], ["c", "gone", "a"])).toEqual(["c", "a", "b", "d"]);
    expect(mergedSectionOrder(["a", "b"], [])).toEqual(["a", "b"]);
  });
});
