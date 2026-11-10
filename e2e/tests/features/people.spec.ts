import type { Bootstrap, ProfileChanges } from "@ember/protocol";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { ADMINISTRATOR, cookieHeader, createSession, signInAsAdministrator, useOwnAddress, type Session } from "../../fixtures";
import { expect, test, unique } from "./fixtures";

/** Changes `session`'s person's profile through the API, as their profile page does. */
async function changeProfile(request: APIRequestContext, session: Session, changes: ProfileChanges): Promise<void> {
  const response = await request.patch("/api/users/me/profile", { data: changes, headers: { Cookie: cookieHeader(session) } });
  expect(response.status(), await response.text()).toBe(200);
}

/** The page's heading, someone's name. */
const heading = (page: Page) => page.getByRole("main").getByRole("heading", { level: 1 });

test.describe("Someone's profile page", () => {
  test("shows someone's page at its address, titled with their name, and starts a DM with them there, whose composer takes focus", async ({ members, request }) => {
    const ada = await members.signIn(unique("Ada"));
    const grace = await members.signIn(unique("Grace"));
    await changeProfile(request, grace.session, { bio: "Wrote the first compiler", emailAddress: `grace-${crypto.randomUUID()}@example.com` });

    const { page } = ada;
    await page.goto(`/users/${grace.session.user.id}`);
    await expect(heading(page)).toHaveText(grace.name);
    await expect(page).toHaveTitle(grace.name);
    await expect(page.getByRole("main").getByText("Wrote the first compiler")).toBeVisible();
    await expect(page.getByRole("img", { name: "Profile avatar" })).toBeVisible();
    // Only administrators are told someone's email address, and only your own page has the pencil.
    await expect(page.getByRole("main").getByRole("link")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Edit my profile" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/");

    await page.getByRole("button", { name: `Ping ${grace.name}` }).click();
    // The DM's name heads its top bar.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Direct message with ${grace.name}`);
    await ada.connected();
    await expect(ada.composer()).toBeFocused();
  });

  test("shows administrators someone's email address, and their own page a pencil to their profile", async ({ members, page, request }) => {
    const grace = await members.signIn(unique("Grace"));
    const emailAddress = `grace-${crypto.randomUUID()}@example.com`;
    await changeProfile(request, grace.session, { emailAddress });

    await useOwnAddress(page);
    await page.goto(`/users/${grace.session.user.id}`);
    await signInAsAdministrator(page);
    await expect(heading(page)).toHaveText(grace.name);
    await expect(page.getByRole("link", { name: emailAddress })).toHaveAttribute("href", `mailto:${emailAddress}`);
    await expect(page.getByRole("link", { name: "Edit my profile" })).toHaveCount(0);

    const { user } = (await (await page.request.get("/api/bootstrap")).json()) as Bootstrap;
    await page.goto(`/users/${user!.id}`);
    await expect(heading(page)).toHaveText(ADMINISTRATOR.name);
    await expect(page.getByRole("link", { name: ADMINISTRATOR.emailAddress })).toHaveAttribute("href", `mailto:${ADMINISTRATOR.emailAddress}`);
    await page.getByRole("link", { name: "Edit my profile" }).click();
    await expect(page).toHaveURL(/\/users\/me\/profile$/);
    await expect(page.getByLabel("Email address")).toHaveValue(ADMINISTRATOR.emailAddress);
  });

  test("answers Campfire's 404 page for the page of someone nobody is", async ({ members }) => {
    const { page } = await members.signIn(unique("Ada"));
    const response = await page.goto("/users/nobody");
    expect(response!.status()).toBe(404);
    await expect(page).toHaveTitle("We can’t find that (404)");
  });
});

test.describe("Avatars open people's pages", () => {
  test("a message's avatar, its reactions' and its mentions' open each person's page, titled with their name and bio", async ({ members, participant, request }) => {
    const tag = crypto.randomUUID().slice(0, 8);
    const grace = await participant(`Grace ${tag}`);
    const linus = await participant(`Linus ${tag}`);
    await changeProfile(request, grace.session, { bio: "Wrote the first compiler" });
    const asked = await grace.say("Ask me anything");
    await linus.boost(asked.id, "👍");
    const ada = await members.signIn(unique("Ada"));
    const { page } = ada;
    const graceTitle = `Grace ${tag} – Wrote the first compiler`;

    // The people @ lists, and the mention written, aren't links, so a click there picks them.
    await ada.composer().pressSequentially("Thanks @");
    await expect(page.getByRole("listbox")).toBeVisible();
    await ada.composer().pressSequentially(tag);
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText([`Grace ${tag}`, `Linus ${tag}`]);
    await expect(page.getByRole("listbox").getByRole("link")).toHaveCount(0);
    await ada.composer().press("Tab");
    await expect(ada.composer().getByText(`Grace ${tag}`, { exact: true })).toBeVisible();
    await expect(ada.composer().getByRole("link")).toHaveCount(0);
    await ada.composer().press("Enter");

    const question = ada.message("Ask me anything");
    await question.getByRole("link", { name: graceTitle }).click();
    await expect(page).toHaveURL(new RegExp(`/users/${grace.session.user.id}$`));
    await expect(heading(page)).toHaveText(`Grace ${tag}`);

    await page.goBack();
    await ada.connected();
    const boost = question.getByRole("list", { name: "Reactions" }).getByRole("link", { name: `Linus ${tag} boosted 👍` });
    await expect(boost).toHaveAttribute("title", `Linus ${tag}`);
    await boost.click();
    await expect(heading(page)).toHaveText(`Linus ${tag}`);

    await page.goBack();
    await ada.connected();
    await ada.message("Thanks").getByRole("paragraph").getByRole("link", { name: graceTitle }).click();
    await expect(heading(page)).toHaveText(`Grace ${tag}`);
  });

  test("the people list, a room's people and a DM's settings link avatars to people's pages too", async ({ members, request, rooms }) => {
    const grace = await createSession(request, unique("Grace"));
    const ada = await members.signIn(unique("Ada"));
    const { page } = ada;
    const toGrace = (scope: Locator) => scope.getByRole("link", { name: grace.user.name, exact: true });

    await page.goto("/account/edit#membership-settings");
    await expect(toGrace(page.getByRole("main"))).toHaveAttribute("href", `/users/${grace.user.id}`);
    // Go Back from their page returns to the people list, rather than the first section of settings.
    await toGrace(page.getByRole("main")).click();
    await expect(heading(page)).toHaveText(grace.user.name);
    await page.getByRole("link", { name: "Go Back" }).click();
    await expect(page).toHaveURL(/\/account\/edit#membership-settings$/);
    await expect(toGrace(page.getByRole("region", { name: "Membership" }))).toBeVisible();

    await page.goto(`/rooms/opens/${rooms.general.id}/edit`);
    await expect(toGrace(page.getByRole("main"))).toHaveAttribute("href", `/users/${grace.user.id}`);

    const response = await request.post("/api/directs", { data: { userIds: [grace.user.id] }, headers: { Cookie: cookieHeader(ada.session) } });
    expect(response.status(), await response.text()).toBe(201);
    const { room } = (await response.json()) as { room: { id: string } };
    await page.goto(`/rooms/directs/${room.id}/edit`);
    await toGrace(page.getByRole("main")).click();
    await expect(heading(page)).toHaveText(grace.user.name);
  });
});
