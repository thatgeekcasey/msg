import { signInAs } from "../../fixtures";
import { expect, test } from "./fixtures";

// Asking for the test's room makes it the room an alert goes home to.
test.beforeEach(async ({ page, session, room: _ }) => {
  await signInAs(page, session);
});

test("an alert shows 12px below the header and centered over the page, clear of the notch", async ({ page, screenIsFine }) => {
  await page.goto("/rooms/opens/nowhere/edit");
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText("Room not found or inaccessible");
  await expect(page.getByRole("log")).toBeVisible();
  // Stopped mid-fade, so it stays to be measured.
  await alert.evaluate((node: HTMLElement) => {
    node.style.animation = "none";
  });

  const flash = (await alert.boundingBox())!;
  // The room's main content starts below the header, however much room the header makes for a notch.
  const main = (await page.getByRole("main").boundingBox())!;
  expect(flash.y).toBeCloseTo(main.y + 12, 0);
  expect(Math.abs(flash.x + flash.width / 2 - (main.x + main.width / 2))).toBeLessThan(1);
  await screenIsFine();
});
