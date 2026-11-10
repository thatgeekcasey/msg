import { describe, expect, it } from "vitest";
import { autoLink, hasLinkable, linkedUrls, TagIndex } from "./autolink";
import { parseHtml } from "./parse";

const link = (html: string) => autoLink(parseHtml, html);
const anchor = (href: string, text = href) => `<a target="_blank" href="${href}">${text}</a>`;

describe("Addresses a message shows as links", () => {
  const linkable = ["See https://example.com/a.", "www.example.com", "SSH://host", "xmpp://ada@example.com", "Write to ada@example.com.", "o'brien+ember@example.co.uk"];
  const unlinkable = ["no link", "http: and www.", "https:// alone", "javascript://alert(1)", "gopher+evil://x", "@ the cliffs, ada@ them", "ada@example"];

  it("finds the addresses autoLink links in plain text, and only those", () => {
    for (const text of linkable) expect(hasLinkable(text), text).toBe(true);
    for (const text of unlinkable) expect(hasLinkable(text), text).toBe(false);
    for (const text of [...linkable, ...unlinkable]) expect(link(`<p>${text}</p>`).includes("<a "), text).toBe(hasLinkable(text));
  });

  it("finds where those links go, but for email addresses", () => {
    for (const text of [...linkable, ...unlinkable]) {
      const hrefs = Array.from(link(`<p>${text}</p>`).matchAll(/href="([^"]*)"/g), ([, href]) => href!).filter((href) => !href.startsWith("mailto:"));
      expect(linkedUrls(text), text).toEqual(hrefs);
    }
    expect(linkedUrls('Ours: https://example.com.au/logo.png, www.example.com/forum! (https://en.wikipedia.org/wiki/Fire_(element)) https://example.com/"x"')).toEqual([
      "https://example.com.au/logo.png",
      "http://www.example.com/forum",
      "https://en.wikipedia.org/wiki/Fire_(element)",
      "https://example.com/",
    ]);
  });
});

describe("Links in message text", () => {
  it("links addresses with a known scheme, and www. addresses with http://", () => {
    expect(link("<p>https://example.com and www.example.com</p>")).toBe(
      `<p>${anchor("https://example.com")} and ${anchor("http://www.example.com", "www.example.com")}</p>`,
    );
    expect(link("<p>SSH://host and ftp://files.example.com/a.txt</p>")).toBe(
      `<p>${anchor("SSH://host")} and ${anchor("ftp://files.example.com/a.txt")}</p>`,
    );
  });

  it("links email addresses with mailto:", () => {
    expect(link("<p>Write to ada@example.com.</p>")).toBe(`<p>Write to ${anchor("mailto:ada@example.com", "ada@example.com")}.</p>`);
    expect(link("<p>o'brien+ember@example.co.uk</p>")).toBe(
      `<p>${anchor("mailto:o%27brien%2Bember@example.co.uk", "o&#39;brien+ember@example.co.uk")}</p>`,
    );
  });

  it("leaves trailing punctuation out, unless it closes a bracket the address opened", () => {
    expect(link("<p>See https://example.com/a, then https://example.com/b!</p>")).toBe(
      `<p>See ${anchor("https://example.com/a")}, then ${anchor("https://example.com/b")}!</p>`,
    );
    expect(link("<p>(https://en.wikipedia.org/wiki/Fire_(element))</p>")).toBe(
      `<p>(${anchor("https://en.wikipedia.org/wiki/Fire_(element)")})</p>`,
    );
    expect(link("<p>https://example.com/?q=1&amp;r=2;</p>")).toBe(`<p>${anchor("https://example.com/?q=1&amp;r=2;")}</p>`);
  });

  it("doesn't link text already in a link, but links addresses in code", () => {
    expect(link('<p><a href="https://example.com">https://example.com</a></p>')).toBe('<p><a href="https://example.com">https://example.com</a></p>');
    expect(link("<pre>curl https://example.com</pre>")).toBe(`<pre>curl ${anchor("https://example.com")}</pre>`);
  });

  it("leaves javascript: and unknown schemes as text", () => {
    expect(link("<p>javascript://alert(1) and gopher+evil://x</p>")).toBe("<p>javascript://alert(1) and gopher+evil://x</p>");
  });

  it("keeps quotes and angle brackets from breaking out of a link", () => {
    expect(link('<p>https://example.com/"onmouseover="alert(1)</p>')).toBe(`<p>${anchor("https://example.com/")}"onmouseover="alert(1)</p>`);
    expect(link("<p>https://example.com/&lt;script&gt;</p>")).toBe(`<p>${anchor("https://example.com/&lt;script")}&gt;</p>`);
  });

  it("tells where it's inside a tag or a link as rails_autolink's regular expressions do", () => {
    for (const text of [
      "<p>www.a.com</p><p>b</p>",
      '<p title="a\nb">x</p> y <p>z</p>',
      '<p title="a\n">x</p>',
      '<a href="x">in <b>link</b></a> out <A\nhref="y">z</A> <a>q</a>',
      '<ab>x</ab><a\tclass="c">y',
      "x<\ny>z<é>",
      "<",
      "<a>",
      "",
    ]) {
      const index = new TagIndex(text);
      for (let start = 0; start <= text.length; start++) {
        for (let end = start; end <= text.length; end++) {
          expect(index.autoLinked(start, end), `${JSON.stringify(text)} at ${start}..${end}`).toBe(
            autoLinkedByRegex(text.slice(0, start), text.slice(end)),
          );
        }
      }
    }
  });
});

/**
 * rails_autolink's `auto_linked?`, as its regular expressions over the whole of `left`. Ruby's `^`
 * and `$` are at a line's start and end, where only `\n` ends a line, and its `.` stops there.
 */
function autoLinkedByRegex(left: string, right: string): boolean {
  if (/<[^>]+(?=\n|(?![\s\S]))/.test(left) && /(?:(?<![\s\S])|(?<=\n))[^>]*>/.test(right)) return true;
  for (let i = left.length - 1; i >= 0; i--) {
    const openAnchor = /<a\b[^\n]*?>/iy;
    openAnchor.lastIndex = i;
    const match = openAnchor.exec(left);
    if (match) return !/<\/a>/i.test(left.slice(i + match[0].length));
  }
  return false;
}
