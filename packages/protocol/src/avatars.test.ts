import { describe, expect, it } from "vitest";
import { avatarColor, avatarSvg, crc32, initials } from "./avatars.ts";

// Rails' own renderings of Campfire's users/avatars/show.svg, for user 127326141, "David", and user
// 773523956, "Anna Bea Cole".
const DAVID =
  "<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\"\n  viewBox=\"0 0 512 512\" class=\"avatar\" aria-hidden=\"true\">\n  <defs>\n    <clipPath id=\"porthole\">\n      <circle cx=\"50%\" cy=\"50%\" r=\"50%\" />\n    </clipPath>\n  </defs>\n\n  <g>\n    <rect width=\"100%\" height=\"100%\" rx=\"50\" fill=\"#736356\" />\n\n    <text x=\"50%\" y=\"50%\" fill=\"#FFFFFF\"\n      text-anchor=\"middle\" dy=\"0.35em\"\n      \n      font-family=\"-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif\"\n      font-size=\"230\"\n      font-weight=\"800\"\n      letter-spacing=\"-5\">\n      D\n    </text>\n  </g>\n</svg>\n";
const THREE_INITIALS =
  "<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\"\n  viewBox=\"0 0 512 512\" class=\"avatar\" aria-hidden=\"true\">\n  <defs>\n    <clipPath id=\"porthole\">\n      <circle cx=\"50%\" cy=\"50%\" r=\"50%\" />\n    </clipPath>\n  </defs>\n\n  <g>\n    <rect width=\"100%\" height=\"100%\" rx=\"50\" fill=\"#5D618F\" />\n\n    <text x=\"50%\" y=\"50%\" fill=\"#FFFFFF\"\n      text-anchor=\"middle\" dy=\"0.35em\"\n      textLength=\"85%\" lengthAdjust=\"spacingAndGlyphs\"\n      font-family=\"-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif\"\n      font-size=\"230\"\n      font-weight=\"800\"\n      letter-spacing=\"-5\">\n      ABC\n    </text>\n  </g>\n</svg>\n";

describe("Initials avatars", () => {
  it("picks colors with zlib's CRC32 of the id", () => {
    expect(crc32("1")).toBe(0x83dcefb7);
    expect(["1", "2", "42", "1000"].map(avatarColor)).toEqual(["#BF7C2A", "#698F9C", "#D07B53", "#BFA07A"]);
  });

  it("reads ids as UTF-8, as TextEncoder encodes them", () => {
    // Python's zlib.crc32 of the same bytes.
    expect(crc32("é")).toBe(0x0e048d3e);
    expect(crc32("€")).toBe(0x83f2c8d6);
    expect(crc32("😀")).toBe(0x054db544);
    expect(crc32("\ud800")).toBe(crc32("\ufffd"));
  });

  it("takes every ASCII letter, digit or underscore that starts a word in any script", () => {
    expect(initials("David Heinemeier Hansson")).toBe("DHH");
    expect(initials("Élodie Ünal-Smith o'Brien 3po _x ñ")).toBe("SoB3_");
    expect(initials("grace")).toBe("g");
    expect(initials("Élodie")).toBe("");
  });

  it("keeps them all, however many", () => {
    expect(initials("Ada Byron King Lovelace Countess")).toBe("ABKLC");
  });

  it("draws them byte for byte, squeezing three or more", () => {
    expect(avatarSvg("127326141", "David")).toBe(DAVID);
    expect(avatarSvg("773523956", "Anna Bea Cole")).toBe(THREE_INITIALS);
  });

  it("draws a plain tile for a name with no initials", () => {
    expect(avatarSvg("127326141", "Élodie")).toBe(DAVID.replace("\n      D\n", "\n      \n"));
  });
});
