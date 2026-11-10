import { expect, test } from "../../fixtures";
import { signInAsAdministrator, useOwnAddress } from "../../fixtures";

/** Chrome 119, a version short of what Campfire allows. */
const OLD_CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.199 Safari/537.36";

test.describe("Translation buttons", () => {
  test("the administrator shows translation buttons, which every page then has, and hides them again", async ({ page, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit");
    await signInAsAdministrator(page);
    const hide = page.getByRole("switch", { name: "Hide translation buttons" });
    // A server kept from an earlier run may show them still.
    await expect(hide).toBeVisible();
    if (!(await hide.isChecked())) await hide.click();
    await expect(hide).toBeChecked();
    await expect(page.getByText("Translate", { exact: true })).toHaveCount(0);
    const otherTab = await page.context().newPage();
    await otherTab.goto("/account/edit");
    await expect(otherTab.getByRole("textbox", { name: "Community name" })).toBeVisible();
    const save = page.getByRole("button", { name: "Save changes" });

    // With the name, by Save changes, and then in the other tab too.
    await hide.click();
    await expect(hide).not.toBeChecked();
    await expect(page.getByText("Translate", { exact: true })).toHaveCount(0);
    await save.click();
    await expect(page.getByRole("alert")).toHaveText("Changes saved.");
    await expect(page.getByText("Translate", { exact: true })).toHaveCount(1);
    await expect(otherTab.getByText("Translate", { exact: true })).toHaveCount(1);

    // The community name's globe, which lists what the field asks in seven languages.
    const globe = page.locator("summary", { hasText: "Translate" });
    await globe.click();
    const languages = page.locator("details[open] dl");
    await expect(languages.locator("dt")).toHaveText(["🇺🇸", "🇪🇸", "🇫🇷", "🇮🇳", "🇩🇪", "🇧🇷", "🇯🇵"]);
    await expect(languages.locator("dd").first()).toHaveText("Name this account");
    await page.keyboard.press("Escape");
    await expect(languages).toHaveCount(0);
    await globe.click();
    await page.getByRole("heading", { level: 1, name: "Basic community settings" }).click();
    await expect(languages).toHaveCount(0);

    const signedOut = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    const signIn = await signedOut.newPage();
    await signIn.goto("/");
    await expect(signIn.getByRole("textbox", { name: "Email address" })).toBeVisible();
    await expect(signIn.getByText("Translate", { exact: true })).toHaveCount(2);

    // So does the page for browsers too old for the app, whose globe lists its message.
    const oldBrowser = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, userAgent: OLD_CHROME });
    const upgrade = await oldBrowser.newPage();
    await upgrade.goto("/");
    const upgradeGlobe = upgrade.locator("summary", { hasText: "Translate" });
    await expect.poll(() => upgradeGlobe.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    // Hidden by its own styles while it's closed too, as Internet Explorer shows a closed details element's list.
    const upgradeList = upgrade.locator(".language-list-menu");
    await expect.poll(() => upgradeList.evaluate((list) => getComputedStyle(list).display)).toBe("none");
    await upgradeGlobe.click();
    await expect.poll(() => upgradeList.evaluate((list) => getComputedStyle(list).display)).toBe("block");
    const upgradeLanguages = upgrade.locator("details[open] dl");
    await expect(upgradeLanguages.locator("dt")).toHaveText(["🇺🇸", "🇪🇸", "🇫🇷", "🇮🇳", "🇩🇪", "🇧🇷", "🇯🇵"]);
    await expect(upgradeLanguages.locator("dd").nth(2)).toContainText("Veuillez utiliser l'un des navigateurs");
    await upgrade.keyboard.press("Escape");
    await expect(upgradeLanguages).toHaveCount(0);
    await upgradeGlobe.click();
    await upgrade.getByRole("heading", { level: 1 }).click();
    await expect(upgradeLanguages).toHaveCount(0);

    await hide.click();
    await expect(hide).toBeChecked();
    await save.click();
    await expect(page.getByText("Translate", { exact: true })).toHaveCount(0);
    await expect(otherTab.getByText("Translate", { exact: true })).toHaveCount(0);
    await signIn.reload();
    await expect(signIn.getByRole("textbox", { name: "Email address" })).toBeVisible();
    await expect(signIn.getByText("Translate", { exact: true })).toHaveCount(0);
    await upgrade.reload();
    await expect(upgrade.getByRole("heading", { level: 1, name: "Upgrade to a supported web browser" })).toBeVisible();
    await expect(upgrade.getByText("Translate", { exact: true })).toHaveCount(0);
    await signedOut.close();
    await oldBrowser.close();
  });
});
