import { describe, expect, it } from "vitest";
import { FixedWindowLimit } from "../src/rate-limit";

describe("Sign-in attempt limit", () => {
  it("counts each key in a fixed window that starts at its first attempt", () => {
    const limit = new FixedWindowLimit(2, 1_000);
    expect(limit.attempt("a", 0)).toBe(true);
    expect(limit.attempt("a", 500)).toBe(true);
    expect(limit.attempt("a", 999)).toBe(false);
    expect(limit.attempt("b", 999)).toBe(true);

    // a's window ends at 1,000 however many attempts it saw; b's runs to 1,999.
    expect(limit.attempt("a", 1_000)).toBe(true);
    expect(limit.attempt("b", 1_500)).toBe(true);
    expect(limit.attempt("b", 1_998)).toBe(false);
    expect(limit.attempt("b", 1_999)).toBe(true);
    expect(limit.attempt("a", 1_999)).toBe(true);
    expect(limit.attempt("a", 1_999)).toBe(false);
  });
});
