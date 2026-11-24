import type { Locator } from "@playwright/test";
import { editorField } from "../../fixtures";
import { expect, test, type Member } from "./fixtures";

// Slack's Schedule for later, the chevron joined to Send: its menu's times and Custom time, the line over the
// composer that counts what you have scheduled there, and its list, from which a message is edited,
// rescheduled, sent now or deleted. The room sends one as its writer's once it's due, which the worker's
// tests wait for.

const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("Not visible");
  return rect;
};

/** The composer whose text box is `field`. */
const composerOf = (field: Locator) => field.locator("xpath=ancestor::form[1]");

/** A button under the text of the composer whose text box is `field`, by its name, found while a menu over the page hides it from the rest too. */
const underText = (field: Locator, name: string) => composerOf(field).getByRole("button", { name, exact: true, includeHidden: true });

/** The line over the composer whose text box is `field`, counting what's scheduled there. */
const scheduledLine = (field: Locator) => composerOf(field).getByRole("button", { name: /scheduled messages? in /, includeHidden: true });

const menuItem = (member: Member, name: string) => member.page.getByRole("menu").getByRole("menuitem", { name, exact: true });
const scheduledList = (member: Member) => member.page.getByRole("dialog", { name: "Scheduled messages" });

/** The thread open beside the room, and its composer's text box. */
const threadOf = (member: Member) => member.page.getByRole("complementary", { name: "Thread" });
const replyBox = (member: Member) => editorField(threadOf(member), "Write a reply");

test.describe("Schedule for later", () => {
  test("schedules what's written for one of Slack's times, counts it over the composer, and sends it now, as its writer's, for everyone", async ({ members, rooms }) => {
    const grace = await members.signIn("Grace");
    const ada = await members.signIn("Ada");
    const field = ada.composer();
    const chevron = underText(field, "Schedule for later");
    // Joined to Send, as Slack's is, and grey until something's written.
    await expect(chevron).toBeDisabled();
    const [send, joined] = [await box(underText(field, "Send Message")), await box(chevron)];
    expect([joined.x, joined.y, joined.height]).toEqual([send.x + send.width, send.y, send.height]);
    await field.fill("Standup moves to 10");
    await chevron.hover();
    await expect(ada.page.getByRole("tooltip", { name: "Schedule for later", exact: true })).toBeVisible();
    await chevron.click();
    await expect(ada.page.getByRole("menu").getByText("Schedule message", { exact: true })).toBeVisible();
    await expect(menuItem(ada, "Tomorrow at 9:00 AM")).toBeVisible();
    await expect(menuItem(ada, "Custom time")).toBeVisible();
    await menuItem(ada, "Tomorrow at 9:00 AM").click();

    await expect(ada.page.getByRole("alert").filter({ hasText: "Your message will be sent tomorrow at 9:00 AM." })).toBeVisible();
    await expect(field).toHaveText("");
    await expect(field).toBeFocused();
    await expect(scheduledLine(field)).toHaveText(`1 scheduled message in #${rooms.general.name}`);
    // It's Ada's alone, and nothing's been sent.
    await expect(scheduledLine(grace.composer())).toHaveCount(0);
    await expect(ada.page.getByRole("article")).toHaveCount(0);
    await expect(grace.page.getByRole("article")).toHaveCount(0);

    // The room keeps it, and lists it as the page loads again.
    await ada.page.reload();
    await scheduledLine(ada.composer()).click();
    const list = scheduledList(ada);
    await expect(list.getByRole("listitem")).toHaveText([/^Scheduled for tomorrow at 9:00 AMStandup moves to 10/]);
    await list.getByRole("button", { name: "Send now" }).click();
    await expect(list).toContainText(`You have nothing scheduled in #${rooms.general.name}.`);
    await expect(grace.message("Standup moves to 10")).toContainText("Ada");
    await list.getByRole("button", { name: "Close" }).click();
    await expect(ada.message("Standup moves to 10")).toBeVisible();
    await expect(scheduledLine(ada.composer())).toHaveCount(0);
    await expect(ada.composer()).toBeFocused();
  });

  test("picks a custom time, then edits, reschedules and deletes what's scheduled", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    const field = ada.composer();
    await field.fill("Retro notes");
    await underText(field, "Schedule for later").click();
    await menuItem(ada, "Custom time").click();
    const custom = ada.page.getByRole("dialog", { name: "Schedule message" });
    await expect(custom).toContainText(/Time zone: \S/);
    const day = custom.getByRole("combobox", { name: "Date" });
    await expect(day).toBeFocused();
    await day.selectOption({ label: "Tomorrow" });
    await custom.getByRole("combobox", { name: "Time" }).selectOption({ label: "2:30 PM" });
    await custom.getByRole("button", { name: "Schedule Message" }).click();
    await expect(custom).toBeHidden();
    await expect(field).toHaveText("");
    await expect(field).toBeFocused();

    await scheduledLine(field).click();
    const list = scheduledList(ada);
    const item = list.getByRole("listitem");
    await expect(item).toContainText("Scheduled for tomorrow at 2:30 PMRetro notes");

    await item.getByRole("button", { name: "Edit" }).click();
    const editor = editorField(list, "Edit message");
    await expect(editor).toBeFocused();
    // The cursor is after the text.
    await ada.page.keyboard.type(" and actions");
    await editor.press("ControlOrMeta+Enter");
    await expect(editor).toHaveCount(0);
    await expect(item).toContainText("Retro notes and actions");
    // Escape puts the editor away, rather than the list.
    await item.getByRole("button", { name: "Edit" }).click();
    await expect(editor).toBeFocused();
    await editor.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(item.getByRole("button", { name: "Edit" })).toBeFocused();

    await item.getByRole("button", { name: "Reschedule" }).click();
    await menuItem(ada, "Tomorrow at 9:00 AM").click();
    await expect(item).toContainText("Scheduled for tomorrow at 9:00 AM");

    ada.page.once("dialog", (dialog) => void dialog.accept());
    await item.getByRole("button", { name: "Delete" }).click();
    await expect(list).toContainText(`You have nothing scheduled in #${rooms.general.name}.`);
    await ada.page.keyboard.press("Escape");
    await expect(scheduledLine(field)).toHaveCount(0);
    await expect(field).toBeFocused();
    await expect(ada.page.getByRole("article")).toHaveCount(0);
  });

  test("schedules a reply in a thread, to the room too while Also send is ticked, counting it in the thread's line rather than the room's", async ({ members, participant }) => {
    await (await participant("Grace")).say("Plans for Friday?");
    const ada = await members.signIn("Ada");
    await (await ada.actions("Plans for Friday?")).getByRole("link", { name: "Reply in thread" }).click();
    await expect(replyBox(ada)).toBeFocused();
    await replyBox(ada).fill("Pizza at noon");
    const alsoSend = threadOf(ada).getByRole("checkbox", { name: /^Also send to #/ });
    await alsoSend.check();
    const chevron = underText(replyBox(ada), "Schedule for later");
    // The thread's buttons keep to one line beside the room, the chevron among them.
    expect((await box(chevron)).y).toBe((await box(underText(replyBox(ada), "Attach"))).y);
    await chevron.click();
    await menuItem(ada, "Tomorrow at 9:00 AM").click();
    await expect(replyBox(ada)).toHaveText("");
    await expect(alsoSend).not.toBeChecked();
    await expect(scheduledLine(replyBox(ada))).toHaveText("1 scheduled message in this thread");
    await expect(scheduledLine(ada.composer())).toHaveCount(0);

    await scheduledLine(replyBox(ada)).click();
    await scheduledList(ada).getByRole("button", { name: "Send now" }).click();
    await scheduledList(ada).getByRole("button", { name: "Close" }).click();
    await expect(threadOf(ada).getByRole("article").filter({ hasText: "Pizza at noon" })).toBeVisible();
    await expect(ada.timeline().getByRole("article").filter({ hasText: "Pizza at noon" })).toBeVisible();
    await expect(scheduledLine(replyBox(ada))).toHaveCount(0);
  });

  test("offers the times in + where the row has no room for the chevron, once something's written: in a narrow composer, and on a phone", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1280, height: 800 } } });
    const field = ada.composer();
    await expect(underText(field, "Schedule for later")).toBeVisible();
    // A card narrower than its nine buttons, its two lines and the chevron, 346px.
    await ada.page.locator("form.composer").evaluate((form) => (form.style.inlineSize = "320px"));
    await expect(underText(field, "Schedule for later")).toBeHidden();
    const [attach, send] = [await box(underText(field, "Attach")), await box(underText(field, "Send Message"))];
    expect(send.y).toBe(attach.y);
    await underText(field, "Attach").click();
    await expect(ada.page.getByRole("menu")).not.toContainText("Schedule message");
    await ada.page.keyboard.press("Escape");
    await expect(ada.page.getByRole("menu")).toHaveCount(0);

    await field.fill("Narrow plan");
    await underText(field, "Attach").click();
    await expect(ada.page.getByRole("menu").getByText("Schedule message", { exact: true })).toBeVisible();
    await menuItem(ada, "Tomorrow at 9:00 AM").click();
    await expect(field).toHaveText("");
    await expect(scheduledLine(field)).toBeVisible();

    const grace = await members.signIn("Grace", { context: phone });
    await expect(underText(grace.composer(), "Schedule for later")).toBeHidden();
    await grace.composer().fill("Phone plan");
    await underText(grace.composer(), "Attach").tap();
    await menuItem(grace, "Custom time").tap();
    const custom = grace.page.getByRole("dialog", { name: "Schedule message" });
    await expect(custom).toBeVisible();
    const fits = await box(custom);
    expect(fits.x).toBeGreaterThanOrEqual(0);
    expect(fits.x + fits.width).toBeLessThanOrEqual(phone.viewport.width);
    // Big enough for a fingertip.
    for (const control of [custom.getByRole("combobox", { name: "Date" }), custom.getByRole("button", { name: "Schedule Message" })]) expect((await box(control)).height).toBeGreaterThanOrEqual(44);
    await custom.getByRole("button", { name: "Schedule Message" }).tap();
    await expect(scheduledLine(grace.composer())).toBeVisible();
    expect((await box(scheduledLine(grace.composer()))).height).toBeGreaterThanOrEqual(44);
  });
});
