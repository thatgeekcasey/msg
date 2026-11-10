import { searchPath, type DirectoryUser, type Me, type Message, type Room, type Search, type SearchResults, type User } from "@ember/protocol";
import { bodyFromPlainText } from "@ember/richtext/dom";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "@/components/ui/sheet";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { navigate } from "@/hooks/use-route";
import { keepAnswer } from "@/lib/search";
import { CONFIRM_CLEAR_SEARCHES, OpenSearchContext } from "./search-box";
import { SearchPage } from "./search-page";

const ada: Me = { id: "u1", name: "Ada Lovelace", administrator: false };
const grace: User = { id: "u2", name: "Grace Hopper" };
const general: Room = { id: "general", name: "general", kind: "open", icon: null };
const direct: Room = { id: "direct-1", kind: "direct", members: [{ id: ada.id, name: ada.name }, grace], activeAt: "2026-10-15T12:00:00.000Z" };
/** The people directory, listing Grace. */
const withGrace: People = new Map([[grace.id, { ...grace, bio: null, role: "member", status: "active", avatarUrl: "/users/u2/avatar" } satisfies DirectoryUser]]);

/** The message `id`, which `creator` wrote in `room`. */
const message = (id: string, room: Room, plainText: string, creator: User = grace): Message => ({
  id,
  clientMessageId: `c-${id}`,
  roomId: room.id,
  creator,
  body: bodyFromPlainText(plainText),
  plainText,
  mentions: [],
  createdAt: "2026-10-12T10:00:00.000Z",
  updatedAt: "2026-10-12T10:00:00.000Z",
  editedAt: null,
  boosts: [],
});

/** What `search` answers: `messages`, matching `words`, in the rooms they're in, the cursor of the page after, and your recent searches. */
const results = (search: Search | null, messages: Message[] = [], { words = [] as string[], next = null as number | null, recent = [] as Search[] } = {}): SearchResults => ({
  search,
  matches: messages.map((message) => ({ message, words })),
  next,
  rooms: [general, direct].filter((room) => messages.some(({ roomId }) => roomId === room.id)),
  recent,
});

/** Answers the page's requests as `answer` does, given each one's method, address and what it sent. */
function serve(answer: (method: string, url: string, sent: unknown) => Response | Promise<Response>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) =>
    answer(init?.method ?? "GET", String(url), init?.body ? JSON.parse(String(init.body)) : undefined),
  );
}

/** The requests the page has made: each one's method and address, and what it sent, if anything. */
const requests = () =>
  vi.mocked(fetch).mock.calls.map(([url, init]) => [init?.method ?? "GET", url, ...(init?.body ? [JSON.parse(String(init.body))] : [])]);

/** A request's answer, held until `answer` gives it. */
const held = () => {
  let answer = (_: Response) => {};
  return { promise: new Promise<Response>((resolve) => (answer = resolve)), answer: (response: Response) => act(async () => answer(response)) };
};

/** The search page at `address`, as Ada sees it, opened from general, with the sidebar listing general and her DM with Grace. */
function showPage(address: string, { people = new Map() as People } = {}) {
  history.replaceState(null, "", "/rooms/general");
  navigate(address);
  const onFailed = vi.fn();
  const openSearch = vi.fn();
  render(
    <PeopleContext value={people}>
      <OpenSearchContext value={openSearch}>
        <Sheet>
          <SearchPage me={ada} rooms={[general, direct]} back="/rooms/general" onFailed={onFailed} />
        </Sheet>
      </OpenSearchContext>
    </PeopleContext>,
  );
  return { onFailed, openSearch, user: userEvent.setup() };
}

const found = () => screen.findByRole("region", { name: "Search results" });
const cards = async () => within(await found()).getAllByRole("listitem");
const filters = () => screen.queryByRole("group", { name: "Search filters" });
const chip = (name: string | RegExp) => within(filters()!).getByRole("button", { name });
const recents = () => screen.queryByRole("region", { name: "Recent searches" });
/** The top bar's search, which opens the search box. */
const changeSearch = () => within(screen.getByRole("navigation", { name: "Page" })).getByRole("button", { name: /^Change search: |^Search$/ });
const here = () => location.pathname + location.search;

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
  document.title = "";
});

describe("Search page", () => {
  it("says what it's for without a search, titled Search, with a button that opens the search box", async () => {
    serve(() => Response.json(results(null)));
    const { openSearch, user } = showPage("/searches");
    expect(await screen.findByRole("heading", { name: "Find a conversation" })).toBeVisible();
    expect(screen.getByText("Search messages across your rooms and direct messages.")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Search messages$/);
    expect(document.title).toBe("Search");
    expect(changeSearch()).toHaveAccessibleName("Search");
    // Nothing's searched for, so there's nothing to narrow or sort.
    expect(filters()).toBeNull();
    expect(screen.queryByRole("button", { name: /^Sort/ })).toBeNull();
    expect(recents()).toBeNull();

    const button = within(await found()).getByRole("button", { name: "Search" });
    await user.click(button);
    expect(openSearch).toHaveBeenCalledExactlyOnceWith({ opener: button });
    await user.click(changeSearch());
    expect(openSearch).toHaveBeenLastCalledWith({ opener: changeSearch(), search: { q: "" }, sort: "newest" });
    expect(requests()).toEqual([["GET", "/api/searches?q="]]);
  });

  it("says when a search found nothing, and what to try, which depends on whether it has filters", async () => {
    serve(() => Response.json(results({ q: "zebra" })));
    showPage(searchPath({ q: "zebra" }));
    expect(await screen.findByRole("heading", { name: "No messages found" })).toBeVisible();
    expect(screen.getByText("Try a different word or phrase.")).toBeVisible();
    expect(changeSearch()).toHaveAccessibleName("Change search: zebra");

    act(() => navigate(searchPath({ q: "zebra", hasLink: true })));
    expect(await screen.findByText("Try different words, or take a filter off.")).toBeVisible();
    expect(changeSearch()).toHaveAccessibleName("Change search: Has a link zebra");
  });

  it("is busy until the search has answered", async () => {
    const answer = held();
    serve(() => answer.promise);
    showPage(searchPath({ q: "hello" }));
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    await answer.answer(Response.json(results({ q: "hello" })));
    expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy");
    expect(screen.getByRole("heading", { name: "No messages found" })).toBeVisible();
  });

  it("goes on showing the last search, busy, until the next has answered, and drops it if that fails", async () => {
    const [zebra, newt] = [held(), held()];
    serve((_, url) =>
      url.endsWith("=zebra") ? zebra.promise : url.endsWith("=newt") ? newt.promise : Response.json(results({ q: "hello" }, [message("m1", general, "Hello")])),
    );
    const { onFailed } = showPage(searchPath({ q: "hello" }));
    await found();

    act(() => navigate(searchPath({ q: "zebra" })));
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("region", { name: "Search results" })).toHaveTextContent("Hello");
    await zebra.answer(Response.json(results({ q: "zebra" })));
    expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy");
    expect(screen.getByRole("heading", { name: "No messages found" })).toBeVisible();

    act(() => navigate(searchPath({ q: "newt" })));
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    await newt.answer(Response.json({ error: "Something went wrong" }, { status: 500 }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    // What another search found doesn't stay at this one's address.
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy");
    expect(changeSearch()).toHaveAccessibleName("Change search: newt");
  });

  it("asks again on every visit, its own address's too", async () => {
    serve(() => Response.json(results({ q: "hello" })));
    showPage(searchPath({ q: "hello" }));
    await screen.findByRole("heading", { name: "No messages found" });
    act(() => navigate(searchPath({ q: "hello" })));
    await waitFor(() => expect(requests()).toEqual([
      ["GET", "/api/searches?q=hello"],
      ["GET", "/api/searches?q=hello"],
    ]));
  });

  it("says why a search failed", async () => {
    serve(() => Response.json({ error: "Searches can be up to 1,000 characters." }, { status: 422 }));
    const { onFailed } = showPage(searchPath({ q: "hello" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(onFailed.mock.calls[0]![0]).toMatchObject({ status: 422, message: "Searches can be up to 1,000 characters." });
  });

  it("goes back to the room it was opened from on Exit, and opens the search box with its search to change it", async () => {
    serve(() => Response.json(results({ q: "eel", hasLink: true })));
    const { openSearch, user } = showPage(searchPath({ q: "eel", hasLink: true }, "oldest"));
    await screen.findByRole("heading", { name: "No messages found" });
    expect(screen.getByRole("link", { name: "Exit search" })).toHaveAttribute("href", "/rooms/general");
    await user.click(changeSearch());
    expect(openSearch).toHaveBeenCalledExactlyOnceWith({ opener: changeSearch(), search: { q: "eel", hasLink: true }, sort: "oldest" });
    expect(here()).toBe("/searches?q=eel&has=link&sort=oldest");
  });
});

describe("Search messages", () => {
  it("shows each message a search found as a card naming its room and day, with a link to the message, which can't be changed", async () => {
    serve(() => Response.json(results({ q: "hello" }, [message("m1", general, "Hello there"), message("m2", direct, "hello again", ada)])));
    showPage(searchPath({ q: "hello" }));
    const [first, second] = await cards();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("2 results");
    expect(within(first!).getByText("general")).toBeVisible();
    expect(within(first!).getByText("Hello there")).toBeVisible();
    expect(within(first!).getByText("October 12, 2026")).toHaveAttribute("datetime", "2026-10-12T10:00:00.000Z");
    expect(within(first!).getByRole("link", { name: "View in room" })).toHaveAttribute("href", "/rooms/general/@m1");
    // A DM is named after the others in it.
    expect(within(second!).getByText("Grace Hopper")).toBeVisible();
    expect(within(second!).getByRole("link", { name: "View in conversation" })).toHaveAttribute("href", "/rooms/direct-1/@m2");
    expect(within(screen.getByRole("region", { name: "Search results" })).queryAllByRole("button")).toEqual([]);
    expect(screen.getByRole("main")).not.toHaveAttribute("aria-busy");
    expect(requests()).toEqual([["GET", "/api/searches?q=hello"]]);
  });

  it("marks the words each message matched, as they're written there", async () => {
    serve(() => Response.json(results({ q: "hello" }, [message("m1", general, "Hello there, and hello again")], { words: ["Hello", "hello"] })));
    showPage(searchPath({ q: "hello" }));
    const [card] = await cards();
    expect([...card!.querySelectorAll("mark[data-search-match]")].map((mark) => mark.textContent)).toEqual(["Hello", "hello"]);
  });

  it("marks them in a bot's cards, which can be all a message has", async () => {
    const cardOnly: Message = { ...message("m1", general, "Deploy finished"), body: "", cards: [{ source: "blocks", parts: [{ kind: "header", text: "Deploy finished" }] }] };
    serve(() => Response.json(results({ q: "deploy" }, [cardOnly], { words: ["Deploy"] })));
    showPage(searchPath({ q: "deploy" }));
    const [card] = await cards();
    expect(within(card!).getByRole("heading", { name: "Deploy finished" }).querySelector("mark[data-search-match]")).toHaveTextContent("Deploy");
  });

  it("names the people in a DM as the people directory lists them now, and a room you've left as one", async () => {
    const renamed: People = new Map([[grace.id, { ...withGrace.get(grace.id)!, name: "Grace Brewster Hopper" }]]);
    const left: Room = { id: "left", name: "left", kind: "open", icon: null };
    serve(() => Response.json(results({ q: "hello" }, [message("m1", direct, "hello again", ada), message("m2", left, "hello there", ada)])));
    showPage(searchPath({ q: "hello" }), { people: renamed });
    const [dm, gone] = await cards();
    expect(within(dm!).getByText("Grace Brewster Hopper")).toBeVisible();
    expect(within(gone!).getByText("A room you’ve left")).toBeVisible();
  });

  it("highlights the results that mention you, as the room does", async () => {
    const mentioning = { ...message("m1", general, "Thanks @Ada Lovelace"), mentions: [{ id: ada.id, name: ada.name }] };
    serve(() => Response.json(results({ q: "thanks" }, [mentioning, message("m2", general, "Thanks all")])));
    showPage(searchPath({ q: "thanks" }));
    const [mentioned, other] = await cards();
    expect(mentioned!.querySelector(".border-mention")).not.toBeNull();
    expect(other!.querySelector(".border-mention")).toBeNull();
  });

  it("counts what it found, with a + while there's more, and shows more under it, leaving out what it shows already", async () => {
    const page = held();
    serve((_, url) =>
      url.includes("cursor=")
        ? page.promise
        : Response.json(results({ q: "hello" }, [message("m1", general, "Hello one"), message("m2", general, "Hello two")], { next: 2 })),
    );
    showPage(searchPath({ q: "hello" }));
    await cards();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("2+ results");
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Loading…" })).toHaveAttribute("aria-busy", "true");
    await page.answer(Response.json(results({ q: "hello" }, [message("m2", general, "Hello two"), message("m3", general, "Hello three")])));
    expect((await cards()).map((card) => card.textContent)).toEqual([expect.stringContaining("Hello one"), expect.stringContaining("Hello two"), expect.stringContaining("Hello three")]);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("3 results");
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(requests()).toEqual([
      ["GET", "/api/searches?q=hello"],
      ["GET", "/api/searches?q=hello&cursor=2"],
    ]);
  });

  it("keeps its place as the next page joins it, and shows another search from its top", async () => {
    serve((_, url) =>
      url.includes("cursor=")
        ? Response.json(results({ q: "hello" }, [message("m2", general, "Hello two")]))
        : url.endsWith("=eel")
          ? Response.json(results({ q: "eel" }, [message("m3", general, "Eel three")]))
          : Response.json(results({ q: "hello" }, [message("m1", general, "Hello one")], { next: 1 })),
    );
    showPage(searchPath({ q: "hello" }));
    await cards();
    const list = await found();
    list.scrollTop = 500;
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(async () => expect(await cards()).toHaveLength(2));
    expect(list.scrollTop).toBe(500);

    act(() => navigate(searchPath({ q: "eel" })));
    await waitFor(async () => expect((await cards()).map((card) => card.textContent)).toEqual([expect.stringContaining("Eel three")]));
    expect(list.scrollTop).toBe(0);
  });

  it("offers the page after one whose matches have all been deleted since it was searched", async () => {
    serve((_, url) =>
      url.includes("cursor=") ? Response.json(results({ q: "hello" }, [message("m2", general, "Hello two")])) : Response.json(results({ q: "hello" }, [], { next: 7 })),
    );
    showPage(searchPath({ q: "hello" }));
    await userEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect((await cards()).map((card) => card.textContent)).toEqual([expect.stringContaining("Hello two")]);
    expect(screen.queryByRole("heading", { name: "No messages found" })).toBeNull();
    expect(requests()).toEqual([
      ["GET", "/api/searches?q=hello"],
      ["GET", "/api/searches?q=hello&cursor=7"],
    ]);
  });

  it("drops a page that comes after another search has shown", async () => {
    const page = held();
    serve((_, url) =>
      url.includes("cursor=")
        ? page.promise
        : url.endsWith("=eel")
          ? Response.json(results({ q: "eel" }))
          : Response.json(results({ q: "hello" }, [message("m1", general, "Hello one")], { next: 1 })),
    );
    showPage(searchPath({ q: "hello" }));
    await cards();
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    act(() => navigate(searchPath({ q: "eel" })));
    expect(await screen.findByRole("heading", { name: "No messages found" })).toBeVisible();
    await page.answer(Response.json(results({ q: "hello" }, [message("m2", general, "Hello two")])));
    expect(screen.getByRole("heading", { name: "No messages found" })).toBeVisible();
  });

  it("shows what the search box's search found without asking again, giving focus to how many it found", async () => {
    serve(() => Response.json(results({ q: "hello" })));
    keepAnswer({ q: "hello" }, "newest", results({ q: "hello" }, [message("m1", general, "Hello there")]));
    showPage(searchPath({ q: "hello" }));
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent("1 result");
    expect(heading).toHaveFocus();
    expect(requests()).toEqual([]);

    // Back, Forward, or the same address again, ask afresh.
    act(() => navigate(searchPath({ q: "hello" })));
    expect(await screen.findByRole("heading", { name: "No messages found" })).not.toHaveFocus();
    expect(requests()).toEqual([["GET", "/api/searches?q=hello"]]);
  });
});

describe("Search filters", () => {
  it("turns each filter on and off as its chip is pressed, keeping the order the results are sorted in", async () => {
    serve(() => Response.json(results({ q: "eel" })));
    const { user } = showPage(searchPath({ q: "eel" }, "oldest"));
    await screen.findByRole("heading", { name: "No messages found" });
    expect(within(filters()!).getAllByRole("button").map((button) => [button.textContent, button.getAttribute("aria-pressed")])).toEqual([
      ["From me", "false"],
      ["Includes me", "false"],
      ["Has a link", "false"],
      ["Has a file", "false"],
      ["Threads only", "false"],
    ]);

    await user.click(chip("Has a link"));
    expect(here()).toBe("/searches?q=eel&has=link&sort=oldest");
    expect(chip("Has a link")).toHaveAttribute("aria-pressed", "true");
    await user.click(chip("From me"));
    expect(here()).toBe("/searches?q=eel&from=u1&has=link&sort=oldest");
    expect(chip("From me")).toHaveAttribute("aria-pressed", "true");
    await user.click(chip("Has a link"));
    await user.click(chip("From me"));
    expect(here()).toBe("/searches?q=eel&sort=oldest");
    await waitFor(() => expect(requests()).toHaveLength(5));
    expect(requests().map(([, url]) => url)).toEqual([
      "/api/searches?q=eel&sort=oldest",
      "/api/searches?q=eel&has=link&sort=oldest",
      "/api/searches?q=eel&from=u1&has=link&sort=oldest",
      "/api/searches?q=eel&from=u1&sort=oldest",
      "/api/searches?q=eel&sort=oldest",
    ]);
  });

  it("shows the room and person a search is narrowed to as chips that take them off, before the rest", async () => {
    serve(() => Response.json(results({ q: "eel" })));
    const { user } = showPage(searchPath({ q: "eel", in: "general", from: grace.id, hasFile: true }), { people: withGrace });
    await screen.findByRole("heading", { name: "No messages found" });
    expect(within(filters()!).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
      "Remove in:general",
      "Remove from:Grace Hopper",
      "From me",
      "Includes me",
      "Has a link",
      "Has a file",
      "Threads only",
    ]);
    expect(changeSearch()).toHaveAccessibleName("Change search: in:general from:Grace Hopper Has a file eel");

    await user.click(chip("Remove in:general"));
    expect(here()).toBe("/searches?q=eel&from=u2&has=file");
    await user.click(chip("Remove from:Grace Hopper"));
    expect(here()).toBe("/searches?q=eel&has=file");
    // A search can be made of filters alone.
    act(() => navigate(searchPath({ q: "", in: "gone", from: ada.id })));
    await waitFor(() => expect(chip("Remove in:an unknown room")).toBeInTheDocument());
    expect(chip("From me")).toHaveAttribute("aria-pressed", "true");
    expect(within(filters()!).queryByRole("button", { name: /^Remove from:/ })).toBeNull();
  });

  it("sorts the results newest first, or oldest first, as its menu says", async () => {
    serve(() => Response.json(results({ q: "eel" })));
    const { user } = showPage(searchPath({ q: "eel" }));
    await screen.findByRole("heading", { name: "No messages found" });
    await user.click(screen.getByRole("button", { name: "Sort: Newest first" }));
    expect(screen.getByRole("menuitemradio", { name: "Newest first" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemradio", { name: "Oldest first" }));
    expect(here()).toBe("/searches?q=eel&sort=oldest");
    expect(await screen.findByRole("button", { name: "Sort: Oldest first" })).toBeInTheDocument();
    await waitFor(() => expect(requests().map(([, url]) => url)).toEqual(["/api/searches?q=eel", "/api/searches?q=eel&sort=oldest"]));
  });
});

describe("Recent searches", () => {
  it("lists your recent searches on the page without a search, newest first, each going to its results", async () => {
    const recent: Search[] = [{ q: "hello  world" }, { q: "café", in: "general" }, { q: "", hasLink: true }];
    serve((_, url) => Response.json(url === "/api/searches?q=" ? results(null, [], { recent }) : results({ q: "café", in: "general" })));
    const { user } = showPage("/searches");
    await screen.findByRole("heading", { name: "Find a conversation" });
    const links = within(recents()!).getAllByRole("link");
    expect(links.map((link) => [link.getAttribute("aria-label"), link.getAttribute("href")])).toEqual([
      ["hello  world", "/searches?q=hello++world"],
      ["in:general café", "/searches?q=caf%C3%A9&in=general"],
      ["Has a link", "/searches?q=&has=link"],
    ]);

    await user.click(links[1]!);
    expect(here()).toBe("/searches?q=caf%C3%A9&in=general");
    expect(await screen.findByRole("heading", { name: "No messages found" })).toBeVisible();
    expect(recents()).toBeNull();
    expect(requests()).toEqual([
      ["GET", "/api/searches?q="],
      ["GET", "/api/searches?q=caf%C3%A9&in=general"],
    ]);
  });

  it("clears them once you confirm, going to the page without a search", async () => {
    let recent: Search[] = [{ q: "eel" }, { q: "hello" }];
    serve((method) => {
      if (method !== "DELETE") return Response.json(results(null, [], { recent }));
      recent = [];
      return new Response(null, { status: 204 });
    });
    const sure = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user } = showPage("/searches");
    await screen.findByRole("heading", { name: "Find a conversation" });
    await user.click(within(recents()!).getByRole("button", { name: "Clear recent searches" }));
    expect(sure).toHaveBeenCalledExactlyOnceWith(CONFIRM_CLEAR_SEARCHES);
    expect(requests()).toEqual([["GET", "/api/searches?q="]]);

    await user.click(within(recents()!).getByRole("button", { name: "Clear recent searches" }));
    await waitFor(() => expect(recents()).toBeNull());
    expect(here()).toBe("/searches");
    expect(screen.getByRole("heading", { name: "Find a conversation" })).toBeVisible();
    expect(requests()).toEqual([
      ["GET", "/api/searches?q="],
      ["DELETE", "/api/searches"],
      ["GET", "/api/searches?q="],
    ]);
  });
});
