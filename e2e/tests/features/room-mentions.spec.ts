import type { APIRequestContext, Locator } from "@playwright/test";
import { cookieHeader, type Session, type TestRoom } from "../../fixtures";
import { expect, test, unique, type Member } from "./fixtures";

// Slack's #channel links: # lists the rooms you're in, and a message shows a room it mentions by name,
// linking to it, to whoever's in it, and as a private room to anyone else.

/** The list of rooms the # prompt opens, while it shows. */
const prompt = (member: Member) => member.page.getByRole("listbox");

/** The rooms the # prompt lists, in order, each after its icon or a #. */
const offered = (member: Member) => prompt(member).getByRole("option");

/** The links in what message `message` says, past its author's avatar and its time. */
const linksIn = (message: Locator) => message.locator(".message-content").getByRole("link");

/**
 * Waits for the list to close and for Lexxy to listen for the next #, which it starts again a frame after
 * closing the list, as it does for @ (mentions.spec.ts).
 */
async function listClosed(member: Member): Promise<void> {
  await expect(prompt(member)).toBeHidden();
  await member.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Creates a private room through the API as `session`'s person, for them alone. */
async function createPrivateRoom(request: APIRequestContext, session: Session, name: string): Promise<TestRoom> {
  const response = await request.post("/api/rooms", { data: { kind: "closed", name, memberIds: [session.user.id] }, headers: { Cookie: cookieHeader(session) } });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { room: TestRoom }).room;
}

/** Changes room `room`'s name or icon through the API, as its settings do, as `session`'s person. */
async function changeRoom(request: APIRequestContext, session: Session, room: TestRoom, change: { name?: string; icon?: string }): Promise<void> {
  const response = await request.patch(`/api/rooms/${room.id}`, { data: change, headers: { Cookie: cookieHeader(session) } });
  expect(response.status(), await response.text()).toBe(200);
}

test.describe("#-mention rooms", () => {
  test("lists the rooms you're in after #, those with a word starting with what follows it, and Tab picks one, which the message links to", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");

    await ada.composer().pressSequentially("Over in ");
    await ada.composer().pressSequentially("#");
    await expect(offered(ada)).toHaveText(["#general", "#random"]);
    await expect(offered(ada).first()).toHaveAttribute("aria-selected");
    await ada.composer().pressSequentially("ra");
    await expect(offered(ada)).toHaveText(["#random"]);
    await ada.composer().press("Tab");
    await listClosed(ada);
    await expect(ada.composer().getByText("#random", { exact: true })).toBeVisible();

    await ada.composer().pressSequentially("please");
    await ada.composer().press("Enter");
    const sent = ada.message("please");
    await expect(sent).toContainText("Over in #random please");
    const link = sent.getByRole("link", { name: "#random" });
    await link.click();
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.random.id}$`));
    await expect(ada.page.getByRole("heading", { level: 1, name: "random", exact: true })).toBeVisible();
  });

  test("picks with Enter and a click too, searching names with spaces in them, and shows each room's icon", async ({ members, request, rooms, session }) => {
    const name = unique("Otter Pond");
    await changeRoom(request, session, rooms.random, { name, icon: "rocket" });
    const ada = await members.signIn("Ada");

    await ada.composer().pressSequentially(`#${name.split(" ")[0]} ${name.split(" ")[1]!.slice(0, 2)}`);
    await expect(offered(ada)).toHaveText([name]);
    await expect(offered(ada).locator(".autocompletable__room--icon")).toBeVisible();
    await ada.composer().press("Enter");
    await listClosed(ada);
    await ada.composer().pressSequentially("and ");
    await ada.composer().pressSequentially("#gen");
    await expect(offered(ada)).toHaveText(["#general"]);
    await offered(ada).first().click();
    await listClosed(ada);
    await expect(ada.page.getByRole("article")).toHaveCount(0);

    await ada.composer().press("Enter");
    const sent = ada.message("and");
    await expect(sent).toContainText(`#${name} and #general`);
    await expect(linksIn(sent)).toHaveText([`#${name}`, "#general"]);
  });

  test("leaves a # that starts no room's name as text, sent by the first Enter, and makes a heading of # and a space at a line's start", async ({ members }) => {
    const ada = await members.signIn("Ada");

    await ada.composer().pressSequentially("We're ");
    await ada.composer().pressSequentially("#");
    await expect(offered(ada)).toHaveText(["#general", "#random"]);
    await ada.composer().pressSequentially("1");
    // The list closes once it finds no room, rather than taking the Enter that sends.
    await listClosed(ada);
    await ada.composer().pressSequentially(" today");
    await ada.composer().press("Enter");
    await expect(ada.message("We're #1 today")).toBeVisible();
    await expect(ada.composer()).toHaveText("");

    await ada.composer().pressSequentially("# Big news");
    await expect(ada.composer().locator("h1")).toHaveText("Big news");
    await expect(prompt(ada)).toBeHidden();
    await ada.composer().press("Enter");
    await expect(ada.message("Big news").locator("h1")).toHaveText("Big news");
  });

  test("shows a private room by name to those in it, and as a lock and private room to everyone else, renamed for all at once", async ({ members, request }) => {
    const ada = await members.signIn("Ada");
    // Grace lists every room she's in, as people do, rather than only this test's, so her sidebar, and her
    // # list with it, takes in the room she makes.
    const grace = await members.signIn("Grace", { serverRooms: true });
    const name = unique("Plans");
    const plans = await createPrivateRoom(request, grace.session, name);
    await expect(grace.page.getByRole("region", { name: "Rooms" }).getByRole("link").filter({ hasText: name })).toBeVisible();

    await grace.composer().pressSequentially(`Details in #${name}`);
    await expect(offered(grace)).toHaveText([`#${name}`]);
    await grace.composer().press("Tab");
    await listClosed(grace);
    await grace.composer().press("Enter");

    await expect(linksIn(grace.message("Details in"))).toHaveAttribute("href", `/rooms/${plans.id}`);
    await expect(linksIn(grace.message("Details in"))).toHaveText(`#${name}`);
    const seen = ada.message("Details in");
    await expect(seen).toHaveText(/Details in\s*private room/);
    await expect(seen).not.toContainText(name);
    await expect(linksIn(seen)).toHaveCount(0);
    await expect(seen.locator("svg.iconoir-lock")).toBeVisible();

    const renamed = unique("Launch");
    await changeRoom(request, grace.session, plans, { name: renamed });
    await expect(linksIn(grace.message("Details in"))).toHaveText(`#${renamed}`);
    await expect(seen).toHaveText(/Details in\s*private room/);
  });

  test("keeps the rooms a message mentions in a quote of it, which names a private room to nobody outside it", async ({ members, request }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace", { serverRooms: true });
    const name = unique("Plans");
    const plans = await createPrivateRoom(request, grace.session, name);
    await expect(grace.page.getByRole("region", { name: "Rooms" }).getByRole("link").filter({ hasText: name })).toBeVisible();
    await grace.composer().pressSequentially(`Notes in #${name}`);
    await expect(offered(grace)).toHaveText([`#${name}`]);
    await grace.composer().press("Tab");
    await listClosed(grace);
    await grace.composer().press("Enter");

    await grace.actions("Notes in");
    await grace.message("Notes in").getByRole("button", { name: "Message options" }).click();
    await grace.message("Notes in").getByRole("group", { name: "More actions" }).getByRole("button", { name: "Quote" }).click();
    await expect(grace.composer().locator("blockquote").getByText(`#${name}`, { exact: true })).toBeVisible();
    await grace.page.keyboard.type("Agreed");
    await grace.page.keyboard.press("Enter");

    const quoted = (member: Member) => member.message("Agreed").locator("blockquote");
    await expect(quoted(grace).getByRole("link")).toHaveText(`#${name}`);
    await expect(quoted(grace).getByRole("link")).toHaveAttribute("href", `/rooms/${plans.id}`);
    await expect(quoted(ada)).toHaveText(/Notes in\s*private room/);
    await expect(ada.message("Agreed")).not.toContainText(name);
    await expect(quoted(ada).locator("svg.iconoir-lock")).toBeVisible();
  });

  test("keeps a message's room mentions through an edit, and offers rooms from # in the edit box too", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("Meet in #rand");
    await expect(offered(ada)).toHaveText(["#random"]);
    await ada.composer().press("Tab");
    await listClosed(ada);
    await ada.composer().press("Enter");

    await (await ada.actions("Meet in")).getByRole("button", { name: "Edit" }).click();
    await expect(ada.editor().getByText("#random", { exact: true })).toBeVisible();
    await ada.editor().pressSequentially(" or #gen");
    await expect(offered(ada)).toHaveText(["#general"]);
    await ada.editor().press("Tab");
    await listClosed(ada);
    await ada.page.getByRole("button", { name: "Save changes" }).click();

    await expect(ada.editor()).toBeHidden();
    await expect(linksIn(ada.message("Meet in"))).toHaveText(["#random", "#general"]);
    await ada.page.reload();
    await expect(linksIn(ada.message("Meet in"))).toHaveText(["#random", "#general"]);
  });

  test("shows a room in what's written by its name as it is, renamed as it's written and in a draft kept before", async ({ members, request, rooms, session }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("Over in #rand");
    await expect(offered(ada)).toHaveText(["#random"]);
    await ada.composer().press("Tab");
    await listClosed(ada);
    await ada.page.keyboard.type("now");

    const renamed = unique("Rumpus");
    await changeRoom(request, session, rooms.random, { name: renamed });
    await expect(ada.composer().getByText(`#${renamed}`, { exact: true })).toBeVisible();
    await expect(ada.composer()).not.toContainText("#random");
    // The cursor stays where it was.
    await ada.page.keyboard.type(" please");

    // Renamed again with nothing typed since, the draft still has the name before.
    const again = unique("Racket");
    await changeRoom(request, session, rooms.random, { name: again });
    await expect(ada.composer().getByText(`#${again}`, { exact: true })).toBeVisible();
    await ada.page.reload();
    await ada.connected();
    await expect(ada.composer().getByText(`#${again}`, { exact: true })).toBeVisible();
    await expect(ada.composer()).not.toContainText(renamed);

    await ada.composer().press("Enter");
    const sent = ada.message("Over in");
    await expect(sent).toContainText(`Over in #${again} now please`);
    await expect(linksIn(sent)).toHaveText(`#${again}`);
  });
});

test.describe("Keep drafts", () => {
  test("keeps room mentions in what's written", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("See #gen");
    await expect(offered(ada)).toHaveText(["#general"]);
    await ada.composer().press("Tab");
    await listClosed(ada);

    await ada.page.reload();
    await ada.connected();
    await expect(ada.composer().getByText("#general", { exact: true })).toBeVisible();
    await ada.composer().press("Enter");
    await expect(linksIn(ada.message("See"))).toHaveText("#general");
  });
});
