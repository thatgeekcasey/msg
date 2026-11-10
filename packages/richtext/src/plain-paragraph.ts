// A paragraph of plain text, which is what most messages are, read without parsing it. The room
// prepares every message as it's written, and parsing one costs it 0.1 ms once V8 has optimized
// the parser and up to 1 ms before, which took a third off a fresh room's top message rate.

/**
 * One paragraph of text and line breaks, as `bodyFromPlainText` writes it and Lexxy sends what's
 * typed into it, holding only what parsing and serializing keep as it is: no control characters
 * but tabs and newlines, no unpaired surrogates, and `&`, `<`, `>` and U+00A0 escaped as the
 * serializer escapes them.
 */
const PLAIN_PARAGRAPH = /^<p>(?:[^\0-\x08\x0b-\x1f\x7f-\xa0&<>\ud800-\udfff]|[\ud800-\udbff][\udc00-\udfff]|&(?:amp|lt|gt|nbsp);|<br>)*<\/p>$/;

const TEXT_ESCAPES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": "\u00a0" };

export const isPlainParagraph = (markup: string) => PLAIN_PARAGRAPH.test(markup);

/** The text of each line of a plain paragraph, or null if `markup` isn't one. */
export function plainParagraphLines(markup: string): string[] | null {
  if (!isPlainParagraph(markup)) return null;
  return markup
    .slice("<p>".length, -"</p>".length)
    .split("<br>")
    .map((line) => line.replace(/&(?:amp|lt|gt|nbsp);/g, (escape) => TEXT_ESCAPES[escape]!));
}
