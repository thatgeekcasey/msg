import type { APIRequestContext, Page } from "@playwright/test";
import { administratorSession, cookieHeader, expect, fakeTurnstile, SAME_ORIGIN, signInAsAdministrator, test, TURNSTILE_WIDGET, turnstileTokenFor, useOwnAddress } from "../../fixtures";
import { startFakeSiteverify, type FakeSiteverify } from "./fake-siteverify";

// Membership's Turnstile card and Set up Turnstile, on the second test server, which asks the siteverify
// this spec fakes about the checks the fake Turnstile passes. Each test leaves the workspace as a new one
// is: no Turnstile keys, and Open off.

let siteverify: FakeSiteverify;
test.beforeAll(async () => void (siteverify = await startFakeSiteverify()));
test.afterAll(() => siteverify.close());
test.afterEach(async ({ request }) => {
  const headers = await asAdministrator(request);
  const forgotten = await request.delete("/api/account/turnstile_keys", { headers });
  expect(forgotten.status(), await forgotten.text()).toBe(200);
  await turnOpen(request, false);
});

/** The administrator's session's headers, for the API. */
const asAdministrator = async (request: APIRequestContext) => ({ Cookie: cookieHeader(await administratorSession(request)), ...SAME_ORIGIN });

/** Turns Open on or off, as the administrator does in Membership. */
async function turnOpen(request: APIRequestContext, on: boolean): Promise<void> {
  const response = await request.patch("/api/account", { data: { settings: { openSignUp: on } }, headers: await asAdministrator(request) });
  expect(response.status(), await response.text()).toBe(200);
}

/** Opens Membership as the administrator, with Open on, answering its Turnstile card. */
async function openTurnstile(page: Page, request: APIRequestContext) {
  await turnOpen(request, true);
  await useOwnAddress(page);
  await fakeTurnstile(page);
  await page.goto("/account/edit#membership-settings");
  await signInAsAdministrator(page);
  return page.getByRole("region", { name: "Turnstile", exact: true });
}

test.describe("Check that people are people with Cloudflare Turnstile", () => {
  test("the administrator gives Ember a widget's keys, which its check proves, and anyone signing up passes it", async ({ page, request, browser, baseURL }) => {
    const turnstile = await openTurnstile(page, request);
    await expect(turnstile).toContainText("Until it does, limits on each network stand in for its check.");
    const open = page.getByRole("region", { name: "Open", exact: true });
    await expect(open).toContainText("Setting up Turnstile lifts these limits.");
    await open.getByRole("button", { name: "Set up Turnstile" }).click();

    const setup = page.getByRole("dialog");
    await expect(setup).toHaveAccessibleName("Set up Turnstile");
    await expect(setup.getByRole("listitem").first()).toContainText("add 127.0.0.1 under Hostname Management");
    await expect(setup.getByRole("link", { name: "Open Turnstile in the Cloudflare dashboard" })).toHaveAttribute("href", "https://dash.cloudflare.com/?to=/:account/turnstile");
    await setup.getByRole("textbox", { name: "Site key" }).fill(TURNSTILE_WIDGET.siteKey);
    await setup.getByRole("textbox", { name: "Secret key" }).fill("0x4AAAAAAA-not-the-widgets-secret");
    await setup.getByRole("button", { name: "Continue" }).click();

    // The check page draws the widget's check, which passes, and a secret key Cloudflare doesn't know comes back to its field.
    await expect(setup).toHaveAccessibleName("Pass the widget's check");
    const check = setup.frameLocator("iframe[title=\"Turnstile's check\"]").getByRole("button", { name: "Verify you are human" });
    await expect(check).toHaveAttribute("data-site-key", TURNSTILE_WIDGET.siteKey);
    await expect(check).toHaveAttribute("data-theme", "light");
    await check.click();
    await expect(setup).toHaveAccessibleName("Set up Turnstile");
    await expect(setup.getByRole("alert")).toHaveText("Cloudflare doesn't know that secret key. Copy it again from your widget in Cloudflare Turnstile.");

    await setup.getByRole("textbox", { name: "Secret key" }).fill(TURNSTILE_WIDGET.secretKey);
    await setup.getByRole("button", { name: "Continue" }).click();
    await check.click();
    await expect(setup).toHaveAccessibleName("Turnstile is set up");
    expect(siteverify.asked.at(-1)).toEqual({ secret: TURNSTILE_WIDGET.secretKey, response: turnstileTokenFor(TURNSTILE_WIDGET.siteKey), remoteip: expect.any(String) as unknown });
    await setup.getByRole("button", { name: "Done" }).click();
    await expect(setup).toBeHidden();
    await expect(turnstile).toContainText("Cloudflare Turnstile checks that whoever signs up, or asks Ember to email them a link to join or a code to reset a password, is a person.");
    await expect(turnstile.getByRole("switch", { name: "Turnstile" })).toBeChecked();
    await expect(open).toContainText("Cloudflare Turnstile checks that whoever signs up is a person.");

    // Ember keeps the keys, and checks whoever signs up with them.
    await page.reload();
    await expect(page.getByRole("region", { name: "Turnstile", exact: true }).getByRole("switch", { name: "Turnstile" })).toBeChecked();
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    const newcomer = await context.newPage();
    await useOwnAddress(newcomer);
    await fakeTurnstile(newcomer);
    await newcomer.goto("/join");
    await newcomer.getByLabel("Name").fill("Grace Hopper");
    await newcomer.getByLabel("Email address").fill(`${crypto.randomUUID()}@example.com`);
    await newcomer.getByLabel("Password").fill("compiler error");
    await expect(newcomer.getByRole("button", { name: "Create account" })).toBeDisabled();
    await newcomer.getByRole("button", { name: "Verify you are human" }).click();
    await newcomer.getByRole("button", { name: "Create account" }).click();
    await expect(newcomer.getByRole("textbox", { name: "Write a message" })).toBeVisible();
    expect(siteverify.asked.at(-1)).toMatchObject({ secret: TURNSTILE_WIDGET.secretKey, response: turnstileTokenFor(TURNSTILE_WIDGET.siteKey) });
    await context.close();
  });

  test("the administrator turns Turnstile off, once they're sure, which brings the limits back", async ({ page, request }) => {
    const headers = await asAdministrator(request);
    const saved = await request.put("/api/account/turnstile_keys", { data: { ...TURNSTILE_WIDGET, turnstileToken: turnstileTokenFor(TURNSTILE_WIDGET.siteKey) }, headers });
    expect(saved.status(), await saved.text()).toBe(200);
    const turnstile = await openTurnstile(page, request);
    page.once("dialog", (dialog) => void dialog.accept());
    const turnstileSwitch = turnstile.getByRole("switch", { name: "Turnstile" });
    await expect(turnstileSwitch).toBeChecked();
    await turnstileSwitch.click();
    await expect(turnstileSwitch).not.toBeChecked();
    await expect(turnstileSwitch).toBeEnabled();
    await expect(page.getByRole("region", { name: "Open", exact: true })).toContainText("Setting up Turnstile lifts these limits.");
    expect(await (await request.get("/api/bootstrap")).json()).toMatchObject({ turnstileSiteKey: null });
  });
});
