import { openRoom, signInAs } from "../../fixtures";
import { expect, test } from "./fixtures";

/** A word in no other test's messages or searches, since every test shares the server and its open rooms. */
const uniqueWord = (word: string) => `${word}${crypto.randomUUID().slice(0, 8)}`;

test.beforeEach(async ({ page, session }) => {
  await signInAs(page, session);
});

test("the search box and its results fit the phone, with recent searches, chips that scroll, and a long result's card", async ({ page, room, participant, screenIsFine }) => {
  const ada = await participant("Ada");
  const word = uniqueWord("zebra");
  await ada.say(`The ${word} at https://example.com/${"analytical-engine-".repeat(8)} ran on and on through the whole afternoon`);
  await openRoom(page, room);

  // A phone has Search in the room's top bar, since the rail is in the drawer.
  const header = page.getByRole("navigation", { name: "Page" });
  const box = page.getByRole("dialog", { name: "Search" });
  const field = box.getByRole("combobox", { name: "Search" });
  await header.getByRole("link", { name: "Search messages" }).tap();
  await expect(field).toBeFocused();
  await expect(box.getByRole("button", { name: `Remove in:${room.name}` })).toBeVisible();
  // The chips scroll sideways rather than push the box off the screen.
  const chips = box.getByRole("group", { name: "Search filters" });
  await expect(chips.getByRole("button", { name: "More filters" })).toBeAttached();
  await screenIsFine();

  for (const query of [uniqueWord("difference engine"), uniqueWord("bernoulli"), uniqueWord("jacquard loom")]) {
    await field.fill(query);
    await field.press("Enter");
    await expect(page.getByRole("heading", { name: "No messages found" })).toBeVisible();
    // The results page's search opens the box with it, to change it.
    await header.getByRole("button", { name: /^Change search: / }).tap();
  }
  const found = page.getByRole("region", { name: "Search results" }).getByRole("listitem");
  await expect(async () => {
    if (!(await box.isVisible())) await header.getByRole("button", { name: /^Change search: / }).tap();
    await field.fill(word);
    await field.press("Enter");
    await expect(found).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await expect(found.getByText(room.name, { exact: true })).toBeVisible();
  await expect(found.getByRole("link", { name: "View in room" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Search filters" }).getByRole("button", { name: `Remove in:${room.name}` })).toBeVisible();
  await screenIsFine();

  // Back in the room, the box lists the searches just made.
  await page.getByRole("link", { name: "Exit search" }).tap();
  await header.getByRole("link", { name: "Search messages" }).tap();
  await expect(box.getByRole("heading", { name: "Recent searches" })).toBeVisible();
  await expect(box.getByRole("option").filter({ hasNotText: "Show results for" })).toHaveCount(4);
  await screenIsFine();
});

test("the results page's top bar keeps the words searched for whole, cutting the filters short or off first", async ({ page, room, session, screenIsFine }) => {
  const search = page.getByRole("navigation", { name: "Page" }).getByRole("button", { name: /^Change search: / });
  /** Whether `words` show whole, inside their line, which the filters can't push them out of. */
  const fit = (words: string) =>
    search.getByText(words, { exact: true }).evaluate((element) => {
      const [word, line] = [element.getBoundingClientRect(), element.parentElement!.getBoundingClientRect()];
      return element.scrollWidth <= element.clientWidth && word.left >= line.left && word.right <= line.right + 0.5;
    });

  await page.goto(`/searches?q=okapi&in=${room.id}&has=link&is=thread`);
  await expect(search).toHaveAccessibleName(`Change search: in:${room.name} Has a link Threads only okapi`);
  expect(await fit("okapi")).toBe(true);
  await screenIsFine();

  // Every filter at once leaves the tokens too little room on the narrowest phones: they're cut off, not the words.
  await page.goto(`/searches?q=okapi+zebra&in=${room.id}&from=${session.user.id}&with=me&has=link&has=file&is=thread`);
  await expect(search).toHaveAccessibleName(`Change search: in:${room.name} from:Me Includes me Has a link Has a file Threads only okapi zebra`);
  expect(await fit("okapi zebra")).toBe(true);
});
