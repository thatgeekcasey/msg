import { SIGN_IN_REJECTED } from "@ember/protocol";
import { ADMINISTRATOR, useOwnAddress } from "../../fixtures";
import { expect, test } from "./fixtures";

test.beforeEach(({ page }) => useOwnAddress(page));

test("the sign-in screen fits the phone", async ({ page, screenIsFine }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Ember" })).toBeVisible();
  await screenIsFine();
});

test("you can sign in with taps", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email address").tap();
  await page.keyboard.type(ADMINISTRATOR.emailAddress);
  await page.getByLabel("Password").tap();
  await page.keyboard.type(ADMINISTRATOR.password);
  await page.getByRole("button", { name: "Sign in" }).tap();
  await expect(page.getByRole("textbox", { name: "Write a message" })).toBeVisible();
});

test("why a sign-in was refused fits the phone", async ({ page, screenIsFine }) => {
  await page.goto("/session/new");
  await page.getByLabel("Email address").fill(ADMINISTRATOR.emailAddress);
  await page.getByLabel("Password").fill("incorrect horse battery");
  await page.getByRole("button", { name: "Sign in" }).tap();
  await expect(page.getByRole("alert")).toHaveText(SIGN_IN_REJECTED);
  await screenIsFine();
});

test("you can join with just a name, with taps", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Join with just a name" }).tap();
  await page.getByLabel("Your name").tap();
  await page.keyboard.type("Pat on a phone");
  await page.getByRole("button", { name: "Join" }).tap();
  await expect(page.getByRole("textbox", { name: "Write a message" })).toBeVisible();
});

test("the page keeps zoom and lets the keyboard resize it", async ({ page }) => {
  await page.goto("/");
  const viewport = await page.locator("meta[name=viewport]").getAttribute("content");
  const settings = Object.fromEntries(viewport!.split(",").map((part) => part.trim().split("=") as [string, string]));

  expect(settings).toMatchObject({ width: "device-width", "viewport-fit": "cover" });
  expect(Number(settings["initial-scale"])).toBe(1);
  // Android Chrome then shrinks the page above the keyboard instead of covering the composer, as
  // Campfire's layouts/application.html.erb asks.
  expect(settings["interactive-widget"]).toBe("resizes-content");
  // Pinch zoom must keep working (WCAG 1.4.4).
  expect(settings).not.toHaveProperty("maximum-scale");
  expect(settings).not.toHaveProperty("user-scalable");
});
