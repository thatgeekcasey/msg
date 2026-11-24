import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const bar = (page: Page) => page.getByRole("banner");
const searchField = (page: Page) => bar(page).getByRole("button", { name: /^Search |^Change search: / });
const searchBox = (page: Page) => page.getByRole("dialog", { name: "Search" });

/** Opens History from the top bar's clock, and says what it lists, each by its name. */
async function openHistory(page: Page) {
  await bar(page).getByRole("button", { name: "History" }).click();
  const menu = page.getByRole("menu", { name: "History" });
  await expect(menu).toBeVisible();
  return menu;
}

/** Waits for `element` to finish opening, before measuring it. */
const opened = (element: Locator) => element.evaluate((shown) => Promise.all(shown.getAnimations().map((animation) => animation.finished)));

/** Searches for `words` from the top bar's search field, as someone types them in the search box. */
async function search(page: Page, words: string) {
  await searchField(page).click();
  await searchBox(page).getByRole("combobox", { name: "Search" }).fill(words);
  await searchBox(page).getByRole("combobox", { name: "Search" }).press("Enter");
  await expect(searchBox(page)).toBeHidden();
}

test.describe("History", () => {
  test("lists the rooms and searches shown lately, newest first, the one shown aside, each going back to it", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    const heading = ada.page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText("general");
    await expect((await openHistory(ada.page)).getByRole("menuitem")).toHaveCount(0);
    await expect(ada.page.getByRole("menu", { name: "History" })).toHaveText(/Rooms, DMs and searches you visit show up here\./);
    await ada.page.keyboard.press("Escape");

    await ada.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: /random/ }).click();
    await expect(heading).toHaveText("random");
    const okapi = `okapi${crypto.randomUUID().slice(0, 8)}`;
    await search(ada.page, okapi);
    await expect(ada.page).toHaveURL(`/searches?q=${okapi}`);

    const menu = await openHistory(ada.page);
    await expect(menu.getByRole("menuitem")).toHaveText([/^#random\s*Just now$/, /^#general\s*Just now$/]);
    await menu.getByRole("menuitem", { name: /general/ }).click();
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
    await expect(heading).toHaveText("general");
    await expect((await openHistory(ada.page)).getByRole("menuitem")).toHaveText([new RegExp(`^“${okapi}”`), /^#random/]);
  });

  test("keeps what every tab of the browser shows, through a reload", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("general");
    const other = await ada.page.context().newPage();
    await other.goto("/");
    await other.getByRole("region", { name: "Rooms" }).getByRole("link", { name: /random/ }).click();
    await expect(other.getByRole("heading", { level: 1 })).toHaveText("random");

    await expect((await openHistory(ada.page)).getByRole("menuitem")).toHaveText([/^#random/]);
    await ada.page.reload();
    await expect((await openHistory(ada.page)).getByRole("menuitem")).toHaveText([/^#random/]);
  });
});

test.describe("Search field", () => {
  test("opens the search box over itself, wider than it, leaving the page undimmed, and shows the search the results page shows", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1280, height: 800 } } });
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("general");
    // The rail leaves Search to the bar.
    await expect(ada.page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Search", includeHidden: true })).toBeHidden();
    await searchField(ada.page).click();
    const box = searchBox(ada.page);
    await expect(box.getByRole("combobox", { name: "Search" })).toBeFocused();
    await opened(box);
    // The bar's field is at 360, 7, 908px wide: the box lies over it, 16px wider, 8px inside the window.
    const place = (await box.boundingBox())!;
    expect([place.x, place.y, place.width].map(Math.round)).toEqual([348, 4, 924]);
    await expect(ada.page.locator("[data-slot=dialog-overlay]")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await box.getByRole("combobox", { name: "Search" }).press("Escape");
    await expect(box).toBeHidden();
    await expect(searchField(ada.page)).toBeFocused();

    const okapi = `okapi${crypto.randomUUID().slice(0, 8)}`;
    await search(ada.page, okapi);
    await expect(searchField(ada.page)).toHaveAccessibleName(`Change search: ${okapi}`);
    await expect(searchField(ada.page)).toHaveText(okapi);
    // Over 900px wide, the page's header leaves the search to the bar.
    const header = ada.page.getByRole("navigation", { name: "Page" });
    await expect(header.getByRole("heading", { level: 1, name: "Search messages" })).toBeVisible();
    await expect(header.getByRole("button", { name: /^Change search: / })).toBeHidden();
    await searchField(ada.page).click();
    await expect(box.getByRole("combobox", { name: "Search" })).toHaveValue(okapi);
  });

  test("opens the search box in the middle of a phone, from the top of the conversations drawer", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } });
    await expect(bar(ada.page)).toBeHidden();
    await ada.page.getByRole("button", { name: "Open conversations" }).click();
    const drawer = ada.page.getByRole("dialog", { name: "Conversations" });
    const field = drawer.getByRole("button", { name: /^Search / });
    await expect(field).toBeVisible();
    // The drawer's rail leaves Search to the field.
    await expect(drawer.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Search", includeHidden: true })).toBeHidden();
    expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await field.click();
    await expect(drawer).toBeHidden();
    await expect(searchBox(ada.page).getByRole("combobox", { name: "Search" })).toBeFocused();
    await expect(ada.page.locator("[data-slot=dialog-overlay]")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });

  test("leaves the bar out on a phone in landscape, wider than 900px, where Search stays in the rail", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 956, height: 390 }, hasTouch: true, isMobile: true } });
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("general");
    await expect(bar(ada.page)).toBeHidden();
    // The room keeps the little height there is: its header is at the top of the screen, and the
    // conversations beside it start with their rooms.
    expect((await ada.page.getByRole("navigation", { name: "Page" }).boundingBox())!.y).toBe(0);
    await expect(ada.page.getByRole("complementary", { name: "Conversations" }).getByRole("button", { name: /^Search /, includeHidden: true })).toBeHidden();
    await ada.page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Search" }).tap();
    await expect(searchBox(ada.page).getByRole("combobox", { name: "Search" })).toBeFocused();
    await expect(ada.page.locator("[data-slot=dialog-overlay]")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });
});
