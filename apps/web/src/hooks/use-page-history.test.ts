import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_KEPT, historyAddressOf, mergedVisits, recordVisit, usePageHistory, withVisit } from "./use-page-history";

/** Another tab's History for `userId`, as it writes it to storage, and tells this one. */
function recordedInAnotherTab(userId: string, visits: unknown) {
  const key = `ember:history:${userId}`;
  localStorage.setItem(key, JSON.stringify(visits));
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: localStorage.getItem(key) }));
}

const refuseStorage = () => {
  const refused = () => {
    throw new DOMException("Refused", "SecurityError");
  };
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(refused);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(refused);
};

afterEach(() => vi.restoreAllMocks());

describe("The pages History keeps", () => {
  it("keeps a room's or DM's address, a thread's, someone's page, Huddles, and a search's without its order", () => {
    expect(historyAddressOf({ page: "room", roomId: "r1" }, "")).toBe("/rooms/r1");
    // A permalink keeps its room's, a reply's its thread's, and a huddle's link its room's.
    expect(historyAddressOf({ page: "room", roomId: "r1", messageId: "m1" }, "")).toBe("/rooms/r1");
    expect(historyAddressOf({ page: "room", roomId: "r1", threadId: "m1", replyId: "m2" }, "")).toBe("/rooms/r1/threads/m1");
    expect(historyAddressOf({ page: "room", roomId: "r1", huddle: true }, "")).toBe("/rooms/r1");
    expect(historyAddressOf({ page: "person", userId: "u2" }, "")).toBe("/users/u2");
    expect(historyAddressOf({ page: "huddles" }, "")).toBe("/huddles");
    expect(historyAddressOf({ page: "search" }, "?q=++release++notes&sort=oldest&cursor=40")).toBe("/searches?q=release+notes");
    expect(historyAddressOf({ page: "search" }, "?q=&in=r1")).toBe("/searches?q=&in=r1");
  });

  it("leaves out an empty search, settings, and the pages that go on to another", () => {
    expect(historyAddressOf({ page: "search" }, "")).toBeNull();
    expect(historyAddressOf({ page: "search" }, "?q=+++")).toBeNull();
    expect(historyAddressOf({ page: "workspace-settings" }, "")).toBeNull();
    expect(historyAddressOf({ page: "profile" }, "")).toBeNull();
    expect(historyAddressOf({ page: "home" }, "")).toBeNull();
    expect(historyAddressOf({ page: "message", roomId: "r1", messageId: "m1" }, "")).toBeNull();
  });
});

describe("History's list", () => {
  it("lists the newest visit first, and each page once, keeping the newest twenty", () => {
    const visits = withVisit(withVisit(withVisit([], "/rooms/r1", 1), "/rooms/r2", 2), "/rooms/r1", 3);
    expect(visits).toEqual([
      { address: "/rooms/r1", at: 3 },
      { address: "/rooms/r2", at: 2 },
    ]);
    const full = Array.from({ length: HISTORY_KEPT }, (_, i) => ({ address: `/rooms/r${i}`, at: 100 - i }));
    const added = withVisit(full, "/huddles", 101);
    expect(added).toHaveLength(HISTORY_KEPT);
    expect(added[0]).toEqual({ address: "/huddles", at: 101 });
    expect(added.at(-1)).toEqual({ address: "/rooms/r18", at: 82 });
  });

  it("merges two lists, each page once at its latest visit, newest first, keeping the newest twenty", () => {
    const here = [
      { address: "/rooms/r2", at: 2 },
      { address: "/rooms/r1", at: 1 },
    ];
    const there = [
      { address: "/rooms/r1", at: 3 },
      { address: "/huddles", at: 0 },
    ];
    expect(mergedVisits(here, there)).toEqual([
      { address: "/rooms/r1", at: 3 },
      { address: "/rooms/r2", at: 2 },
      { address: "/huddles", at: 0 },
    ]);
    const full = Array.from({ length: HISTORY_KEPT }, (_, i) => ({ address: `/rooms/r${i}`, at: 100 - i }));
    expect(mergedVisits(full, [{ address: "/huddles", at: 50 }])).toEqual(full);
  });

  it("keeps each person's apart, in this browser, which every tab adds to", () => {
    const { result } = renderHook(() => usePageHistory("u1"));
    expect(result.current).toEqual([]);
    act(() => recordVisit("u1", "/rooms/r1", 1000));
    act(() => recordVisit("u2", "/rooms/r2", 2000));
    expect(result.current).toEqual([{ address: "/rooms/r1", at: 1000 }]);
    expect(JSON.parse(localStorage.getItem("ember:history:u1")!)).toEqual([{ address: "/rooms/r1", at: 1000 }]);

    act(() => recordedInAnotherTab("u1", [{ address: "/huddles", at: 3000 }, { address: "/rooms/r1", at: 1000 }]));
    expect(result.current.map(({ address }) => address)).toEqual(["/huddles", "/rooms/r1"]);
    // A visit here goes over what the other tab listed.
    act(() => recordVisit("u1", "/rooms/r3", 4000));
    expect(result.current.map(({ address }) => address)).toEqual(["/rooms/r3", "/huddles", "/rooms/r1"]);
    // Clearing the site's storage clears it.
    localStorage.clear();
    act(() => void window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(result.current).toEqual([]);
  });

  it("leaves out what it can't read as a visit", () => {
    localStorage.setItem("ember:history:u3", "{not json");
    expect(renderHook(() => usePageHistory("u3")).result.current).toEqual([]);
    localStorage.setItem("ember:history:u4", JSON.stringify([{ address: "/rooms/r1", at: 1 }, { address: "https://example.com/", at: 2 }, { address: "/huddles" }, "/rooms/r2"]));
    expect(renderHook(() => usePageHistory("u4")).result.current).toEqual([{ address: "/rooms/r1", at: 1 }]);
  });

  it("keeps and stores this tab's visits that another tab's list lacks, from both recording one at once", () => {
    const { result } = renderHook(() => usePageHistory("u8"));
    act(() => recordVisit("u8", "/rooms/r1", 1000));
    act(() => recordVisit("u8", "/rooms/r2", 2000));
    // The other tab had r1 alone when it recorded Huddles, before hearing of r2.
    act(() => recordedInAnotherTab("u8", [{ address: "/huddles", at: 2500 }, { address: "/rooms/r1", at: 1000 }]));
    expect(result.current.map(({ address }) => address)).toEqual(["/huddles", "/rooms/r2", "/rooms/r1"]);
    expect(JSON.parse(localStorage.getItem("ember:history:u8")!)).toEqual(result.current);
    // A list lacking nothing this tab holds, as the other tab's is once it has heard this one's, isn't stored
    // again, so the two don't answer each other back and forth.
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    act(() => void window.dispatchEvent(new StorageEvent("storage", { key: "ember:history:u8", newValue: JSON.stringify(result.current) })));
    expect(setItem).not.toHaveBeenCalled();
    expect(result.current.map(({ address }) => address)).toEqual(["/huddles", "/rooms/r2", "/rooms/r1"]);

    // A list another tab removes is gone.
    act(() => {
      localStorage.removeItem("ember:history:u8");
      window.dispatchEvent(new StorageEvent("storage", { key: "ember:history:u8", newValue: null }));
    });
    expect(result.current).toEqual([]);
  });

  it("goes on listing what this tab shows once storage is full", () => {
    const { result } = renderHook(() => usePageHistory("u6"));
    act(() => recordVisit("u6", "/rooms/r1", 1000));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    act(() => recordVisit("u6", "/rooms/r2", 2000));
    act(() => recordVisit("u6", "/rooms/r3", 3000));
    expect(result.current.map(({ address }) => address)).toEqual(["/rooms/r3", "/rooms/r2", "/rooms/r1"]);
    expect(JSON.parse(localStorage.getItem("ember:history:u6")!)).toEqual([{ address: "/rooms/r1", at: 1000 }]);
  });

  it("reads storage again after nothing here listened, while other tabs may have listed more", () => {
    const shown = renderHook(() => usePageHistory("u7"));
    act(() => recordVisit("u7", "/rooms/r1", 1000));
    shown.unmount();
    localStorage.setItem("ember:history:u7", JSON.stringify([{ address: "/huddles", at: 2000 }, { address: "/rooms/r1", at: 1000 }]));
    expect(renderHook(() => usePageHistory("u7")).result.current.map(({ address }) => address)).toEqual(["/huddles", "/rooms/r1"]);
  });

  it("lists what this tab showed where storage is refused", () => {
    refuseStorage();
    const { result } = renderHook(() => usePageHistory("u5"));
    act(() => recordVisit("u5", "/rooms/r1", 1000));
    act(() => recordVisit("u5", "/rooms/r2", 2000));
    expect(result.current.map(({ address }) => address)).toEqual(["/rooms/r2", "/rooms/r1"]);
  });
});
