import type { Locator } from "@playwright/test";
import { cookieHeader, editorField } from "../../fixtures";
import { expect, recordsClips, startDirect, test, unique, type Member } from "./fixtures";

// Slack's Manage drafts, the pencil beside Send: the conversation's drafts, the one written ticked, any of
// which it opens again, and Save as draft, which puts what's written aside to write another.

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("Not visible");
  return rect;
};

/** The composer whose text box is `field`. */
const composerOf = (field: Locator) => field.locator("xpath=ancestor::form[1]");

/** A button under the text of the composer whose text box is `field`, by its name, found while a menu over the page hides it from the rest too. */
const underText = (field: Locator, name: string) => composerOf(field).getByRole("button", { name, exact: true, includeHidden: true });

/** The drafts the open menu lists under its heading, each by its first line. */
const drafts = (member: Member, place: "room" | "conversation" | "thread") => member.page.getByRole("group", { name: `Drafts in this ${place}` }).getByRole("menuitemradio");

/** Which of the drafts listed is ticked, as the one written. */
const ticks = (listed: Locator) => listed.evaluateAll((items) => items.map((item) => item.getAttribute("aria-checked") === "true"));

const saveAsDraft = (member: Member) => member.page.getByRole("menu").getByRole("menuitem", { name: "Save as draft" });

/** The thread open beside the room, and its composer's text box. */
const threadOf = (member: Member) => member.page.getByRole("complementary", { name: "Thread" });
const replyBox = (member: Member) => editorField(threadOf(member), "Write a reply");

test.describe("Manage drafts", () => {
  test("puts what's written aside with Save as draft, to write another, lists the room's drafts with the one written ticked, and opens one again, putting what's written aside", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const field = ada.composer();
    // As Slack's, it's there once something's written.
    await expect(field).toBeFocused();
    await expect(underText(field, "Manage drafts")).toHaveCount(0);
    await field.fill("First thought");
    const pencil = underText(field, "Manage drafts");
    await pencil.hover();
    await expect(ada.page.getByRole("tooltip", { name: "Manage drafts", exact: true })).toBeVisible();
    // Beside Send, on the line of the buttons under the text.
    expect((await box(pencil)).y).toBe((await box(underText(field, "Attach"))).y);
    expect((await box(pencil)).x).toBeLessThan((await box(underText(field, "Send Message"))).x);

    await pencil.click();
    await expect(ada.page.getByRole("menu").getByText("Drafts in this room", { exact: true })).toBeVisible();
    await expect(drafts(ada, "room")).toHaveText(["First thought"]);
    expect(await ticks(drafts(ada, "room"))).toEqual([true]);
    await saveAsDraft(ada).click();
    await expect(field).toHaveText("");
    await expect(field).toBeFocused();
    await expect(ada.page.getByRole("button", { name: "Send Message" })).toHaveAttribute("data-empty");

    await field.fill("Second thought");
    await pencil.click();
    await expect(drafts(ada, "room")).toHaveText(["Second thought", "First thought"]);
    expect(await ticks(drafts(ada, "room"))).toEqual([true, false]);
    await drafts(ada, "room").filter({ hasText: "First thought" }).click();
    await expect(field).toHaveText("First thought");
    await expect(field).toBeFocused();

    // Both are kept in this browser, the one written as the room's draft, and nothing went to the room.
    await ada.page.reload();
    await expect(ada.composer()).toHaveText("First thought");
    await underText(ada.composer(), "Manage drafts").click();
    await expect(drafts(ada, "room")).toHaveText(["First thought", "Second thought"]);
    expect(await ticks(drafts(ada, "room"))).toEqual([true, false]);
    await ada.page.keyboard.press("Escape");
    await expect(ada.composer()).toBeFocused();
    await expect(ada.page.getByRole("article")).toHaveCount(0);
  });

  test("keeps a thread's drafts apart from its room's, and a DM's, beside Send in a thread too", async ({ members, request, participant }) => {
    await (await participant("Grace")).say("Plans for Friday?");
    const ada = await members.signIn("Ada");
    await ada.composer().fill("For the room");
    await underText(ada.composer(), "Manage drafts").click();
    await saveAsDraft(ada).click();

    await (await ada.actions("Plans for Friday?")).getByRole("link", { name: "Reply in thread" }).click();
    await expect(replyBox(ada)).toBeFocused();
    await expect(underText(replyBox(ada), "Manage drafts")).toHaveCount(0);
    await replyBox(ada).fill("For the thread");
    const pencil = underText(replyBox(ada), "Manage drafts");
    // The thread's buttons, Manage drafts among them, keep to one line beside the room.
    expect((await box(pencil)).y).toBe((await box(underText(replyBox(ada), "Attach"))).y);
    await pencil.click();
    await expect(drafts(ada, "thread")).toHaveText(["For the thread"]);
    await saveAsDraft(ada).click();
    await expect(replyBox(ada)).toHaveText("");
    await expect(replyBox(ada)).toBeFocused();
    await underText(ada.composer(), "Manage drafts").click();
    await expect(drafts(ada, "room")).toHaveText(["For the room"]);
    await ada.page.keyboard.press("Escape");

    const grace = await members.signIn("Grace");
    const direct = await startDirect(request, ada, [grace]);
    await ada.page.goto(`/rooms/${direct}`);
    await ada.connected();
    await expect(underText(ada.composer(), "Manage drafts")).toHaveCount(0);
    await ada.composer().fill("Just between us");
    await underText(ada.composer(), "Manage drafts").click();
    await expect(drafts(ada, "conversation")).toHaveText(["Just between us"]);
  });

  test("opens a draft with the rooms it mentions by their names as they are now", async ({ members, request, rooms, session }) => {
    const ada = await members.signIn("Ada");
    const field = ada.composer();
    await field.pressSequentially("Over in #rand");
    await expect(ada.page.getByRole("listbox").getByRole("option")).toHaveText(["#random"]);
    await field.press("Tab");
    await expect(ada.page.getByRole("listbox")).toBeHidden();
    await expect(field.getByText("#random", { exact: true })).toBeVisible();
    await underText(field, "Manage drafts").click();
    await saveAsDraft(ada).click();
    await expect(field).toHaveText("");

    // Renamed while the draft is put aside, which the sidebar shows once the page has heard.
    const renamed = unique("Rumpus");
    const response = await request.patch(`/api/rooms/${rooms.random.id}`, { data: { name: renamed }, headers: { Cookie: cookieHeader(session) } });
    expect(response.status(), await response.text()).toBe(200);
    await expect(ada.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: renamed, exact: true })).toBeVisible();
    await underText(field, "Manage drafts").click();
    await drafts(ada, "room").filter({ hasText: "Over in" }).click();
    await expect(field.getByText(`#${renamed}`, { exact: true })).toBeVisible();
    await expect(field).not.toContainText("#random");
  });

  test("is in + where the composer has no room for it beside Send, as in a narrow window", async ({ members, browserName }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1280, height: 800 } } });
    // A card narrower than its nine buttons and two lines, 326px, with Manage drafts.
    await ada.page.locator("form.composer").evaluate((form) => (form.style.inlineSize = "330px"));
    await ada.composer().fill("Narrow thought");
    await expect(underText(ada.composer(), "Manage drafts")).toBeHidden();
    // The clips keep their place, where the browser can record them.
    await expect(underText(ada.composer(), "Record video clip")).toBeVisible({ visible: recordsClips(browserName) });
    await underText(ada.composer(), "Attach").click();
    await expect(drafts(ada, "room")).toHaveText(["Narrow thought"]);
    await saveAsDraft(ada).click();
    await expect(ada.composer()).toHaveText("");
    await expect(ada.composer()).toBeFocused();

    await underText(ada.composer(), "Attach").click();
    await expect(drafts(ada, "room")).toHaveText(["Narrow thought"]);
    expect(await ticks(drafts(ada, "room"))).toEqual([false]);
    await drafts(ada, "room").click();
    await expect(ada.composer()).toHaveText("Narrow thought");
  });
});
