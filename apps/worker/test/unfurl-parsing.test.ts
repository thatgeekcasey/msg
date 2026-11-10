import { describe, expect, it } from "vitest";
import { looksLikeFileOrMedia, MAX_BODY_SIZE } from "../src/unfurl/fetch";
import { decodeUtf8OrLatin1, metaElements } from "../src/unfurl/html";
import { cleanText, MAX_CLEANED_LENGTH, opengraphAttributes } from "../src/unfurl/metadata";
import { parseHttpUri, requestTarget, uriToString } from "../src/unfurl/uri";

const encode = (text: string) => new TextEncoder().encode(text);
/** A string's characters as bytes, so `"\xff"` is the byte 0xFF. */
const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

/** The last og:title's content, when it has one. */
function title(html: string): string | null {
  const metas = [...metaElements(encode(`<meta charset=utf-8>${html}`))];
  return metas.findLast((meta) => meta.get("property") === "og:title")?.get("content") || null;
}
const titleOf = (content: string) => title(`<meta property="og:title" content="a${content}b">`);

describe("Link preview lookup", () => {
  // Each probed against Campfire's Nokogiri, 1.19.4.
  it.each([
    ["&apos;", "a'b"],
    ["&eacute", "a&eacuteb"],
    ["&eacute;x", "aéxb"],
    ["&#233", "aéb"],
    ["&#233x", "aéxb"],
    ["&#xE9", "aປ"],
    ["&#xe9;", "aéb"],
    ["&AMP;", "a&AMP;b"],
    ["&Eacute;", "aÉb"],
    ["&unknown;", "a&unknown;b"],
    ["& x", "a& xb"],
    ["&#65;&#x41;", "aAAb"],
    ["&#128;", "a\u0080b"],
    ["&#150;", "a\u0096b"],
    ["&#xD800;", "a"],
    ["&#1114112;", "a"],
    ["&lt", "a&ltb"],
    ["&amp;amp;", "a&amp;b"],
    ["&hellip;", "a…b"],
    ["&nbsp", "a&nbspb"],
    ["&#;", "a"],
    ["&#x;", "a"],
  ])("decodes %s in a value as libxml2 does", (reference, expected) => {
    expect(titleOf(reference)).toBe(expected);
  });

  it.each([
    ['<script><meta property="og:title" content="in script"></script><meta property="og:title" content="after">', "after"],
    ['<style><meta property="og:title" content="in style"></style>', null],
    ['<textarea><meta property="og:title" content="in textarea"></textarea>', "in textarea"],
    ['<title><meta property="og:title" content="in title"></title>', "in title"],
    ['<noscript><meta property="og:title" content="in noscript"></noscript>', "in noscript"],
    ['<template><meta property="og:title" content="in template"></template>', "in template"],
    ['<svg><meta property="og:title" content="in svg"></svg>', "in svg"],
    ['<!-- <meta property="og:title" content="comment"> --><p>', null],
    ["<meta property=og:title content=unquoted>", "unquoted"],
    ['<meta property="og:title" content="line1\r\nline2">', "line1\r\nline2"],
    ["<meta property='og:title' content='single'>", "single"],
    ['<meta property = "og:title" content = "spaced">', "spaced"],
    ['<META PROPERTY="og:title" CONTENT="upper">', "upper"],
    ['<meta property="og:title"content="nospace">', "nospace"],
    ['<meta/property="og:title"/content="slashes">', null],
    ['<meta property="og:title" content="<b>tag</b>">', "<b>tag</b>"],
    ['<meta property="og:title" content="a">b">', "a"],
    ['<meta property="og:title" content="unterminated>', "unterminated>"],
    ['<meta property="og:title" content=unq"uoted>', 'unq"uoted'],
    ['<meta property="og:title" content=a&amp;b>', "a&b"],
    ['<!--> <meta property="og:title" content="after empty comment"> -->', "after empty comment"],
    ['<!---> <meta property="og:title" content="after dash comment"> -->', "after dash comment"],
    ['<!DOCTYPE html><meta property="og:title" content="doctype">', "doctype"],
    ['<?xml version="1.0"?><meta property="og:title" content="pi">', "pi"],
    ['<![CDATA[ <meta property="og:title" content="cdata"> ]]>', null],
    ['<p <meta property="og:title" content="broken">', null],
    ['< meta property="og:title" content="space">', null],
    ['<meta property="og:title" content="tab\there">', "tab\there"],
    ['<meta property="og:title" content="\0nul">', null],
    // And comments that close with "--!>", and raw text that ends at its end tag in any case.
    ['<!-- x --!><meta property="og:title" content="after bang comment">', "after bang comment"],
    ['<SCRIPT>x</ScRiPt ><meta property="og:title" content="after script">', "after script"],
    ['<script/><meta property="og:title" content="after empty script">', "after empty script"],
  ])("tokenizes %j as libxml2 does", (html, expected) => {
    expect(title(html)).toBe(expected);
  });

  it("reads bytes as UTF-8, and any byte that isn't part of a character as Latin-1", () => {
    expect(decodeUtf8OrLatin1(bytes("caf\xc3\xa9 \xff x"))).toBe("café ÿ x");
    expect(decodeUtf8OrLatin1(bytes("\xff caf\xc3\xa9 x"))).toBe("ÿ café x");
    expect(decodeUtf8OrLatin1(bytes("\x93q\x94"))).toBe("\x93q\x94");
    expect(decodeUtf8OrLatin1(bytes("\x82\xa0"))).toBe("\x82\xa0");
    // A surrogate's encoding, an overlong one, and a sequence cut short are all Latin-1, byte by byte.
    expect(decodeUtf8OrLatin1(bytes("\xed\xa0\x80 \xc0\xaf \xe2\x82"))).toBe("\xed\xa0\x80 \xc0\xaf \xe2\x82");
    expect(decodeUtf8OrLatin1(bytes("\xf0\x9f\x98\x80\xef\xbb\xbf"))).toBe("😀\uFEFF");
  });

  it("keeps a meta's property, name and content, the first of each, among its first 256 distinct attributes", () => {
    const meta = (attributes: string) => [...metaElements(encode(`<meta ${attributes}>`))][0];
    expect(meta('CONTENT="first" content="second" Property=og:title name')).toEqual(new Map([["content", "first"], ["property", "og:title"], ["name", ""]]));
    const others = (count: number) => Array.from({ length: count }, (_, i) => `a${i}=x a${i}=y`).join(" ");
    expect(meta(`${others(255)} content=kept`)?.get("content")).toBe("kept");
    expect(meta(`${others(256)} content=dropped`)?.has("content")).toBe(false);
  });

  // Campfire's test/models/opengraph/document_test.rb.
  it("reads a page's OpenGraph tags", () => {
    const page = '<html><head><meta property="og:url" content="https://example.com"><meta property="og:title" content="Hey!"><meta property="og:description" content="desc.."><meta property="og:image" content="https://example.com/image.png"></head></html>';
    const expected = { title: "Hey!", url: "https://example.com", image: "https://example.com/image.png", description: "desc.." };
    expect(opengraphAttributes(encode(page))).toEqual(expected);
    expect(opengraphAttributes(encode(page.replaceAll("property=", "name=")))).toEqual(expected);
    // Campfire drops every non-ASCII character from a page without a meta charset, leaving "Hello World".
    const mojibake = '<meta name="og:description" content="Hello â\u0080\u0099World">';
    expect(opengraphAttributes(encode(mojibake)).description).toBe("Hello â\u0080\u0099World");
  });

  it("reads pages built to be slow in time proportional to their size", { timeout: 60_000 }, () => {
    const fill = (open: string, item: (i: number) => string, close: string) => {
      const parts = [open];
      for (let i = 0, length = open.length; length <= MAX_BODY_SIZE - close.length - 64; i++) {
        parts.push(item(i));
        length += parts[parts.length - 1]!.length;
      }
      return encode(parts.join("") + close);
    };
    const pages = [
      fill('<meta property="og:title" content="x" ', (i) => `a${String(i).padStart(7, "0")} `, ">"),
      fill("<meta charset=utf-8>", (i) => `<meta property="og:t${i}" content="x">`, '<meta property="og:title" content="x">'),
      fill('<meta property="og:title" content="', () => "&amp;é", '">'),
      fill('<meta property="og:title" content="x" ', () => "a ", ">"),
      fill('<meta property="og:title" content="x"><!--', () => "-", ""),
      fill('<meta property="og:title" content="x">', () => "<", ""),
    ];
    for (const page of pages) {
      const started = performance.now();
      expect(opengraphAttributes(page).title).toBeDefined();
      // About 100 ms here; parsing that's quadratic in the page's size would take minutes.
      expect(performance.now() - started).toBeLessThan(5_000);
    }
  });

  // Rails' `strip_tags` and `sanitize`, answered as plain text rather than HTML-escaped.
  it.each([
    ["Tom & Jerry", "Tom & Jerry"],
    ["a < b", "a < b"],
    ["x&nbsp;y", "x\u00a0y"],
    ["\u00a0nb", "\u00a0nb"],
    ["Hey!<script>alert('hi')</script>", "Hey!alert('hi')"],
    ["<!-- c -->t", "t"],
    ["a &lt;b&gt; c", "a <b> c"],
    ["<p>one</p><p>two</p>", "onetwo"],
    ["\"q\" 'a'", "\"q\" 'a'"],
    ["<style>x</style>y", "xy"],
    ["&amp;amp;", "&amp;"],
    ["<b>bold</b>", "bold"],
    ["</script><img src=a onerror=prompt(1)>", ""],
    [" sp  ", " sp  "],
    ["<textarea>t<b>x</b></textarea>", "t<b>x</b>"],
    ["\uFEFFbom", "bom"],
    ["<template>in <b>template</b></template>", "in template"],
  ])("strips the tags from %j as Rails does", (value, expected) => {
    expect(cleanText(value)).toBe(expected);
  });

  it("strips the tags from at most 4,096 UTF-16 code units, never half a character", () => {
    expect(cleanText("x".repeat(MAX_CLEANED_LENGTH + 10))).toBe("x".repeat(MAX_CLEANED_LENGTH));
    expect(cleanText(`${"x".repeat(MAX_CLEANED_LENGTH - 1)}😀`)).toBe("x".repeat(MAX_CLEANED_LENGTH - 1));
    expect(cleanText(`${"x".repeat(MAX_CLEANED_LENGTH - 2)}😀`)).toBe(`${"x".repeat(MAX_CLEANED_LENGTH - 2)}😀`);
  });

  it("has no text for markup Gumbo refuses: over 400 elements deep, or over 400 attributes on one", () => {
    expect(cleanText(`${"<b>".repeat(400)}deep`)).toBe("deep");
    expect(cleanText(`${"<b>".repeat(401)}deep`)).toBeNull();
    const attributes = (count: number) => Array.from({ length: count }, (_, i) => `a${i}`).join(" ");
    expect(cleanText(`<b ${attributes(400)}>many</b>`)).toBe("many");
    expect(cleanText(`<b ${attributes(401)}>many</b>`)).toBeNull();
  });
});

describe("Link preview safety limits", () => {
  // For the http(s) URLs a preview can use.
  it("reads URLs as Ruby's URI.parse does", () => {
    expect(parseHttpUri("https://x.com/dhh/status/1?s=20")).toEqual({
      scheme: "https",
      userinfo: null,
      host: "x.com",
      port: 443,
      path: "/dhh/status/1",
      query: "s=20",
      fragment: null,
    });
    expect(parseHttpUri("http://user:pass@[::1]:8080/x#top")).toMatchObject({ userinfo: "user:pass", host: "[::1]", port: 8080, path: "/x", fragment: "top" });
    expect(parseHttpUri("https://")).toMatchObject({ host: "", path: "" });
    expect(parseHttpUri("http://a.com:/")).toMatchObject({ port: 80 });
    expect(uriToString(parseHttpUri("https://x.com:443/a")!)).toBe("https://x.com/a");
    expect(parseHttpUri("HTTPS://x.com/a")?.scheme).toBe("https");
    expect(uriToString(parseHttpUri("HTTP://X.com:80/a")!)).toBe("http://X.com/a");
    // Ruby parses each of these, but none is an http(s) URL with a host.
    for (const url of ["http://exa mple.com/ ", "https:/rooms/1", "https:rooms/1", "mailto:foo", "mailto:a@b.com", "FILE:///etc", "//x.com/a", "/a", "http://é.com/", "http://x.com/a b", "http://[::g]/", "http://x.com/#a#b"]) {
      expect(parseHttpUri(url), url).toBeNull();
    }
  });

  it("escapes a query as Ruby's URI#query= does, and refuses a bad escape", () => {
    expect(parseHttpUri("http://a.com/?q=a b&c=\"d\"'`<>\\^{|}~%41")?.query).toBe("q=a%20b&c=%22d%22%27%60%3C%3E\\^{|}~%41");
    expect(parseHttpUri("http://a.com/?a=1\t2\r\n3")?.query).toBe("a=123");
    expect(parseHttpUri("http://a.com/?a=%z1&b=%2")?.query).toBe("a=%z1&b=%2");
    expect(parseHttpUri("http://a.com/?a=%zz")).toBeNull();
  });

  it("asks for the path and query, at least /, as Net::HTTP does", () => {
    const target = (url: string) => requestTarget(parseHttpUri(url)!);
    expect(target("http://a.com")).toBe("/");
    expect(target("http://a.com?x=1")).toBe("/?x=1");
    expect(target("http://user@a.com/p/q?r#s")).toBe("/p/q?r");
  });

  it.each([
    ["http://example.com/video.mp4", true],
    ["http://example.com/archive.tar.gz?x=1", true],
    ["http://example.com/a.zip/b", true],
    ["http://example.com/?file=a.mp3", true],
    ["see https://example.com/a.png", true],
    ["http://example.com/archive.tar.gzip", true],
    ["http://example.com/archive.gzip", false],
    ["http://example.com/UPPER.MP4", false],
    ["http://example.com/package", false],
    ["http://.mp4", false],
    ["xhttp://example.com/a.mp4", false],
    ["http://example.com/a .mp4", false],
  ])("judges whether %s names a file or media", (url, expected) => {
    expect(looksLikeFileOrMedia(url)).toBe(expected);
  });
});
