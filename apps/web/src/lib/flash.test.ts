import { afterEach, describe, expect, it, vi } from "vitest";
import { flashOnNextPage, takeFlashFromLastPage } from "./flash";
import { loadPage } from "./page";

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("Saved notices", () => {
  it("keeps a message for the next page this tab loads, once", () => {
    flashOnNextPage({ kind: "notice", text: "✓" });
    expect(takeFlashFromLastPage()).toEqual({ kind: "notice", text: "✓" });
    expect(takeFlashFromLastPage()).toBeNull();
  });

  it("carries one across the page it loads", () => {
    loadPage("/session/new", { kind: "alert", text: "Room not found or inaccessible" });
    expect(takeFlashFromLastPage()).toEqual({ kind: "alert", text: "Room not found or inaccessible" });
  });

  it("ignores anything else kept under its name", () => {
    for (const stored of ["not JSON", "null", '"✓"', '{"kind":"warning","text":"✓"}', '{"kind":"notice"}']) {
      sessionStorage.setItem("ember:flash", stored);
      expect(takeFlashFromLastPage()).toBeNull();
      expect(sessionStorage.getItem("ember:flash")).toBeNull();
    }
  });

  it("does without when storage is refused", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Refused", "SecurityError");
    });
    expect(() => flashOnNextPage({ kind: "notice", text: "✓" })).not.toThrow();
    expect(takeFlashFromLastPage()).toBeNull();
  });
});
