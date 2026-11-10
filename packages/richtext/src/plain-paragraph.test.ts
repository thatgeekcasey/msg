/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { bodyFromPlainText, prepareBody, prepareParsedBody } from "./body";
import { parseDom } from "./dom";
import type { HtmlParser } from "./markup";
import { userIdsIn } from "./mentions";
import { parseHtml } from "./parse";
import { isPlainParagraph } from "./plain-paragraph";

const PARSERS: Record<string, HtmlParser> = { parse5: parseHtml, DOMParser: parseDom };
const nobody = () => undefined;

/** Text made of what parsing treats specially, from a seeded generator so a failure repeats. */
function* texts(count: number): Generator<string> {
  const pieces = [
    ..."a Z1 \t\n\r\0\f\v\u001f\u007f\u0085\u00a0\u2003\u200b\ufeff\ufffe\uffff\ufdd0&<>\"'=/;#~".split(""),
    "😄", "\ud800", "\udc00", "~~", "&amp;", "&lt;", "&gt;", "&nbsp;", "&quot;", "&#38;", "&amp", "<br>", "<br/>", "</p>", "<p>", "<b>", "\r\n",
  ];
  let seed = 0x2f6e2b1;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    let text = "";
    for (let n = Math.floor(random() * 12); n > 0; n--) text += pieces[Math.floor(random() * pieces.length)];
    yield text;
  }
}

describe("Send a message", () => {
  it("prepares a plain paragraph without parsing it, as parsing it would", () => {
    let plain = 0;
    for (const text of texts(4_000)) {
      for (const markup of [bodyFromPlainText(text), `<p>${text}</p>`]) {
        if (!isPlainParagraph(markup)) continue;
        plain++;
        for (const [name, parse] of Object.entries(PARSERS)) {
          expect(prepareBody(parse, markup, nobody), `${name}: ${JSON.stringify(markup)}`).toEqual(prepareParsedBody(parse, markup, nobody));
          expect(userIdsIn(parse, markup)).toEqual([]);
        }
      }
    }
    // Enough of them are plain paragraphs to show it.
    expect(plain).toBeGreaterThan(2_000);
  });

  it("reads only what parsing keeps as it is the short way", () => {
    for (const markup of ["<p></p>", "<p><br></p>", "<p>a<br><br>b\n</p>", "<p>&amp;&lt;&gt;&nbsp;\"'</p>", "<p>\t😄</p>"]) {
      expect(isPlainParagraph(markup), markup).toBe(true);
    }
    for (const markup of ["<p>a\rb</p>", "<p>a\0b</p>", "<p>&quot;</p>", "<p>\u00a0</p>", "<p>\ud800</p>", "<P>x</P>", "<p>x</p> ", "<p>x</p><p>y</p>", "<p>a<br/>b</p>"]) {
      expect(isPlainParagraph(markup), markup).toBe(false);
    }
  });

  it("reads a paragraph as long as a message can arrive as the short way", () => {
    const escapes = `<p>${"&amp;".repeat(19_990)}</p>`;
    expect(prepareBody(parseHtml, escapes, nobody)?.plainText).toBe("&".repeat(19_990));
    const lines = `<p>${"a<br>".repeat(19_990)}a</p>`;
    expect(prepareBody(parseHtml, lines, nobody)).toEqual(prepareParsedBody(parseHtml, lines, nobody));
  });
});
