import type { Bootstrap } from "@ember/protocol";
import { expect, test } from "./fixtures";

const PENDING: Bootstrap = {
  setup: "pending",
  setupAccess: "open",
  setupPlaceholders: { name: "Kevin Rose", emailAddress: "kevin@kevinrose.com" },
  guestSignIn: true,
  signInWithMemberful: false,
  turnstileSiteKey: null,
  passwordResetCodes: false,
  account: { name: "Ember", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false },
  version: "0.1",
  vapidPublicKey: null,
  platform: { ios: false, android: false, desktop: true, windows: false, chrome: false, firefox: false, safari: false, edge: false, browser: "Mozilla", operatingSystem: "" },
  user: null,
};

// The first-run project has set the server up by now, so these show the page as a new deployment
// would: the app's page at /first_run, told that Ember is waiting to be set up.
test.beforeEach(async ({ page, baseURL }) => {
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: PENDING }));
  await page.route("**/first_run", async (route) => route.fulfill({ response: await route.fetch({ url: new URL("/", baseURL).href }) }));
});

test("the Set up Ember screen fits the phone", async ({ page, screenIsFine }) => {
  await page.goto("/first_run");
  await expect(page.getByRole("heading", { name: "Set up Ember" })).toBeVisible();
  await screenIsFine();
});

test("the setup link screen fits the phone", async ({ page, screenIsFine }) => {
  // As a deployed Worker, opened without its setup link, shows it.
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: { ...PENDING, setupAccess: "link" } }));
  await page.goto("/first_run");
  await expect(page.getByText("Ember is waiting for its administrator.")).toBeVisible();
  await expect(page.getByText("EMBER_SETUP_PASSWORD")).toBeVisible();
  await screenIsFine();
});

test("the setup password screen fits the phone, and so does a refused one", async ({ page, screenIsFine }) => {
  // As a Worker deployed with Deploy to Cloudflare, whose form asked for a setup password, shows it.
  await page.route("**/api/bootstrap", (route) => route.fulfill({ json: { ...PENDING, setupAccess: "password" } }));
  await page.route("**/api/first_run/check", (route) => route.fulfill({ status: 403, json: { error: "That isn't this Ember's setup password" } }));
  await page.goto("/first_run");
  const field = page.getByLabel("Setup password");
  await expect(field).toBeFocused();
  await screenIsFine();

  await field.fill("not the setup password");
  await page.getByRole("button", { name: "Show password" }).tap();
  await page.getByRole("button", { name: "Continue" }).tap();
  await expect(page.getByRole("alert")).toHaveText("That isn't this Ember's setup password");
  await expect(field).toHaveValue("");
  await screenIsFine();
});

test("a password that's too short keeps the screen in shape", async ({ page, screenIsFine }) => {
  await page.route("**/api/first_run", (route) => route.fulfill({ status: 422, json: { error: "Password must be at least 8 characters.", field: "password" } }));
  await page.goto("/first_run");
  await page.getByLabel("Name").fill("Pat on a phone");
  await page.getByLabel("Email address").fill("pat@example.com");
  await page.getByLabel("Password", { exact: true }).fill("🔐🔐🔐🔐");
  await page.getByRole("button", { name: "Show password" }).tap();
  await page.getByRole("button", { name: "Continue" }).tap();
  await expect(page.getByRole("alert")).toHaveText("Password must be at least 8 characters.");
  await screenIsFine();
});
