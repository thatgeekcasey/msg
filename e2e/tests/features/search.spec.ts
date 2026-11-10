import type { Locator, Page } from "@playwright/test";
import { expect, startDirect, test } from "./fixtures";

/** A word in no other test's messages or searches, since every test shares the server and its open rooms. */
const uniqueWord = (word: string) => `${word}${crypto.randomUUID().slice(0, 8)}`;

const box = (page: Page) => page.getByRole("dialog", { name: "Search" });
const field = (page: Page) => box(page).getByRole("combobox", { name: "Search" });
const results = (page: Page) => page.getByRole("region", { name: "Search results" });
const cards = (page: Page) => results(page).getByRole("listitem");
const filters = (page: Page) => page.getByRole("group", { name: "Search filters" });
const railSearch = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Search", exact: true });

/** How many lines `elements` are laid out on, going by where each one's top is. */
const linesOf = (elements: Locator) => elements.evaluateAll((all) => new Set(all.map((element) => Math.round(element.getBoundingClientRect().top))).size);

/** The address of a search's results: its words, as typed, and then what `filters` adds. */
const searchAddress = (words: string, filters = "") => `/searches?q=${encodeURIComponent(words).replaceAll("%20", "+")}${filters}`;

/**
 * Searches for `words` from the search box, which Cmd+F or Ctrl+F opens in the room shown, or with the
 * results page's search, until `found` shows, since a message can be found only a moment after it's sent.
 */
async function searchUntil(page: Page, words: string, found: Locator) {
  await expect(async () => {
    await page.keyboard.press("ControlOrMeta+f");
    await field(page).fill(words);
    await field(page).press("Enter");
    await expect(box(page)).toBeHidden();
    await expect(found).toBeVisible({ timeout: 1_000 });
  }).toPass();
}

test.describe("Search messages", () => {
  test("finds a room's messages from Ctrl+F there, newest first, marking what matched, each linking to the message", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    const word = uniqueWord("zebra");
    for (const text of [`First ${word}`, `Second ${word}`]) {
      await ada.send(text);
      await expect(ada.message(text)).not.toHaveAttribute("aria-busy");
    }

    await ada.page.keyboard.press("ControlOrMeta+f");
    await expect(field(ada.page)).toBeFocused();
    await expect(box(ada.page).getByRole("button", { name: `Remove in:${rooms.general.name}` })).toBeVisible();
    await expect(box(ada.page).getByRole("button", { name: "In this room" })).toHaveAttribute("aria-pressed", "true");
    await field(ada.page).press("Escape");
    await expect(box(ada.page)).toBeHidden();

    await searchUntil(ada.page, word, cards(ada.page).nth(1));
    await expect(ada.page).toHaveURL(searchAddress(word, `&in=${rooms.general.id}`));
    await expect(ada.page).toHaveTitle("Search");
    await expect(cards(ada.page)).toHaveText([new RegExp(`Second ${word}`), new RegExp(`First ${word}`)]);
    await expect(results(ada.page).getByRole("heading", { level: 2 })).toHaveText("2 results");
    await expect(cards(ada.page).first().locator("mark[data-search-match]")).toHaveText(word);
    // Results can't be changed here: hovering shows no actions.
    await cards(ada.page).first().hover();
    await expect(ada.page.getByRole("group", { name: "Message actions" })).toBeHidden();

    await cards(ada.page).last().getByRole("link", { name: "View in room" }).click();
    await expect(ada.page).toHaveURL(new RegExp(`/rooms/${rooms.general.id}/@`));
    await expect(ada.message(`First ${word}`)).toBeInViewport();
  });

  test("searches everywhere from the rail, for the words typed, as its address says", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const [one, two] = [uniqueWord("analytical"), uniqueWord("engine")];
    await ada.send(`The ${one} ${two}`);
    await expect(ada.message(`The ${one} ${two}`)).not.toHaveAttribute("aria-busy");
    await expect(async () => {
      await railSearch(ada.page).click();
      await expect(box(ada.page).getByRole("button", { name: /^Remove / })).toHaveCount(0);
      await field(ada.page).fill(`${two},  ${one}!`);
      await field(ada.page).press("Enter");
      await expect(cards(ada.page)).toBeVisible({ timeout: 1_000 });
    }).toPass();
    // The address keeps the words as typed, their runs of spaces made one.
    await expect(ada.page).toHaveURL(`/searches?q=${two}%2C+${one}!`);
    await expect(cards(ada.page)).toContainText(`The ${one} ${two}`);

    // The address alone shows the search again, as a link or a reload does.
    await ada.page.reload();
    await expect(cards(ada.page)).toContainText(`The ${one} ${two}`);
  });

  test("narrows a search with the filters, as chips on the results page or modifiers typed in the box", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const word = uniqueWord("quokka");
    await grace.send(`Hers ${word} at https://example.com/${word}`);
    await expect(grace.message(`Hers ${word}`)).not.toHaveAttribute("aria-busy");
    await ada.send(`Mine ${word}`);
    await expect(ada.message(`Mine ${word}`)).not.toHaveAttribute("aria-busy");
    await searchUntil(ada.page, word, cards(ada.page).nth(1));

    await filters(ada.page).getByRole("button", { name: "From me" }).click();
    await expect(ada.page).toHaveURL(searchAddress(word, `&in=${rooms.general.id}&from=${ada.session.user.id}`));
    await expect(cards(ada.page)).toHaveText([new RegExp(`Mine ${word}`)]);
    await filters(ada.page).getByRole("button", { name: `Remove in:${rooms.general.name}` }).click();
    await expect(ada.page).toHaveURL(searchAddress(word, `&from=${ada.session.user.id}`));
    await expect(cards(ada.page)).toHaveText([new RegExp(`Mine ${word}`)]);

    // has: offers the filters it can name, and Enter takes the one picked as a token.
    await ada.page.keyboard.press("ControlOrMeta+f");
    await box(ada.page).getByRole("button", { name: "Remove from:Me" }).click();
    await field(ada.page).press("End");
    await field(ada.page).pressSequentially(" has:li");
    await expect(box(ada.page).getByRole("option", { name: "Has a link", selected: true })).toBeVisible();
    await field(ada.page).press("Enter");
    await expect(box(ada.page).getByRole("button", { name: "Remove Has a link" })).toBeVisible();
    await expect(field(ada.page)).toHaveValue(word);
    await field(ada.page).press("Enter");
    await expect(ada.page).toHaveURL(searchAddress(word, "&has=link"));
    await expect(cards(ada.page)).toHaveText([new RegExp(`Hers ${word}`)]);
    await expect(filters(ada.page).getByRole("button", { name: "Has a link" })).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("Search box", () => {
  test("opens from a room's header in the room, gives focus back as it closes, and goes back to the room on Exit", async ({ members, rooms }) => {
    const ada = await members.signIn("Ada");
    const header = ada.page.getByRole("navigation", { name: "Page" }).getByRole("link", { name: "Search messages" });
    await header.click();
    await expect(field(ada.page)).toBeFocused();
    await expect(box(ada.page).getByRole("button", { name: `Remove in:${rooms.general.name}` })).toBeVisible();
    await field(ada.page).press("Escape");
    await expect(box(ada.page)).toBeHidden();
    await expect(header).toBeFocused();
    await expect(ada.page).toHaveURL(`/rooms/${rooms.general.id}`);

    await header.click();
    await field(ada.page).fill(uniqueWord("nothing"));
    await field(ada.page).press("Enter");
    await expect(ada.page.getByRole("heading", { name: "No messages found" })).toBeFocused();
    await expect(ada.page.getByText("Try different words, or take a filter off.")).toBeVisible();

    await ada.page.getByRole("link", { name: "Exit search" }).click();
    await expect(ada.page).toHaveURL(`/rooms/${rooms.general.id}`);
    await ada.connected();
  });

  test("fits its chips on one line, in a room and in a conversation, whose chip is the widest", async ({ members, request }) => {
    const ada = await members.signIn("Ada");
    const grace = await members.signIn("Grace");
    const header = ada.page.getByRole("navigation", { name: "Page" }).getByRole("link", { name: "Search messages" });
    const chips = box(ada.page).getByRole("group", { name: "Search filters" }).getByRole("button");
    await header.click();
    await expect(chips.first()).toHaveAccessibleName("In this room");
    await expect(chips.last()).toHaveAccessibleName("More filters");
    expect(await linesOf(chips)).toBe(1);
    await field(ada.page).press("Escape");

    await ada.page.goto(`/rooms/${await startDirect(request, ada, [grace])}`);
    await header.click();
    await expect(chips.first()).toHaveAccessibleName("In this conversation");
    expect(await linesOf(chips)).toBe(1);
  });
});

test.describe("Recent searches", () => {
  test("keeps your own recent searches, newest first, in the box and on the search page, until you clear them", async ({ members }) => {
    const ada = await members.signIn("Ada");
    const [eel, newt] = [uniqueWord("eel"), uniqueWord("newt")];
    for (const words of [eel, newt]) {
      await railSearch(ada.page).click();
      await field(ada.page).fill(words);
      await field(ada.page).press("Enter");
      await expect(ada.page).toHaveURL(searchAddress(words));
    }

    await railSearch(ada.page).click();
    await expect(box(ada.page).getByRole("heading", { name: "Recent searches" })).toBeVisible();
    await expect(box(ada.page).getByRole("option")).toHaveText([newt, eel]);
    // Picking one searches for it again, as your newest.
    await box(ada.page).getByRole("option", { name: eel }).click();
    await expect(ada.page).toHaveURL(searchAddress(eel));
    await ada.page.goto("/searches");
    const recent = ada.page.getByRole("region", { name: "Recent searches" });
    await expect(recent.getByRole("link")).toHaveText([eel, newt]);

    const grace = await members.signIn("Grace");
    await grace.page.goto("/searches");
    await expect(grace.page.getByRole("heading", { name: "Find a conversation" })).toBeVisible();
    await expect(grace.page.getByRole("region", { name: "Recent searches" })).toBeHidden();

    const clear = recent.getByRole("button", { name: "Clear recent searches" });
    ada.page.once("dialog", (dialog) => void dialog.dismiss());
    await clear.click();
    await expect(recent.getByRole("link")).toHaveCount(2);
    const asked = new Promise<string>((resolve) =>
      ada.page.once("dialog", (dialog) => {
        resolve(dialog.message());
        void dialog.accept();
      }),
    );
    await clear.click();
    expect(await asked).toBe("Are you sure you want to clear your recent searches?");
    await expect(ada.page).toHaveURL("/searches");
    await expect(recent).toBeHidden();
    await ada.page.reload();
    await expect(ada.page.getByRole("heading", { name: "Find a conversation" })).toBeVisible();
    await expect(recent).toBeHidden();
    await railSearch(ada.page).click();
    await expect(box(ada.page).getByRole("option")).toHaveCount(0);
  });
});
