import { PASSWORD_RESET_CODE_WRONG, type AccountChanges, type WorkspaceSettings } from "@ember/protocol";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { administratorSession, cookieHeader, newAddress, SAME_ORIGIN, sentFrom, useOwnAddress } from "../../fixtures";
import { forgetResendKey, giveResendKey, startFakeResend, type FakeResend } from "./fake-resend";

// Resetting a forgotten password with a code Ember emails, on the second test server, which sends email
// with the Resend API the email specs fake once it's given the key that API takes. Each test leaves the
// workspace as a new one is: no Resend API key and no From address.

const FROM = "chat@acme.example";
const PASSWORD = "heuristically";

let resend: FakeResend;
test.beforeAll(async () => void (resend = await startFakeResend()));
test.afterAll(() => resend.close());
test.afterEach(async ({ request }) => {
  await changeAccount(request, { emailFrom: null });
  await forgetResendKey(request);
});

/** Changes the workspace as the administrator. */
async function changeAccount(request: APIRequestContext, changes: AccountChanges): Promise<void> {
  const administrator = await administratorSession(request);
  const response = await request.patch("/api/account", { data: changes, headers: { Cookie: cookieHeader(administrator), ...SAME_ORIGIN } });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * Has someone new join with the join link, with an email address of their own and `PASSWORD`, in a
 * browser of their own, which `request` isn't, since it keeps the administrator's cookie, answering the address.
 */
async function someoneWithAPassword(request: APIRequestContext, browser: Browser, baseURL: string): Promise<string> {
  const administrator = await administratorSession(request);
  const { joinCode } = (await (await request.get("/api/account", { headers: { Cookie: cookieHeader(administrator) } })).json()) as WorkspaceSettings;
  const emailAddress = `hal-${crypto.randomUUID()}@example.com`;
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  const response = await context.request.post(`/api/join/${joinCode}`, { data: { name: "Hal", emailAddress, password: PASSWORD }, headers: { "CF-Connecting-IP": newAddress(), ...SAME_ORIGIN } });
  expect(response.status(), await response.text()).toBe(201);
  await context.close();
  return emailAddress;
}

/** A page signed out, in a browser of its own, from an IP address of its own. */
async function signedOut(browser: Browser, baseURL: string): Promise<Page> {
  const page = await (await browser.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage();
  await useOwnAddress(page);
  return page;
}

/** Asks for a code on the page `page` shows, for the address its field holds, answering the code Ember emailed. */
async function askForCode(page: Page, emailAddress: string): Promise<string> {
  const sent = resend.sent.length;
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email");
  await expect.poll(() => resend.sent.length).toBe(sent + 1);
  const email = resend.sent.at(-1)!;
  expect(email).toEqual(expect.objectContaining({ from: await sentFrom(page.request, FROM), to: [emailAddress], subject: expect.stringMatching(/^Reset your password at /) as unknown }));
  return /Your code: ([0-9]{8})/.exec(email.text)![1]!;
}

/** Signs in through the API with `emailAddress` and `password`, answering the status. */
async function signInStatus(request: APIRequestContext, emailAddress: string, password: string): Promise<number> {
  const response = await request.post("/api/session", { data: { emailAddress, password }, headers: { "CF-Connecting-IP": newAddress(), ...SAME_ORIGIN } });
  return response.status();
}

test.describe("Reset a forgotten password with an emailed code", () => {
  test("someone who forgot their password asks for a code from sign in, then chooses a new one with it, signed in", async ({ browser, request, baseURL }) => {
    await giveResendKey(request);
    await changeAccount(request, { emailFrom: FROM });
    const hal = await someoneWithAPassword(request, browser, baseURL!);

    const page = await signedOut(browser, baseURL!);
    await page.goto("/session/new");
    await page.getByLabel("Email address").fill(hal);
    await page.getByRole("link", { name: "Reset it" }).click();
    await expect(page).toHaveURL(`${baseURL}/passwords/new?email_address=${encodeURIComponent(hal)}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reset your password");
    await expect(page.getByRole("textbox", { name: "Email address" })).toHaveValue(hal);
    const code = await askForCode(page, hal);

    // A code that's wrong is said so, keeping what was typed.
    const codeField = page.getByRole("textbox", { name: "Code" });
    await codeField.fill(code === "00000000" ? "11111111" : "00000000");
    await page.getByLabel("New password").fill("a password of my own");
    await page.getByRole("button", { name: "Reset password" }).click();
    await expect(page.getByRole("alert")).toHaveText(PASSWORD_RESET_CODE_WRONG);
    await expect(page.getByLabel("New password")).toHaveValue("a password of my own");

    await codeField.fill(`${code.slice(0, 4)} ${code.slice(4)}`);
    await page.getByRole("button", { name: "Reset password" }).click();
    await expect(page.getByRole("textbox", { name: "Write a message" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveText("Your password has been reset.");
    await page.context().close();

    expect(await signInStatus(request, hal, PASSWORD)).toBe(401);
    expect(await signInStatus(request, hal, "a password of my own")).toBe(201);
  });

  test("the sign-in page offers it only while Ember can send email, and the page says why it can't", async ({ browser, request, baseURL }) => {
    const page = await signedOut(browser, baseURL!);
    await page.goto("/session/new");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Reset it" })).toBeHidden();
    await page.goto("/passwords/new");
    await expect(page.getByText("Ember can't email you a code right now. Ask an administrator for help.")).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);

    await giveResendKey(request);
    await changeAccount(request, { emailFrom: FROM });
    await page.goto("/session/new");
    await expect(page.getByRole("link", { name: "Reset it" })).toHaveAttribute("href", "/passwords/new");
    await page.context().close();
  });
});
