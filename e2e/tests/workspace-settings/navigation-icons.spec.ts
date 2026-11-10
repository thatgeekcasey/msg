import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { ICON_CATALOG_LOADED, signInAsAdministrator, useOwnAddress } from "../../fixtures";

/** The rail's Home link. */
const homeOf = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Home", exact: true });

test.describe("Navigation icons", () => {
  test("the administrator gives Home a coffee cup in Custom styles, which every tab's rail shows at once, then gives Home its own back", async ({ page }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit");
    await signInAsAdministrator(page);
    // Not in General.
    await expect(page.getByRole("heading", { level: 1, name: "Basic community settings" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Navigation icons" })).toHaveCount(0);
    await page.getByRole("navigation", { name: "Community settings" }).getByRole("link", { name: "Custom styles" }).click();
    await expect(page).toHaveURL(/\/account\/custom_styles\/edit$/);
    const section = page.getByRole("region", { name: "Navigation icons" });
    const picker = section.getByRole("button", { name: "Choose Home icon" });
    const save = section.getByRole("button", { name: "Save changes" });
    await expect(picker).toBeEnabled();
    const otherTab = await page.context().newPage();
    await otherTab.goto("/");
    await expect(homeOf(otherTab)).toBeVisible();

    await picker.click();
    const dialog = page.getByRole("dialog", { name: "Choose a navigation icon" });
    await expect(dialog.getByRole("status")).toHaveText("3,540 icons · 72 shown", ICON_CATALOG_LOADED);
    await dialog.getByRole("searchbox", { name: "Search icons" }).fill("coffee");
    await dialog.getByRole("button", { name: "Use Coffee Cup icon from Iconoir" }).click();
    await dialog.getByRole("button", { name: "Use icon", exact: true }).click();
    await expect(picker).toContainText("Coffee Cup · Iconoir");
    await save.click();
    await expect(page.getByRole("alert")).toHaveText("Changes saved.");
    for (const tab of [page, otherTab]) await expect(homeOf(tab).locator('[data-icon="iconoir:regular:coffee-cup"]')).toBeVisible();
    expect((await page.request.get("/iconoir/icons/regular/coffee-cup.svg")).headers()["content-type"]).toContain("image/svg+xml");

    // Back to its own, as the other tests expect it.
    await picker.click();
    await dialog.getByRole("button", { name: "Use default icon" }).click();
    await dialog.getByRole("button", { name: "Use icon", exact: true }).click();
    await expect(picker).toContainText("Default icon");
    await save.click();
    await expect(page.getByRole("alert")).toHaveText("Changes saved.");
    for (const tab of [page, otherTab]) await expect(homeOf(tab).locator(".iconoir-home")).toBeVisible();
  });
});
