import type { Locator } from "@playwright/test";
import { ROOM_SOCKET } from "../../fixtures";
import { expect, paste, test, type Member } from "./fixtures";

const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const box = async (locator: Locator) => {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("Not visible");
  return rect;
};

/** The composer's card, around the text and its buttons. */
const card = (member: Member) => member.page.locator("form.composer > div:has([role=textbox])");

/** Formatting options, which screen readers call "Rich text". */
const formattingOptions = (member: Member) => member.page.getByRole("button", { name: "Rich text" });

/** Lexxy's formatting toolbar in the composer. */
const toolbar = (member: Member) => member.page.locator("form.composer lexxy-toolbar");

/** A button of the formatting toolbar, by its title. */
const tool = (member: Member, name: string) => toolbar(member).getByRole("button", { name, exact: true });

/** Replaces what's in the composer with `markup`, as Lexxy holds what's typed. */
const write = (member: Member, markup: string) =>
  member.composer().evaluate((content, markup) => {
    (content.closest("lexxy-editor") as HTMLElement & { value: string }).value = markup;
  }, markup);

/** Opens another of the test's rooms from the sidebar. */
async function openRoom(member: Member, name: string) {
  await member.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: new RegExp(name) }).click();
  await expect(member.page.getByRole("heading", { level: 1 })).toHaveText(name);
  await member.connected();
}

test.describe("Composer", () => {
  test("is a card at least 108px tall, with the text on top and Attach files, Formatting options and a round Send button below", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1280, height: 800 } } });
    const field = ada.composer();
    const send = ada.page.getByRole("button", { name: "Send Message" });
    const attachFiles = ada.page.locator("label").filter({ has: ada.page.getByLabel("Attach a file") });
    await expect(field).toHaveAttribute("placeholder", "Message #general");
    await expect(attachFiles).toHaveAttribute("title", "Attach files");
    await expect(formattingOptions(ada)).toHaveAttribute("title", "Formatting options");
    await expect(send).toHaveAttribute("title", "Send message");

    expect((await box(card(ada))).height).toBeGreaterThanOrEqual(108);
    await expect(card(ada)).toHaveCSS("border-top-left-radius", "12px");
    const fieldBox = await box(field);
    const sendBox = await box(send);
    expect(sendBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height);
    expect((await box(formattingOptions(ada))).y).toBe(sendBox.y);
    expect((await box(attachFiles)).y).toBe(sendBox.y);
    expect((await box(attachFiles)).x).toBeLessThan((await box(formattingOptions(ada))).x);
    expect(sendBox.width).toBe(sendBox.height);
    expect(parseFloat(await send.evaluate((el) => getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThanOrEqual(sendBox.width / 2);
  });

  test("is focused as the room opens", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await expect(ada.composer()).toBeFocused();
  });

  test("loads the editor once the room's messages are in, so its code doesn't hold them up", async ({ members }) => {
    let answeredAt = Number.POSITIVE_INFINITY;
    let editorRequestedAt = Number.NEGATIVE_INFINITY;
    const ada = await members.signIn("Ada", {
      beforeOpen: async (page) => {
        page.on("request", (request) => {
          if (/\/assets\/rich-text-editor-[\w-]+\.js$/.test(request.url())) editorRequestedAt = Date.now();
        });
        await page.routeWebSocket(ROOM_SOCKET, (ws) => {
          const room = ws.connectToServer();
          let frames = Promise.resolve();
          room.onMessage((frame) => {
            frames = frames.then(async () => {
              // The room's first answer, its welcome, comes a second late, long enough for an editor that didn't wait to load first.
              if (answeredAt === Number.POSITIVE_INFINITY) {
                await new Promise((resolve) => setTimeout(resolve, 1_000));
                answeredAt = Date.now();
              }
              ws.send(frame);
            });
          });
        });
      },
    });
    await expect(ada.composer()).toBeVisible();
    expect(editorRequestedAt).toBeGreaterThanOrEqual(answeredAt);
  });

  test("grows with the text up to a third of the window", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1280, height: 800 } } });
    const field = ada.composer();
    // The text box takes the card's padding, around the room for the text.
    const room = () => field.evaluate((el) => el.clientHeight - parseFloat(getComputedStyle(el).paddingTop) - parseFloat(getComputedStyle(el).paddingBottom));
    const empty = await room();
    await write(ada, "<p>A line</p>".repeat(3));
    expect(await room()).toBeGreaterThan(empty);
    // min(32dvh, 300px) of an 800px window
    await write(ada, "<p>A line</p>".repeat(40));
    expect(await room()).toBe(256);
  });

  test("takes a tap anywhere above its buttons in the text", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: phone });
    const cardBox = await box(card(ada));
    const sendBox = await box(ada.page.getByRole("button", { name: "Send Message" }));
    await ada.page.touchscreen.tap(cardBox.x + 2, cardBox.y + 2);
    await expect(ada.composer()).toBeFocused();
    await ada.composer().blur();
    await ada.page.touchscreen.tap(cardBox.x + cardBox.width - 2, sendBox.y - 1);
    await expect(ada.composer()).toBeFocused();
  });

  test("is at least 100px tall on phones", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: phone });
    expect((await box(card(ada))).height).toBeGreaterThanOrEqual(100);
  });
});

test.describe("Formatting toolbar", () => {
  test("Formatting options shows Lexxy's toolbar under the text, without the tools Campfire leaves out", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await expect(toolbar(ada)).toBeHidden();
    await formattingOptions(ada).click();
    await expect(formattingOptions(ada)).toHaveAttribute("aria-pressed", "true");
    await expect(toolbar(ada)).toBeVisible();
    await expect(ada.composer()).toBeFocused();
    expect((await box(toolbar(ada))).y).toBeGreaterThanOrEqual((await box(ada.composer())).y + (await box(ada.composer())).height);
    await expect(toolbar(ada).getByRole("button", { name: "Bold" })).toBeVisible();
    for (const name of ["Underline", "Color highlight", "Insert a table", "Insert a divider", "Undo", "Redo"]) {
      await expect(toolbar(ada).getByRole("button", { name, exact: true })).toBeHidden();
    }

    await formattingOptions(ada).click();
    await expect(toolbar(ada)).toBeHidden();
  });

  test("formats what's selected with each of its tools, and sends the formatting", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const tools = [
      ["Bold", "strong"],
      ["Italic", "em"],
      ["Strikethrough", "s"],
      ["Quote", "blockquote"],
      ["Code", "code"],
      ["Bullet list", "ul > li"],
      ["Numbered list", "ol > li"],
    ] as const;
    for (const [name, element] of tools) {
      await formattingOptions(ada).click();
      await ada.composer().fill(`${name} text`);
      await ada.composer().press("ControlOrMeta+a");
      await tool(ada, name).click();
      await expect(tool(ada, name)).toHaveAttribute("aria-pressed", "true");
      await ada.composer().press("ControlOrMeta+Enter");
      await expect(grace.message(`${name} text`).locator(`.message-content ${element}`)).toHaveText(`${name} text`);
    }

    // Code marks words selected on one line as code, and otherwise makes a code block of the line.
    await formattingOptions(ada).click();
    await ada.composer().fill("Block of code");
    await tool(ada, "Code").click();
    await ada.composer().press("ControlOrMeta+Enter");
    await expect(grace.message("Block of code").locator(".message-content pre")).toHaveText("Block of code");
  });

  test("leaves no formatting on for the next message", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await formattingOptions(ada).click();
    await ada.composer().fill("Loud");
    await ada.composer().press("ControlOrMeta+a");
    await tool(ada, "Bold").click();
    await ada.composer().press("ControlOrMeta+Enter");
    await expect(grace.message("Loud").locator(".message-content strong")).toHaveText("Loud");

    await formattingOptions(ada).click();
    await expect(tool(ada, "Bold")).toHaveAttribute("aria-pressed", "false");
    await ada.composer().pressSequentially("Quiet");
    await ada.composer().press("ControlOrMeta+Enter");
    await expect(grace.message("Quiet").locator(".message-content")).toHaveText("Quiet");
    await expect(grace.message("Quiet").locator(".message-content strong")).toHaveCount(0);
  });

  test("offers Normal, Large Heading and Clear formatting under Text formatting, in a menu that opens upward", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await formattingOptions(ada).click();
    await ada.composer().fill("Big news");
    await tool(ada, "Text formatting").click();
    const menu = toolbar(ada).getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText(["Normal", "Large Heading", "Clear formatting"]);
    const menuBox = await box(menu);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual((await box(tool(ada, "Text formatting"))).y);
    await menu.getByRole("menuitem", { name: "Large Heading" }).click();
    await expect(ada.composer().locator("h1")).toHaveText("Big news");

    await tool(ada, "Text formatting").click();
    await menu.getByRole("menuitem", { name: "Normal" }).click();
    await expect(ada.composer().locator("p")).toHaveText("Big news");

    await ada.composer().press("ControlOrMeta+a");
    await tool(ada, "Bold").click();
    await tool(ada, "Italic").click();
    await expect(ada.composer().locator("strong")).toHaveText("Big news");
    await tool(ada, "Text formatting").click();
    await menu.getByRole("menuitem", { name: "Clear formatting" }).click();
    await expect(ada.composer().locator("strong, em")).toHaveCount(0);

    await tool(ada, "Text formatting").click();
    await menu.getByRole("menuitem", { name: "Large Heading" }).click();
    await ada.composer().press("ControlOrMeta+Enter");
    await expect(grace.message("Big news").locator(".message-content h1")).toHaveText("Big news");
  });

  test("links what's selected to the address given in Link, and Unlink takes the link off", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await formattingOptions(ada).click();
    await ada.composer().fill("Ember");
    await ada.composer().press("ControlOrMeta+a");
    await tool(ada, "Link").click();
    const field = toolbar(ada).getByRole("dialog", { name: "Link" });
    const address = field.getByPlaceholder("Enter a URL…");
    await expect(address).toBeFocused();
    await address.fill("https://example.com/");
    await field.getByRole("button", { name: "Link", exact: true }).click();
    await expect(ada.composer().getByRole("link", { name: "Ember" })).toHaveAttribute("href", "https://example.com/");

    await tool(ada, "Link").click();
    await expect(address).toHaveValue("https://example.com/");
    await field.getByRole("button", { name: "Unlink" }).click();
    await expect(ada.composer().getByRole("link")).toHaveCount(0);

    // An address has to be a URL.
    await ada.composer().press("ControlOrMeta+a");
    await tool(ada, "Link").click();
    await address.fill("example.com");
    await address.press("Enter");
    await expect(address).toBeFocused();
    await address.fill("https://example.com/");
    await address.press("Enter");
    await ada.composer().press("ControlOrMeta+Enter");
    await expect(grace.message("Ember").getByRole("link", { name: "Ember" })).toHaveAttribute("href", "https://example.com/");
  });

  test("shows the toolbar with its Link field on Ctrl or Cmd+K, and shuts it again as the field closes", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().fill("Ember");
    await ada.composer().press("ControlOrMeta+a");
    await ada.composer().press("ControlOrMeta+k");
    const address = toolbar(ada).getByPlaceholder("Enter a URL…");
    await expect(address).toBeVisible();
    await expect(address).toBeFocused();
    await address.press("Escape");
    await expect(toolbar(ada)).toBeHidden();
    await expect(ada.composer()).toBeFocused();

    await ada.composer().press("ControlOrMeta+a");
    await ada.composer().press("ControlOrMeta+k");
    await address.fill("https://example.com/");
    await address.press("Enter");
    await expect(toolbar(ada)).toBeHidden();
    await expect(ada.composer()).toBeFocused();
    // Enter sends again, as it does while the toolbar is shut.
    await ada.composer().press("Enter");
    await expect(grace.message("Ember").getByRole("link", { name: "Ember" })).toHaveAttribute("href", "https://example.com/");

    // Opened by Formatting options, the toolbar stays.
    await formattingOptions(ada).click();
    await ada.composer().press("ControlOrMeta+k");
    await expect(address).toBeFocused();
    await address.press("Escape");
    await expect(toolbar(ada)).toBeVisible();
  });

  test("formats Markdown as it's typed, and Ctrl or Cmd+B, I and U", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const blocks = [
      ["# Heading", "h1", "Heading"],
      ["## Subheading", "h2", "Subheading"],
      ["> Quoted", "blockquote", "Quoted"],
      ["- Bulleted", "ul > li", "Bulleted"],
      ["1. Numbered", "ol > li", "Numbered"],
      ["```js let x = 1", "pre[data-language=js]", "let x = 1"],
    ] as const;
    for (const [typed, element, text] of blocks) {
      await ada.composer().pressSequentially(typed);
      await ada.composer().press("Enter");
      await expect(grace.message(text).locator(`.message-content ${element}`)).toHaveText(text);
    }

    await ada.composer().pressSequentially("Some `code`, ~~struck~~ and [linked](https://example.com/) text");
    await ada.composer().press("Enter");
    const inline = grace.message("Some code").locator(".message-content");
    await expect(inline.locator("code")).toHaveText("code");
    await expect(inline.locator("s")).toHaveText("struck");
    await expect(inline.getByRole("link", { name: "linked" })).toHaveAttribute("href", "https://example.com/");

    for (const [key, element] of [
      ["b", "strong"],
      ["i", "em"],
      ["u", "u"],
    ] as const) {
      await ada.composer().fill(`Pressed ${key}`);
      await ada.composer().press("ControlOrMeta+a");
      await ada.composer().press(`ControlOrMeta+${key}`);
      await ada.composer().press("Enter");
      await expect(grace.message(`Pressed ${key}`).locator(`.message-content ${element}`)).toHaveText(`Pressed ${key}`);
    }

    // A divider starts a paragraph, where Enter, which sends while the toolbar's shut, can't take you.
    await formattingOptions(ada).click();
    await ada.composer().pressSequentially("Above");
    await ada.composer().press("Enter");
    await ada.composer().pressSequentially("--- Below");
    await ada.composer().press("ControlOrMeta+Enter");
    await expect(grace.message("Above").locator(".message-content > *")).toHaveText(["Above", "", "Below"]);
    await expect(grace.message("Above").locator(".message-content hr")).toHaveCount(1);
  });

  test("fits on one row on the narrowest screen, and wraps rather than hiding any under Show more where it can't", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { ...phone, viewport: { width: 320, height: 568 } } });
    await formattingOptions(ada).tap();
    const showMore = toolbar(ada).getByRole("button", { name: "Show more toolbar buttons" });
    expect((await box(tool(ada, "Numbered list"))).y).toBe((await box(tool(ada, "Bold"))).y);
    await expect(showMore).toBeHidden();

    // Narrower than a page lets it be, since nothing is under 320px wide.
    await ada.page.locator("form.composer").evaluate((form) => (form.style.inlineSize = "200px"));
    await expect.poll(async () => (await box(tool(ada, "Numbered list"))).y).toBeGreaterThan((await box(tool(ada, "Bold"))).y);
    await expect(showMore).toBeHidden();
  });
});

test.describe("Pasting into the composer", () => {
  test("pastes an address as a link, and over selected text, links the text to it", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await paste(ada, "https://example.com/article");
    await expect(ada.composer().getByRole("link", { name: "https://example.com/article" })).toHaveAttribute("href", "https://example.com/article");

    await ada.composer().press("ControlOrMeta+a");
    await ada.composer().press("Delete");
    await ada.composer().pressSequentially("Ember");
    await ada.composer().press("ControlOrMeta+a");
    await paste(ada, "https://example.com/");
    await expect(ada.composer()).toHaveText("Ember");
    await ada.composer().press("Enter");
    await expect(grace.message("Ember").getByRole("link", { name: "Ember" })).toHaveAttribute("href", "https://example.com/");
  });

  test("converts pasted Markdown, keeping its line breaks, and pastes other text as it is", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await paste(ada, "**Bold** and _italic_\nsecond line\n\n- one\n- two");
    await expect(ada.composer().locator("strong")).toHaveText("Bold");
    await expect(ada.composer().locator("em")).toHaveText("italic");
    await expect(ada.composer().locator("li")).toHaveText(["one", "two"]);
    await ada.composer().press("Enter");
    const message = grace.message("Bold and italic").locator(".message-content");
    await expect(message.locator("p")).toHaveText("Bold and italic\nsecond line", { useInnerText: true });
    await expect(message.locator("p > br")).toHaveCount(1);
    await expect(message.locator("ul > li")).toHaveText(["one", "two"]);

    // Without Markdown, nothing is changed: not runs of spaces, nor backslashes.
    await paste(ada, "C:\\Users\\ada\\my  notes.txt");
    await ada.composer().press("Enter");
    await expect(grace.message("notes.txt")).toBeVisible();
    expect(await grace.message("notes.txt").locator(".message-content").textContent()).toBe("C:\\Users\\ada\\my  notes.txt");
  });

  test("keeps text pasted into a code block as it is", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().pressSequentially("```");
    await ada.composer().press("Space");
    await paste(ada, "**not bold**\n  indented");
    await ada.composer().press("Enter");
    const code = grace.message("not bold").locator(".message-content pre");
    await expect(code).toBeVisible();
    expect(await code.innerText()).toBe("**not bold**\n  indented");
  });

  test("keeps pasted formatting, tables included", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await paste(ada, "Name Points\nJason 10", "<table><tr><th>Name</th><th>Points</th></tr><tr><td>Jason</td><td>10</td></tr></table>");
    await expect(ada.composer().locator("table")).toBeVisible();
    await ada.composer().press("Enter");
    const table = grace.message("Jason").locator(".message-content table");
    await expect(table.locator("th")).toHaveText(["Name", "Points"]);
    await expect(table.locator("td")).toHaveText(["Jason", "10"]);

    await paste(ada, "Bold, struck and linked", '<p><b>Bold</b>, <s>struck</s> and <a href="https://example.com/">linked</a></p>');
    await ada.composer().press("Enter");
    const formatted = grace.message("struck and linked").locator(".message-content");
    await expect(formatted.locator("strong")).toHaveText("Bold");
    await expect(formatted.locator("s")).toHaveText("struck");
    await expect(formatted.getByRole("link", { name: "linked" })).toHaveAttribute("href", "https://example.com/");
  });

  test("waits to send pasted files rather than putting them in the text", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("Look");
    await ada.composer().evaluate((content) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File([new Uint8Array([137, 80, 78, 71])], "screenshot.png", { type: "image/png" }));
      content.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await expect(ada.composer()).toHaveText("Look");
    await expect(ada.composer().locator("img, action-text-attachment, figure")).toHaveCount(0);
    await expect(ada.page.getByRole("button", { name: "Remove screenshot.png" })).toBeVisible();
  });
});

test.describe("Send from the keyboard", () => {
  test("sends on Enter, starts a new line on Shift+Enter and never sends a blank message", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().pressSequentially("   ");
    await ada.composer().press("Enter");

    await ada.composer().fill("First line");
    await ada.composer().press("Shift+Enter");
    await ada.composer().pressSequentially("second line");
    await expect(ada.composer()).toHaveText("First line\nsecond line", { useInnerText: true });
    await ada.composer().press("Enter");

    await expect(grace.message("First line")).toContainText("second line");
    await expect(grace.page.getByRole("article")).toHaveCount(1);
    await expect(ada.composer()).toHaveText("");
    await expect(ada.composer()).toBeFocused();
  });

  test("starts a new paragraph on Enter while the toolbar shows, and sends on Ctrl or Cmd+Enter, closing it", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await formattingOptions(ada).click();
    await ada.composer().pressSequentially("One");
    await ada.composer().press("Enter");
    await ada.composer().pressSequentially("Two");
    await expect(ada.composer().locator("p")).toHaveText(["One", "Two"]);
    await expect(ada.page.getByRole("article")).toHaveCount(0);

    await ada.composer().press("ControlOrMeta+Enter");
    await expect(ada.message("One").locator(".message-content p")).toHaveText(["One", "Two"]);
    await expect(toolbar(ada)).toBeHidden();
  });

  test("sends from the Send button with an address left unfinished in Link, or Link left open and empty", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const send = ada.page.getByRole("button", { name: "Send Message" });
    await formattingOptions(ada).click();
    await toolbar(ada).getByRole("button", { name: "Link" }).click();
    const address = toolbar(ada).getByPlaceholder("Enter a URL…");
    await address.fill("example.com");
    await address.press("Escape");
    // Lexxy keeps what was in the field, which isn't an address.
    expect(await address.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
    await ada.composer().fill("Never mind the link");
    await send.click();
    await expect(ada.message("Never mind the link")).toBeVisible();

    // Ctrl or Cmd+K opens Link, which wants an address.
    await ada.composer().fill("Linked nowhere");
    await ada.composer().press("ControlOrMeta+k");
    await send.click();
    await expect(ada.message("Linked nowhere")).toBeVisible();
  });

  test("says a message over 10,000 characters is too long instead of sending it, keeping it to be cut down", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await write(ada, `<p>${"x".repeat(10_001)}</p>`);
    await ada.composer().press("Enter");
    await expect(ada.page.getByRole("alert")).toHaveText("Messages can be up to 10,000 characters.");
    await expect(ada.composer()).toHaveText("x".repeat(10_001));
    await expect(ada.page.getByRole("article")).toHaveCount(0);
  });

  test("starts a new paragraph on Enter on a touch screen, where only the Send button sends", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: phone });
    await ada.composer().tap();
    await ada.page.keyboard.type("First line");
    await ada.page.keyboard.press("Enter");
    await ada.page.keyboard.type("second line");
    await expect(ada.composer().locator("p")).toHaveText(["First line", "second line"]);
    await expect(ada.page.getByRole("article")).toHaveCount(0);

    await ada.page.getByRole("button", { name: "Send Message" }).tap();
    await expect(ada.message("First line")).toContainText("second line");
    await expect(ada.composer()).toBeFocused();
  });
});

test.describe("Keep drafts", () => {
  test("keeps what's written in a room, formatting and all, until it's sent", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("Half a **thought** so far");
    await expect(ada.composer().locator("strong")).toHaveText("thought");

    await ada.page.reload();
    await ada.connected();
    await expect(ada.composer().locator("strong")).toHaveText("thought");
    await expect(ada.composer()).toBeFocused();
    // The cursor is after what was written.
    await ada.page.keyboard.type(" and more");
    await expect(ada.composer()).toHaveText("Half a thought so far and more");

    await ada.composer().press("Enter");
    await expect(ada.message("Half a thought so far and more").locator(".message-content strong")).toHaveText("thought");
    await ada.page.reload();
    await ada.connected();
    await expect(ada.composer()).toHaveText("");
  });

  test("keeps each room's to itself", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("For general");
    await openRoom(ada, "random");
    await expect(ada.composer()).toHaveText("");
    await ada.composer().pressSequentially("For random");

    await openRoom(ada, "general");
    await expect(ada.composer()).toHaveText("For general");
    await openRoom(ada, "random");
    await expect(ada.composer()).toHaveText("For random");
  });
});

test.describe("Rich text, safely", () => {
  test("sends the formatting Markdown makes as it's typed", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    await ada.composer().pressSequentially("Some **bold** and _italic_ text");
    await ada.composer().press("Enter");
    const text = grace.message("Some bold").locator(".message-content");
    await expect(text.locator("strong")).toHaveText("bold");
    await expect(text.locator("em")).toHaveText("italic");
  });

  test("sends what's typed as text, never as markup", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.composer().pressSequentially("<b>1</b> < 2 & 3");
    await ada.composer().press("Enter");
    await expect(ada.message("<b>1</b> < 2 & 3")).toBeVisible();
    await expect(ada.message("< 2 & 3").locator(".message-content b")).toHaveCount(0);
  });
});
