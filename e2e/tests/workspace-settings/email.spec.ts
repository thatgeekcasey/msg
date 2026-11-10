import { EMAIL_FROM_REFUSED } from "@ember/protocol";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { ADMINISTRATOR, administratorSession, cookieHeader, SAME_ORIGIN, signInAsAdministrator, useOwnAddress } from "../../fixtures";
import { RESEND_KEY } from "../../projects/workspace-settings";
import { forgetResendKey, giveResendKey, startFakeResend, type FakeResend } from "./fake-resend";

// Membership's Email card and Set up email, on the second test server, which sends email with the
// Resend API this spec fakes once it's given the key that API takes. Each test leaves the workspace as a
// new one is: no Resend API key and no From address.

let resend: FakeResend;
test.beforeAll(async () => void (resend = await startFakeResend()));
test.afterAll(() => resend.close());
test.afterEach(async ({ request }) => {
  await forgetResendKey(request);
  await giveFrom(request, null);
});

/** Gives the workspace the From address `emailFrom`, as the administrator. */
async function giveFrom(request: APIRequestContext, emailFrom: string | null): Promise<void> {
  const administrator = await administratorSession(request);
  const response = await request.patch("/api/account", { data: { emailFrom }, headers: { Cookie: cookieHeader(administrator), ...SAME_ORIGIN } });
  expect(response.status(), await response.text()).toBe(200);
}

/** Opens Membership as the administrator, answering its Email card. */
async function openEmail(page: Page) {
  await useOwnAddress(page);
  await page.goto("/account/edit#membership-settings");
  await signInAsAdministrator(page);
  return page.getByRole("region", { name: "Email", exact: true });
}

test.describe("Sending email", () => {
  test("the administrator sets up Resend with an API key Ember checks, a From address and a test email", async ({ page, baseURL }) => {
    const email = await openEmail(page);
    await expect(email).toContainText("Ember can't send email yet, so it can't email invitations, the links people at your email domains join with, or codes to reset a forgotten password.");
    await email.getByRole("button", { name: "Set up email" }).click();
    const setup = page.getByRole("dialog");
    await expect(setup).toHaveAccessibleName("Set up email");
    await setup.getByRole("radio", { name: "Resend" }).check();
    await setup.getByRole("button", { name: "Continue" }).click();

    // A key Resend doesn't have is refused, as Resend says.
    await expect(setup).toHaveAccessibleName("Send with Resend");
    const key = setup.getByRole("textbox", { name: "API key" });
    await key.fill("re_not_one_resend_has");
    await setup.getByRole("button", { name: "Continue" }).click();
    await expect(setup.getByRole("alert")).toHaveText("Resend doesn't take this API key. Copy it again from API Keys in Resend, or make another.");
    await key.fill(RESEND_KEY);
    await setup.getByRole("button", { name: "Continue" }).click();

    await expect(setup).toHaveAccessibleName("Choose the From address");
    await setup.getByRole("textbox", { name: "From" }).fill("Acme, Inc. <chat@acme.example>");
    const sent = resend.sent.length;
    await setup.getByRole("button", { name: "Continue" }).click();

    // The last step sends a test email as it opens.
    await expect(setup).toHaveAccessibleName("Send a test email");
    await expect(setup.getByRole("status")).toHaveText(`Sent to ${ADMINISTRATOR.emailAddress}. If it isn't in your inbox, look in spam.`);
    expect(resend.sent.slice(sent)).toEqual([
      expect.objectContaining({
        from: '"Acme, Inc." <chat@acme.example>',
        to: [ADMINISTRATOR.emailAddress],
        subject: expect.stringMatching(/^Test email from /) as unknown,
      }),
    ]);
    expect(resend.sent.at(-1)!.text).toContain(`, at ${baseURL}.\n\nIt reached you, so Ember can send email.`);
    expect(resend.sent.at(-1)!.html).toContain(`<a href="${baseURL}">${baseURL}</a>`);
    await setup.getByRole("button", { name: "Done" }).click();
    await expect(setup).toBeHidden();
    await expect(email).toContainText('Ember sends email from "Acme, Inc." <chat@acme.example> with Resend.');

    // Membership shows what Ember kept.
    await page.reload();
    const kept = page.getByRole("region", { name: "Email", exact: true });
    await expect(kept).toContainText('Ember sends email from "Acme, Inc." <chat@acme.example> with Resend.');

    // Stop sending email takes the From address away, once it's confirmed.
    page.once("dialog", (dialog) => void dialog.accept());
    await kept.getByRole("button", { name: "Stop sending email" }).click();
    await expect(kept).toContainText("Ember can't send email yet");
    await page.reload();
    await expect(page.getByRole("region", { name: "Email", exact: true })).toContainText("Ember can't send email yet");
  });

  test("Set up email refuses a From address that isn't one, and the card says why Resend refused a test email", async ({ page, request }) => {
    await giveResendKey(request);
    const email = await openEmail(page);
    await email.getByRole("button", { name: "Set up email" }).click();
    const setup = page.getByRole("dialog");
    // Ember has a key, so Resend is chosen already, and its step needs no other.
    await expect(setup.getByRole("radio", { name: "Resend" })).toBeChecked();
    await setup.getByRole("button", { name: "Continue" }).click();
    await expect(setup.getByRole("textbox", { name: "API key" })).toHaveAccessibleDescription(
      "Ember has a Resend API key already. Paste another to send with it instead.",
    );
    await setup.getByRole("button", { name: "Continue" }).click();
    await setup.getByRole("textbox", { name: "From" }).fill("Acme");
    await setup.getByRole("button", { name: "Continue" }).click();
    await expect(setup.getByRole("alert")).toHaveText(EMAIL_FROM_REFUSED);
    await setup.getByRole("button", { name: "Close" }).click();
    await expect(email).toContainText("Ember can't send email yet");

    await giveFrom(request, "chat@acme.example");
    await page.reload();
    resend.refuseNext({
      status: 403,
      name: "validation_error",
      message: "The acme.example domain is not verified. Please, add and verify your domain on https://resend.com/domains",
    });
    const sent = resend.sent.length;
    const card = page.getByRole("region", { name: "Email", exact: true });
    await card.getByRole("button", { name: "Send me a test email" }).click();
    await expect(card.getByRole("status")).toHaveText(
      "Resend refused it: The acme.example domain is not verified. Please, add and verify your domain on https://resend.com/domains",
    );
    expect(resend.sent).toHaveLength(sent);
  });
});
