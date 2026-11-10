import { administratorOn, editorField } from "../../fixtures";
import { expect, test, type Member } from "./fixtures";

/** The thread open beside the room. */
const threadOf = (member: Member) => member.page.getByRole("complementary", { name: "Thread" });
/** The message in the open thread that says `text`. */
const inThread = (member: Member, text: string) => threadOf(member).getByRole("article").filter({ hasText: text });
/** The message in the room that says `text`, leaving out the open thread's. */
const inRoom = (member: Member, text: string) => member.timeline().getByRole("article").filter({ hasText: text });
const replyBox = (member: Member) => editorField(threadOf(member), "Write a reply");
/** The summary under a message with replies, which opens its thread. */
const repliesTo = (message: ReturnType<typeof inRoom>, count: number) => message.getByRole("link", { name: new RegExp(`^${count} repl(y|ies)\\b`) });

test.describe("Reply in a thread", () => {
  test("replies beside the room, whose message says how many replies it has, for everyone, and opens its thread from there", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await grace.send("Who has the keys?");
    await (await ada.actions("Who has the keys?")).getByRole("link", { name: "Reply in thread" }).click();
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}/threads/[^/@]+$`));
    await expect(threadOf(ada).getByRole("heading", { name: "Thread" })).toBeVisible();
    await expect(inThread(ada, "Who has the keys?")).toBeVisible();
    await expect(replyBox(ada)).toBeFocused();

    await replyBox(ada).fill("In the cupboard");
    await replyBox(ada).press("Enter");
    await expect(inThread(ada, "In the cupboard")).toBeVisible();
    await expect(threadOf(ada)).toContainText("1 reply");
    // A reply only in the thread stays out of the room.
    for (const member of [ada, grace]) {
      await expect(repliesTo(inRoom(member, "Who has the keys?"), 1)).toBeVisible();
      await expect(inRoom(member, "In the cupboard")).toHaveCount(0);
    }

    await repliesTo(inRoom(grace, "Who has the keys?"), 1).click();
    await expect(inThread(grace, "In the cupboard")).toBeVisible();
    await threadOf(grace).getByRole("link", { name: "Close thread" }).click();
    await expect(threadOf(grace)).toHaveCount(0);
    await expect(grace.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}$`));
  });

  test("also sends a reply to the room when asked, saying so in the thread, and the room's copy opens the thread at it", async ({ members, participant, rooms }) => {
    await (await participant("Grace")).say("Ship it Thursday?");
    const ada = await members.signIn("Ada");
    await (await ada.actions("Ship it Thursday?")).getByRole("link", { name: "Reply in thread" }).click();
    const alsoSend = threadOf(ada).getByRole("checkbox", { name: `Also send to #${rooms.general.name}` });
    await alsoSend.check();
    await replyBox(ada).fill("Thursday it is");
    await replyBox(ada).press("Enter");
    await expect(inThread(ada, "Thursday it is")).toContainText(`Also sent to #${rooms.general.name}`);
    // It's ticked for one reply at a time.
    await expect(alsoSend).not.toBeChecked();

    const copy = inRoom(ada, "Thursday it is");
    await expect(copy).toContainText("replied to a thread: Ship it Thursday?");
    await expect(repliesTo(inRoom(ada, "Ship it Thursday?"), 1)).toBeVisible();
    await threadOf(ada).getByRole("link", { name: "Close thread" }).click();
    await copy.getByRole("link", { name: "Ship it Thursday?" }).click();
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}/threads/[^/@]+/@[^/]+$`));
    await expect(inThread(ada, "Thursday it is")).toBeVisible();
  });

  test("opens a reply's link in its thread, at the reply, paging back to it when it's older than the newest", async ({ members, participant, rooms }) => {
    const grace = await participant("Grace");
    const parent = await grace.say("A long thread");
    const replies = [];
    for (let i = 1; i <= 45; i++) replies.push(await grace.reply(parent.id, `Answer number ${i}.`));
    const ada = await members.signIn("Ada", { path: `/rooms/${rooms.general.id}/threads/${parent.id}/@${replies[0]!.id}` });
    await expect(inThread(ada, "Answer number 1.")).toBeInViewport();
    await expect(inThread(ada, "Answer number 45.")).not.toBeInViewport();
    await expect(inRoom(ada, "Answer number")).toHaveCount(0);
  });
});

test.describe("Delete a message with replies", () => {
  test("keeps its place for its replies, saying it was deleted, with its thread's summary", async ({ browser, baseURL, members, participant, rooms }) => {
    const grace = await participant("Grace");
    const parent = await grace.say("Plans for Friday");
    await grace.reply(parent.id, "Pizza");
    const ada = await members.signIn("Ada");
    await expect(repliesTo(inRoom(ada, "Plans for Friday"), 1)).toBeVisible();

    const administrator = await administratorOn(browser, baseURL!, rooms.general);
    const message = administrator.getByRole("article").filter({ hasText: "Plans for Friday" });
    await message.hover();
    await message.getByRole("button", { name: "Message options" }).click();
    administrator.once("dialog", (dialog) => void dialog.accept());
    await message.getByRole("group", { name: "More actions" }).getByRole("button", { name: "Delete message" }).click();

    const deleted = inRoom(ada, "This message was deleted.");
    await expect(repliesTo(deleted, 1)).toBeVisible();
    await expect(inRoom(ada, "Plans for Friday")).toHaveCount(0);
    await repliesTo(deleted, 1).click();
    await expect(inThread(ada, "Pizza")).toBeVisible();
    await expect(inThread(ada, "This message was deleted.")).toBeVisible();
    await administrator.context().close();
  });
});
