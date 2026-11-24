import type { APIRequestContext, Locator } from "@playwright/test";
import { allowNotifications, cookieHeader, createSession, type Session, type TestRoom } from "../../fixtures";
import { expect, test, typeWhileFramesWait, unique, type Member } from "./fixtures";

/** The commands / lists at the start of a message, while it shows. */
const commandList = (member: Member) => member.page.getByRole("listbox");

/** The names of the commands / lists, in order. */
const listed = (member: Member) => commandList(member).getByRole("option").locator("[data-command] strong");

/** What's said over the composer's card of the command written: its name, what it takes and what it does. */
const usage = (member: Member) => member.page.locator("form.composer p:has(> strong)");

/** The header's bell, named for your level in the room, once the browser has turned notifications on. */
const bell = (member: Member) => member.page.getByRole("navigation", { name: "Page" }).getByRole("checkbox");

/** A flash, a notice or an alert, saying `text`. */
const flash = (member: Member, text: string) => member.page.getByRole("alert").filter({ hasText: text });

/** Writes `command` and sends it with Enter, a space first ending its name, as the list would pick otherwise. */
async function run(member: Member, command: string): Promise<void> {
  await member.composer().pressSequentially(command.includes(" ") ? command : `${command} `);
  await expect(commandList(member)).toBeHidden();
  await member.composer().press("Enter");
}

/**
 * Writes the command `before`, then @ and `filter`, and picks whom the @ list offers for it once it lists
 * just `name`, waiting for the answer for all of `filter`, as one for less of it can list the same people
 * first.
 */
async function mention(member: Member, before: string, filter: string, name: string): Promise<void> {
  const field = member.composer();
  await field.pressSequentially(before);
  // As someone does who reads what the command takes first.
  await expect(usage(member)).toBeVisible();
  await field.pressSequentially("@");
  await expect(member.page.getByRole("listbox")).toBeVisible();
  const answered = member.page.waitForResponse((response) => new URL(response.url()).searchParams.get("filter") === filter);
  await field.pressSequentially(filter);
  await answered;
  await expect(member.page.getByRole("listbox").getByRole("option")).toHaveText([name]);
  await field.press("Enter");
  await expect(field.getByText(name, { exact: true })).toBeVisible();
}

/** Creates a private room through the API as `session`'s person, for exactly `members`. */
async function createPrivateRoom(request: APIRequestContext, session: Session, name: string, members: Session[]): Promise<TestRoom> {
  const memberIds = members.map(({ user }) => user.id);
  const response = await request.post("/api/rooms", { data: { kind: "closed", name, memberIds }, headers: { Cookie: cookieHeader(session) } });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { room: TestRoom }).room;
}

/** Whether `session`'s person can see the room `roomId`, as its settings answer. */
async function canSee(request: APIRequestContext, session: Session, roomId: string): Promise<boolean> {
  const response = await request.get(`/api/rooms/${roomId}/settings`, { headers: { Cookie: cookieHeader(session) } });
  expect([200, 404], await response.text()).toContain(response.status());
  return response.status() === 200;
}

/** Opens `room` in `member`'s browser. */
async function open(member: Member, room: TestRoom): Promise<void> {
  await member.page.goto(`/rooms/${room.id}`);
  await member.connected();
}

const text = (field: Locator) => field.evaluate((element) => element.textContent);

/**
 * Empties the composer as you would, selecting what's written and deleting it. `fill("")` selects it by
 * script and presses Delete at once, which Lexical can take before it hears of the selection, deleting
 * nothing, or only a letter of it.
 */
async function clear(field: Locator): Promise<void> {
  await field.press("ControlOrMeta+a");
  await field.press("Delete");
  await expect(field).toHaveText("");
}

/**
 * Waits for Lexxy to hear the / that opens the list again: it looks again at what's typed 50 ms after the
 * last key, even once a pick has closed the list, closing it again where the / has gone, and a closed list
 * opens again only from the next frame on.
 */
const listSettled = (member: Member) => member.page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(resolve), 50)));

test.describe("/ commands", () => {
  test("lists Slack's commands as / starts a message, for what follows it, and Enter, Tab or a click picks one, saying what it takes", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"));
    const field = ada.composer();
    await field.pressSequentially("/");
    await expect(listed(ada)).toHaveText(["/darkmode", "/dm", "/msg", "/mute", "/rename", "/search", "/shortcuts", "/shrug", "/snippet"]);
    await expect(commandList(ada).getByRole("option", { name: /^\/mute/ })).toHaveAccessibleName("/mute [#room] Mute or unmute a conversation");
    await field.pressSequentially("s");
    await expect(listed(ada)).toHaveText(["/search", "/shortcuts", "/shrug", "/snippet"]);
    await field.pressSequentially("h");
    await expect(listed(ada)).toHaveText(["/shortcuts", "/shrug"]);
    await field.press("ArrowDown");
    await field.press("Enter");
    await expect(commandList(ada)).toBeHidden();
    expect(await text(field)).toBe("/shrug ");
    await expect(usage(ada)).toHaveText("/shrug [your message] Append ¯\\_(ツ)_/¯ to the end of your message");

    await listSettled(ada);
    await clear(field);
    await field.pressSequentially("/sea");
    await field.press("Tab");
    expect(await text(field)).toBe("/search ");
    await expect(usage(ada)).toHaveText("/search [your search terms] Search messages");
    await listSettled(ada);
    await clear(field);
    await field.pressSequentially("/");
    await commandList(ada).getByRole("option", { name: /^\/darkmode/ }).click();
    expect(await text(field)).toBe("/darkmode ");
    await expect(usage(ada)).toHaveText("/darkmode Turn dark mode on or off");
    await expect(field).toBeFocused();
  });

  test("picks the command typed, though the list hasn't caught up with quick typing", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"));
    const field = ada.composer();
    for (const [typed, picked] of [
      ["dm", "/dm "],
      ["sh", "/shortcuts "],
      ["MU", "/mute "],
    ] as const) {
      await listSettled(ada);
      await clear(field);
      // The list shows a frame after the /, and then lists for what follows it once typing pauses.
      await field.pressSequentially("/");
      await expect(commandList(ada)).toBeVisible();
      await field.pressSequentially(typed);
      await field.press("Enter");
      await expect(commandList(ada)).toBeHidden();
      expect(await text(field), typed).toBe(picked);
    }
  });

  test("ends the name as typed at a space or another /, picking nothing, and says a / that names no command isn't one, keeping the message to send with a space before it", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"));
    const field = ada.composer();
    await field.pressSequentially("/mu ");
    await expect(commandList(ada)).toBeHidden();
    expect(await text(field)).toBe("/mu ");
    await clear(field);
    // On a busy page, where the list, which shows a frame after the /, shows only once the name's ended.
    for (const typed of ["/mu ", "/r/"]) {
      await listSettled(ada);
      await typeWhileFramesWait(ada, typed);
      await expect(commandList(ada), typed).toBeHidden();
      expect(await text(field)).toBe(typed);
      await clear(field);
    }

    await field.pressSequentially("/r/programming is great");
    await expect(commandList(ada)).toBeHidden();
    await field.press("Enter");
    const alert = ada.page.locator("form.composer").getByRole("alert");
    await expect(alert).toHaveText("/r/programming isn't a command. To send a message that starts with /, put a space before it.");
    await expect(field).toHaveText("/r/programming is great");
    await expect(ada.message("/r/programming")).toHaveCount(0);

    await field.press("Home");
    await field.pressSequentially(" ");
    await expect(alert).toHaveCount(0);
    await field.press("Enter");
    await expect(ada.message("/r/programming is great")).toBeVisible();
    await expect(field).toHaveText("");
  });

  test("starts a command with Run shortcut at the start of what's written, and /shrug sends it with ¯\\_(ツ)_/¯ after it", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"));
    const field = ada.composer();
    await field.pressSequentially("it works");
    await ada.page.locator("form.composer").getByRole("button", { name: "Run shortcut", exact: true }).click();
    await expect(commandList(ada)).toBeVisible();
    await expect(field).toBeFocused();
    expect(await text(field)).toBe("/ it works");

    await field.pressSequentially("shr");
    await expect(listed(ada)).toHaveText(["/shrug"]);
    await field.press("Enter");
    expect(await text(field)).toBe("/shrug it works");
    await field.press("Enter");
    await expect(ada.message("it works ¯\\_(ツ)_/¯")).toBeVisible();
    await expect(field).toHaveText("");
  });

  test("mutes the room with /mute, as its bell shows, and unmutes it, saying so", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"), { beforeOpen: (page) => allowNotifications(page.context()) });
    await expect(bell(ada)).toHaveAccessibleName("Notifying about @ mentions");
    await run(ada, "/mute");
    await expect(flash(ada, "Muted #general.")).toBeVisible();
    await expect(bell(ada)).toHaveAccessibleName("Notifications are off");
    await expect(ada.composer()).toHaveText("");

    await run(ada, "/mute");
    await expect(flash(ada, "Unmuted #general.")).toBeVisible();
    await expect(bell(ada)).toHaveAccessibleName("Notifying about @ mentions");
  });

  test("adds whom /invite mentions, offering everyone, to a private room, and /kick takes them out, both only for private rooms", async ({ members, request }) => {
    const tag = crypto.randomUUID().slice(0, 8);
    const ada = await members.signIn(unique("Ada"), { serverRooms: true });
    const grace = await createSession(request, `Grace ${tag}`);
    const leads = await createPrivateRoom(request, ada.session, unique("Leads"), [ada.session]);
    await open(ada, leads);
    await ada.composer().pressSequentially("/re");
    await expect(listed(ada)).toHaveText(["/remove", "/rename"]);
    await clear(ada.composer());

    await mention(ada, "/invite ", tag, `Grace ${tag}`);
    await ada.composer().press("Enter");
    await expect(flash(ada, `Added Grace ${tag} to #${leads.name}.`)).toBeVisible();
    await expect(ada.composer()).toHaveText("");
    expect(await canSee(request, grace, leads.id)).toBe(true);

    await mention(ada, "/kick ", tag, `Grace ${tag}`);
    await ada.composer().press("Enter");
    await expect(flash(ada, `Removed Grace ${tag} from #${leads.name}.`)).toBeVisible();
    expect(await canSee(request, grace, leads.id)).toBe(false);
  });

  test("has @ offer the room's people again once the /msg it was offering everyone for is taken away while its list shows", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"));
    const thrown: Error[] = [];
    ada.page.on("pageerror", (error) => thrown.push(error));
    const asked = (everyone: boolean) =>
      ada.page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === "/api/autocompletable/users" && url.searchParams.has("room_id") !== everyone;
      });
    const field = ada.composer();
    await field.pressSequentially("/msg ");
    await expect(usage(ada)).toBeVisible();
    const everyone = asked(true);
    await field.pressSequentially("@");
    await everyone;
    await expect(ada.page.getByRole("listbox")).toBeVisible();

    // Selecting back from the @ leaves its list open, and deleting what's selected closes it as the command goes.
    await field.press("Shift+Home");
    await expect(ada.page.getByRole("listbox")).toBeVisible();
    // As someone does who sees what's selected first, by when the page has told the editor of it.
    await listSettled(ada);
    await field.press("Backspace");
    await expect(field).toHaveText("");
    await expect(ada.page.getByRole("listbox")).toBeHidden();
    await listSettled(ada);
    const theRoom = asked(false);
    await field.pressSequentially("@");
    await theRoom;
    await expect(ada.page.getByRole("listbox")).toBeVisible();
    expect(thrown).toEqual([]);
  });

  test("leaves a private room with /leave once you confirm, which then leaves your sidebar", async ({ members, request }) => {
    const ada = await members.signIn(unique("Ada"), { serverRooms: true });
    const linus = await createSession(request, unique("Linus"));
    const leads = await createPrivateRoom(request, linus, unique("Leads"), [linus, ada.session]);
    await open(ada, leads);
    const asked = new Promise<string>((resolve) =>
      ada.page.once("dialog", (dialog) => {
        resolve(dialog.message());
        void dialog.accept();
      }),
    );
    await run(ada, "/leave");
    expect(await asked).toBe("Are you sure you want to leave this room? Only someone in it who can change it can add you back.");
    await expect(ada.page).not.toHaveURL(new RegExp(leads.id));
    await expect(ada.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: leads.name })).toHaveCount(0);
    expect(await canSee(request, ada.session, leads.id)).toBe(false);
  });

  test("sends /msg's message to whom it mentions, in a DM with them, or to a room it names or mentions", async ({ members, rooms }) => {
    const tag = crypto.randomUUID().slice(0, 8);
    const grace = await members.signIn(`Grace ${tag}`);
    const ada = await members.signIn(unique("Ada"));
    await mention(ada, "/msg ", tag, `Grace ${tag}`);
    await ada.composer().pressSequentially("lunch at noon?");
    await ada.composer().press("Enter");
    await expect(flash(ada, `Sent to Grace ${tag}.`)).toBeVisible();
    await expect(ada.composer()).toHaveText("");
    await expect(ada.message("lunch at noon?")).toHaveCount(0);
    await grace.page.getByRole("region", { name: "DMs" }).getByRole("link", { name: `Direct message with ${ada.name}`, exact: true }).click();
    await expect(grace.message("lunch at noon?")).toBeVisible();

    await run(ada, "/msg #random see the brief");
    await expect(flash(ada, "Sent to #random.")).toBeVisible();
    // Not by reloading, which would take what the page has yet to send with it.
    await ada.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: rooms.random.name, exact: true }).click();
    await expect(ada.message("see the brief")).toBeVisible();

    // A room picked from the # list, which the message goes to without the mention.
    await ada.composer().pressSequentially("/msg ");
    await expect(usage(ada)).toBeVisible();
    await ada.composer().pressSequentially("#gen");
    await expect(ada.page.getByRole("listbox").getByRole("option")).toHaveText(["#general"]);
    await ada.composer().press("Enter");
    await expect(ada.composer().getByText("#general", { exact: true })).toBeVisible();
    await ada.composer().pressSequentially("see the plan");
    await ada.composer().press("Enter");
    await expect(flash(ada, "Sent to #general.")).toBeVisible();
    await ada.page.getByRole("region", { name: "Rooms" }).getByRole("link", { name: rooms.general.name, exact: true }).click();
    await expect(ada.message("see the plan").locator(".message-content")).toHaveText("see the plan");
  });

  test("searches for what follows /search, and opens the search box for /search alone", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"));
    await run(ada, "/search launch plans");
    await expect(ada.page).toHaveURL(/\/searches\?q=launch(\+|%20)plans/);

    await ada.page.goBack();
    await ada.connected();
    await run(ada, "/search");
    await expect(ada.page.getByRole("dialog", { name: "Search" })).toBeVisible();
  });

  test("turns dark mode on and off with /darkmode, and opens New direct message with /dm and the keyboard shortcuts with /shortcuts", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"), { context: { colorScheme: "light" } });
    const html = ada.page.locator("html");
    await run(ada, "/darkmode");
    await expect(html).toHaveClass(/\bdark\b/);
    await run(ada, "/darkmode");
    await expect(html).not.toHaveClass(/\bdark\b/);

    await run(ada, "/dm");
    const directs = ada.page.getByRole("dialog", { name: "New direct message" });
    await expect(directs).toBeVisible();
    await ada.page.keyboard.press("Escape");
    await expect(directs).toHaveCount(0);
    await expect(ada.composer()).toBeFocused();
    await run(ada, "/shortcuts");
    await expect(ada.page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  });

  test("renames the room with /rename, which its administrators can", async ({ members }) => {
    const ada = await members.signIn(unique("Ada"), { administrator: true });
    const name = unique("Town square");
    await run(ada, `/rename ${name}`);
    await expect(flash(ada, `Renamed the room #${name}.`)).toBeVisible();
    await expect(ada.page.getByRole("heading", { level: 1 })).toHaveText(name);
  });
});
