/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { autoLink } from "./autolink";
import { prepareBody } from "./body";
import { displayBody } from "./display";
import { parseDom } from "./dom";
import { ParseLimitError, type HtmlParser } from "./markup";
import { parseHtml } from "./parse";
import { presentMessage } from "./render";
import { toHtml } from "./serialize";
import { HTML_NAMESPACE, SVG_NAMESPACE, textContent } from "./tree";
import { corpus, corpusUser, railsMentionPartial, railsUser } from "./testing/corpus";

const readings: Record<string, (parse: HtmlParser, body: string) => unknown> = {
  presentation: (parse, body) => autoLink(parse, presentMessage(parse, body, railsUser, railsMentionPartial)),
  "prepared body": (parse, body) => prepareBody(parse, body, corpusUser),
  "prepared body as it shows": (parse, body) => {
    const prepared = prepareBody(parse, body, corpusUser);
    return prepared && displayBody(parse, prepared.html, prepared.plainText, "once.campfire.test");
  },
};

function outcome(read: () => unknown): string {
  try {
    return JSON.stringify(read());
  } catch (error) {
    return `(raises ${(error as Error).name}: ${(error as Error).message})`;
  }
}

const roundTrip = (markup: string) => toHtml(parseDom(markup));
const textOf = (markup: string) => textContent(parseDom(markup));

const limit = (markup: string) => {
  try {
    parseDom(markup);
    return undefined;
  } catch (error) {
    if (error instanceof ParseLimitError) return error.limit;
    throw error;
  }
};

/**
 * Bodies Gumbo refuses for what it counts as it parses, which the browser's finished tree can't
 * show: open elements closed again by the time it's built, attributes dropped as duplicates, and
 * attributes on end tags or on a tag the input ends inside.
 */
const BEYOND_THE_TREE = new Set([
  "limits too deep before the adoption agency cuts",
  "limits attributes at the limit and a duplicate",
  "limits attributes on an end tag",
  "limits attributes on an unfinished tag",
]);

describe("Rich text, safely", () => {
  it("reads every corpus body in a browser as the Worker does", { timeout: 60_000 }, () => {
    const differences: string[] = [];
    const nowAgreeing: string[] = [];
    for (const { name, body } of corpus.cases) {
      for (const [what, read] of Object.entries(readings)) {
        const worker = outcome(() => read(parseHtml, body));
        const browser = outcome(() => read(parseDom, body));
        if (worker === browser && BEYOND_THE_TREE.has(name)) nowAgreeing.push(`${name}, ${what}`);
        if (worker !== browser && !BEYOND_THE_TREE.has(name)) differences.push(`${name}, ${what}\n  worker:  ${worker}\n  browser: ${browser}`);
      }
    }
    expect(differences).toEqual([]);
    expect(nowAgreeing).toEqual([]);
  });

  it("parses as Nokogiri does: templates' contents as their children, noscript as markup", () => {
    expect(roundTrip("<template><td>x</td></template>")).toBe("<template><td>x</td></template>");
    expect(roundTrip("<noscript><b>x</b></noscript>")).toBe("<noscript><b>x</b></noscript>");
    expect(roundTrip("<SVG viewBox='0 0 1 1'><CLIPPATH/></SVG>")).toBe('<svg viewBox="0 0 1 1"><clipPath></clipPath></svg>');
    expect(roundTrip("\uFEFF\uFEFFx")).toBe("\uFEFFx");
    // Without scripting: as markup in a body, and as in a div in a noscript context
    expect(textOf("<noscript><b>&amp;</b></noscript>")).toBe("&");
    expect(toHtml(parseDom("<b>&amp;</b>", { name: "noscript", namespace: HTML_NAMESPACE }))).toBe("<b>&amp;</b>");
  });

  it("parses in the context of elements the DOM won't create", () => {
    const parsedIn = (name: string, namespace = HTML_NAMESPACE) => toHtml(parseDom("<b>&amp;</b>", { name, namespace }));
    expect(parsedIn("https:")).toBe("<b>&amp;</b>");
    expect(parsedIn("x:textarea")).toBe("<b>&amp;</b>");
    expect(parsedIn("x:title", SVG_NAMESPACE)).toBe(toHtml(parseHtml("<b>&amp;</b>", { name: "x:title", namespace: SVG_NAMESPACE })));
  });

  it("holds the tree to Gumbo's limits", () => {
    expect(limit("<b>".repeat(400))).toBeUndefined();
    expect(limit("<b>".repeat(401))).toBe("depth");
    // jsdom checks each insertion against every ancestor, so it can't take the hardening tests' 80,000
    expect(limit("<div>".repeat(2_000))).toBe("depth");
    expect(limit(`<p ${Array.from({ length: 400 }, (_, i) => `a${i}`).join(" ")}>x</p>`)).toBeUndefined();
    expect(limit(`<p ${Array.from({ length: 401 }, (_, i) => `a${i}`).join(" ")}>x</p>`)).toBe("attributes");
  });
});
