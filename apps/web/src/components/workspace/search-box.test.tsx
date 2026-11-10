import type { DirectoryUser, Me, Room, RoomId, Search, SearchResults, SearchSort } from "@ember/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { guardLeaving, navigate, pageMark } from "@/hooks/use-route";
import { takeAnswer } from "@/lib/search";
import { CONFIRM_CLEAR_SEARCHES, SearchBox } from "./search-box";

const ada: Me = { id: "u1", name: "Ada Lovelace", administrator: false };
/** Someone in the people directory. */
const person = (id: string, name: string): DirectoryUser => ({ id, name, bio: null, role: "member", status: "active", avatarUrl: `/users/${id}/avatar` });
const grace = person("u2", "Grace Hopper");
const alan = person("u3", "Alan Turing");
const people: People = new Map([grace, alan].map((p) => [p.id, p]));
const general: Room = { id: "general", name: "general", kind: "open", icon: null };
const random: Room = { id: "random", name: "random", kind: "open", icon: null };
const direct: Room = { id: "direct-1", kind: "direct", members: [{ id: ada.id, name: ada.name }, grace], activeAt: "2026-10-15T12:00:00.000Z" };
const rooms = [random, direct, general];

/** What a search answers when it finds nothing, with your recent searches. */
const results = (search: Search | null, recent: Search[] = []): SearchResults => ({ search, matches: [], next: null, rooms: [], recent });

/** Answers the box's requests as `answer` does, given each one's method, address and what it sent, with `recent` as your recent searches. */
function serve(recent: Search[] = [], answer?: (method: string, url: string, sent: unknown) => Response | Promise<Response> | undefined) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const method = init?.method ?? "GET";
    const sent = init?.body ? JSON.parse(String(init.body)) : undefined;
    const { sort: _, ...recorded } = sent ?? {};
    return (
      (await answer?.(method, String(url), sent)) ??
      (method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(results(method === "POST" ? recorded : null, recent)))
    );
  });
}

/** The requests the box has made: each one's method and address, and what it sent, if anything. */
const requests = () =>
  vi.mocked(fetch).mock.calls.map(([url, init]) => [init?.method ?? "GET", url, ...(init?.body ? [JSON.parse(String(init.body))] : [])]);

/** A request's answer, held until `answer` gives it. */
const held = () => {
  let answer = (_: Response) => {};
  return { promise: new Promise<Response>((resolve) => (answer = resolve)), answer: (response: Response) => act(async () => answer(response)) };
};

interface Options {
  roomId?: RoomId;
  search?: Search;
  sort?: SearchSort;
  /** Whether a link opened it, rather than a key. */
  opener?: boolean;
  /** The people directory: Grace and Alan, unless it says. */
  directory?: People;
  /** The rooms the sidebar lists, until `listRooms` lists others. */
  listed?: Room[];
}

/** The search box as Ada opens it over a room's page, with the drawer's toggle in its header. */
function showBox({ roomId, search, sort, opener = true, directory = people, listed = rooms }: Options = {}) {
  history.replaceState(null, "", "/rooms/general");
  const [onClose, onFailed] = [vi.fn(), vi.fn()];
  render(
    <>
      <button type="button" data-ember-sidebar-toggle>
        Open conversations
      </button>
      <a href="/searches">Search</a>
    </>,
  );
  const link = opener ? screen.getByRole("link", { name: "Search" }) : null;
  const boxListing = (shown: Room[]) => (
    <PeopleContext value={directory}>
      <SearchBox opener={link} search={search} sort={sort} roomId={roomId} me={ada} rooms={shown} onClose={onClose} onFailed={onFailed} />
    </PeopleContext>
  );
  const { rerender } = render(boxListing(listed));
  return { link, onClose, onFailed, user: userEvent.setup(), listRooms: (shown: Room[]) => rerender(boxListing(shown)) };
}

const box = () => screen.queryByRole("dialog", { name: "Search" });
const field = () => screen.getByRole("combobox", { name: "Search" });
const list = () => screen.getByRole("listbox");
/** The list's options, by what screen readers call them, the one highlighted marked with a ›. */
const options = () => within(list()).queryAllByRole("option").map((option) => `${option.getAttribute("aria-selected") === "true" ? "› " : ""}${option.getAttribute("aria-label") ?? option.textContent}`);
const chips = () => screen.queryByRole("group", { name: "Search filters" });
const chip = (name: string) => within(chips()!).getByRole("button", { name });
/** The tokens before the field, by what each says. */
const tokens = () => within(box()!).queryAllByRole("button", { name: /^Remove / }).map((button) => button.getAttribute("aria-label")!.slice("Remove ".length));
const here = () => location.pathname + location.search;

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("Search box", () => {
  it("opens with the field focused, in the room it was opened in, offering to search it, then your recent searches", async () => {
    serve([{ q: "launch" }, { q: "", hasLink: true }]);
    showBox({ roomId: "general" });
    expect(box()).toBeInTheDocument();
    expect(field()).toHaveFocus();
    expect(field()).toHaveValue("");
    expect(tokens()).toEqual(["in:general"]);
    expect(within(chips()!).getAllByRole("button").map((button) => [button.getAttribute("aria-label") ?? button.textContent, button.getAttribute("aria-pressed")])).toEqual([
      ["#In this room", "true"],
      ["From me", "false"],
      ["Includes me", "false"],
      ["Has a link", "false"],
      ["Threads only", "false"],
      ["More filters", null],
    ]);
    expect(await screen.findByRole("heading", { name: "Recent searches" })).toBeVisible();
    expect(list()).toHaveAccessibleName("Suggestions");
    expect(options()).toEqual(["› Show results for in:general", "launch", "Has a link"]);
    expect(field()).toHaveAttribute("aria-activedescendant", within(list()).getAllByRole("option")[0]!.id);
    expect(requests()).toEqual([["GET", "/api/searches?q="]]);
  });

  it("opens everywhere from the rail, offering only your recent searches until there's something to search for", async () => {
    serve([{ q: "launch" }]);
    showBox();
    expect(await screen.findByRole("option", { name: "launch" })).toBeInTheDocument();
    expect(tokens()).toEqual([]);
    expect(within(chips()!).queryByRole("button", { name: /In this/ })).toBeNull();
    expect(options()).toEqual(["launch"]);
    expect(field()).not.toHaveAttribute("aria-activedescendant");
  });

  it("names the room In this conversation in a DM, which its token names after the others in it", async () => {
    serve();
    showBox({ roomId: "direct-1" });
    expect(tokens()).toEqual(["in:Grace Hopper"]);
    expect(chip("In this conversation")).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(requests()).toHaveLength(1));
  });

  it("opens with the results page's search, sorted as it is", async () => {
    serve();
    const { user } = showBox({ search: { q: "eel", hasLink: true }, sort: "oldest", roomId: "general" });
    expect(field()).toHaveValue("eel");
    expect(tokens()).toEqual(["Has a link"]);
    expect(chip("In this room")).toHaveAttribute("aria-pressed", "false");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(here()).toBe("/searches?q=eel&has=link&sort=oldest"));
    expect(requests()).toContainEqual(["POST", "/api/searches", { q: "eel", hasLink: true, sort: "oldest" }]);
  });
});

describe("Search messages", () => {
  it("searches for what's typed with the filters on, recording it, and goes to its results, which the results page shows as answered", async () => {
    serve();
    const { link, onClose, user } = showBox({ roomId: "general" });
    await user.keyboard("launch  notes");
    // What it shows is what it searches for, its runs of spaces made one.
    expect(options()[0]).toBe("› Show results for in:general launch notes");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(box()).not.toBeInTheDocument());
    expect(onClose).toHaveBeenCalledOnce();
    expect(here()).toBe("/searches?q=launch+notes&in=general");
    expect(requests()).toEqual([
      ["GET", "/api/searches?q="],
      ["POST", "/api/searches", { q: "launch notes", in: "general", sort: "newest" }],
    ]);
    expect(takeAnswer({ q: "launch notes", in: "general" }, "newest", pageMark())).toEqual(results({ q: "launch notes", in: "general" }));
    // The results take focus.
    expect(link).not.toHaveFocus();
  });

  it("searches with filters alone, but nothing for a field with no words and no filters", async () => {
    serve();
    const { user } = showBox();
    await user.keyboard("{Enter}  {Enter}");
    expect(box()).toBeInTheDocument();
    await user.clear(field());
    await user.click(chip("Includes me"));
    expect(field()).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(here()).toBe("/searches?q=&with=me"));
    expect(requests().filter(([method]) => method === "POST")).toEqual([["POST", "/api/searches", { q: "", withMe: true, sort: "newest" }]]);
  });

  it("takes has:, is: and with: typed in full as filters, and from:me", async () => {
    serve();
    const { user } = showBox();
    await user.keyboard("deploy has:link from:me is:thread ");
    expect(options()[0]).toBe("› Show results for from:Me Has a link Threads only deploy");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(here()).toBe("/searches?q=deploy&from=u1&has=link&is=thread"));
  });

  it("says why a search failed, staying open with what was typed to try again", async () => {
    serve([], (method) => (method === "POST" ? Response.json({ error: "Something went wrong" }, { status: 500 }) : undefined));
    const { onFailed, user } = showBox();
    await user.keyboard("eel{Enter}");
    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(onFailed.mock.calls[0]![0]).toMatchObject({ status: 500 });
    expect(box()).toBeInTheDocument();
    expect(field()).toHaveValue("eel");
    expect(here()).toBe("/rooms/general");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(2));
  });

  it("searches once at a time, and stays on a page gone to meanwhile, open to search again", async () => {
    const answer = held();
    let posts = 0;
    serve([], (method) => (method === "POST" && posts++ === 0 ? answer.promise : undefined));
    const { user } = showBox();
    await user.keyboard("eel{Enter}{Enter}");
    act(() => navigate("/rooms/random"));
    await answer.answer(Response.json(results({ q: "eel" })));
    expect(here()).toBe("/rooms/random");
    expect(box()).toBeInTheDocument();
    expect(requests().filter(([method]) => method === "POST")).toHaveLength(1);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(requests().filter(([method]) => method === "POST")).toHaveLength(2));
  });

  it("leaves what it found for the results page only once unsaved changes let the app go there", async () => {
    serve();
    let proceed = () => {};
    const stopGuarding = guardLeaving((_, go) => {
      proceed = go as () => void;
      return true;
    });
    try {
      const { user } = showBox();
      await user.keyboard("kelp{Enter}");
      await waitFor(() => expect(box()).not.toBeInTheDocument());
      expect(here()).toBe("/rooms/general");
      // Had the person kept editing, their next visit to the search would ask for it afresh.
      expect(takeAnswer({ q: "kelp" }, "newest", pageMark() + 1)).toBeNull();
      await act(async () => proceed());
      expect(here()).toBe("/searches?q=kelp");
      expect(takeAnswer({ q: "kelp" }, "newest", pageMark())).toEqual(results({ q: "kelp" }));
    } finally {
      stopGuarding();
    }
  });
});

describe("Search filters", () => {
  it("turns filters on and off with the chips, shows more under +, and takes them away with their ×", async () => {
    serve();
    const { user } = showBox({ roomId: "general" });
    await user.click(chip("In this room"));
    await user.click(chip("From me"));
    await user.click(chip("Includes me"));
    expect(tokens()).toEqual(["from:Me", "Includes me"]);
    expect(chip("From me")).toHaveAttribute("aria-pressed", "true");
    expect(field()).toHaveFocus();

    await user.click(chip("More filters"));
    expect(chip("More filters")).toHaveAttribute("aria-expanded", "true");
    await user.click(chip("Has a file"));
    expect(tokens()).toEqual(["from:Me", "Includes me", "Has a file"]);
    await user.click(within(box()!).getByRole("button", { name: "Remove Includes me" }));
    expect(tokens()).toEqual(["from:Me", "Has a file"]);
    expect(chip("Includes me")).toHaveAttribute("aria-pressed", "false");
    expect(field()).toHaveFocus();
  });

  it("presses the chips for modifiers typed in full, which turning a chip off takes out of the field", async () => {
    serve();
    const { user } = showBox();
    await user.keyboard("has:link deploy IS:THREAD from:me ");
    expect(["Has a link", "Threads only", "From me", "Includes me"].map((name) => chip(name).getAttribute("aria-pressed"))).toEqual(["true", "true", "true", "false"]);
    await user.click(chip("Has a link"));
    expect(field()).toHaveValue("deploy IS:THREAD from:me");
    expect(chip("Has a link")).toHaveAttribute("aria-pressed", "false");
    await user.click(chip("From me"));
    expect(field()).toHaveValue("deploy IS:THREAD");
    expect(chip("From me")).toHaveAttribute("aria-pressed", "false");
    await user.click(chip("Threads only"));
    expect(field()).toHaveValue("deploy");
    // On again, it's a token, which turning it off takes away with a modifier typed for it since.
    await user.click(chip("Threads only"));
    expect(tokens()).toEqual(["Threads only"]);
    await user.keyboard(" is:thread ");
    await user.click(chip("Threads only"));
    expect(tokens()).toEqual([]);
    expect(field()).toHaveValue("deploy");
    expect(options()[0]).toBe("› Show results for deploy");
    expect(field()).toHaveFocus();
  });

  it("turns From me off for a from:me typed, leaving a person picked, whom the from:me was winning over", async () => {
    serve();
    const { user } = showBox();
    await user.keyboard("deploy from:gr{Enter}");
    expect(tokens()).toEqual(["from:Grace Hopper"]);
    await user.keyboard(" from:me ");
    expect(chip("From me")).toHaveAttribute("aria-pressed", "true");
    await user.click(chip("From me"));
    expect(field()).toHaveValue("deploy");
    expect(field()).toHaveFocus();
    expect(tokens()).toEqual(["from:Grace Hopper"]);
    expect(options()[0]).toBe("› Show results for from:Grace Hopper deploy");
  });

  it("types in: or from: for From someone… and In a room…, after what's typed, to pick from", async () => {
    serve();
    const { user } = showBox();
    await user.keyboard("launch ");
    await user.click(chip("More filters"));
    await user.click(chip("From someone…"));
    expect(field()).toHaveValue("launch from:");
    expect(field()).toHaveFocus();
    expect(list()).toHaveAccessibleName("People");
    expect(chip("More filters")).toHaveAttribute("aria-expanded", "false");

    await user.clear(field());
    await user.click(chip("More filters"));
    await user.click(chip("In a room…"));
    expect(field()).toHaveValue("in:");
    expect(list()).toHaveAccessibleName("Rooms");
  });

  it("completes in: with the rooms whose names have what's typed, rooms before DMs, and takes the one picked as a filter", async () => {
    serve();
    const { user } = showBox({ roomId: "general" });
    await user.keyboard("launch in:");
    expect(list()).toHaveAccessibleName("Rooms");
    expect(options()).toEqual(["› #general", "#random", "Grace Hopper"]);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(tokens()).toEqual(["in:random"]);
    expect(field()).toHaveValue("launch");
    expect(chip("In this room")).toHaveAttribute("aria-pressed", "false");

    await user.keyboard(" in:#gra");
    expect(options()).toEqual(["› Grace Hopper"]);
    await user.click(screen.getByRole("option", { name: "Grace Hopper" }));
    expect(tokens()).toEqual(["in:Grace Hopper"]);
    expect(field()).toHaveFocus();
    await user.keyboard(" in:zebra");
    expect(options()).toEqual([]);
    expect(screen.getByText("No rooms match.")).toBeVisible();
  });

  it("completes from: with you first, then the people whose names have what's typed", async () => {
    serve();
    const { user } = showBox();
    await user.keyboard("from:");
    expect(list()).toHaveAccessibleName("People");
    expect(options()).toEqual(["› Me (Ada Lovelace)", "Alan Turing", "Grace Hopper"]);
    await user.keyboard("@gr");
    expect(options()).toEqual(["› Grace Hopper"]);
    await user.keyboard("{Enter}");
    expect(tokens()).toEqual(["from:Grace Hopper"]);
    await user.keyboard("from:zebra");
    expect(screen.getByText("No people match.")).toBeVisible();
  });

  it("searches for someone picked from from:'s list, in place of a from:me typed before", async () => {
    serve();
    const { user } = showBox();
    await user.keyboard("from:me deploy from:gr{Enter}");
    expect(tokens()).toEqual(["from:Grace Hopper"]);
    expect(field()).toHaveValue("deploy");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(here()).toBe("/searches?q=deploy&from=u2"));
  });

  it("completes from: with people who've been deactivated or suspended too, but not anyone banned, whatever the case of what's typed", async () => {
    serve();
    const left = (id: string, name: string, status: DirectoryUser["status"]): DirectoryUser => ({ ...person(id, name), status });
    const directory: People = new Map(
      [grace, person("u4", "Élodie Martin"), left("u5", "Ezra Gone", "deactivated"), left("u6", "Esme Paused", "suspended"), left("u7", "Eve Banned", "banned")].map((p) => [p.id, p]),
    );
    const { user } = showBox({ directory });
    await user.keyboard("from:ÉLO");
    expect(options()).toEqual(["› Élodie Martin"]);
    await user.clear(field());
    await user.keyboard("from:e");
    expect(options()).toEqual(["› Me (Ada Lovelace)", "Élodie Martin", "Esme Paused", "Ezra Gone", "Grace Hopper"]);
  });

  it("opens in the room it was opened in before the sidebar lists it, naming it once it does", async () => {
    serve();
    const { listRooms } = showBox({ roomId: "general", listed: [] });
    expect(tokens()).toEqual(["in:an unknown room"]);
    listRooms(rooms);
    expect(tokens()).toEqual(["in:general"]);
    expect(chip("In this room")).toHaveAttribute("aria-pressed", "true");
  });

  it("completes has:, is: and with: with the filters they name", async () => {
    serve();
    const { user } = showBox();
    await user.keyboard("has:");
    expect(list()).toHaveAccessibleName("Filters");
    expect(options()).toEqual(["› Has a link", "Has a file"]);
    await user.keyboard("f{Enter}");
    expect(tokens()).toEqual(["Has a file"]);
    expect(field()).toHaveValue("");
    await user.keyboard("is:x");
    expect(screen.getByText("No filters match. Try has:link, has:file, is:thread or with:me.")).toBeVisible();
  });

  it("takes the last token away with Backspace at the field's start, and everything with Clear", async () => {
    serve();
    const { user } = showBox({ roomId: "general" });
    await user.click(chip("From me"));
    await user.click(chip("Has a link"));
    await user.click(chip("Threads only"));
    await user.keyboard("eel{Backspace}");
    expect(field()).toHaveValue("ee");
    expect(tokens()).toEqual(["in:general", "from:Me", "Has a link", "Threads only"]);
    await user.keyboard("{Home}{Backspace}{Backspace}");
    expect(tokens()).toEqual(["in:general", "from:Me"]);
    await user.keyboard("{Backspace}");
    expect(tokens()).toEqual(["in:general"]);
    expect(field()).toHaveValue("ee");

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(tokens()).toEqual([]);
    expect(field()).toHaveValue("");
    expect(field()).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("hides the chips with Filters, which stays pressed while they show", async () => {
    serve();
    const { user } = showBox();
    const filters = screen.getByRole("button", { name: "Filters" });
    expect(filters).toHaveAttribute("aria-pressed", "true");
    await user.click(filters);
    expect(chips()).toBeNull();
    expect(filters).toHaveAttribute("aria-pressed", "false");
    await user.click(filters);
    expect(chips()).toBeInTheDocument();
  });
});

describe("Recent searches", () => {
  it("runs the one picked, recording it as your newest, and lists only those with the words typed", async () => {
    serve([{ q: "launch notes" }, { q: "lunch" }, { q: "launch", in: "random" }]);
    const { user } = showBox({ roomId: "general" });
    await screen.findByRole("heading", { name: "Recent searches" });
    await user.keyboard("LAU");
    expect(options()).toEqual(["› Show results for in:general LAU", "launch notes", "in:random launch"]);
    // Only while nothing's typed are they headed.
    expect(screen.queryByRole("heading", { name: "Recent searches" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "in:random launch" }));
    await waitFor(() => expect(here()).toBe("/searches?q=launch&in=random"));
    expect(requests()).toContainEqual(["POST", "/api/searches", { q: "launch", in: "random", sort: "newest" }]);
  });

  it("goes through the list with the arrows, round from either end, and the pointer", async () => {
    serve([{ q: "launch" }, { q: "lunch" }]);
    const { user } = showBox({ roomId: "general" });
    await screen.findByRole("option", { name: "launch" });
    await user.keyboard("{ArrowDown}");
    expect(options()).toEqual(["Show results for in:general", "› launch", "lunch"]);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(options()).toEqual(["› Show results for in:general", "launch", "lunch"]);
    await user.keyboard("{ArrowUp}");
    expect(options()).toEqual(["Show results for in:general", "launch", "› lunch"]);
    await user.hover(screen.getByRole("option", { name: "launch" }));
    expect(options()).toEqual(["Show results for in:general", "› launch", "lunch"]);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(here()).toBe("/searches?q=launch"));
  });

  it("hides them with Recent searches, and clears them once you confirm", async () => {
    serve([{ q: "launch" }]);
    const sure = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user } = showBox();
    await screen.findByRole("option", { name: "launch" });
    const toggle = screen.getByRole("button", { name: "Recent searches" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(options()).toEqual([]);
    await user.click(toggle);
    expect(options()).toEqual(["launch"]);

    await user.click(screen.getByRole("button", { name: "Clear recent searches" }));
    expect(sure).toHaveBeenCalledExactlyOnceWith(CONFIRM_CLEAR_SEARCHES);
    expect(options()).toEqual(["launch"]);
    await user.click(screen.getByRole("button", { name: "Clear recent searches" }));
    await waitFor(() => expect(options()).toEqual([]));
    expect(screen.queryByRole("heading", { name: "Recent searches" })).toBeNull();
    expect(field()).toHaveFocus();
    expect(requests()).toEqual([
      ["GET", "/api/searches?q="],
      ["DELETE", "/api/searches"],
    ]);
  });
});

describe("Closing the search box", () => {
  it("closes on Escape, giving focus back to the link that opened it", async () => {
    serve();
    const { link, onClose, user } = showBox();
    await user.keyboard("eel{Escape}");
    await waitFor(() => expect(box()).not.toBeInTheDocument());
    expect(onClose).toHaveBeenCalledOnce();
    expect(link).toHaveFocus();
    expect(requests()).toEqual([["GET", "/api/searches?q="]]);
  });

  it("closes on Ctrl+F, leaving the key to the browser to find in the page, and on Back", async () => {
    serve();
    const { onClose } = showBox({ opener: false });
    expect(fireEvent.keyDown(field(), { key: "f", ctrlKey: true })).toBe(true);
    await waitFor(() => expect(box()).not.toBeInTheDocument());
    expect(onClose).toHaveBeenCalledOnce();

    showBox({ opener: false });
    act(() => void window.dispatchEvent(new PopStateEvent("popstate")));
    await waitFor(() => expect(box()).not.toBeInTheDocument());
  });
});
