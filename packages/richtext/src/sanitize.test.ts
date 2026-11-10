import { describe, expect, it } from "vitest";
import { parseHtml } from "./parse";
import { allowedUri, cgiUnescapeHtml, CONTENT_FILTER, sanitize, sanitizeTags, type SafeList } from "./sanitize";
import { toHtml } from "./serialize";

// The expected outputs are rails-html-sanitizer's.
describe("Rich text, safely", () => {
  it("scrubs like Rails", () => {
    const scrubbed = (html: string) => sanitize(parseHtml, html, CONTENT_FILTER);
    expect(scrubbed('<div><a href="javascript:alert(1)">x</a></div>')).toBe("<div><a>x</a></div>");
    expect(scrubbed('<a href="/x" onmouseover="alert(1)">x</a>')).toBe('<a href="/x">x</a>');
    expect(scrubbed('<a href="data:text/html,pwned">x</a>')).toBe("<a>x</a>");
    expect(scrubbed('<a href="a b">x</a><!-- c -->')).toBe('<a href="a%20b">x</a>');
    expect(scrubbed("<svg><a>x</a></svg>y<script>z</script>")).toBe("yz");
    expect(scrubbed('<a name="body" href="/x">x</a>')).toBe('<a href="/x">x</a>');
  });

  it("re-escapes URL attributes as each attribute is scrubbed", () => {
    const list: SafeList = { tags: new Set(["img", "a"]), attributes: new Set(["src", "href", "name", "title", "alt"]) };
    const scrubbed = (html: string) => sanitize(parseHtml, html, list);
    // The blank src is removed, and the escaping it still triggers lets the href through
    expect(scrubbed('<img src=" " href=" javascript:alert(1)">')).toBe('<img href="%20javascript:alert(1)">');
    expect(scrubbed('<img href=" javascript:alert(1)">')).toBe("<img>");
    expect(scrubbed('<a href="a b" name="c d" title="x y">t</a>')).toBe('<a href="a%20b" name="c%20d" title="x y">t</a>');
    expect(scrubbed('<img src="a b" alt="q">')).toBe('<img src="a%20b" alt="q">');
  });

  it("checks URIs like Loofah", () => {
    for (const uri of ["javascript:alert(1)", "java\nscript:alert(1)", "javascript&#58;alert(1)", "&#106;avascript:alert(1)", "javascript&colon;alert(1)", "data:text/html,xx"]) {
      expect(allowedUri(uri), uri).toBe(false);
    }
    for (const uri of ["/rooms/1", "https://example.com", "data:image/png;base64,xx", "mailto:a@example.com"]) {
      expect(allowedUri(uri), uri).toBe(true);
    }
    // CGI.unescapeHTML turns the zero-padded `&` into `&#106;`, which Loofah then decodes
    expect(sanitize(parseHtml, '<a href="&amp;#0000000000038;#106;avascript:alert(1)">x</a>', CONTENT_FILTER)).toBe("<a>x</a>");
  });

  it("unescapes HTML like CGI", () => {
    for (const [escaped, unescaped] of [
      ["&#65;", "A"],
      ["&#X41;", "A"],
      ["&#00000000065;", "A"],
      ["&#0000000000000000000000065;", "A"],
      ["&#x000000041;", "A"],
      ["&#x0000000000000000000041;", "A"],
      ["&#00000000000000000000000000000000106;avascript", "javascript"],
      ["&#0;", "\0"],
      ["&#65535;", "￿"],
      ["&#1114110;", "\u{10fffe}"],
      ["&#1114111;", "&#1114111;"],
      ["&#x10FFFF;", "&#x10FFFF;"],
      ["&#x110000;", "&#x110000;"],
      ["&#99999999999999999999;", "&#99999999999999999999;"],
      ["&#18446744073709551615;", "&#18446744073709551615;"],
      ["&#x10000000000000041;", "&#x10000000000000041;"],
      ["&#;", "&#;"],
      ["&#x;", "&#x;"],
      ["&#65", "&#65"],
      ["&#0x41;", "&#0x41;"],
      ["&amp;#65;", "&#65;"],
    ]) {
      expect(cgiUnescapeHtml(escaped!), escaped).toBe(unescaped);
    }
  });

  it("removes the elements SanitizeTags doesn't allow, with their contents", () => {
    const fragment = parseHtml('Hello <img src="https://example.com/x.svg">World<iframe>x</iframe><p>kept <video>gone</video></p>');
    sanitizeTags(fragment);
    expect(toHtml(fragment)).toBe("Hello World<p>kept </p>");
  });
});
