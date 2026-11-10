import { expect, test } from "../../fixtures";
import { signInAsAdministrator, useOwnAddress } from "../../fixtures";

test.describe("Regenerate the join link", () => {
  test("the administrator regenerates the join link, and only the new one joins", async ({ page, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit#membership-settings");
    await signInAsAdministrator(page);
    const link = page.getByRole("textbox", { name: "Share to invite more people" });
    await expect(link).toHaveValue(/\/join\//);
    const old = await link.inputValue();

    // At once, with nothing to confirm and nothing said after.
    await page.getByRole("button", { name: "Regenerate join link" }).click();
    await expect(link).not.toHaveValue(old);
    const regenerated = await link.inputValue();
    expect(regenerated).toMatch(new RegExp(`^${baseURL}/join/[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){2}$`));
    await expect(page.getByRole("alert")).toHaveCount(0);

    // The welcome card in the first room, general, has the new link too.
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await page.getByRole("complementary", { name: "Conversations" }).getByRole("link", { name: "general" }).click();
    await expect(page.getByRole("log").getByRole("textbox", { name: "Share to invite more people" })).toHaveValue(regenerated);

    const signedOut = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    const gone = await signedOut.request.get(old);
    expect(gone.status()).toBe(404);
    expect(await gone.text()).toBe("");
    const join = await signedOut.newPage();
    await join.goto(regenerated);
    await expect(join.getByRole("heading", { level: 1 })).toHaveText(/^Join /);
    await signedOut.close();
  });
});
