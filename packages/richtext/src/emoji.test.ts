import { describe, expect, it } from "vitest";
import { isAllEmoji } from "./emoji";

describe("Emoji-only messages", () => {
  it("is only emoji, as Ruby's regexp reads it", () => {
    for (const text of ["😄🤘", "👍", "❤️", "👍🏽", "🇨🇦", "©", "™"]) expect(isAllEmoji(text), text).toBe(true);
    for (const text of ["Haha! 😄🤘", "🔥 💯", "", "👨‍👩‍👧", "1️⃣", "😄\n"]) expect(isAllEmoji(text), text).toBe(false);
  });

  it("reads a run of emoji before other text in a moment", () => {
    const started = Date.now();
    // Each is both properties Campfire's pattern alternates between, and V8 trying each for every one of these
    // took half a minute, twice that with one more.
    expect(isAllEmoji(`${"🎉".repeat(28)} Shipped!`)).toBe(false);
    expect(isAllEmoji("🎉".repeat(5_000))).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
