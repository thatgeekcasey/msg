import { expect, test } from "./fixtures";

/** Safari on iOS 16, older than the 17.2 Campfire asks for. Every phone says it, as the page is the same on all of them. */
const OLD_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

test.use({ userAgent: OLD_IPHONE });

test("the upgrade screen fits the phone", async ({ page, screenIsFine }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Upgrade to a supported web browser" })).toBeVisible();
  await screenIsFine();
});
