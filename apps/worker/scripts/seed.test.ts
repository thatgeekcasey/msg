// The seed writes messages as the composer does, without the rich text package, whose imports Node
// can't load as they are: this checks what it writes against that package.

import { displayBody, prepareBody, previewContent, type DisplayNode, type MentionUser } from "@ember/richtext";
import { describe, expect, it } from "vitest";
import { codeBlock, escapeHtml, html, linkWithPreview, mention, paragraph, preview, replyMarkup, type LinkPreview } from "./seed/markup.ts";

const MAYA: MentionUser = { id: "0000000000000001", name: "Maya Chen" };
const resolve = (sgid: string) => (sgid === MAYA.id ? MAYA : undefined);

const LINK: LinkPreview = {
  url: "https://developers.cloudflare.com/durable-objects/",
  title: "Overview · Cloudflare Durable Objects docs",
  description: "Build stateful serverless applications with Durable Objects, including AI agents & real-time chat.",
  image: "https://developers.cloudflare.com/durable-objects/og.png",
};

function stored(body: string) {
  const prepared = prepareBody(body, resolve);
  if (prepared === null) throw new Error(`refused ${body}`);
  return prepared;
}

/** What `body` shows once the room has stored it. */
function shown(body: string): DisplayNode[] {
  const { html, plainText } = stored(body);
  return displayBody(html, plainText, "ember.example");
}

/** The content of the attachment `body` is, as HTML reads its attribute. */
const contentOf = (body: string) =>
  /content="([^"]*)"/.exec(body)![1]!.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

const previewsIn = (nodes: DisplayNode[]): DisplayNode[] =>
  nodes.flatMap((node) => (node.kind === "preview" ? [node] : node.kind === "element" ? previewsIn(node.children) : []));

describe("the seed's messages", () => {
  it("keeps what's typed as text, line breaks and all", () => {
    expect(stored(paragraph("Tom & Jerry <3\nsecond line").body)).toMatchObject({ plainText: "Tom & Jerry <3\nsecond line", mentions: [] });
  });

  it("escapes the text a template is given, but not the markup", () => {
    expect(html`<p>${"<b>"} ${mention(MAYA)}</p>`).toEqual({
      body: `<p>&lt;b&gt; ${mention(MAYA).body}</p>`,
      quoted: "<p>&lt;b&gt; Maya Chen</p>",
    });
  });

  it("mentions someone as the composer's prompt does", () => {
    expect(stored(html`<p>${mention(MAYA)} can you look?</p>`.body)).toMatchObject({ plainText: "@Maya Chen can you look?", mentions: [MAYA] });
  });

  it("writes a link preview's content as the composer does", () => {
    expect(contentOf(preview(LINK).body)).toBe(previewContent({ href: LINK.url, url: LINK.image, filename: LINK.title, description: LINK.description }));
  });

  it("shows a link with its preview", () => {
    expect(previewsIn(shown(linkWithPreview("TIL:", LINK).body))).toEqual([
      expect.objectContaining({ href: LINK.url, image: LINK.image, title: [{ kind: "text", value: LINK.title }], description: [{ kind: "text", value: LINK.description }] }),
    ]);
  });

  it("quotes what a reply answers as Quote does, naming whom it mentions and leaving out its previews", () => {
    const original = html`<p>${mention(MAYA)} see</p>${preview(LINK)}`;
    const permalink = "https://ember.example/rooms/0000000000000002/@0000000000000003";
    const reply = replyMarkup(original, { id: "0000000000000004", name: "Sam Rivera" }, permalink, paragraph("On it"));
    expect(reply.body).toBe(`<blockquote><p>Maya Chen see</p></blockquote><cite>Sam Rivera <a href="${permalink}">#</a></cite><p>On it</p>`);
    expect(stored(reply.body)).toMatchObject({ plainText: expect.stringContaining("On it"), mentions: [] });
  });

  it("writes a code block whose lines the room keeps", () => {
    const [block] = shown(codeBlock("javascript", "const a = 1 < 2;\nreturn a;").body);
    expect(block).toEqual({
      kind: "element",
      name: "pre",
      attrs: { "data-language": "javascript" },
      children: [{ kind: "text", value: "const a = 1 < 2;" }, { kind: "element", name: "br", attrs: {}, children: [] }, { kind: "text", value: "return a;" }],
    });
  });

  it("escapes what HTML would read as markup", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});
