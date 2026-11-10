import type { SearchResults } from "@ember/protocol";
import { describe, expect, it } from "vitest";
import { flagNamed, keepAnswer, marksFor, modifierTyped, sameSearch, takeAnswer, withoutFlag, withoutFromMe, withTypedFilters } from "./search";

/** What `marks` marks in `text`. */
const marked = (marks: RegExp | null, text: string) => [...text.matchAll(marks!)].map((match) => match[0]);

/** What a search for "eel" answers when it finds nothing. */
const answer = (): SearchResults => ({ search: { q: "eel" }, matches: [], next: null, rooms: [], recent: [] });

describe("Modifiers as they're typed", () => {
  it("finds the modifier being typed at the end of the words, after a space or at the start", () => {
    expect(modifierTyped("in:")).toEqual({ key: "in", value: "", start: 0 });
    expect(modifierTyped("launch from:Pri")).toEqual({ key: "from", value: "Pri", start: 7 });
    expect(modifierTyped("notes HAS:Li")).toEqual({ key: "has", value: "Li", start: 6 });
    expect(modifierTyped("is:thread")).toEqual({ key: "is", value: "thread", start: 0 });
  });

  it("finds none in the middle of a word, before the end, or for a key it doesn't know", () => {
    expect(modifierTyped("login:")).toBeNull();
    expect(modifierTyped("in:general notes")).toBeNull();
    expect(modifierTyped("to:me")).toBeNull();
    expect(modifierTyped("launch")).toBeNull();
  });

  it("names the filters Slack's modifiers do, however they're cased", () => {
    expect(flagNamed("has", "link")).toBe("hasLink");
    expect(flagNamed("HAS", "File")).toBe("hasFile");
    expect(flagNamed("is", "thread")).toBe("inThread");
    expect(flagNamed("with", "me")).toBe("withMe");
    expect(flagNamed("has", "pin")).toBeNull();
  });

  it("turns the modifiers typed in full into filters, and leaves the rest as words", () => {
    expect(withTypedFilters({ q: "deploy has:link  is:thread" }, "u1")).toEqual({ q: "deploy", hasLink: true, inThread: true });
    expect(withTypedFilters({ q: "from:me notes with:ME" }, "u1")).toEqual({ q: "notes", from: "u1", withMe: true });
    expect(withTypedFilters({ q: "from:@me" }, "u1")).toEqual({ q: "", from: "u1" });
    // The others are words until the box's list names what they mean.
    expect(withTypedFilters({ q: "from:Priya in:general has:pin" }, "u1")).toEqual({ q: "from:Priya in:general has:pin" });
    expect(withTypedFilters({ q: "launch", in: "general" }, "u1")).toEqual({ q: "launch", in: "general" });
  });

  it("takes from:me typed in full out of what's typed, for someone picked in its place", () => {
    expect(withoutFromMe("from:me deploy FROM:@me notes")).toBe("deploy notes");
    expect(withoutFromMe("deploy from:me")).toBe("deploy");
    expect(withoutFromMe("from:mel deploy:from:me")).toBe("from:mel deploy:from:me");
  });

  it("takes the modifiers typed in full for one flag out of what's typed, for its chip turned off", () => {
    expect(withoutFlag("has:link deploy HAS:LINK notes has:file", "hasLink")).toBe("deploy notes has:file");
    expect(withoutFlag("deploy is:thread", "inThread")).toBe("deploy");
    expect(withoutFlag("with:me deploy with:@me", "withMe")).toBe("deploy with:@me");
    expect(withoutFlag("has:links deploy:has:link has:", "hasLink")).toBe("has:links deploy:has:link has:");
  });
});

describe("Marking what a search matched", () => {
  it("marks each word whole, however it's cased, the longest first", () => {
    const marks = marksFor(["deploy", "Deploying"]);
    expect(marked(marks, "Deploying the deploy, redeploy and DEPLOY")).toEqual(["Deploying", "deploy", "DEPLOY"]);
  });

  it("marks words in any script, and what a pattern would read as its own syntax as itself", () => {
    expect(marked(marksFor(["café", "日本"]), "Café cafés 日本 日本語")).toEqual(["Café", "日本"]);
    expect(marked(marksFor(["a.b", "(x)"]), "a.b axb (x)")).toEqual(["a.b", "(x)"]);
  });

  it("marks nothing without words", () => {
    expect(marksFor([])).toBeNull();
    expect(marksFor([""])).toBeNull();
  });

  it("tells searches apart by their words, once spaces are made one, and their filters", () => {
    expect(sameSearch({ q: " launch  notes ", hasLink: true }, { q: "launch notes", hasLink: true })).toBe(true);
    expect(sameSearch({ q: "launch", in: "general" }, { q: "launch" })).toBe(false);
  });
});

describe("What the search box's search answered", () => {
  it("is the results page's for the visit that takes it, as often as that visit asks", () => {
    const found = answer();
    keepAnswer({ q: "eel  " }, "newest", found);
    expect(takeAnswer({ q: "eel" }, "newest", 3)).toBe(found);
    expect(takeAnswer({ q: "eel" }, "newest", 3)).toBe(found);
    // Another visit asks afresh, as does any after it.
    expect(takeAnswer({ q: "eel" }, "newest", 4)).toBeNull();
    expect(takeAnswer({ q: "eel" }, "newest", 3)).toBeNull();
  });

  it("isn't another search's, nor another order's", () => {
    keepAnswer({ q: "eel" }, "newest", answer());
    expect(takeAnswer({ q: "eel" }, "oldest", 1)).toBeNull();
    keepAnswer({ q: "eel" }, "newest", answer());
    expect(takeAnswer({ q: "eel", hasFile: true }, "newest", 1)).toBeNull();
    expect(takeAnswer({ q: "eel" }, "newest", 1)).toBeNull();
  });
});
