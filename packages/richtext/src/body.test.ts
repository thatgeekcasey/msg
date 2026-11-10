import { describe, expect, it } from "vitest";
import { prepareBody } from "./body";
import { mentionSgid } from "./mentions";
import { parseHtml } from "./parse";
import { testUserId, testUsers } from "./testing/users";

const { resolve } = testUsers("David", "Jason");
const prepare = (html: string) => prepareBody(parseHtml, html, resolve);
const mention = (n: number, attributes = "") =>
  `<action-text-attachment sgid="${mentionSgid(testUserId(n))}" content-type="application/vnd.campfire.mention"${attributes}></action-text-attachment>`;
const storedMention = (n: number) =>
  `<action-text-attachment content-type="application/vnd.campfire.mention" sgid="${mentionSgid(testUserId(n))}"></action-text-attachment>`;

describe("Rich text, safely", () => {
  it("stores Lexxy's formatting, without classes, styles, targets or scripts", () => {
    const body = '<p class="x" style="color: red">Hi <strong>all</strong><script>alert(1)</script></p><pre data-language="ruby">x = 1</pre>';
    expect(prepare(body)).toEqual({
      html: '<p>Hi <strong>all</strong></p><pre data-language="ruby">x = 1</pre>',
      plainText: "Hi all\n\nx = 1",
      mentions: [],
      blank: false,
    });
    expect(prepare('<a href="https://example.com" target="_blank">x</a>')?.html).toBe('<a href="https://example.com">x</a>');
    expect(prepare('<p><a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)></p>')?.html).toBe("<p><a>x</a></p>");
  });

  it("stores rendered attachments, with an image's caption but not its image", () => {
    expect(prepare('<action-text-attachment content-type="text/html" content="&lt;hr&gt;"></action-text-attachment>')?.html).toBe("<hr>");
    const image = '<action-text-attachment content-type="image/png" url="https://example.com/a.png" caption="Cat"></action-text-attachment>';
    expect(prepare(image)).toMatchObject({ html: "Cat", plainText: "Cat" });
  });

  it("keeps the plain text and mentions of what it stores, so storing that again changes nothing", () => {
    // Rails reads both from the body as sent, so it misses a mention inside a content attachment
    // and keeps the newlines a code block starts with, which the stored form drops
    const mentionInside = `<action-text-attachment content-type="text/html" content="&lt;p&gt;Hi ${mention(1).replaceAll('"', "&quot;")}&lt;/p&gt;"></action-text-attachment>`;
    const codeAfterBlankLines = `<pre>${"\n".repeat(10)}x = 1</pre>`;
    expect(prepare(mentionInside)).toMatchObject({ plainText: "Hi @David", mentions: [{ id: testUserId(1), name: "David" }] });
    expect(prepare(codeAfterBlankLines)).toMatchObject({ html: "<pre>x = 1</pre>", plainText: "x = 1" });
    for (const body of [mentionInside, codeAfterBlankLines]) {
      const prepared = prepare(body)!;
      expect(prepare(prepared.html), body).toEqual(prepared);
    }
  });

  it("is blank when there's no text but whitespace and no attachment", () => {
    for (const body of ["", "  \n ", "<p> </p>", "<p><br></p>"]) expect(prepare(body)?.blank, body).toBe(true);
    expect(prepare(`<p>${mention(3)}</p>`)?.blank).toBe(false);
  });

  it("refuses a body it can't show", () => {
    expect(prepare("<b>".repeat(401))).toBeNull();
    expect(prepare(`<p ${Array.from({ length: 401 }, (_, i) => `a${i}`).join(" ")}>x</p>`)).toBeNull();
    // Rails raises rendering these: an image that isn't at a URL, and an attachment of nothing
    expect(prepare('<action-text-attachment content-type="image/png" url="x.png"></action-text-attachment>')).toBeNull();
    expect(prepare("<action-text-attachment></action-text-attachment>")).toBeNull();
  });
});

describe("How mentions look", () => {
  it("stores a mention as an attachment that renders the person as they are now, and names them as they are", () => {
    const body = `<p>Hi ${mention(1, ' content="&lt;img src=&quot;/x.png&quot;&gt; David"')} and ${mention(2)}, and ${mention(1)}!</p>`;
    expect(prepare(body)).toEqual({
      html: `<p>Hi ${storedMention(1)} and ${storedMention(2)}, and ${storedMention(1)}!</p>`,
      plainText: "Hi @David and @Jason, and @David!",
      mentions: [
        { id: testUserId(1), name: "David" },
        { id: testUserId(2), name: "Jason" },
      ],
      blank: false,
    });
  });

  it("stores ☒ for a mention of someone who doesn't exist", () => {
    expect(prepare(`<p>Hi ${mention(3)}</p>`)).toEqual({ html: "<p>Hi ☒</p>", plainText: "Hi ☒", mentions: [], blank: false });
  });

  it("keeps a user's id in its attribute, whatever characters it holds", () => {
    const user = { id: `"><img src=x onerror=alert(1)>`, name: "Odd" };
    const stored = prepareBody(parseHtml, `<p>${mention(1)}</p>`, () => user);
    expect(stored?.html).toBe(
      '<p><action-text-attachment content-type="application/vnd.campfire.mention" sgid="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"></action-text-attachment></p>',
    );
    expect(stored?.mentions).toEqual([user]);
  });
});

describe("Plain-text version of a message", () => {
  it("reads the body's plain text", () => {
    expect(prepare("<blockquote>q</blockquote><ul><li>a</li></ul>")?.plainText).toBe("“q”\n\n• a");
  });
});
