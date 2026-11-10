import { cookieHeader, ICON_CATALOG_LOADED, signInAs, type TestRoom } from "../../fixtures";
import { expect, hasDrawerLayout, SWITCHES, test } from "./fixtures";

// Asking for the test's room keeps every other test's rooms out of the workspace these pages show.
test.beforeEach(async ({ page, session, room: _ }) => {
  await signInAs(page, session);
});

test("Rooms and permissions fit the phone", async ({ page, screenIsFine }) => {
  await page.goto("/account/edit#channel-settings");
  await expect(page.getByRole("link", { name: "New room" })).toBeVisible();
  await screenIsFine();
});

test("the private New room form fits the phone", async ({ page, screenIsFine }) => {
  await page.goto("/rooms/closeds/new");
  await expect(page.getByRole("switch", { name: "Give everyone access to this room" })).toBeVisible();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("a private room's settings, with a switch for each person, fit the phone", async ({ page, request, session, screenIsFine }) => {
  const response = await request.post("/api/rooms", { data: { kind: "closed", name: "Leads", memberIds: [session.user.id] }, headers: { Cookie: cookieHeader(session) } });
  expect(response.status(), await response.text()).toBe(201);
  const { room } = (await response.json()) as { room: TestRoom };
  await page.goto(`/rooms/closeds/${room.id}/edit`);
  await expect(page.getByRole("switch", { name: "Give everyone access to this room" })).toBeVisible();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("a room's settings fit the phone", async ({ page, room, screenIsFine }) => {
  await page.goto(`/rooms/opens/${room.id}/edit`);
  await expect(page.getByRole("textbox", { name: "Room name" })).toHaveValue(room.name);
  // With the Everyone switch and Delete, which whoever can change the room has.
  await expect(page.getByRole("button", { name: `Delete ${room.name}` })).toBeAttached();
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("tapping into a room's name selects it, and a second tap places the cursor", async ({ page, room }) => {
  await page.goto(`/rooms/opens/${room.id}/edit`);
  const name = page.getByRole("textbox", { name: "Room name" });
  await expect(name).toHaveValue(room.name);
  await page.getByRole("heading", { level: 1, name: "Room settings" }).tap();
  await expect(name).not.toBeFocused();
  await name.tap();
  await page.keyboard.type("Phone");
  await expect(name).toHaveValue("Phone");
  await name.tap();
  await page.keyboard.type(" room");
  await expect(name).toHaveValue("Phone room");
});

test("the room icon picker fits the phone", async ({ page, room, screenIsFine }) => {
  await page.goto(`/rooms/opens/${room.id}/edit`);
  await page.getByRole("button", { name: "Choose room icon" }).click();
  const picker = page.getByRole("dialog", { name: "Choose a room icon" });
  await expect(picker.getByRole("status")).toHaveText("3,540 icons · 72 shown", ICON_CATALOG_LOADED);
  await screenIsFine({ denseTargets: [SWITCHES] });
});

test("asking about unsaved changes opens over the drawer, keeps focus in, and fits the phone", async ({ page, room, screenIsFine }) => {
  await page.goto(`/rooms/opens/${room.id}/edit`);
  await page.getByRole("textbox", { name: "Room name" }).fill("Phone draft");
  if (hasDrawerLayout(page)) await page.getByRole("button", { name: "Open navigation" }).tap();
  await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Workspace" }).tap();
  const unsaved = page.getByRole("dialog", { name: "Unsaved Changes" });
  await expect(unsaved).toBeVisible();
  for (let step = 0; step < 4; step++) {
    await page.keyboard.press("Tab");
    expect(await unsaved.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  }
  await screenIsFine();

  await unsaved.getByRole("button", { name: "Discard" }).tap();
  await expect(page).toHaveURL(/\/account\/edit$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
