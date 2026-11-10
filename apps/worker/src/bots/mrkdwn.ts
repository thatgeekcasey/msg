import { trimmed } from "../trim";
import { EMOJI, TONED } from "./emoji-names";

// Slack's mrkdwn (https://docs.slack.dev/messaging/formatting-message-text), the markup of the text a Slack
// incoming webhook is sent, read into the rich text a message keeps: paragraphs and line breaks, `>` quotes,
// code blocks between ``` fences, `code`, *bold*, _italics_ and ~strike-through~, links, mentions and dates in
// angle brackets, and emoji by name. As in Slack, `&amp;`, `&lt;` and `&gt;` are the only escapes, and
// formatting needs a word's edge, so `node_cpu_seconds_total` keeps its underscores. Mentions show as text and
// notify nobody, since Slack's ids name no one here.

/**
 * How much of mrkdwn a text gets: all of it, or only its links, mentions, dates, emoji and escapes, as Slack
 * reads a payload's text beside `mrkdwn: false`, or an attachment's field that its `mrkdwn_in` doesn't name.
 */
export type Formatting = "mrkdwn" | "plain";

/** How a run of text is read: as `Formatting` says, or as code, where only links, mentions, dates and escapes count. */
type Mode = Formatting | "code";

/** A piece of a line: a character, or markup that emphasis can't start or end inside. */
type Atom = string | { html: string };

/** A paragraph or quote, with its lines; a code block, with its text; or the blocks after a `>>>`, which it quotes. */
type Block = { tag: "p" | "blockquote"; lines: string[] } | { tag: "pre"; text: string } | { tag: "rest"; blocks: Block[] };

const FENCE = "```";
/** `>>>` quotes the rest of the text, and `>` its line, either escaped or not. */
const QUOTE_REST = /^(?:>>>|&gt;&gt;&gt;) ?/;
const QUOTE = /^(?:>|&gt;) ?/;

const CODE = /`([^`\n]+)`/y;
/** Slack's own markup, which starts with something other than a space, so `a < b > c` is text. */
const SPECIAL = /<([^<>\s][^<>\n]*)>/y;
const ESCAPE = /&(amp|lt|gt);/y;
/** A web address written out, which Ember links as it shows, and whose underscores and colons are its own. */
const WEB_ADDRESS = /https?:\/\/[^\s<>]+/iy;
const SHORTCODE = /:([a-z0-9_+-]+):(?::skin-tone-([2-6]):)?/y;

const UNESCAPED: Record<string, string> = { amp: "&", lt: "<", gt: ">" };
const ESCAPED: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const EMPHASES = new Map([
  ["*", "strong"],
  ["_", "em"],
  ["~", "s"],
]);
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

/** `text` as markup, formatted as `formatting` says, or "" when it shows nothing. */
export function mrkdwnHtml(text: string, formatting: Formatting = "mrkdwn"): string {
  const lines = text.replace(/\r\n?/g, "\n");
  const blocks: Block[] = formatting === "plain" ? [{ tag: "p", lines: lines.split("\n") }] : blocksOf(lines);
  return blocks.map((block) => blockHtml(block, formatting)).join("");
}

/** `text` as a line of markup, its line breaks `<br>`, formatted as `formatting` says but without quotes or code blocks. */
function mrkdwnLine(text: string, formatting: Formatting = "plain"): string {
  const lines = withoutBlankEnds(text.replace(/\r\n?/g, "\n").split("\n"));
  return lines.map((line) => lineHtml(line, formatting)).join("<br>");
}

/**
 * `text` as plain text, as Slack shows a title or a name: its links as their labels, and its mentions, dates and
 * emoji, without the formatting `formatting` reads, as a text object's mrkdwn is in a header or a button.
 */
export const mrkdwnText = (text: string, formatting: Formatting = "plain") => lineText(mrkdwnLine(text, formatting));

/** Text that Slack shows as it is, a `plain_text` object's, as plain text, with emoji by name unless `emoji` is false. */
export const plainText = (text: string, emoji = true) => lineText(plainTextLine(text, emoji));

/** A line of markup, whose text is escaped as `escapeText` escapes it, as the text it shows, its line breaks kept. */
const lineText = (html: string) =>
  html
    .replace(/<br>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt);/g, (_, name: string) => UNESCAPED[name]!)
    .trim();

/** Text that Slack shows as it is, a `plain_text` object's, as markup: a paragraph, with emoji by name unless `emoji` is false. */
export function plainTextHtml(text: string, emoji = true): string {
  const html = plainTextLine(text, emoji);
  return html === "" ? "" : `<p>${html}</p>`;
}

/** `plainTextHtml` without the paragraph, its lines between line breaks. */
export function plainTextLine(text: string, emoji = true): string {
  const lines = withoutBlankEnds(text.replace(/\r\n?/g, "\n").split("\n"));
  return lines.map((line) => (emoji ? atomsHtml(atomsOf(line, "emoji")) : escapeText(line))).join("<br>");
}

/** The emoji `name` names, in skin tone `tone` (2 to 6) if it takes one, or undefined for a name it doesn't know. */
export function emojiNamed(name: string, tone?: number): string | undefined {
  if (!Object.hasOwn(EMOJI, name)) return undefined;
  const emoji = EMOJI[name]!;
  const rule = tone !== undefined && Number.isInteger(tone) && tone >= 2 && tone <= 6 && Object.hasOwn(TONED, name) ? TONED[name] : undefined;
  if (!rule) return emoji;
  const modifier = String.fromCodePoint(0x1f3fb + tone! - 2);
  const [first, ...rest] = [...emoji];
  if (rest[0] === "\uFE0F") rest.shift();
  return first + modifier + rest.join("") + (rule === 2 ? modifier : "");
}

/** `text` with `&`, `<` and `>` escaped, as markup writes text. */
export const escapeText = (text: string) => text.replace(/[&<>]/g, (char) => ESCAPED[char]!);

/** Where a link goes: a web or email address, as Slack links, or null for anything else, which shows as text. */
export function linkHref(address: string): string | null {
  if (!/^(?:https?|mailto):/i.test(address)) return null;
  try {
    return new URL(address).href;
  } catch {
    return null;
  }
}

/** `html` linked to `href`. */
export const anchor = (href: string, html: string) => `<a href="${escapeText(href).replace(/"/g, "&quot;")}">${html}</a>`;

/** A moment, in seconds, as text, where Slack shows it in its reader's time zone, which a message can't know; "" for none. */
export function utcTime(seconds: number): string {
  const time = new Date(seconds * 1000);
  return Number.isNaN(time.getTime()) ? "" : `${time.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The code blocks between pairs of fences in `text`, and the paragraphs and quotes around them. */
function blocksOf(text: string): Block[] {
  const pieces = text.split(FENCE);
  // A fence without a partner is text.
  if (pieces.length % 2 === 0) {
    const last = pieces.pop()!;
    pieces[pieces.length - 1] += FENCE + last;
  }
  const blocks: Block[] = [];
  // The blocks from the first line that starts with `>>>` on, code blocks too, which it quotes.
  let rest: Block[] | undefined;
  for (const [index, piece] of pieces.entries()) {
    if (index % 2 === 1) {
      const code = trimmed(piece, (c) => c === "\n");
      if (code.trim() !== "") (rest ?? blocks).push({ tag: "pre", text: code });
      continue;
    }
    // The spaces beside a fence are its line's, which the code block ends.
    const lines = trimmed(piece, (c) => c === " " || c === "\t").split("\n");
    if (rest) {
      rest.push({ tag: "p", lines });
      continue;
    }
    const quoting = lines.findIndex((line) => QUOTE_REST.test(line));
    blocks.push(...lineBlocksOf(quoting < 0 ? lines : lines.slice(0, quoting)));
    if (quoting >= 0) {
      rest = [{ tag: "p", lines: [lines[quoting]!.replace(QUOTE_REST, ""), ...lines.slice(quoting + 1)] }];
      blocks.push({ tag: "rest", blocks: rest });
    }
  }
  return blocks;
}

/** The paragraphs and quotes of lines between code blocks: each run of lines that start with `>`, or don't. */
function lineBlocksOf(lines: string[]): Block[] {
  const blocks: { tag: "p" | "blockquote"; lines: string[] }[] = [];
  for (const written of lines) {
    const tag = QUOTE.test(written) ? "blockquote" : "p";
    const line = tag === "blockquote" ? written.replace(QUOTE, "") : written;
    const last = blocks.at(-1);
    if (last?.tag === tag) last.lines.push(line);
    else blocks.push({ tag, lines: [line] });
  }
  return blocks;
}

function blockHtml(block: Block, formatting: Formatting): string {
  if (block.tag === "pre") return `<pre>${atomsHtml(atomsOf(block.text, "code"))}</pre>`;
  if (block.tag === "rest") {
    const html = block.blocks.map((quoted) => blockHtml(quoted, formatting)).join("");
    return html && `<blockquote>${html}</blockquote>`;
  }
  const lines = withoutBlankEnds(block.lines);
  if (lines.length === 0) return "";
  const html = lines.map((line) => lineHtml(line, formatting)).join("<br>");
  return block.tag === "p" ? `<p>${html}</p>` : `<blockquote><p>${html}</p></blockquote>`;
}

/** `lines` without the blank ones at either end. */
function withoutBlankEnds(lines: string[]): string[] {
  const start = lines.findIndex((line) => line.trim() !== "");
  if (start < 0) return [];
  const end = lines.findLastIndex((line) => line.trim() !== "");
  return lines.slice(start, end + 1);
}

/** A line as markup, emphasized where `formatting` says to. */
function lineHtml(line: string, formatting: Formatting): string {
  const atoms = atomsOf(line, formatting);
  return formatting === "mrkdwn" ? emphasized(atoms) : atomsHtml(atoms);
}

/** The atoms of `text`, read as `mode` says, or, as `emoji`, with only emoji by name, as `plain_text` is. */
function atomsOf(text: string, mode: Mode | "emoji"): Atom[] {
  const atoms: Atom[] = [];
  for (let at = 0; at < text.length; ) {
    const [length, atom] = atomAt(text, at, mode);
    atoms.push(atom);
    at += length;
  }
  return atoms;
}

/** The atom at `at` in `text`, with how much of it it takes. */
function atomAt(text: string, at: number, mode: Mode | "emoji"): [number, Atom] {
  if (mode !== "emoji") {
    const code = mode === "mrkdwn" ? matchAt(CODE, text, at) : null;
    if (code) return [code[0].length, { html: `<code>${atomsHtml(atomsOf(code[1]!, "code"))}</code>` }];
    const special = matchAt(SPECIAL, text, at);
    if (special) return [special[0].length, { html: specialHtml(special[1]!, mode) }];
    const escape = matchAt(ESCAPE, text, at);
    if (escape) return [escape[0].length, UNESCAPED[escape[1]!]!];
  }
  if (mode !== "code") {
    const match = matchAt(WEB_ADDRESS, text, at);
    const address = match && (mode === "mrkdwn" ? withoutClosingMarks(match[0]) : match[0]);
    if (address) return [address.length, { html: escapeText(mode === "emoji" ? address : unescaped(address)) }];
    const shortcode = matchAt(SHORTCODE, text, at);
    const emoji = shortcode && emojiNamed(shortcode[1]!, shortcode[2] === undefined ? undefined : Number(shortcode[2]));
    if (emoji) return [shortcode[0].length, { html: emoji }];
  }
  const char = String.fromCodePoint(text.codePointAt(at)!);
  return [char.length, char];
}

/**
 * A web address without the marks after its last letter or digit, which end the emphasis around it, as in
 * `*https://example.com*.`, and what follows them.
 */
function withoutClosingMarks(address: string): string {
  const chars = [...address];
  let end = chars.length;
  while (end > 0 && !WORD.test(chars[end - 1]!)) end--;
  const mark = chars.slice(end).findIndex((char) => EMPHASES.has(char));
  return mark < 0 ? address : chars.slice(0, end + mark).join("");
}

function matchAt(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

const atomsHtml = (atoms: Atom[]) => atoms.map((atom) => (typeof atom === "string" ? escapeText(atom) : atom.html)).join("");

/** `&amp;`, `&lt;` and `&gt;` in `text` as what they escape. */
const unescaped = (text: string) => text.replace(/&(amp|lt|gt);/g, (_, name: string) => UNESCAPED[name]!);

/**
 * What Slack writes between angle brackets: a link, `<https://…|label>` or `<mailto:…>`; a mention of someone,
 * `<@U…>`, or a channel, `<#C…|name>`; or a command, `<!here>`, `<!subteam^S…|@handle>` or `<!date^…|fallback>`.
 */
function specialHtml(inside: string, mode: Mode): string {
  const bar = inside.indexOf("|");
  const target = bar < 0 ? inside : inside.slice(0, bar);
  const label = bar < 0 ? "" : inside.slice(bar + 1);
  if (target.startsWith("@") || target.startsWith("#")) return escapeText(target[0] + unescaped(label || target.slice(1)));
  if (target.startsWith("!")) return commandHtml(target.slice(1).split("^"), label);
  const address = unescaped(target);
  const href = linkHref(address);
  const shown = label === "" ? escapeText(address.replace(/^mailto:/i, "")) : labelHtml(label, mode);
  return href ? anchor(href, shown) : shown;
}

/** A link's label, formatted as the text around it is. */
function labelHtml(label: string, mode: Mode): string {
  const atoms = atomsOf(label, mode);
  return mode === "mrkdwn" ? emphasized(atoms) : atomsHtml(atoms);
}

/** A command: a date as its fallback text, linked if it gives a link, and the rest as Slack shows them, as text. */
function commandHtml([name, ...args]: string[], label: string): string {
  if (name === "date") {
    const [seconds, , link] = args;
    const shown = escapeText(label === "" ? utcTime(Number(seconds)) : unescaped(label));
    const href = link === undefined ? null : linkHref(unescaped(link));
    return href ? anchor(href, shown) : shown;
  }
  if (name === "subteam") return escapeText(label === "" ? `@${args[0] ?? ""}` : unescaped(label));
  return escapeText(`@${name}`);
}

/**
 * `atoms` as markup, each run between a pair of `*`, `_` or `~` in bold, in italics or struck through, as
 * Slack draws them: a pair starts after a word's edge, before something other than a space, and ends after
 * something other than a space, before a word's edge, all on the run's line.
 */
function emphasized(atoms: Atom[]): string {
  // Where the next pair of each kind could end, from each atom on, so a run without one isn't searched again.
  const ends = new Map([...EMPHASES.keys()].map((mark) => [mark, nextEnds(atoms, mark)]));
  const emphasizedIn = (from: number, to: number): string => {
    let html = "";
    for (let at = from; at < to; at++) {
      const atom = atoms[at]!;
      const tag = typeof atom === "string" ? EMPHASES.get(atom) : undefined;
      const end = tag && startsPair(atoms, at, to) ? ends.get(atom as string)![at + 2]! : Infinity;
      if (end < to) {
        html += `<${tag}>${emphasizedIn(at + 1, end)}</${tag}>`;
        at = end;
      } else html += typeof atom === "string" ? escapeText(atom) : atom.html;
    }
    return html;
  };
  return emphasizedIn(0, atoms.length);
}

/** For each atom, the first from it on that could end a pair of `mark`, or Infinity, with two to spare at the end. */
function nextEnds(atoms: Atom[], mark: string): number[] {
  const ends: number[] = new Array(atoms.length + 2).fill(Infinity);
  for (let at = atoms.length - 1; at >= 1; at--) {
    const endsPair = atoms[at] === mark && !isSpace(atoms[at - 1]) && !isWord(atoms[at + 1]);
    ends[at] = endsPair ? at : ends[at + 1]!;
  }
  return ends;
}

/** Whether the mark at `at` can start a pair that ends before `to`. */
function startsPair(atoms: Atom[], at: number, to: number): boolean {
  const next = atoms[at + 1];
  return !isWord(atoms[at - 1]) && at + 1 < to && !isSpace(next) && next !== atoms[at];
}

const isWord = (atom: Atom | undefined) => typeof atom === "string" && WORD.test(atom);
const isSpace = (atom: Atom | undefined) => typeof atom === "string" && SPACE.test(atom);
