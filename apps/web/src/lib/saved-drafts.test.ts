import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepSavedDrafts, keepsDrafts, readSavedDrafts, savedDraft } from "./saved-drafts";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Drafts put aside", () => {
  it("keeps a conversation's drafts beside the one being written there, and reads them newest first", () => {
    const [older, newer] = [{ id: "a", body: "<p>Older</p>", savedAt: 1 }, { id: "b", body: "<p>Newer</p>", savedAt: 2 }];
    expect(keepSavedDrafts("composer-draft-u1-r1", [older, newer])).toBe(true);
    expect(readSavedDrafts("composer-draft-u1-r1")).toEqual([newer, older]);
    expect(localStorage.getItem("composer-draft-u1-r1/saved")).toBe(JSON.stringify([older, newer]));
    expect(readSavedDrafts("composer-draft-u1-r2")).toEqual([]);

    // Keeping none takes them out of storage.
    expect(keepSavedDrafts("composer-draft-u1-r1", [])).toBe(true);
    expect(localStorage.getItem("composer-draft-u1-r1/saved")).toBeNull();
  });

  it("reads none from what doesn't read as drafts, and leaves out what isn't one", () => {
    for (const held of ["not json", "{}", "null"]) {
      localStorage.setItem("composer-draft-u1-r1/saved", held);
      expect(readSavedDrafts("composer-draft-u1-r1"), held).toEqual([]);
    }
    const draft = { id: "a", body: "<p>Kept</p>", savedAt: 1 };
    localStorage.setItem("composer-draft-u1-r1/saved", JSON.stringify([draft, null, { id: "b", body: 1, savedAt: 2 }, "c"]));
    expect(readSavedDrafts("composer-draft-u1-r1")).toEqual([draft]);
  });

  it("makes a draft put aside now, with an id of its own", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const [one, other] = [savedDraft("<p>One</p>"), savedDraft("<p>One</p>")];
    expect(one).toEqual({ id: expect.any(String), body: "<p>One</p>", savedAt: 1234 });
    expect(other.id).not.toBe(one.id);
  });

  it("keeps drafts where storage is full, which still holds those put aside, though no more fit", () => {
    const draft = { id: "a", body: "<p>Kept</p>", savedAt: 1 };
    expect(keepSavedDrafts("composer-draft-u1-r1", [draft])).toBe(true);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    expect(keepsDrafts()).toBe(true);
    expect(readSavedDrafts("composer-draft-u1-r1")).toEqual([draft]);
    expect(keepSavedDrafts("composer-draft-u1-r1", [savedDraft("<p>More</p>"), draft])).toBe(false);
  });

  it("keeps and reads nothing where storage is unavailable, and says so", () => {
    expect(keepsDrafts()).toBe(true);
    const refuse = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: refuse, setItem: refuse, removeItem: refuse });
    expect(keepsDrafts()).toBe(false);
    expect(keepSavedDrafts("composer-draft-u1-r1", [savedDraft("<p>Lost</p>")])).toBe(false);
    expect(readSavedDrafts("composer-draft-u1-r1")).toEqual([]);
  });
});
