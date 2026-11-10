import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { signInAsAdministrator, useOwnAddress } from "../../fixtures";
import { join } from "./fixtures";

/** CSS whose effect a test can read, and no other test notices. */
const CSS = ":root { --e2e-custom-styles: applied; }";

/** What the CSS has set on `page`, if anything. */
const styled = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--e2e-custom-styles").trim());

test.describe("Custom CSS", () => {
  test("the administrator saves custom CSS, which every page applies at once, open ones and sign-in included", async ({ page, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit");
    await signInAsAdministrator(page);
    const otherTab = await page.context().newPage();
    await otherTab.goto("/account/edit");
    await expect(otherTab.getByRole("heading", { level: 1, name: "Basic community settings" })).toBeVisible();

    await page.getByRole("link", { name: "Custom styles" }).click();
    await expect(page).toHaveURL(/\/account\/custom_styles\/edit$/);
    await expect(page.getByRole("heading", { level: 1, name: "Custom CSS" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Community settings" }).getByRole("link", { name: "Custom styles" })).toHaveAttribute("aria-current", "page");
    const css = page.getByRole("textbox", { name: "Custom CSS" });
    await css.fill(CSS);
    await css.press("ControlOrMeta+Enter");
    // The flash's check, read as "Changes saved".
    await expect(page.getByRole("alert")).toHaveText("Changes saved");
    await expect.poll(() => styled(page)).toBe("applied");
    await expect.poll(() => styled(otherTab)).toBe("applied");

    const signedOut = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    const signIn = await signedOut.newPage();
    await signIn.goto("/");
    await expect(signIn.getByRole("heading", { level: 1 })).toHaveText(/^Sign in to /);
    expect(await styled(signIn)).toBe("applied");
    await signedOut.close();

    await page.reload();
    await expect(css).toHaveValue(CSS);
    await css.fill("");
    await page.getByRole("region", { name: "Custom CSS" }).getByRole("button", { name: "Save changes" }).click();
    await expect.poll(() => styled(otherTab)).toBe("");
    // The saving page hears of it from its answer or its own socket, either of which can come after the other tab's.
    await expect.poll(() => styled(page)).toBe("");
  });

  test("a member who opens Custom CSS is sent to workspace settings, told why", async ({ page, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit#membership-settings");
    await signInAsAdministrator(page);
    const member = await join(browser, baseURL!, await page.getByRole("textbox", { name: "Share to invite more people" }).inputValue(), "Grace Hopper");

    await member.goto("/account/custom_styles/edit");
    await expect(member.getByRole("alert")).toHaveText("Only administrators can change the workspace");
    await expect(member).toHaveURL(/\/account\/edit$/);
    await expect(member.getByRole("heading", { level: 1, name: "Basic community settings" })).toBeVisible();
    await expect(member.getByRole("link", { name: "Custom styles" })).toHaveCount(0);
    await member.context().close();
  });
});
