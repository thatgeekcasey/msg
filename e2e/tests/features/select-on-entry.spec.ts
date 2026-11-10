import type { Locator } from "@playwright/test";
import { signInAs } from "../../fixtures";
import { expect, test } from "./fixtures";

/** Whether `field` shows a cursor rather than a selection. */
const hasCursor = (field: Locator) => field.evaluate((input: HTMLInputElement | HTMLTextAreaElement) => input.selectionStart === input.selectionEnd);

test.describe("Select a field's text on entry", () => {
  test("selects what's in a field when it's entered, so typing replaces it, and a second click places the cursor", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Workspace" }).click();
    await ada.page.getByRole("link", { name: "Rooms and permissions" }).click();
    await ada.page.getByRole("link", { name: "New room" }).click();
    const name = ada.page.getByRole("textbox", { name: "Room name" });
    await expect(name).toBeFocused();
    await name.pressSequentially("Research");
    await expect(name, "typing replaces the initial room name").toHaveValue("Research");

    await ada.page.getByRole("heading", { level: 1, name: "New room" }).click();
    await name.click();
    await name.pressSequentially("Design");
    await expect(name, "entering a field again selects what's in it").toHaveValue("Design");

    await name.click();
    expect(await hasCursor(name)).toBe(true);
    await name.pressSequentially(" team");
    await expect(name, "a second click places the cursor").toHaveValue("Design team");
  });

  test("selects a field focused as the page opens", async ({ page, session }) => {
    await signInAs(page, session);
    await page.goto("/rooms/opens/new");
    const name = page.getByRole("textbox", { name: "Room name" });
    await expect(name).toBeFocused();
    await page.keyboard.type("Research");
    await expect(name).toHaveValue("Research");
  });

  test("keeps what a drag across a field selects", async ({ page, session }) => {
    await signInAs(page, session);
    await page.goto("/rooms/opens/new");
    const name = page.getByRole("textbox", { name: "Room name" });
    await name.fill("Design team");
    await page.getByRole("heading", { level: 1, name: "New room" }).click();
    const box = (await name.boundingBox())!;
    // From before the text to a few letters in.
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const selection = await name.evaluate((input: HTMLInputElement) => input.value.slice(input.selectionStart!, input.selectionEnd!));
    expect(selection.length).toBeGreaterThan(0);
    expect(selection).not.toBe("Design team");
  });

  test("never selects what's in the message box", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().fill("Hello");
    await ada.page.getByRole("heading", { level: 1 }).click();
    await ada.composer().click();
    expect(await ada.composer().evaluate(() => getSelection()!.isCollapsed)).toBe(true);
    await ada.page.keyboard.type(" there");
    await expect(ada.composer()).toHaveText("Hello there");
  });

  test("works on the sign-in page, signed out", async ({ page }) => {
    await page.goto("/session/new");
    const emailAddress = page.getByLabel("Email address");
    await emailAddress.fill("grace@example.com");
    await page.getByLabel("Password").click();
    await emailAddress.click();
    await page.keyboard.type("ada@example.com");
    await expect(emailAddress).toHaveValue("ada@example.com");
  });
});
