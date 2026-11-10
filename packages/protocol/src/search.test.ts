import { describe, expect, it } from "vitest";
import {
  hasFilters,
  isSearchable,
  MAX_SEARCH_LENGTH,
  normalizedSearch,
  parseSearch,
  sanitizeSearch,
  SEARCH_TOO_LONG,
  searchKey,
  searchOfQuery,
  searchPath,
  searchQuery,
  searchTerms,
  type Search,
  type SearchParams,
} from "./index";

// The package is typed without the web's globals, which the tests have.
declare const URLSearchParams: new (init: string) => SearchParams;

describe("Search messages", () => {
  it("turns every character but a word's into a space, one each", () => {
    expect(sanitizeSearch("héllo wörld_1 ２ 日本語 ‿ a-b \u{fe0f} ❤ é")).toBe("héllo wörld_1 ２ 日本語 ‿ a b \u{fe0f}   é");
    expect(sanitizeSearch('"quoted" OR NEAR(x*)')).toBe(" quoted  OR NEAR x  ");
    expect(sanitizeSearch("hello, world!")).toBe("hello  world ");
    expect(sanitizeSearch("café_1 日本")).toBe("café_1 日本");
    expect(sanitizeSearch('"quoted" AND-x')).toBe(" quoted  AND x");
    expect(sanitizeSearch("")).toBe("");
  });

  it("keeps the characters Onigmo calls word characters, and no others", () => {
    for (const c of ["a", "Z", "0", "_", "é", "ß", "日", "‿", "\u{0301}", "٣", "ǅ", "ʰ", "Ⅻ", "Ⓐ", "\u{200d}"]) expect(sanitizeSearch(c), c).toBe(c);
    for (const c of [" ", "-", "*", '"', "\u{a0}", "❤", "€", "½", "²", "\0", "😀"]) expect(sanitizeSearch(c), c).toBe(" ");
  });

  it("searches only for words with a word left in them once they're sanitized, or with a filter", () => {
    expect(isSearchable({ q: "eels" })).toBe(true);
    for (const q of ["", "   ", "!!!", "😀 ❤", "\0"]) expect(isSearchable({ q }), q).toBe(false);
    for (const filter of [{ in: "room" }, { from: "ada" }, { withMe: true }, { hasLink: true }, { hasFile: true }, { inThread: true }] as const) {
      expect(isSearchable({ q: "!!!", ...filter }), JSON.stringify(filter)).toBe(true);
      expect(hasFilters(filter)).toBe(true);
    }
    expect(hasFilters({})).toBe(false);
  });

  it("quotes each word, so that every word has to match and none is FTS5's syntax", () => {
    expect(searchTerms("NOT eel")).toBe('"NOT" "eel"');
    expect(searchTerms("  hello  world ")).toBe('"hello" "world"');
    expect(searchTerms('say "hi"')).toBe('"say" """hi"""');
    expect(searchTerms("eel\0shark")).toBe('"eel" "shark"');
    expect(searchTerms("")).toBe("");
  });
});

describe("A search's address", () => {
  it("gives a search's address, spaces as + and everything else escaped", () => {
    expect(searchPath({ q: "hello  world" })).toBe("/searches?q=hello++world");
    expect(searchPath({ q: "café_1 日本" })).toBe("/searches?q=caf%C3%A9_1+%E6%97%A5%E6%9C%AC");
    expect(searchPath({ q: "C++ & co" })).toBe("/searches?q=C%2B%2B+%26+co");
    expect(searchPath({ q: "" })).toBe("/searches?q=");
  });

  it("names a search's filters, its order and its page, unless they're the first, newest first", () => {
    const search: Search = { q: "eel", in: "room1", from: "ada", withMe: true, hasLink: true, hasFile: true, inThread: true };
    expect(searchQuery(search)).toBe("q=eel&in=room1&from=ada&with=me&has=link&has=file&is=thread");
    expect(searchPath({ q: "eel", hasFile: true }, "oldest")).toBe("/searches?q=eel&has=file&sort=oldest");
    expect(searchQuery({ q: "eel" }, "newest", 42)).toBe("q=eel&cursor=42");
  });

  it("reads the search an address names back, leaving out what it doesn't know", () => {
    const search: Search = { q: "eel pie", in: "room1", from: "ada", withMe: true, hasLink: true, hasFile: true, inThread: true };
    expect(searchOfQuery(new URLSearchParams(searchQuery(search, "oldest", 42)))).toEqual({ search, sort: "oldest", cursor: 42 });
    expect(searchOfQuery(new URLSearchParams("q=eel&has=pin&with=you&is=starred&sort=best&cursor=soon&in=&from=" + "x".repeat(65)))).toEqual({ search: { q: "eel" }, sort: "newest", cursor: null });
    expect(searchOfQuery(new URLSearchParams(""))).toEqual({ search: { q: "" }, sort: "newest", cursor: null });
  });
});

describe("Recent searches", () => {
  it("tells searches apart by their words, spaces made one, and the filters they have on", () => {
    expect(normalizedSearch({ q: "  eel   pie ", hasLink: undefined, inThread: true, from: "ada", in: "room1" })).toEqual({ q: "eel pie", in: "room1", from: "ada", inThread: true });
    expect(searchKey({ q: "eel  pie", inThread: true, from: "ada" })).toBe('{"q":"eel pie","from":"ada","inThread":true}');
    expect(searchKey({ q: "eel" })).toBe(searchKey({ q: " eel " }));
    expect(searchKey({ q: "eel" })).not.toBe(searchKey({ q: "Eel" }));
  });

  it("takes a search that's text, of up to 1,000 characters, with its filters and order, to record", () => {
    expect(parseSearch({ q: "eels" })).toEqual({ search: { q: "eels" }, sort: "newest" });
    expect(parseSearch({ q: "" })).toEqual({ search: { q: "" }, sort: "newest" });
    expect(parseSearch({ q: "e".repeat(MAX_SEARCH_LENGTH) })).toEqual({ search: { q: "e".repeat(MAX_SEARCH_LENGTH) }, sort: "newest" });
    expect(parseSearch({ q: "eel", in: "room1", from: "ada", withMe: true, hasLink: false, hasFile: true, inThread: true, sort: "oldest", page: 2 })).toEqual({
      search: { q: "eel", in: "room1", from: "ada", withMe: true, hasFile: true, inThread: true },
      sort: "oldest",
    });
    expect(parseSearch({ q: "e".repeat(MAX_SEARCH_LENGTH + 1) })).toBe(SEARCH_TOO_LONG);
    for (const data of [null, undefined, "eels", 5, [], {}, { q: 5 }, { q: null }, { q: ["eels"] }]) expect(parseSearch(data), JSON.stringify(data)).toBe("Searches have to be text");
    expect(parseSearch({ q: "eel", in: 5 })).toBe("A search can only be in a room");
    expect(parseSearch({ q: "eel", from: "" })).toBe("A search can only be from a person");
    expect(parseSearch({ q: "eel", withMe: "yes" })).toBe("A search's filters are on or off");
    expect(parseSearch({ q: "eel", sort: "best" })).toBe("Search results are sorted by newest or oldest");
  });
});
