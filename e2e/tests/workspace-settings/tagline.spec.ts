import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { signInAsAdministrator, useOwnAddress } from "../../fixtures";

/** A tagline as long as Ember takes, in everyday words. */
const TAGLINE = "Engines and tea for every soul";

/** The tagline right under the workspace's name, at the top of the conversations. */
const taglineOf = (page: Page) => page.getByRole("complementary", { name: "Conversations" }).locator("hgroup > h2 + p");

/** How many lines `text` takes up. */
const linesOf = (text: Locator) =>
  text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map((line) => Math.round(line.top))).size;
  });

test.describe("Workspace tagline", () => {
  test("the administrator gives the workspace a tagline, which every tab shows under its name, then takes it away", async ({ page }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit");
    await signInAsAdministrator(page);
    const field = page.getByRole("textbox", { name: "Tagline" });
    await expect(field).toBeVisible();
    const otherTab = await page.context().newPage();
    await otherTab.goto("/account/edit");
    await expect(otherTab.getByRole("textbox", { name: "Tagline" })).toBeVisible();

    // A server kept from an earlier run may have one already.
    await field.fill(TAGLINE);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("alert")).toHaveText("Changes saved.");
    // The other tab's settings follow, so saving there keeps it.
    await expect(otherTab.getByRole("textbox", { name: "Tagline" })).toHaveValue(TAGLINE);
    await otherTab.getByRole("button", { name: "Save changes" }).click();
    await expect(otherTab.getByRole("alert")).toHaveText("Changes saved.");
    // Community settings' links take the conversations' place, which have it under the name back in a room.
    for (const tab of [page, otherTab]) await tab.getByRole("link", { name: "Go Back" }).click();
    for (const tab of [page, otherTab]) await expect(taglineOf(tab)).toHaveText(TAGLINE);
    // On one line in the sidebar's full 280px, as in a phone's drawer (mobile/accounts.spec.ts).
    expect(await linesOf(taglineOf(page))).toBe(1);

    await page.goto("/account/edit");
    await expect(field).toHaveValue(TAGLINE);
    await field.clear();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("alert")).toHaveText("Changes saved.");
    // At once in the tab still in a room.
    await expect(taglineOf(otherTab)).toHaveCount(0);
    await page.getByRole("link", { name: "Go Back" }).click();
    await expect(taglineOf(page)).toHaveCount(0);
  });
});
