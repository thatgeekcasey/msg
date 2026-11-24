import { searchPath, type DirectoryUser, type Me, type Room, type User } from "@ember/protocol";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { recordVisit } from "@/hooks/use-page-history";
import { HistoryMenu } from "./history-menu";

const ada: Me = { id: "u1", name: "Ada Lovelace", administrator: false };
const grace: User = { id: "u2", name: "Grace Hopper" };
const general: Room = { id: "general", name: "general", kind: "open", icon: null };
const design: Room = { id: "design", name: "Design", kind: "closed", icon: "palette" };
const direct: Room = { id: "direct-1", kind: "direct", members: [{ id: ada.id, name: ada.name }, grace], activeAt: "2026-10-15T12:00:00.000Z" };
const people: People = new Map([[grace.id, { ...grace, bio: null, role: "member", status: "active", avatarUrl: "/users/u2/avatar" } satisfies DirectoryUser]]);

const NOW = new Date(2026, 10, 20, 15, 0);
const MINUTE = 60_000;

/** `me`'s visit to `address`, `ago` milliseconds before now. */
const visited = (address: string, ago: number, me = ada) => recordVisit(me.id, address, NOW.getTime() - ago);

/** History's clock, as `me` sees it on the page at `address`, with the sidebar listing general, Design and Ada's DM with Grace. */
function showClock(address = "/rooms/general", me = ada) {
  history.replaceState(null, "", address);
  render(
    <PeopleContext value={people}>
      <HistoryMenu me={me} rooms={[general, design, direct]} />
    </PeopleContext>,
  );
  return { clock: screen.getByRole("button", { name: "History" }), user: userEvent.setup() };
}

/** Opens History from its clock, and says what it lists, each as its label and how long ago. */
async function opened({ clock, user }: ReturnType<typeof showClock>) {
  await user.click(clock);
  const menu = await screen.findByRole("menu", { name: "History" });
  return { menu, listed: within(menu).queryAllByRole("menuitem").map((item) => [item.children[1]!.textContent, item.querySelector("time")!.textContent]) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});

describe("History", () => {
  it("lists the pages you've visited lately, newest first, with how long ago, leaving out the one shown", async () => {
    visited("/rooms/general", 3 * 24 * 60 * MINUTE);
    visited("/rooms/design", 26 * 60 * MINUTE);
    visited("/rooms/direct-1", 2 * 60 * MINUTE);
    visited("/rooms/general", 5 * MINUTE);
    visited("/huddles", 30_000);
    const { menu, listed } = await opened(showClock());
    expect(listed).toEqual([
      ["Huddles", "Just now"],
      ["Grace Hopper", "2 hr"],
      ["Design", "Yesterday"],
    ]);
    expect(menu).toHaveClass("w-[320px]", "bg-background");
    expect(within(menu).getByText("History")).toHaveClass("text-xs", "text-muted-foreground");
    const [huddles] = within(menu).getAllByRole("menuitem");
    expect(huddles!.querySelector("time")).toHaveAttribute("dateTime", new Date(NOW.getTime() - 30_000).toISOString());
  });

  it("says how long ago each was as it opens, however long the page has shown", async () => {
    visited("/huddles", 30_000);
    const shown = showClock();
    expect((await opened(shown)).listed).toEqual([["Huddles", "Just now"]]);
    await shown.user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    vi.setSystemTime(NOW.getTime() + 2 * 60 * MINUTE);
    expect((await opened(shown)).listed).toEqual([["Huddles", "2 hr"]]);
  });

  it("names a thread by its room or the people in its DM, a search by its filters and words, and someone by their name, as their pages are titled", async () => {
    visited("/users/u2", 4 * MINUTE);
    visited(searchPath({ q: "release notes", in: "general", hasLink: true }), 3 * MINUTE);
    visited("/rooms/general/threads/m1", 2 * MINUTE);
    visited("/rooms/direct-1/threads/m2", MINUTE);
    const { menu, listed } = await opened(showClock("/huddles"));
    expect(listed.map(([label]) => label)).toEqual(["Thread with Grace Hopper", "Thread in general", "“in:general Has a link release notes”", "Grace Hopper"]);
    // Each marked as the sidebar marks it: a DM by the face of the other person in it, a room by its icon.
    const marks = within(menu).getAllByRole("menuitem").map((item) => item.firstElementChild!);
    expect(marks[0]!.querySelector("img")).toHaveAttribute("src", "/users/u2/avatar");
    expect(marks[1]).toHaveTextContent(/^#$/);
    expect(marks[2]!.querySelector("svg")).toHaveClass("iconoir-search");
    expect(marks[3]!.querySelector("img")).toHaveAttribute("src", "/users/u2/avatar");
  });

  it("leaves out a room or DM the sidebar no longer lists, someone unknown, and an address that names nothing it lists", async () => {
    visited("/rooms/left", 4 * MINUTE);
    visited("/users/u9", 3 * MINUTE);
    visited("/account/edit", 2 * MINUTE);
    visited("/rooms/design", MINUTE);
    const { menu, listed } = await opened(showClock());
    expect(listed).toEqual([["Design", "1 min"]]);
    expect(within(menu).getByRole("menuitem").firstElementChild!.querySelector("[data-icon]")).toHaveAttribute("data-icon", "palette");
  });

  it("goes to a page it lists, in place, and closes", async () => {
    visited("/rooms/design", MINUTE);
    const shown = showClock();
    const { menu } = await opened(shown);
    const length = history.length;
    const design = within(menu).getByRole("menuitem", { name: /^Design/ });
    expect(design).toHaveAttribute("href", "/rooms/design");
    await shown.user.click(design);
    expect(location.pathname).toBe("/rooms/design");
    expect(history.length).toBe(length + 1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("says what it lists while it has nothing to", async () => {
    const charles: Me = { id: "u3", name: "Charles Babbage", administrator: false };
    const { menu, listed } = await opened(showClock("/rooms/general", charles));
    expect(listed).toEqual([]);
    expect(menu).toHaveTextContent("Rooms, DMs and searches you visit show up here.");
  });

  it("lists what another tab visits as it does", async () => {
    visited("/rooms/design", 2 * MINUTE);
    const shown = showClock();
    act(() => {
      localStorage.setItem("ember:history:u1", JSON.stringify([{ address: "/huddles", at: NOW.getTime() - MINUTE }, { address: "/rooms/design", at: NOW.getTime() - 2 * MINUTE }]));
      window.dispatchEvent(new StorageEvent("storage", { key: "ember:history:u1", newValue: localStorage.getItem("ember:history:u1") }));
    });
    const { listed } = await opened(shown);
    expect(listed.map(([label]) => label)).toEqual(["Huddles", "Design"]);
  });
});
