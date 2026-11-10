import type { Locator } from "@playwright/test";
import { expect, test, type Member } from "./fixtures";

/** The reactions under the message whose text includes `text`, as `member` sees them. */
const reactions = (member: Member, text: string) => member.message(text).getByRole("list", { name: "Reactions" });

/** Reacts to the message whose text includes `text` from its bar. */
async function react(member: Member, text: string, name: string) {
  await (await member.actions(text)).getByRole("button", { name }).click();
}

/** Opens New boost's form on the message whose text includes `text`, from its bar's tray, and returns its field. */
async function newBoost(member: Member, text: string): Promise<Locator> {
  const bar = await member.actions(text);
  await bar.getByRole("button", { name: "More reactions" }).click();
  await bar.getByRole("button", { name: "New boost" }).click();
  const field = member.message(text).getByRole("textbox", { name: "Custom reaction" });
  await expect(field).toBeFocused();
  return field;
}

test.describe("React to a message", () => {
  test("adds a quick reaction from the bar for everyone to see, with the avatar of who added it", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const text = "Ship it?";
    await ada.send(text);

    await react(grace, text, "Thumbs up");
    await expect(reactions(ada, text).getByRole("listitem")).toHaveText(["👍"]);
    await expect(reactions(ada, text).getByRole("img", { name: "Grace boosted 👍" })).toBeVisible();
    // Only your own reactions do anything.
    await expect(reactions(ada, text).getByRole("button")).toHaveCount(0);
    await expect(reactions(grace, text).getByRole("button", { name: "👍" })).toBeVisible();
  });

  test("adds the other reactions from the tray", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const text = "Party?";
    await ada.send(text);

    await (await grace.actions(text)).getByRole("button", { name: "More reactions" }).click();
    const tray = grace.message(text).getByRole("group", { name: "More reactions" });
    await expect(tray.getByRole("button")).toHaveText(["💪Muscle", "❤️Red heart", "😂Face with tears of joy", "🎉Party popper", "🔥Fire", "New boost"]);
    await tray.getByRole("button", { name: "Party popper" }).click();
    await expect(reactions(ada, text).getByRole("img", { name: "Grace boosted 🎉" })).toBeVisible();
  });

  test("lists each reaction on its own, oldest first, adding one you've added already only once", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const text = "Agreed?";
    await ada.send(text);
    await react(grace, text, "Clapping");
    await expect(reactions(ada, text).getByRole("listitem")).toHaveCount(1);
    await react(ada, text, "Clapping");

    const avatars = reactions(grace, text).getByRole("img");
    await expect(avatars).toHaveCount(2);
    await expect(avatars.nth(0)).toHaveAccessibleName("Grace boosted 👏");
    await expect(avatars.nth(1)).toHaveAccessibleName("Ada boosted 👏");

    // A second 👏 from Ada does nothing, so the 👍 after it is the third reaction.
    await react(ada, text, "Clapping");
    await react(ada, text, "Thumbs up");
    await expect(avatars.nth(2)).toHaveAccessibleName("Ada boosted 👍");
    await expect(avatars).toHaveCount(3);
  });

  test("opens the bar with More reactions from Add a boost, and Escape hands focus back to it", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1200, height: 900 } } });
    const text = "React from either control.";
    await ada.send(text);
    const message = ada.message(text);
    const add = message.getByRole("button", { name: "Add a boost" });
    const tray = message.getByRole("group", { name: "More reactions" });
    await expect(message).not.toHaveAttribute("aria-busy");
    await expect(add).toHaveCount(0);
    await react(ada, text, "Thumbs up");

    await ada.composer().hover();
    await add.focus();
    await ada.page.keyboard.press("Enter");
    await expect(tray.getByRole("button", { name: "Muscle" })).toBeFocused();
    await ada.page.keyboard.press("Escape");
    await expect(tray).toBeHidden();
    await expect(add).toBeFocused();

    await add.click();
    await tray.getByRole("button", { name: "Fire" }).click();
    await expect(reactions(ada, text).getByRole("button", { name: "🔥" })).toBeVisible();
    await expect(message.getByRole("button", { name: "Message options" })).toBeFocused();

    await add.click();
    await tray.getByRole("button", { name: "New boost" }).click();
    await expect(message.getByRole("textbox", { name: "Custom reaction" })).toBeFocused();
    await message.getByRole("button", { name: "Cancel" }).click();
    await add.click();
    await expect(tray).toBeVisible();
    await ada.page.getByRole("heading", { level: 1 }).click();
    await expect(tray).toBeHidden();
  });
});

test.describe("Custom reactions", () => {
  // The mobile suite checks the form's phone layouts.
  test("adds a reaction of your own from New boost, but not a blank one or one starting with a space", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1008, height: 797 } } });
    const grace = await members.signIn("Grace");
    await ada.send("First in this group.");
    const text = "A short follow-up.";
    await ada.send(text);

    const field = await newBoost(ada, text);
    await expect(field).toHaveAttribute("maxlength", "16");
    const submit = ada.message(text).getByRole("button", { name: "Add reaction" });
    // Add reaction shows once something's written, and Enter sends nothing blank.
    await expect(submit).toHaveCount(0);
    await field.press("Enter");
    expect(await field.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
    const asWideAsItsPlaceholder = (await field.boundingBox())!.width;
    await field.fill("  ");
    await field.press("Enter");
    expect(await field.evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(true);
    await field.fill("Lovely!");

    // The form is a one-line pill, its field as wide as what's written.
    const formBox = (await ada.message(text).locator("form").boundingBox())!;
    const fieldBox = (await field.boundingBox())!;
    const submitBox = (await submit.boundingBox())!;
    expect(formBox.height).toBeLessThanOrEqual(32);
    expect(fieldBox.width).toBeLessThan(asWideAsItsPlaceholder);
    expect(Math.abs(submitBox.y + submitBox.height / 2 - (fieldBox.y + fieldBox.height / 2))).toBeLessThanOrEqual(1);

    await submit.click();
    await expect(field).toHaveCount(0);
    await expect(reactions(grace, text).getByRole("img", { name: "Ada boosted Lovely!" })).toBeVisible();
    await expect(ada.message(text).getByRole("button", { name: "Message options" })).toBeFocused();
  });

  test("scrolls its form to the middle of the timeline as it opens, from the newest messages too", async ({ members, participant }) => {
    const archivist = await participant("Archivist");
    for (let n = 1; n <= 40; n++) await archivist.say(`Entry #${String(n).padStart(2, "0")}`);
    const ada = await members.signIn("Ada");
    // The room opens at its newest messages. The form's message is near the top of the view, so the form would
    // go up by however much it adds under the message, if the timeline stayed at the end.
    const [, entry] = await ada.inView(/Entry #\d+/);
    await newBoost(ada, entry!);
    await expect.poll(() => ada.offCentre(ada.message(entry!).locator("form"))).toBeLessThanOrEqual(1);
  });

  test("closes on Cancel or Escape, adding nothing", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const text = "Never mind.";
    await ada.send(text);

    await (await newBoost(ada, text)).fill("Hmm");
    await ada.message(text).getByRole("button", { name: "Cancel" }).click();
    await expect(ada.message(text).getByRole("textbox")).toHaveCount(0);
    await (await newBoost(ada, text)).press("Escape");
    await expect(ada.message(text).getByRole("textbox")).toHaveCount(0);
    await expect(ada.message(text).getByRole("button", { name: "Message options" })).toBeFocused();
    await expect(reactions(ada, text)).toHaveCount(0);
  });

  // After Campfire's "message update preserves the input state" and "boost by another user preserves
  // the input state" (boosting_messages_test.rb).
  test("keeps what's written as someone edits or reacts to the message", async ({ members }) => {
    const grace = await members.signIn("Grace");
    const ada = await members.signIn("Ada");
    const text = "Third time's a charm.";
    await grace.send(text);
    await (await newBoost(ada, text)).fill("Hey!");

    await (await grace.actions(text)).getByRole("button", { name: "Edit" }).click();
    await grace.editor().fill("Redacted!");
    await grace.editor().press("ControlOrMeta+Enter");
    await react(grace, "Redacted!", "Clapping");

    await expect(reactions(ada, "Redacted!").getByRole("img", { name: "Grace boosted 👏" })).toBeVisible();
    await expect(ada.message("Redacted!").getByRole("textbox", { name: "Custom reaction" })).toHaveValue("Hey!");
  });
});

test.describe("Take back a reaction", () => {
  // After Campfire's "deleting a boost" (boosting_messages_test.rb).
  test("takes back your own reaction from Delete this boost, for everyone", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const text = "Hmm";
    await ada.send(text);
    await react(grace, text, "Waving hand");
    await expect(reactions(ada, text).getByRole("img", { name: "Grace boosted 👋" })).toBeVisible();

    const mine = reactions(grace, text).getByRole("button", { name: "👋" });
    await expect(mine).toHaveAccessibleDescription("Press enter to delete this boost");
    await mine.click();
    const remove = reactions(grace, text).getByRole("button", { name: "Delete this boost" });
    await expect(remove).toBeFocused();
    await remove.click();
    await expect(reactions(ada, text)).toHaveCount(0);
    await expect(reactions(grace, text)).toHaveCount(0);
  });

  test("takes back your reaction from the keyboard, handing focus to Message options", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const text = "Keyboard only";
    await ada.send(text);
    await react(ada, text, "Thumbs up");

    await reactions(ada, text).getByRole("button", { name: "👍" }).focus();
    await ada.page.keyboard.press("Enter");
    await expect(reactions(ada, text).getByRole("button", { name: "Delete this boost" })).toBeFocused();
    await ada.page.keyboard.press("Enter");
    await expect(reactions(ada, text)).toHaveCount(0);
    await expect(ada.message(text).getByRole("button", { name: "Message options" })).toBeFocused();
  });
});
