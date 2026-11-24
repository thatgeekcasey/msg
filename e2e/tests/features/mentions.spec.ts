import type { Locator, Page } from "@playwright/test";
import { cookieHeader } from "../../fixtures";
import { expect, test, type Member } from "./fixtures";

/**
 * A word for the names of one test's people that no other test's people have: the @ prompt lists
 * everyone in the room whose name has what's typed, and every test's people are in its rooms.
 */
const newTag = () => crypto.randomUUID().slice(0, 8);

/** The list of people the @ prompt opens, while it shows. */
const prompt = (member: Member) => member.page.getByRole("listbox");

/** The people the @ prompt lists, in order. */
const offered = (member: Member) => prompt(member).getByRole("option");

/**
 * Waits for the @ prompt's list to close and for Lexxy to listen for the next @, which it starts again a
 * frame after closing the list: sooner than anyone types one, but not always sooner than a test does,
 * whose @ it would miss.
 */
async function listClosed(member: Member): Promise<void> {
  await expect(prompt(member)).toBeHidden();
  await member.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** The mention of `name` in `scope`: their avatar, then their name. */
const mention = (scope: Locator, name: string) => scope.getByText(name, { exact: true });

/**
 * Resolves as `page` gets the list of people for all of `filter`. Lexxy searches whenever typing pauses and
 * draws each answer as it comes, picking its first, and an answer for less of `filter` can list the same
 * people first, as on a busy machine. When someone is picked from that list, the answer for all of it comes
 * after: Lexxy then closes its list once more, and misses an @ typed in the frame that follows.
 */
const answerFor = (page: Page, filter: string) => page.waitForResponse((response) => new URL(response.url()).searchParams.get("filter") === filter);

/**
 * Types @ and then `filter` into `field`, waiting for the list between them, as someone does who reads it
 * first, and then for the answer for all of `filter`. The list follows what's typed while it loads too
 * ("lists the people for what's typed while…").
 */
async function typeMention(field: Locator, filter: string): Promise<void> {
  const page = field.page();
  await field.pressSequentially("@");
  await expect(page.getByRole("listbox")).toBeVisible();
  const answered = answerFor(page, filter);
  await field.pressSequentially(filter);
  await answered;
}

/** Writes `before` in the composer, then mentions whoever the @ prompt lists first for `filter` once it lists just `people`. */
async function writeMention(member: Member, before: string, filter: string, people: string[]): Promise<void> {
  await member.composer().pressSequentially(before);
  await typeMention(member.composer(), filter);
  await expect(offered(member)).toHaveText(people);
  await member.composer().press("Tab");
}

/** Sends `before` and a mention of whoever the @ prompt lists first for `filter`, once it lists just `people`. */
async function sendMention(member: Member, before: string, filter: string, people: string[]): Promise<void> {
  await writeMention(member, before, filter, people);
  await member.composer().press("Enter");
}

// After Campfire's "mentioning a user with @ inserts a mention attachment" (composer_test.rb).
test.describe("@-mention people", () => {
  test("lists the room's people whose names have what follows @, you too, with avatars, and Up, Down and Tab pick one", async ({ members, participant }) => {
    const tag = newTag();
    await participant(`Jason ${tag}`);
    await participant(`Jasmine ${tag}`);
    const ada = await members.signIn(`Ada ${tag}`);

    await ada.composer().pressSequentially("Hey ");
    await typeMention(ada.composer(), tag);
    await expect(offered(ada)).toHaveText([`Ada ${tag}`, `Jasmine ${tag}`, `Jason ${tag}`]);
    await expect(offered(ada).first()).toHaveAttribute("aria-selected");
    await expect(offered(ada).first().locator("img")).toBeVisible();
    for (const key of ["ArrowDown", "ArrowDown", "ArrowUp", "ArrowDown"]) await ada.composer().press(key);
    await expect(offered(ada).nth(2)).toHaveAttribute("aria-selected");
    await ada.composer().press("Tab");
    await expect(prompt(ada)).toBeHidden();
    await expect(mention(ada.composer(), `Jason ${tag}`)).toBeVisible();

    await ada.composer().pressSequentially("how are you?");
    await ada.composer().press("Enter");
    const sent = ada.message("how are you?");
    await expect(sent).toContainText(`Hey Jason ${tag} how are you?`);
    await expect(mention(sent, `Jason ${tag}`).locator("img")).toBeVisible();
  });

  test("picks with Enter, Space and comma too, without sending", async ({ members, participant }) => {
    const tag = newTag();
    await participant(`Bea ${tag}`);
    const zed = await members.signIn(`Zed ${tag}`);

    for (const key of ["Enter", "Space", ","]) {
      await typeMention(zed.composer(), tag);
      await expect(offered(zed)).toHaveText([`Bea ${tag}`, `Zed ${tag}`]);
      await zed.composer().press(key);
      await listClosed(zed);
    }
    await expect(mention(zed.composer(), `Bea ${tag}`)).toHaveCount(3);
    await expect(zed.composer()).toContainText(",");
    await expect(zed.page.getByRole("article")).toHaveCount(0);

    await zed.composer().press("Enter");
    await expect(mention(zed.message(`Bea ${tag}`), `Bea ${tag}`)).toHaveCount(3);
  });

  test("lists the people for what's typed while the list loads, each time it opens", async ({ members, participant }) => {
    const tag = newTag();
    await participant(`Bea ${tag}`);
    const zed = await members.signIn(`Zed ${tag}`);

    // The first time, Lexxy fetches the list before it reads what follows the @, and after that, as the @ is typed.
    for (const time of ["first", "second"]) {
      const answered = answerFor(zed.page, tag);
      await zed.composer().pressSequentially(`@${tag}`);
      await answered;
      await expect(offered(zed), `the ${time} time`).toHaveText([`Bea ${tag}`, `Zed ${tag}`]);
      await zed.composer().press("Tab");
      await listClosed(zed);
    }
    await expect(mention(zed.composer(), `Bea ${tag}`)).toHaveCount(2);
  });

  test("lists someone whose username starts with what follows @ too, showing it after their name", async ({ members, participant, request }) => {
    const tag = newTag();
    const grace = await participant(`Grace ${tag}`);
    const username = `amazing.${tag}`;
    const changed = await request.patch("/api/users/me/profile", { data: { username }, headers: { Cookie: cookieHeader(grace.session) } });
    expect(changed.status(), await changed.text()).toBe(200);
    const ada = await members.signIn(`Ada ${tag}`);

    await ada.composer().pressSequentially("Hey ");
    await typeMention(ada.composer(), username.slice(0, -2));
    await expect(offered(ada)).toHaveText([`Grace ${tag} @${username}`]);
    await ada.composer().press("Tab");
    // The mention names them, as every mention does.
    await expect(mention(ada.composer(), `Grace ${tag}`)).toBeVisible();
  });

  test("says No matches when no one's name has what follows @, and Escape closes the list, keeping what's written", async ({ members }) => {
    const ada = await members.signIn(`Ada ${newTag()}`);
    const nobody = `zz${newTag()}`;
    await ada.composer().pressSequentially("Hi ");
    await typeMention(ada.composer(), nobody);
    await expect(prompt(ada)).toHaveText("No matches");
    await ada.composer().press("Escape");
    await expect(prompt(ada)).toBeHidden();
    await expect(ada.composer()).toHaveText(`Hi @${nobody}`);
    await expect(ada.composer()).toBeFocused();
  });

  test("opens only for an @ at the start of a line or after a space", async ({ members }) => {
    const ada = await members.signIn(`Ada ${newTag()}`);
    let searches = 0;
    ada.page.on("request", (request) => void (request.url().includes("/api/autocompletable/users") && searches++));
    await ada.composer().pressSequentially("Write to ada@example.com");
    await ada.composer().press("Enter");
    await expect(ada.message("Write to ada@example.com")).toBeVisible();
    expect(searches).toBe(0);
  });
});

test.describe("Send from the keyboard", () => {
  test("sends a message holding only a mention", async ({ members, participant }) => {
    const tag = newTag();
    await participant(`Bea ${tag}`);
    const zed = await members.signIn(`Zed ${tag}`);
    await sendMention(zed, "", tag, [`Bea ${tag}`, `Zed ${tag}`]);
    await expect(mention(zed.message(`Bea ${tag}`), `Bea ${tag}`)).toBeVisible();
    await expect(zed.composer()).toHaveText("");
  });
});

test.describe("Keep drafts", () => {
  test("keeps mentions in what's written", async ({ members, participant }) => {
    const tag = newTag();
    await participant(`Bea ${tag}`);
    const zed = await members.signIn(`Zed ${tag}`);
    await writeMention(zed, "For ", tag, [`Bea ${tag}`, `Zed ${tag}`]);

    await zed.page.reload();
    await zed.connected();
    await expect(mention(zed.composer(), `Bea ${tag}`)).toBeVisible();
    await zed.composer().press("Enter");
    await expect(mention(zed.message("For"), `Bea ${tag}`)).toBeVisible();
  });
});

test.describe("Highlight mentions of you", () => {
  test("highlights messages that mention you, not ones that only type your name", async ({ members }) => {
    const tag = newTag();
    const ada = await members.signIn(`Ada ${tag}`);
    const grace = await members.signIn(`Grace ${tag}`);
    await sendMention(grace, "Thanks ", tag, [`Ada ${tag}`, `Grace ${tag}`]);
    await grace.send(`Typed out: @Ada ${tag}`);

    const highlight = (member: Member, text: string) => member.message(text).locator(".border-mention");
    await expect(highlight(ada, "Thanks")).toHaveCSS("border-left-width", "2px");
    await expect(ada.message("Typed out")).toBeVisible();
    await expect(highlight(ada, "Typed out")).toHaveCount(0);
    await expect(grace.message("Thanks")).toBeVisible();
    await expect(highlight(grace, "Thanks")).toHaveCount(0);
  });
});

// Slack's mention badges, counting what in an unread room asks for you.
test.describe("Count mentions of you", () => {
  test("counts the messages mentioning you in a room you're not in on its row, in place of its dot, through a reload, until you open it", async ({ members, rooms }) => {
    const tag = newTag();
    const ada = await members.signIn(`Ada ${tag}`, { path: `/rooms/${rooms.random.id}` });
    const grace = await members.signIn(`Grace ${tag}`);
    const row = (name: string) => ada.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name });
    const general = row("general");

    await grace.send("Lunch?");
    await expect(general).toHaveAccessibleDescription(/^Unread/);
    await expect(general).not.toHaveAccessibleDescription(/mention/);

    await sendMention(grace, "Thanks ", tag, [`Ada ${tag}`, `Grace ${tag}`]);
    await expect(general).toHaveAccessibleDescription(/^Unread 1 mention /);
    await sendMention(grace, "And ", tag, [`Ada ${tag}`, `Grace ${tag}`]);
    await expect(general).toHaveAccessibleDescription(/^Unread 2 mentions /);
    await expect(general.getByText("2", { exact: true })).toHaveCSS("height", "18px");

    // The server keeps the count.
    await ada.page.reload();
    await expect(general).toHaveAccessibleDescription(/^Unread 2 mentions /);

    // Opening it reads it, once the room has let Ada's socket in.
    await general.click();
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText("general");
    await ada.connected();
    await expect(general).not.toHaveAccessibleDescription(/^Unread/);
    await expect(general.getByText("2", { exact: true })).toBeHidden();

    // Reading it starts the count again, for what comes once Ada has left and her sidebar has heard of the read.
    await expect(grace.presence()).toHaveText("2 here now");
    await row("random").click();
    await expect(grace.presence()).toHaveText("1 here now");
    await expect(general).not.toHaveAccessibleDescription(/^Unread/);
    await grace.send("Bye");
    await expect(general).toHaveAccessibleDescription(/^Unread/);
    await expect(general).not.toHaveAccessibleDescription(/mention/);
  });
});

// Slack's @here and @channel, which notify the room rather than someone.
test.describe("Notify a room", () => {
  test("offers @here and @channel after the people, and @here first once it's typed in full, which Space picks, highlighting the message for everyone", async ({ members, participant }) => {
    const tag = newTag();
    // With whoever made the room, and other tests' people, it holds more than six, so sending asks first.
    for (const name of ["Hopper", "Joan", "Kay", "Lin"]) await participant(`${name} ${tag}`);
    const ada = await members.signIn(`Ada ${tag}`);
    const grace = await members.signIn(`Grace ${tag}`);

    await grace.composer().pressSequentially("Lunch? ");
    await typeMention(grace.composer(), "h");
    await expect(offered(grace).last()).toHaveText("@here Notify everyone active in this room");
    await expect(offered(grace).last().locator(".autocompletable__at")).toBeVisible();
    const answered = answerFor(grace.page, "here");
    await grace.composer().pressSequentially("ere");
    await answered;
    await expect(offered(grace).first()).toHaveText("@here Notify everyone active in this room");
    await expect(offered(grace).first()).toHaveAttribute("aria-selected");
    await grace.composer().press("Space");
    await listClosed(grace);
    await expect(grace.composer().getByText("@here", { exact: true })).toBeVisible();
    await grace.composer().press("Enter");
    // Ada's tab is in use, so @here notifies someone.
    await expect(grace.page.getByRole("dialog").getByRole("button", { name: "Send" })).toBeFocused();
    await grace.page.keyboard.press("Enter");

    for (const member of [ada, grace]) {
      await expect(member.message("Lunch?")).toContainText("Lunch? @here");
      await expect(member.message("Lunch?").locator(".border-mention")).toHaveCSS("border-left-width", "2px");
    }
  });

  test("asks before @channel notifies a room of six or more, as Slack asks, going back to the message on Escape and sending it on Enter", async ({ members, participant }) => {
    const tag = newTag();
    // With whoever made the room, and other tests' people, it holds more than six.
    for (const name of ["Hopper", "Joan", "Kay", "Lin"]) await participant(`${name} ${tag}`);
    const ada = await members.signIn(`Ada ${tag}`);
    const grace = await members.signIn(`Grace ${tag}`);

    await grace.composer().pressSequentially("Standup ");
    await typeMention(grace.composer(), "channel");
    await expect(offered(grace).first()).toHaveText("@channel Notify everyone in this room");
    await grace.composer().press("Tab");
    await listClosed(grace);
    await grace.composer().press("Enter");
    const dialog = grace.page.getByRole("dialog");
    await expect(dialog.getByRole("heading")).toHaveText(/^Notify [\d,]+ people\?$/);
    await expect(dialog).toContainText("@channel notifies everyone in #general.");
    await expect(dialog.getByRole("button", { name: "Send" })).toBeFocused();
    await grace.page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(grace.composer()).toBeFocused();
    await expect(grace.composer()).toContainText("Standup @channel");

    await grace.composer().press("Enter");
    await expect(dialog.getByRole("button", { name: "Send" })).toBeFocused();
    await grace.page.keyboard.press("Enter");
    await expect(dialog).toBeHidden();
    for (const member of [ada, grace]) await expect(member.message("Standup")).toContainText("Standup @channel");
    await expect(grace.composer()).toHaveText("");
  });
});

test.describe("How mentions look", () => {
  test("shows a mention as the person's avatar and name, renamed everywhere at once when they're renamed", async ({ members, request }) => {
    const tag = newTag();
    const ada = await members.signIn(`Ada ${tag}`);
    const grace = await members.signIn(`Grace ${tag}`);
    await sendMention(grace, "Thanks ", tag, [`Ada ${tag}`, `Grace ${tag}`]);
    await expect(mention(ada.message("Thanks"), `Ada ${tag}`).locator("img")).toBeVisible();

    const renamed = await request.patch("/api/users/me/profile", { data: { name: `Ada King ${tag}` }, headers: { Cookie: cookieHeader(ada.session) } });
    expect(renamed.status(), await renamed.text()).toBe(200);
    for (const member of [ada, grace]) await expect(mention(member.message("Thanks"), `Ada King ${tag}`)).toBeVisible();
    await grace.page.reload();
    await expect(mention(grace.message("Thanks"), `Ada King ${tag}`)).toBeVisible();
  });
});

test.describe("Edit a message", () => {
  // After Campfire's "editing a message with a mention keeps the mention" (composer_test.rb).
  test("keeps a message's mentions through an edit, where Escape closes just the @ prompt's list", async ({ members, participant }) => {
    const tag = newTag();
    await participant(`Bea ${tag}`);
    const zed = await members.signIn(`Zed ${tag}`);
    await sendMention(zed, "Hey ", tag, [`Bea ${tag}`, `Zed ${tag}`]);

    await (await zed.actions("Hey")).getByRole("button", { name: "Edit" }).click();
    await expect(mention(zed.editor(), `Bea ${tag}`)).toBeVisible();
    await zed.editor().pressSequentially(" and ");
    await typeMention(zed.editor(), tag);
    await expect(offered(zed)).toHaveText([`Bea ${tag}`, `Zed ${tag}`]);
    await zed.editor().press("Escape");
    await expect(prompt(zed)).toBeHidden();
    await zed.page.getByRole("button", { name: "Save changes" }).click();

    await expect(zed.editor()).toBeHidden();
    await expect(zed.message("Hey")).toContainText(`and @${tag}`);
    await expect(mention(zed.message("Hey"), `Bea ${tag}`)).toBeVisible();
    await zed.page.reload();
    await expect(mention(zed.message("Hey"), `Bea ${tag}`)).toBeVisible();
    await expect(zed.message("Hey")).toContainText(`and @${tag}`);
  });
});
