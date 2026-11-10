import type { AccountSettings } from "@ember/protocol";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { administratorSession, cookieHeader, SAME_ORIGIN, signInAsAdministrator, useOwnAddress } from "../../fixtures";

// Membership's ways to join. The specs that follow join through the join link, so each spec here puts
// the ways back as they start: the join link on, and Open off.

test.afterEach(({ request }) => changeWays(request, { joinLink: true, openSignUp: false }));

/** Changes the ways to join, as the administrator. */
async function changeWays(request: APIRequestContext, settings: AccountSettings): Promise<void> {
  const administrator = await administratorSession(request);
  const response = await request.patch("/api/account", { data: { settings }, headers: { Cookie: cookieHeader(administrator), ...SAME_ORIGIN } });
  expect(response.status(), await response.text()).toBe(200);
}

/** Opens Membership as the administrator. */
async function openMembership(page: Page): Promise<void> {
  await useOwnAddress(page);
  await page.goto("/account/edit#membership-settings");
  await signInAsAdministrator(page);
}

/** A page signed out, in a browser of its own, from an IP address of its own. */
async function signedOut(browser: Browser, baseURL: string): Promise<Page> {
  const page = await (await browser.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage();
  await useOwnAddress(page);
  return page;
}

test.describe("Sign up without a link", () => {
  test("the administrator turns Open on, once they confirm, and someone new creates an account from the sign-in page, until it's off", async ({ page, browser, baseURL }) => {
    await openMembership(page);
    const open = page.getByRole("switch", { name: "Open" });
    await expect(open).not.toBeChecked();
    page.once("dialog", (dialog) => void dialog.accept());
    await open.click();
    await expect(open).toBeChecked();
    await expect(page.getByRole("textbox", { name: "Share so anyone can sign up" })).toHaveValue(`${baseURL}/join`);
    await expect(page.getByRole("switch", { name: "Join link" })).toBeDisabled();

    const newcomer = await signedOut(browser, baseURL!);
    await newcomer.goto("/");
    await newcomer.getByRole("link", { name: "Create an account" }).click();
    await expect(newcomer.getByRole("heading", { level: 1 })).toHaveText(/^Join /);
    await expect(newcomer).toHaveURL(/\/join$/);
    await newcomer.getByLabel("Name").fill("Grace Hopper");
    await newcomer.getByLabel("Email address").fill(`${crypto.randomUUID()}@example.com`);
    await newcomer.getByLabel("Password").fill("compiler error");
    await newcomer.getByRole("button", { name: "Create account" }).click();
    await expect(newcomer.getByRole("textbox", { name: "Write a message" })).toBeVisible();
    await newcomer.context().close();

    // Turning it off asks nothing.
    await open.click();
    await expect(open).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "Join link" })).toBeEnabled();
    const latecomer = await signedOut(browser, baseURL!);
    await latecomer.goto("/join");
    await expect(latecomer.getByRole("alert")).toHaveText("Signing up is closed.");
    await expect(latecomer).toHaveURL(/\/session\/new$/);
    await expect(latecomer.getByRole("link", { name: "Create an account" })).toHaveCount(0);
    await latecomer.context().close();
  });
});

test.describe("Ways to join", () => {
  test("the administrator turns the join link off, which sends it to sign in saying so, and on again with the same link", async ({ page, browser, baseURL }) => {
    await openMembership(page);
    const field = page.getByRole("textbox", { name: "Share to invite more people" });
    const joinUrl = await field.inputValue();
    const link = page.getByRole("switch", { name: "Join link" });
    await link.click();
    await expect(link).not.toBeChecked();
    await expect(field).toHaveCount(0);

    const visitor = await signedOut(browser, baseURL!);
    await visitor.goto(joinUrl);
    await expect(visitor.getByRole("alert")).toHaveText("Joining by link is off.");
    await expect(visitor).toHaveURL(/\/session\/new$/);

    await link.click();
    await expect(field).toHaveValue(joinUrl);
    await visitor.goto(joinUrl);
    await expect(visitor.getByRole("heading", { level: 1 })).toHaveText(/^Join /);
    await visitor.context().close();
  });
});
