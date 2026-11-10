import { EMAIL_LINK_GONE, JOINING_PROBLEMS, onlyAddressesAt, type AccountChanges } from "@ember/protocol";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { administratorSession, cookieHeader, SAME_ORIGIN, sentFrom, signInAsAdministrator, useOwnAddress } from "../../fixtures";
import { RESEND_KEY } from "../../projects/workspace-settings";
import { forgetResendKey, giveResendKey, startFakeResend, type FakeResend, type SentEmail } from "./fake-resend";

// Membership's Email domain card, and the page where someone with an address at its domains asks for a
// link to join, on the second test server, which sends email with the Resend API the email specs fake
// once it's given the key that API takes. Each test leaves the workspace as a new one is: Email domain
// off, with no domains, no Resend API key and no From address.

const FROM = "chat@acme.example";
const DOMAIN = "analytical.example";

let resend: FakeResend;
test.beforeAll(async () => void (resend = await startFakeResend()));
test.afterAll(() => resend.close());
test.afterEach(async ({ request }) => {
  await changeAccount(request, { settings: { emailDomainSignUp: false }, emailDomains: [], emailFrom: null });
  await forgetResendKey(request);
});

/** Changes the workspace as the administrator. */
async function changeAccount(request: APIRequestContext, changes: AccountChanges): Promise<void> {
  const administrator = await administratorSession(request);
  const response = await request.patch("/api/account", { data: changes, headers: { Cookie: cookieHeader(administrator), ...SAME_ORIGIN } });
  expect(response.status(), await response.text()).toBe(200);
}

/** A page signed out, in a browser of its own, from an IP address of its own. */
async function signedOut(browser: Browser, baseURL: string): Promise<Page> {
  const page = await (await browser.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage();
  await useOwnAddress(page);
  return page;
}

/** Asks for a link to join with `emailAddress` on the page `page` shows, answering the email Ember sent. */
async function askForLink(page: Page, emailAddress: string): Promise<SentEmail> {
  const sent = resend.sent.length;
  await page.getByRole("textbox", { name: "Email address" }).fill(emailAddress);
  await page.getByRole("button", { name: "Email me a link" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email");
  await expect(page.getByText(`Ember emailed ${emailAddress}.`, { exact: false })).toBeVisible();
  await expect.poll(() => resend.sent.length).toBe(sent + 1);
  return resend.sent.at(-1)!;
}

/** The link in an email Ember sent to join or sign in with. */
const linkIn = (email: SentEmail) => /(?:Join|Sign in) here: (\S+)/.exec(email.text)![1]!;

test.describe("Join with an email domain", () => {
  test("the administrator lets in an email domain, and someone there asks for a link from sign in, then joins with it, once", async ({ page, request, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit#membership-settings");
    await signInAsAdministrator(page);
    const card = page.getByRole("region", { name: "Email domain" });
    const emailDomain = card.getByRole("switch", { name: "Email domain" });
    await expect(emailDomain).not.toBeChecked();
    await expect(emailDomain).toHaveAccessibleDescription(
      "People with an email address at your domains join with a link Ember emails them. Ember can't send email yet, so turning this on sets that up first.",
    );
    // Ember can't send email yet, so turning it on sets that up first.
    await emailDomain.click();
    const setup = page.getByRole("dialog", { name: "Set up email" });
    await setup.getByRole("radio", { name: "Resend" }).check();
    await setup.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("textbox", { name: "API key" }).fill(RESEND_KEY);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("textbox", { name: "From" }).fill(FROM);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("dialog").getByRole("status")).toHaveText(/^Sent to /);
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    // It can't be on without a domain either, so then it opens the list, and saving that turns it on.
    await card.getByRole("textbox", { name: "Add a domain" }).fill(`@${DOMAIN.toUpperCase()}`);
    await card.getByRole("button", { name: "Add", exact: true }).click();
    await expect(card.getByRole("list", { name: "Domains that can join" }).getByRole("listitem")).toHaveText([DOMAIN]);
    await card.getByRole("button", { name: "Save and turn on" }).click();
    await expect(page.getByText("Changes saved.")).toBeVisible();
    await expect(emailDomain).toBeChecked();
    await expect(card.getByRole("textbox", { name: "Share with people at your domains" })).toHaveValue(`${baseURL}/join/email`);

    const hal = `hal-${crypto.randomUUID()}@${DOMAIN}`;
    const newcomer = await signedOut(browser, baseURL!);
    await newcomer.goto("/");
    await expect(newcomer.getByText(`Have an address at ${DOMAIN}?`)).toBeVisible();
    await newcomer.getByRole("link", { name: "Join with it" }).click();
    await expect(newcomer).toHaveURL(`${baseURL}/join/email`);
    await expect(newcomer.getByRole("textbox", { name: "Email address" })).toHaveAccessibleDescription(`Addresses at ${DOMAIN} can join.`);
    const email = await askForLink(newcomer, hal);
    expect(email).toEqual(expect.objectContaining({ from: await sentFrom(request, FROM), to: [hal], subject: expect.stringMatching(/^Your link to join /) as unknown }));
    const link = linkIn(email);
    expect(link).toMatch(new RegExp(`^${baseURL}/join/email#token=[\\w-]{43}$`));

    // Opened from the email, in a tab of its own.
    const opened = await newcomer.context().newPage();
    await useOwnAddress(opened);
    await opened.goto(link);
    // The secret has left the address bar.
    await expect(opened).toHaveURL(`${baseURL}/join/email`);
    const address = opened.getByRole("textbox", { name: "Email address" });
    await expect(address).toHaveValue(hal);
    await expect(address).not.toBeEditable();
    await opened.getByLabel("Name").fill("Hal");
    await opened.getByLabel("Password").fill("heuristically");
    await opened.getByRole("button", { name: "Create account" }).click();
    await expect(opened.getByRole("textbox", { name: "Write a message" })).toBeVisible();
    await newcomer.context().close();

    // The link is spent, and asking again for the address, which has an account now, emails a way to sign in.
    const latecomer = await signedOut(browser, baseURL!);
    await latecomer.goto(link);
    await expect(latecomer.getByText(EMAIL_LINK_GONE)).toBeVisible();
    const signIn = await askForLink(latecomer, hal);
    expect(signIn).toEqual(expect.objectContaining({ to: [hal], subject: expect.stringMatching(/^You already have an account at /) as unknown }));
    expect(linkIn(signIn)).toBe(`${baseURL}/session/new?email_address=${encodeURIComponent(hal)}`);
    await latecomer.context().close();
  });

  test("the page asks only for addresses at the domains, and sends people to sign in, which says why, once it's off", async ({ browser, request, baseURL }) => {
    await giveResendKey(request);
    await changeAccount(request, { emailFrom: FROM, emailDomains: [DOMAIN], settings: { emailDomainSignUp: true } });
    const newcomer = await signedOut(browser, baseURL!);
    await newcomer.goto("/join/email");
    const sent = resend.sent.length;
    await newcomer.getByRole("textbox", { name: "Email address" }).fill("hal@elsewhere.example");
    await newcomer.getByRole("button", { name: "Email me a link" }).click();
    await expect(newcomer.getByRole("alert")).toHaveText(onlyAddressesAt([DOMAIN]));
    expect(resend.sent).toHaveLength(sent);

    await changeAccount(request, { settings: { emailDomainSignUp: false } });
    await newcomer.goto("/join/email");
    await expect(newcomer.getByRole("alert")).toHaveText(JOINING_PROBLEMS.email_off);
    await expect(newcomer).toHaveURL(`${baseURL}/session/new`);
    await newcomer.context().close();
  });
});
