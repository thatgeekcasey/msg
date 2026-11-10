import { cookieHeader, createSession, signInAs, signInAsAdministrator, useOwnAddress } from "../../fixtures";
import { expect, test } from "./fixtures";

/** A name as long as the server takes, with a run that only breaks anywhere. */
const LONG_NAME = "Augusta-Ada-King-Noel-Countess-of-Lovelace-Byron";
/** A bio as long as the server takes, all one run, as a pasted link is. */
const LONG_BIO = `https://example.com/${"analytical-engine-".repeat(10)}`.padEnd(200, "x");

// Asking for the test's room makes it the only one in the sidebar, which wider phones show beside the page.
test.beforeEach(async ({ page, session, room: _ }) => {
  await signInAs(page, session);
});

test("someone's page, with a long name and bio, fits the phone with its DM button easy to tap", async ({ page, request, screenIsFine }) => {
  const person = await createSession(request, LONG_NAME);
  const response = await request.patch("/api/users/me/profile", { data: { bio: LONG_BIO }, headers: { Cookie: cookieHeader(person) } });
  expect(response.status(), await response.text()).toBe(200);

  await page.goto(`/users/${person.user.id}`);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText(LONG_NAME);
  await expect(page.getByRole("button", { name: `Ping ${LONG_NAME}` })).toBeVisible();
  await screenIsFine();
});

test("your own page fits the phone with the pencil to your profile in the top bar", async ({ page, session, screenIsFine }) => {
  await page.goto(`/users/${session.user.id}`);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toHaveText(session.user.name);
  await expect(page.getByRole("navigation", { name: "Page" }).getByRole("link", { name: "Edit my profile" })).toBeVisible();
  await screenIsFine();
});

test("an administrator's view of someone's page fits the phone, down to their sign-in link and Ban", async ({ page, request, screenIsFine }) => {
  const person = await createSession(request, LONG_NAME);
  await useOwnAddress(page);
  await page.goto("/session/new");
  await signInAsAdministrator(page);
  await expect(page).not.toHaveURL(/\/session\/new$/);

  await page.goto(`/users/${person.user.id}`);
  const link = page.getByRole("textbox", { name: "Share to get them back into their account" });
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeInViewport();
  await screenIsFine();
  const ban = page.getByRole("button", { name: `Ban ${LONG_NAME}` });
  await ban.scrollIntoViewIfNeeded();
  await expect(ban).toBeInViewport();
  await screenIsFine();
});
