import { editorField, openRoom, signInAs } from "../../fixtures";
import { settle } from "./audits";
import { expect, hasDrawerLayout, test } from "./fixtures";

test.beforeEach(async ({ page, session, room }) => {
  test.skip(!hasDrawerLayout(page), "Wider than 900px the rail and sidebar are always on screen");
  await signInAs(page, session);
  await openRoom(page, room);
});

test("the conversations drawer opens from the header and fits", async ({ page, screenIsFine }) => {
  await page.getByRole("button", { name: "Open conversations" }).tap();
  const drawer = page.getByRole("dialog", { name: "Conversations" });
  await expect(drawer).toBeVisible();
  await screenIsFine();

  // The drawer leaves a strip of the room showing, so it reads as a drawer and there's somewhere to tap
  // to close it.
  const box = (await drawer.boundingBox())!;
  expect(page.viewportSize()!.width - (box.x + box.width)).toBeGreaterThanOrEqual(16);
});

test("on community settings the drawer holds the rail alone, as Navigation, and fits", async ({ page, screenIsFine }) => {
  await page.goto("/account/edit#channel-settings");
  await page.getByRole("button", { name: "Open navigation" }).tap();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer.getByRole("navigation", { name: "Workspace" })).toBeVisible();
  await expect(drawer.getByRole("complementary", { name: "Conversations" })).toHaveCount(0);
  await screenIsFine();
});

test("tapping outside the drawer closes it", async ({ page }) => {
  await page.getByRole("button", { name: "Open conversations" }).tap();
  await expect(page.getByRole("dialog")).toBeVisible();
  // Radix starts listening for presses outside the drawer a timer tick after it opens, and a raw
  // tap sent the moment it shows can beat that. Wait for it to finish sliding in, as a person would.
  await settle(page);
  const { width, height } = page.viewportSize()!;
  await page.touchscreen.tap(width - 6, height / 2);
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("the drawer opens on its close button, which closes it and returns focus to the menu button", async ({ page }) => {
  const menu = page.getByRole("button", { name: "Open conversations" });
  await menu.tap();
  const close = page.getByRole("dialog").getByRole("button", { name: "Close conversations" });
  await expect(close).toBeFocused();
  // While the drawer is open, everything behind it is hidden from assistive tech, the menu button
  // too, which is named for closing it.
  await expect(page.getByRole("button", { name: "Close conversations", expanded: true, includeHidden: true })).toBeAttached();
  await close.tap();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
});

test("focus moved on as the drawer slides away stays where it went", async ({ page }) => {
  const composer = editorField(page, "Write a message");
  // Found now, since the drawer hides the page from assistive tech, and so from role queries, till it's gone.
  const field = await composer.elementHandle();
  await page.getByRole("button", { name: "Open conversations" }).tap();
  const drawer = page.getByRole("dialog", { name: "Conversations" });
  await expect(drawer).toBeVisible();
  await settle(page);
  await drawer.getByRole("button", { name: "Close conversations" }).tap();
  // Straight away, as a quick tap on the message box would, before the drawer has slid away.
  await field.focus();
  // Radix gives focus back a timer tick after the drawer goes.
  await expect(page.locator("[data-slot=sheet-content]")).toHaveCount(0);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(composer).toBeFocused();
});

test("choosing a room closes the drawer", async ({ page, room }) => {
  await page.getByRole("button", { name: "Open conversations" }).tap();
  await page.getByRole("dialog").getByRole("link", { name: room.name }).tap();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}$`));
});

test("Activity filters the drawer's conversations, and the drawer stays open as it turns on and off", async ({ page, room, screenIsFine }) => {
  await page.getByRole("button", { name: "Open conversations" }).tap();
  const drawer = page.getByRole("dialog", { name: "Conversations" });
  const activity = drawer.getByRole("button", { name: "Activity" });
  // The room shown is read, so Activity leaves it out.
  const row = drawer.getByRole("link", { name: room.name });
  await activity.tap();
  await expect(activity).toHaveAttribute("aria-pressed", "true");
  await expect(row).toBeHidden();
  await expect(drawer.getByText("You’re all caught up. No unread conversations.")).toBeVisible();
  await screenIsFine();

  await activity.tap();
  await expect(activity).toHaveAttribute("aria-pressed", "false");
  await expect(drawer).toBeVisible();
  await expect(row).toBeVisible();
});

test("Activity, tapped in the drawer on community settings, goes home with the drawer open on the conversations it filters", async ({ page, room }) => {
  await page.goto("/account/edit#channel-settings");
  await page.getByRole("button", { name: "Open navigation" }).tap();
  await page.getByRole("dialog", { name: "Navigation" }).getByRole("button", { name: "Activity" }).tap();
  // Home goes on to the room last visited, which is read, so Activity leaves it out.
  await expect(page).toHaveURL(new RegExp(`/rooms/${room.id}$`));
  const drawer = page.getByRole("dialog", { name: "Conversations" });
  await expect(drawer.getByRole("button", { name: "Activity" })).toHaveAttribute("aria-pressed", "true");
  await expect(drawer.getByText("You’re all caught up. No unread conversations.")).toBeVisible();
});

test("rotating the phone with the drawer open leaves the page usable", async ({ page, room }) => {
  await page.getByRole("button", { name: "Open conversations" }).tap();
  await expect(page.getByRole("dialog")).toBeVisible();

  // Turn it on its side, or upright for a phone already on its side. With viewport-fit=cover the
  // page runs the full length of the screen.
  const [short, long] = await page.evaluate(() => [Math.min(screen.width, screen.height), Math.max(screen.width, screen.height)]);
  const { width, height } = page.viewportSize()!;
  await page.setViewportSize(width < height ? { width: long, height: short } : { width: short, height: long });
  if (hasDrawerLayout(page)) {
    await expect(page.getByRole("dialog")).toBeVisible();
  } else {
    // A big phone on its side is past 900px, where there's no drawer. It has to close rather than
    // hide, or it dims the page and takes the next tap.
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.locator("[data-slot=sheet-overlay]")).toBeHidden();
    const composer = editorField(page, "Write a message");
    await composer.tap();
    await expect(composer).toBeFocused();
  }
});
