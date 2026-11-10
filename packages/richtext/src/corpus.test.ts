// The golden tests: the corpus of message bodies with what Campfire's real Rails pipeline made of each
// (corpus/README.md). Every case must read as it did in Rails, or be listed in
// testing/known-differences.ts with the reason it doesn't.

import { describe, expect, it } from "vitest";
import { OPENGRAPH_EMBED_CONTENT_TYPE } from "./attachments";
import { autoLink } from "./autolink";
import { plainText, prepareBody, type PreparedBody } from "./body";
import { mentionedUsers } from "./mentions";
import { parseHtml } from "./parse";
import { filterMessage, presentMessage } from "./render";
import { AUTO_LINK, type SafeList } from "./sanitize";
import { toHtml } from "./serialize";
import { descendants, getAttr, isElement, removeAttr } from "./tree";
import {
  corpus,
  corpusUser,
  emberUser,
  emberUserIds,
  railsMentionPartial,
  railsUser,
  UnloggableRailsError,
  verifiedUser,
  withPortDivergences,
  type CorpusCase,
  type Outcome,
} from "./testing/corpus";
import { KNOWN_DIFFERENCES, type Field } from "./testing/known-differences";
import { dangerousUrl, securityViolations } from "./testing/security";

const RAISES = "(raises)";

function attempt(read: () => string): string {
  try {
    return read();
  } catch {
    return RAISES;
  }
}

const expectedOutcome = (outcome: Outcome<string>, read = (ok: string) => ok) => ("ok" in outcome ? read(outcome.ok) : RAISES);

/** Every case reads as Rails read it, but those listed as known differences for `field`, which don't. */
function expectRailsReadings(field: Field, read: (body: CorpusCase) => { expected: string; actual: string }) {
  const unexpected: string[] = [];
  const nowMatching: string[] = [];
  for (const body of corpus.cases) {
    const { expected, actual } = read(body);
    const known = KNOWN_DIFFERENCES[body.name]?.fields.includes(field) ?? false;
    if (expected === actual && known) nowMatching.push(body.name);
    if (expected !== actual && !known) unexpected.push(`${body.name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
  expect(unexpected).toEqual([]);
  expect(nowMatching).toEqual([]);
}

describe("Plain-text version of a message", () => {
  it("reads every body's plain text as Rails did", () => {
    expectRailsReadings("plain_text", (body) => ({
      expected: expectedOutcome(body.plain_text),
      actual: attempt(() => plainText(parseHtml, body.body, railsUser)),
    }));
  });
});

describe("How mentions look", () => {
  it("finds the users every body mentions as Rails did", () => {
    expectRailsReadings("mentioned", (body) => ({
      expected: "ok" in body.mentioned ? JSON.stringify(emberUserIds(body.mentioned.ok)) : RAISES,
      actual: attempt(() => JSON.stringify(mentionedUsers(parseHtml, body.body, verifiedUser).map((user) => user.id))),
    }));
  });
});

describe("Rich text, safely", () => {
  // Loofah scrubs the CSS in `style` attributes, which the last sanitizing removes anyway
  const withoutStyles = (html: string) => html.replace(/ style="[^"]*"/g, "");

  it("filters every body as Rails did", () => {
    expectRailsReadings("filtered", (body) => ({
      expected: expectedOutcome(body.filtered, (html) => withoutStyles(withPortDivergences(html))),
      actual: attempt(() => withoutStyles(toHtml(filterMessage(parseHtml, body.body, railsUser, body.host), { escapeAttributeBrackets: true }))),
    }));
  });

  it("renders every body as Rails did", () => {
    expectRailsReadings("presentation", (body) => {
      let actual: string;
      try {
        actual = autoLink(parseHtml, presentMessage(parseHtml, body.body, railsUser, railsMentionPartial, body.host));
      } catch (error) {
        // message_presentation rescues and shows nothing, unless logging the error raises too
        actual = error instanceof UnloggableRailsError ? "(unrenderable)" : "";
      }
      // Deliberate: a missing attachable Rails can't find a partial for, like a deleted user's mention,
      // shows ☒ rather than raising and blanking the message
      if (body.presentation_raised_message?.includes("to_missing_attachable_partial_path")) {
        return { expected: "a rendering with ☒", actual: actual.includes("☒") ? "a rendering with ☒" : actual };
      }
      const expected = "ok" in body.presentation ? withPortDivergences(body.presentation.ok) : "(unrenderable)";
      return { expected, actual };
    });
  });

  it("renders nothing a browser could run", () => {
    // auto_link's own links add `target`
    const shown: SafeList = { tags: AUTO_LINK.tags, attributes: new Set([...AUTO_LINK.attributes, "target"]) };
    const violations = corpus.cases.flatMap((body) => {
      const html = attempt(() => autoLink(parseHtml, presentMessage(parseHtml, body.body, railsUser, railsMentionPartial, body.host)));
      return html === RAISES ? [] : securityViolations(html, shown).map((violation) => `${body.name}: ${violation}`);
    });
    expect(violations).toEqual([]);
  });

  it("catches what the security assertions are for", () => {
    for (const html of [
      "<script>alert(1)</script>",
      '<p onclick="x()">p</p>',
      '<a href="java\tscript:alert(1)">x</a>',
      '<a href=" JAVASCRIPT:alert(1)">x</a>',
      '<img src="data:text/html,<script>">',
      '<span style="color: red">x</span>',
      '<svg><a xlink:href="javascript:1">x</a></svg>',
      '<span data-controller="x">x</span>',
      '<p title="a" _blank"="">x</p>',
      "<details>x</details>",
    ]) {
      expect(securityViolations(html, AUTO_LINK), html).not.toEqual([]);
    }
    expect(securityViolations('<p><a href="https://example.com">x</a><img src="/a.png"></p>', AUTO_LINK)).toEqual([]);
    expect(dangerousUrl("data:image/png;base64,AAAA")).toBe(false);
  });
});

describe("Rich text, safely", () => {
  const STORED: SafeList = {
    tags: new Set([...[...AUTO_LINK.tags].filter((tag) => tag !== "img"), "action-text-attachment"]),
    attributes: new Set([...[...AUTO_LINK.attributes].filter((name) => name !== "class"), "content-type", "sgid"]),
  };
  /** What `previewContent` writes. */
  const PREVIEW_CONTENT: SafeList = {
    tags: new Set(["actiontext-opengraph-embed", "div", "a", "img"]),
    attributes: new Set(["class", "href", "rel", "target", "src", "alt"]),
  };

  it("stores every body it renders in a safe form that comes back the same when stored again", () => {
    const problems: string[] = [];
    for (const body of corpus.cases) {
      const prepared = attempt(() => JSON.stringify(prepareBody(parseHtml, body.body, corpusUser)));
      const renders = attempt(() => presentMessage(parseHtml, body.body, corpusUser, railsMentionPartial)) !== RAISES;
      const refused = prepared === RAISES || prepared === "null";
      if (refused === renders) problems.push(`${body.name}: ${renders ? "renders, but was refused" : "doesn't render, but was stored"}`);
      if (refused) continue;
      const stored = (JSON.parse(prepared) as PreparedBody).html;
      const fragment = parseHtml(stored);
      for (const node of descendants(fragment)) {
        if (!isElement(node, "action-text-attachment") || getAttr(node, "content-type") !== OPENGRAPH_EMBED_CONTENT_TYPE) continue;
        for (const violation of securityViolations(removeAttr(node, "content") ?? "", PREVIEW_CONTENT)) problems.push(`${body.name}: preview's ${violation}`);
      }
      const rest = toHtml(fragment, { escapeAttributeBrackets: true });
      for (const violation of securityViolations(rest, STORED)) problems.push(`${body.name}: ${violation}`);
      for (const [, attributes] of rest.matchAll(/<action-text-attachment([^>]*)>/g)) {
        if (!/^ content-type="application\/vnd\.(?:campfire\.mention" sgid="[0-9a-z]{16}|actiontext\.opengraph-embed)"$/.test(attributes!)) {
          problems.push(`${body.name}: <action-text-attachment${attributes}>`);
        }
      }
      const again = attempt(() => JSON.stringify(prepareBody(parseHtml, stored, emberUser)));
      if (again !== prepared) problems.push(`${body.name}\n  stored:       ${prepared}\n  stored again: ${again}`);
    }
    expect(problems).toEqual([]);
  });
});
