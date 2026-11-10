// rails_autolink 1.1.8's `auto_link(html, html: { target: "_blank" })`, the last step of
// `MessagesHelper#message_presentation`. It works on serialized HTML with regular expressions, so it
// needs the form `presentMessage` and `canonicalize` serialize: with `<` and `>` escaped in attribute
// values, every `<` and `>` left is a tag's, and a link is only ever inserted between tags. (Nokogiri
// leaves them raw, so in Rails a URL after a `>` in a `title` was linked inside the attribute, and the
// rest of the value became markup.)

import type { HtmlParser } from "./markup";
import { htmlEscape, isBlank, urlEncode } from "./ruby";
import { RAILS_DEFAULTS, sanitize } from "./sanitize";

/** `AUTO_LINK_RE`. Ruby's `\s` is ASCII-only. */
const AUTO_LINK_RE =
  /(?:((?:ed2k|ftp|http|https|irc|mailto|news|gopher|nntp|telnet|webcal|xmpp|callto|feed|svn|urn|aim|rsync|tag|ssh|sftp|rtsp|afs|file):)\/\/|www\.[a-zA-Z0-9_])[^ \t\r\n\v\f< "]+/gi;

/** `AUTO_EMAIL_RE`, tried at one position at a time, without its lookbehind, which is checked separately. */
const AUTO_EMAIL_RE = /[a-zA-Z0-9_.!#$%+-]\.?[a-zA-Z0-9_.!#$%&'*/=?^`{|}~+-]*@[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+/y;

/** `AUTO_EMAIL_LOCAL_RE`, the lookbehind: no address starts right after one of these. */
const EMAIL_LOCAL_CHAR = /[a-zA-Z0-9_.!#$%&'*/=?^`{|}~+-]/;

/** An address `autoLink` links, anywhere: one `AUTO_LINK_RE` matches, or an email address where one can start. */
const LINKABLE = new RegExp(`${AUTO_LINK_RE.source}|(?<!${EMAIL_LOCAL_CHAR.source})${AUTO_EMAIL_RE.source}`, "i");

/** `AUTO_LINK_CRE[2]`, `/<a\b.*?>/i`, tried at a `<`; Ruby's `.` stops at a newline. */
const OPEN_ANCHOR = /<a\b[^\n]*?>/iy;

/** Ruby's `\p{Word}`: Unicode's word characters. */
const WORD_CHAR = /^[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]$/u;

/** Closing brackets that may end an address when the address opened them. */
const OPENING_BRACKETS: Record<string, string> = { "]": "[", ")": "(", "}": "{" };

/**
 * Whether plain text has an address in it that `autoLink` links, which a message shows as a link: one with
 * a scheme it knows, a www. one, or an email address.
 */
export function hasLinkable(text: string): boolean {
  return LINKABLE.test(text);
}

/**
 * Where the links `autoLink` makes in plain text go, in order, but those to email addresses: each
 * address whole, without the punctuation after it, and a www. one with "http://" in front.
 */
export function linkedUrls(text: string): string[] {
  return Array.from(text.matchAll(AUTO_LINK_RE), ([whole, scheme]) => {
    const { address } = withoutTrailingPunctuation(whole);
    return scheme === undefined ? `http://${address}` : address;
  });
}

/**
 * `auto_link(html, html: { target: "_blank" })`, without the sanitizing it starts with: `html`
 * must be sanitized already, and serialized as `presentMessage` serializes it. Addresses in text
 * become links that open in a new tab, as do email addresses, with `mailto:`. Text already in a
 * link stays as it is.
 */
export function autoLink(parse: HtmlParser, html: string): string {
  if (isBlank(html)) return "";
  return autoLinkEmailAddresses(parse, autoLinkUrls(parse, html));
}

function autoLinkUrls(parse: HtmlParser, text: string): string {
  const tags = new TagIndex(text);
  let out = "";
  let last = 0;
  for (const match of text.matchAll(AUTO_LINK_RE)) {
    const [whole, scheme] = match;
    const start = match.index;
    const end = start + whole.length;
    out += text.slice(last, start);
    last = end;
    if (tags.autoLinked(start, end)) {
      out += whole;
      continue;
    }
    const { address, punctuation } = withoutTrailingPunctuation(whole);
    let href = address;
    let trailingGt = "";
    if (href.endsWith("&gt;")) {
      href = href.slice(0, -"&gt;".length);
      trailingGt = "&gt;";
    }
    const linkText = sanitize(parse, href, RAILS_DEFAULTS);
    if (scheme === undefined) href = `http://${href}`;
    // `content_tag(:a, link_text, attributes, false)` escapes nothing but the attribute's double quotes.
    out += `<a target="_blank" href="${sanitize(parse, href, RAILS_DEFAULTS).replaceAll('"', "&quot;")}">${linkText}</a>`;
    out += htmlEscape(punctuation) + trailingGt;
  }
  return out + text.slice(last);
}

/**
 * An address with the punctuation that ends it taken off: everything after its last word
 * character, `/`, `-`, `=` or `;`, but for a closing bracket the address opened more of.
 */
function withoutTrailingPunctuation(url: string): { address: string; punctuation: string } {
  const chars = Array.from(url);
  const counts = new Map<string, number>();
  for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
  const removed: string[] = [];
  for (let c = chars.at(-1); c !== undefined && !(WORD_CHAR.test(c) || "/-=;".includes(c)); c = chars.at(-1)) {
    chars.pop();
    removed.push(c);
    counts.set(c, counts.get(c)! - 1);
    const opening = OPENING_BRACKETS[c];
    if (opening !== undefined && (counts.get(opening) ?? 0) > counts.get(c)!) {
      chars.push(removed.pop()!);
      break;
    }
  }
  return { address: chars.join(""), punctuation: removed.reverse().join("") };
}

function autoLinkEmailAddresses(parse: HtmlParser, text: string): string {
  const tags = new TagIndex(text);
  let out = "";
  let copied = 0;
  // Code unit by code unit: everything an address is made of is ASCII.
  for (let position = 0; position < text.length; ) {
    const precededByLocalChar = position > 0 && EMAIL_LOCAL_CHAR.test(text[position - 1]!);
    AUTO_EMAIL_RE.lastIndex = position;
    const email = precededByLocalChar ? undefined : AUTO_EMAIL_RE.exec(text)?.[0];
    if (email === undefined) {
      position++;
      continue;
    }
    const end = position + email.length;
    out += text.slice(copied, position);
    if (tags.autoLinked(position, end)) {
      out += email;
    } else {
      const sanitized = sanitize(parse, email, RAILS_DEFAULTS);
      // `mail_to` escapes the address it shows, unless sanitizing changed it, which marks it safe.
      const display = sanitized === email ? htmlEscape(email) : sanitized;
      const href = `mailto:${urlEncode(sanitized).replaceAll("%40", "@")}`;
      out += `<a target="_blank" href="${htmlEscape(href)}">${display}</a>`;
    }
    copied = end;
    position = end;
  }
  return out + text.slice(copied);
}

/**
 * What `auto_linked?(left, right)` asks about the text around a match, where `left` is everything
 * before it and `right` everything after: whether it's inside a tag, or inside a link. rails_autolink
 * runs its regular expressions over the whole of `left` for each match, which takes time quadratic
 * in the body; this indexes the text once, so each answer is a binary search. The answers are the same.
 */
export class TagIndex {
  /** Where each `<` and `>` is, in order. */
  private readonly lts: number[] = [];
  private readonly gts: number[] = [];
  /**
   * The first newline that ends a line inside an unclosed tag, after which `/<[^>]+$/` (whose `$`
   * also matches before a newline) matches every `left`.
   */
  private readonly firstDanglingNewline: number | undefined;
  /** Where each `/<a\b.*?>/i` match starts and ends: in order, and apart. */
  private readonly openAnchors: [number, number][] = [];
  /** Where each `</a>`, in any case, starts. */
  private readonly closeAnchors: number[] = [];

  constructor(text: string) {
    let firstDanglingNewline: number | undefined;
    // The first `<` since the last `>`
    let unclosedLt: number | undefined;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "<") {
        this.lts.push(i);
        unclosedLt ??= i;
        if (text[i + 1] === "/" && (text[i + 2] === "a" || text[i + 2] === "A") && text[i + 3] === ">") this.closeAnchors.push(i);
        if ((this.openAnchors.at(-1)?.[1] ?? 0) <= i) {
          OPEN_ANCHOR.lastIndex = i;
          const anchor = OPEN_ANCHOR.exec(text);
          if (anchor) this.openAnchors.push([i, i + anchor[0].length]);
        }
      } else if (c === ">") {
        this.gts.push(i);
        unclosedLt = undefined;
      } else if (c === "\n" && firstDanglingNewline === undefined && unclosedLt !== undefined && unclosedLt + 2 <= i) {
        firstDanglingNewline = i;
      }
    }
    this.firstDanglingNewline = firstDanglingNewline;
  }

  /** `auto_linked?(text[..start], text[end..])` */
  autoLinked(start: number, end: number): boolean {
    return (this.openTagAtLineEnd(start) && this.closesTag(end)) || this.insideAnchor(start);
  }

  /** `left =~ /<[^>]+$/` */
  private openTagAtLineEnd(start: number): boolean {
    if (this.firstDanglingNewline !== undefined && this.firstDanglingNewline < start) return true;
    // At the end of `left`: a `<` after the last `>`, with at least one character after it
    const lastGt = this.gts[partitionPoint(this.gts, (gt) => gt < start) - 1];
    const firstLtAfter = this.lts[lastGt === undefined ? 0 : partitionPoint(this.lts, (lt) => lt <= lastGt)];
    return firstLtAfter !== undefined && firstLtAfter + 2 <= start;
  }

  /** `right =~ /^[^>]*>/`, which matches whenever `right` has a `>` at all. */
  private closesTag(end: number): boolean {
    const lastGt = this.gts.at(-1);
    return lastGt !== undefined && lastGt >= end;
  }

  /**
   * `(i = left.rindex(/<a\b.*?>/i)) && left[i..] !~ /<\/a>/i`: the last `<a ...>` wholly in `left`
   * isn't closed before `left` ends.
   */
  private insideAnchor(start: number): boolean {
    const anchor = this.openAnchors[partitionPoint(this.openAnchors, ([, end]) => end <= start) - 1];
    if (anchor === undefined) return false;
    const close = this.closeAnchors[partitionPoint(this.closeAnchors, (p) => p < anchor[1])];
    return close === undefined || close + "</a>".length > start;
  }
}

/** How many of `sorted`'s first items `before` holds for, where it holds for a prefix of them. */
function partitionPoint<T>(sorted: T[], before: (item: T) => boolean): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (before(sorted[middle]!)) low = middle + 1;
    else high = middle;
  }
  return low;
}
