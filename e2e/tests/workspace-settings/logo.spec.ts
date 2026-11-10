import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { drawnPicture, nextSecond, shownPicture, signInAsAdministrator, useOwnAddress } from "../../fixtures";
import { join } from "./fixtures";

/** The picture on `page`'s rail that goes home. */
const railLogo = (page: Page) => page.getByRole("link", { name: "Ember home" }).locator("img");

/** The type and size of the picture at `src`, as `page`'s browser fetches and decodes it. */
const fetchedPicture = (page: Page, src: string) =>
  page.evaluate(async (src) => {
    const picture = await (await fetch(src)).blob();
    const { width, height } = await createImageBitmap(picture);
    return { type: picture.type, width, height };
  }, src);

test.describe("Workspace logo", () => {
  test("the administrator uploads a logo, which every page shows at once, sign-in included, and removes it", async ({ page, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit");
    await signInAsAdministrator(page);
    const logo = page.getByRole("img", { name: "Community icon" });
    const remove = page.getByRole("button", { name: "Remove icon" });
    await expect(logo).toBeVisible();
    // A server kept from an earlier run may have its logo still.
    if (await remove.isVisible()) await remove.click();
    await expect(logo).toHaveAttribute("src", "/logos/app-icon.png");
    await expect(page.getByText("Choose a community icon")).toBeVisible();
    await expect(remove).toHaveCount(0);
    await page.getByRole("link", { name: "Membership" }).click();
    const member = await join(browser, baseURL!, await page.getByRole("textbox", { name: "Share to invite more people" }).inputValue(), "Grace Hopper");
    await page.getByRole("link", { name: "General", exact: true }).click();
    await expect(railLogo(member)).toHaveAttribute("src", "/ember-icon.png");

    await nextSecond();
    await page.getByLabel("Upload icon").setInputFiles(await drawnPicture(page, "logo.png", 1200, 800));
    await expect(page.getByRole("alert")).toHaveText("Changes saved.");
    await expect(logo).toHaveAttribute("src", /^\/account\/logo\?v=\d{14}$/);
    const uploaded = (await logo.getAttribute("src"))!;
    // The variants the administrator's browser made, within 512×512 and 192×192.
    expect(await shownPicture(logo)).toEqual({ type: "image/png", width: 512, height: 341 });
    expect(await fetchedPicture(page, `${uploaded}&size=small`)).toEqual({ type: "image/png", width: 192, height: 128 });
    await expect(railLogo(page)).toHaveAttribute("src", uploaded);
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", `${uploaded}&size=small`);
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", uploaded);
    await expect(page.locator("body")).toHaveClass(/\baccount-has-logo\b/);
    // The member's open page shows it at once, and the installed app's icons are its variants.
    await expect(railLogo(member)).toHaveAttribute("src", uploaded);
    const manifest = (await (await page.request.get("/webmanifest.json")).json()) as { icons: Array<{ src: string }> };
    expect(manifest.icons.map(({ src }) => src)).toEqual([`${uploaded}&size=small`, uploaded, uploaded]);

    const signedOut = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    const signIn = await signedOut.newPage();
    await signIn.goto("/");
    await expect(signIn.getByRole("heading", { level: 1 })).toHaveText(/^Sign in to /);
    await expect(signIn.getByRole("img", { name: "Account logo" })).toHaveAttribute("src", uploaded);
    await signedOut.close();

    await nextSecond();
    await remove.click();
    await expect(remove).toHaveCount(0);
    await expect(logo).toHaveAttribute("src", "/logos/app-icon.png");
    await expect(railLogo(page)).toHaveAttribute("src", "/ember-icon.png");
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/logos/app-icon-48.png");
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/logos/app-icon.png");
    await expect(railLogo(member)).toHaveAttribute("src", "/ember-icon.png");
    await member.context().close();
  });
});
