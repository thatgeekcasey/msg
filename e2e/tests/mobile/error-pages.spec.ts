import { expect, test } from "./fixtures";

const PAGES = [
  ["/no-such-page", "We can’t find that (404)"],
  ["/422", "That didn’t work (422)"],
  ["/500", "Something went wrong (500)"],
] as const;

for (const [path, title] of PAGES) {
  test(`Campfire's "${title}" page fits the phone`, async ({ page, screenIsFine }) => {
    await page.goto(path);
    await expect(page).toHaveTitle(title);
    await screenIsFine();
  });
}
