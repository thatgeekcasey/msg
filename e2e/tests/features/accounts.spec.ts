import { SIGN_IN_REJECTED } from "@ember/protocol";
import type { Page } from "@playwright/test";
import { invitation, signInAsAdministrator, useOwnAddress } from "../../fixtures";
import { RECOVERY_TOKEN } from "../../projects/features";
import { expect, test } from "./fixtures";

// Renaming the workspace or regenerating its join link changes every other test's pages, so the
// workspace-settings project does those on a server of its own. These save the name as it is.

test.describe("Community settings page", () => {
  test("a member sees the community's name in Community settings, with nothing to change", async ({ members }) => {
    const grace = await members.signIn("Grace Hopper");
    await grace.page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Workspace" }).click();
    await expect(grace.page).toHaveTitle("Community settings");
    await expect(grace.page.getByRole("heading", { level: 1, name: "Basic community settings" })).toBeVisible();
    await expect(grace.page.getByRole("main").getByRole("heading", { level: 2, name: "Ember", exact: true })).toBeVisible();
    await expect(grace.page.getByRole("textbox", { name: "Community name" })).toHaveCount(0);
  });
});

test.describe("Rename the workspace", () => {
  test("the administrator saves the workspace's name from the Admin page, which says Changes saved.", async ({ page }) => {
    await useOwnAddress(page);
    await page.goto("/session/new");
    await signInAsAdministrator(page);
    await expect(page.getByRole("textbox", { name: "Write a message" })).toBeVisible();
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Admin" }).click();

    const name = page.getByRole("textbox", { name: "Community name" });
    await expect(name).toHaveValue("Ember");
    await expect(name).not.toBeFocused();
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/account") && response.request().method() === "PATCH");
    await name.press("Enter");
    expect((await saved).status()).toBe(200);
    await expect(page.getByRole("alert")).toHaveText("Changes saved.");
    await expect(page).toHaveURL(/\/account\/edit$/);
  });
});

test.describe("Join link", () => {
  /** Opens Membership in Community settings, from the rail's Workspace link. */
  async function openMembership(page: Page) {
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Workspace" }).click();
    await page.getByRole("navigation", { name: "Community settings" }).getByRole("link", { name: "Membership" }).click();
  }

  test("a member's Membership settings have the welcome card's join link, which only administrators regenerate", async ({ page, request, session, baseURL }) => {
    await useOwnAddress(page);
    const { joinCode } = await invitation(request, session);
    await page.goto(`/join/${joinCode}`);
    await page.getByLabel("Name").fill("Grace Hopper");
    await page.getByLabel("Email address").fill(`grace-${crypto.randomUUID()}@example.com`);
    await page.getByLabel("Password").fill("compiler");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", "Grace Hopper");

    await openMembership(page);
    await expect(page.getByRole("textbox", { name: "Share to invite more people" })).toHaveValue(new URL(`/join/${joinCode}`, baseURL).href);
    await expect(page.getByRole("link", { name: "Show join link QR code" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy join link" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Regenerate join link" })).toHaveCount(0);
  });

  test("someone who signed in with just a name isn't given the join link, which would let them stay once guests are turned away", async ({ members }) => {
    const guest = await members.signIn("Mallory");
    await openMembership(guest.page);
    await expect(guest.page.getByText("Only the people administrators invite can join.")).toBeVisible();
    await expect(guest.page.getByRole("textbox", { name: "Share to invite more people" })).toHaveCount(0);
  });
});

test.describe("Reset a password from the server", () => {
  test("someone's open tab goes to sign in once their password is reset, where only the new one signs them in", async ({ page, request, session }) => {
    await useOwnAddress(page);
    await page.goto(`/join/${(await invitation(request, session)).joinCode}`);
    const emailAddress = `grace-${crypto.randomUUID()}@example.com`;
    await page.getByLabel("Name").fill("Grace Hopper");
    await page.getByLabel("Email address").fill(emailAddress);
    await page.getByLabel("Password").fill("compiler");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", "Grace Hopper");

    // As apps/worker/scripts/reset-password.ts asks for it.
    const reset = await request.post("/api/recovery/reset-password", {
      headers: { Authorization: `Bearer ${RECOVERY_TOKEN}` },
      data: { emailAddress, password: "correct horse" },
    });
    expect(reset.status()).toBe(200);
    expect(await reset.json()).toEqual({ message: "Password updated; existing sessions and live connections for this user were revoked." });

    // Without being loaded again.
    await expect(page.getByRole("heading", { level: 1, name: "Sign in to Ember" })).toBeVisible();
    await page.getByLabel("Email address").fill(emailAddress);
    await page.getByLabel("Password").fill("compiler");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText(SIGN_IN_REJECTED);
    await page.getByLabel("Password").fill("correct horse");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("link", { name: "Your profile" })).toHaveAttribute("title", "Grace Hopper");
  });
});
