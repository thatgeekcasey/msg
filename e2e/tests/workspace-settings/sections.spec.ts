import type { Page } from "@playwright/test";
import type { Sidebar } from "@ember/protocol";
import { expect, test } from "../../fixtures";
import { signInAsAdministrator, useOwnAddress } from "../../fixtures";
import { join } from "./fixtures";

/**
 * Sends `body` to the API from `page`, as the app does, which over HTTPS is the only way the Worker
 * takes a change, and answers the status.
 */
const send = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    async ([method, path, body]) =>
      (await fetch(path, { method, headers: { "Content-Type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) })).status,
    [method, path, body] as const,
  );

/** The sections `page`'s person's sidebar lists, as the API answers them. */
const sectionsOf = (page: Page) => page.evaluate(async () => ((await (await fetch("/api/sidebar")).json()) as Sidebar).sections ?? []);

/** The sidebar of `tab`'s person, and the rooms it lists under the section named `name`, top to bottom. */
const sidebarOf = (tab: Page) => tab.getByRole("complementary", { name: "Conversations" }).getByRole("region", { name: "Rooms" });
const roomsUnder = (tab: Page, name: string) => sidebarOf(tab).getByRole("group", { name }).getByRole("link");

/** Each tab waits up to 5 seconds at random before loading its sidebar again for a change to the sections. */
const RELOADED = { timeout: 15_000 };

test.describe("Sidebar sections", () => {
  test("the administrator makes a section, puts rooms in it, renames it and deletes it, and a member's sidebar follows, folding it", async ({ page, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit#membership-settings");
    await signInAsAdministrator(page);
    const joinLink = page.getByRole("textbox", { name: "Share to invite more people" });
    await expect(joinLink).toBeVisible();
    // Rooms and a section of this run's own, since a server kept from an earlier run has others.
    const run = crypto.randomUUID().slice(0, 8);
    const [first, second] = [`Sectioned ${run} a`, `Sectioned ${run} b`];
    const [section, renamed] = [`Engineering ${run}`, `Software ${run}`];
    for (const name of [first, second]) expect(await send(page, "POST", "/api/rooms", { kind: "open", name })).toBe(201);
    const member = await join(browser, baseURL!, await joinLink.inputValue(), `Grace ${run}`);

    try {
      await page.getByRole("link", { name: "Rooms and permissions" }).click();
      const list = page.getByRole("list", { name: "Room order" });
      await expect(list).toBeVisible();
      const rows = list.getByRole("listitem");
      const row = (name: string) => rows.filter({ hasText: name });

      // New section, beside New room.
      await page.getByRole("button", { name: "New section" }).click();
      const dialog = page.getByRole("dialog", { name: "New section" });
      await dialog.getByRole("textbox", { name: "Section name" }).fill(section);
      await dialog.getByRole("button", { name: "Create section" }).click();
      await expect(dialog).toBeHidden();
      await expect(row(section)).toContainText("No rooms");

      // The first room goes in it from its settings.
      await row(first).getByRole("link").click();
      await page.getByRole("button", { name: "Sidebar section" }).click();
      await page.getByRole("menuitemradio", { name: new RegExp(`^${section}`) }).click();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page).toHaveURL(/\/rooms\/[^/]+$/);
      await expect(roomsUnder(member, section)).toHaveText([`#${first}`]);

      // The second with Alt and the down arrow, past the rooms below it and the heading.
      await page.goto("/account/edit#channel-settings");
      await expect(row(section)).toContainText("1 room");
      const ids = await rows.evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.roomId!));
      const names = await rows.allTextContents();
      const below = names.findIndex((text) => text.startsWith(section)) - names.findIndex((text) => text.includes(second));
      expect(below, ids.join()).toBeGreaterThan(0);
      await row(second).focus();
      for (let i = 0; i < below; i++) await page.keyboard.press("Alt+ArrowDown");
      await expect(row(section)).toContainText("2 rooms");
      await page.getByRole("button", { name: "Save order" }).click();
      await expect(page.getByText("Room order saved for everyone.")).toBeVisible();
      await expect(roomsUnder(member, section)).toHaveText([`#${second}`, `#${first}`], RELOADED);

      // The member folds it, which lasts through a reload, and unfolds it.
      const divider = sidebarOf(member).getByRole("button", { name: section });
      await expect(divider).toHaveAttribute("aria-expanded", "true");
      await divider.click();
      await expect(divider).toHaveAttribute("aria-expanded", "false");
      await expect(roomsUnder(member, section)).toHaveCount(0);
      await member.reload();
      await expect(divider).toHaveAttribute("aria-expanded", "false");
      await divider.click();
      await expect(roomsUnder(member, section)).toHaveText([`#${second}`, `#${first}`]);

      // Renamed, then deleted, the rooms staying, in none.
      await row(section).getByRole("button", { name: `Rename ${section}` }).click();
      const renaming = page.getByRole("dialog", { name: "Rename section" });
      await renaming.getByRole("textbox", { name: "Section name" }).fill(renamed);
      await renaming.getByRole("button", { name: "Rename" }).click();
      await expect(renaming).toBeHidden();
      await expect(row(renamed)).toBeVisible();
      await expect(roomsUnder(member, renamed)).toHaveText([`#${second}`, `#${first}`], RELOADED);

      page.once("dialog", (asked) => void asked.accept());
      await row(renamed).getByRole("button", { name: `Delete ${renamed}` }).click();
      await expect(row(renamed)).toHaveCount(0);
      await expect(sidebarOf(member).getByRole("group", { name: renamed })).toHaveCount(0, RELOADED);
      await expect(sidebarOf(member).getByRole("link", { name: second })).toBeVisible();
    } finally {
      // Sections this run made, and the shared order, as the tests that follow expect them.
      for (const { id, name } of await sectionsOf(page)) if (name.includes(run)) expect(await send(page, "DELETE", `/api/account/sections/${id}`)).toBe(204);
      expect(await send(page, "PUT", "/api/account/room_order", { roomIds: [] })).toBe(200);
    }
    await member.context().close();
  });
});
