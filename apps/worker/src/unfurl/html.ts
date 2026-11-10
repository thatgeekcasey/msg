import { ENTITIES } from "./entities";

// The slice of `Nokogiri::HTML(html)` (libxml2's legacy HTML parser, in recovery mode) that a link
// preview reads: its `<meta>` elements. Pages tokenize as they do there: the page is read as UTF-8, with
// any byte that isn't valid UTF-8 taken as Latin-1, a NUL ends it, `<script>` and `<style>` hold raw
// text, comments and `<!…>`/`<?…>` markup are skipped, tag and attribute names are lowercased, the first
// of a repeated attribute wins, and attribute values decode HTML 4 entities only when they end with `;`,
// and numeric references with or without one (an invalid one cuts the value short, as the NUL it
// produces ends libxml2's C string).

export type Attributes = ReadonlyMap<string, string>;

/** The attributes a preview reads. A `<meta>` tag's others are parsed, to find where it ends, but not kept. */
const KEPT_ATTRIBUTES = new Set(["property", "name", "content"]);
/** How many distinct attributes of one tag count; the rest are parsed and dropped. */
const MAX_ATTRIBUTES = 256;
/** "thetasym": no longer name is an entity. */
const LONGEST_ENTITY_NAME = 8;
/** A value can hold a million references, so its pieces are joined this many at a time. */
const PIECES_PER_JOIN = 1024;

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const BANG = 0x21;
const DOUBLE_QUOTE = 0x22;
const HASH = 0x23;
const AMPERSAND = 0x26;
const SINGLE_QUOTE = 0x27;
const HYPHEN = 0x2d;
const DOT = 0x2e;
const SLASH = 0x2f;
const COLON = 0x3a;
const SEMICOLON = 0x3b;
const LT = 0x3c;
const EQUALS = 0x3d;
const GT = 0x3e;
const QUESTION = 0x3f;
const UNDERSCORE = 0x5f;

const isBlank = (c: number) => c === SPACE || c === TAB || c === LF || c === CR;
const isAlpha = (c: number) => (c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isNameChar = (c: number) => isAlpha(c) || isDigit(c) || c === COLON || c === UNDERSCORE || c === DOT || c === HYPHEN;

/**
 * The `<meta>` elements of a page, in document order, with whichever of `property`, `name` and
 * `content` they have. A page can hold a hundred thousand, so they're found as they're read.
 */
export function metaElements(page: Uint8Array): Iterable<Attributes> {
  return new Scanner(decodeUtf8OrLatin1(page)).metas();
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes bytes as libxml2 reads a UTF-8 buffer: valid sequences decode, and any other byte is taken as Latin-1. */
export function decodeUtf8OrLatin1(bytes: Uint8Array): string {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    // Spell each byte that isn't part of a sequence as the UTF-8 for its Latin-1 character, and decode that.
    const fixed = new Uint8Array(bytes.length * 2);
    let length = 0;
    for (let i = 0; i < bytes.length; ) {
      const size = utf8SequenceLength(bytes, i);
      if (size === 0) {
        const byte = bytes[i++]!;
        fixed[length++] = 0xc0 | (byte >> 6);
        fixed[length++] = 0x80 | (byte & 0x3f);
      }
      for (const end = i + size; i < end; ) fixed[length++] = bytes[i++]!;
    }
    return strictUtf8.decode(fixed.subarray(0, length));
  }
}

/** How long the well-formed UTF-8 sequence starting at `i` is (Unicode's table 3-7), or 0 if none starts there. */
function utf8SequenceLength(bytes: Uint8Array, i: number): number {
  const first = bytes[i]!;
  if (first < 0x80) return 1;
  // The second byte's range depends on the first; later ones are always 0x80 to 0xBF.
  let size = 0;
  let low = 0x80;
  let high = 0xbf;
  if (first >= 0xc2 && first <= 0xdf) size = 2;
  else if (first >= 0xe0 && first <= 0xef) {
    size = 3;
    if (first === 0xe0) low = 0xa0;
    else if (first === 0xed) high = 0x9f;
  } else if (first >= 0xf0 && first <= 0xf4) {
    size = 4;
    if (first === 0xf0) low = 0x90;
    else if (first === 0xf4) high = 0x8f;
  } else return 0;
  if (i + size > bytes.length) return 0;
  const second = bytes[i + 1]!;
  if (second < low || second > high) return 0;
  for (let k = 2; k < size; k++) if ((bytes[i + k]! & 0xc0) !== 0x80) return 0;
  return size;
}

/** The value of `c` as a digit in base 10 or 16, or -1. */
function digitValue(c: number, radix: number): number {
  if (isDigit(c)) return c - 0x30;
  const lower = c | 0x20;
  return radix === 16 && lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
}

/** Whether `value` is a character XML allows, which a numeric reference must be. */
const isXmlChar = (value: number) =>
  value === TAB || value === LF || value === CR || (value >= 0x20 && value <= 0xd7ff) || (value >= 0xe000 && value <= 0xfffd) || (value >= 0x10000 && value <= 0x10ffff);

class Scanner {
  private pos = 0;
  /** A NUL ends libxml2's input. */
  private readonly end: number;

  constructor(private readonly html: string) {
    const nul = html.indexOf("\0");
    this.end = nul < 0 ? html.length : nul;
  }

  *metas(): Generator<Attributes> {
    while ((this.pos = this.find(LT, this.pos)) < this.end) {
      const next = this.peek(1);
      if (next === SLASH) this.endTag();
      else if (next === BANG) this.markupDeclaration();
      else if (next === QUESTION) this.skipPast(GT);
      else if (isAlpha(next)) {
        const meta = this.startTag();
        if (meta) yield meta;
      } else this.pos++;
    }
  }

  /** The character `ahead` of here, or -1 past the end. */
  private peek(ahead = 0): number {
    const at = this.pos + ahead;
    return at < this.end ? this.html.charCodeAt(at) : -1;
  }

  /** Where the first `c` from `from` up to `to` is, or `to`. */
  private find(c: number, from: number, to = this.end): number {
    const html = this.html;
    let i = from;
    while (i < to && html.charCodeAt(i) !== c) i++;
    return i;
  }

  private skipBlanks(): void {
    while (isBlank(this.peek())) this.pos++;
  }

  /** Moves past the next `c`, or to the end. */
  private skipPast(c: number): void {
    this.pos = Math.min(this.find(c, this.pos) + 1, this.end);
  }

  /** `htmlParseHTMLName`: `[A-Za-z_:.][A-Za-z0-9:_.-]*`. Answers where it started, or -1 when there's no name. */
  private skipName(): number {
    const first = this.peek();
    if (!(isAlpha(first) || first === UNDERSCORE || first === COLON || first === DOT)) return -1;
    const start = this.pos;
    while (isNameChar(this.peek())) this.pos++;
    return start;
  }

  /** Whether the text from `start` begins with `word`, which is lowercase letters, in any case. */
  private startsWithIgnoringCase(start: number, word: string): boolean {
    if (start + word.length > this.end) return false;
    for (let i = 0; i < word.length; i++) if ((this.html.charCodeAt(start + i) | 0x20) !== word.charCodeAt(i)) return false;
    return true;
  }

  /** Whether the name between `start` and here is `name`, which is lowercase letters, in any case. */
  private nameIs(start: number, name: string): boolean {
    return this.pos - start === name.length && this.startsWithIgnoringCase(start, name);
  }

  private endTag(): void {
    this.pos += 2;
    if (this.skipName() >= 0) this.skipPast(GT);
  }

  /** `<!--…-->` (with `<!-->` and `<!--->` closing at once, and `--!>` accepted), `<!DOCTYPE…>`, and any other `<!…>` as a bogus comment. */
  private markupDeclaration(): void {
    if (this.peek(2) !== HYPHEN || this.peek(3) !== HYPHEN) return this.skipPast(GT);
    this.pos += 4;
    if (this.peek() === GT) return void (this.pos += 1);
    if (this.peek() === HYPHEN && this.peek(1) === GT) return void (this.pos += 2);
    for (let hyphen = this.find(HYPHEN, this.pos); hyphen < this.end; hyphen = this.find(HYPHEN, hyphen + 1)) {
      this.pos = hyphen;
      if (this.peek(1) !== HYPHEN) continue;
      if (this.peek(2) === GT) return void (this.pos += 3);
      if (this.peek(2) === BANG && this.peek(3) === GT) return void (this.pos += 4);
    }
    this.pos = this.end;
  }

  /** `htmlParseStartTag`, from its `<`, skipping the raw text of `<script>` and `<style>`. Answers a `<meta>` tag's attributes. */
  private startTag(): Attributes | null {
    this.pos++;
    const start = this.skipName();
    const rawText = this.nameIs(start, "script") ? "script" : this.nameIs(start, "style") ? "style" : null;
    // In a meta, the first MAX_ATTRIBUTES distinct names count, and the first of each wins.
    const meta = this.nameIs(start, "meta");
    const names = meta ? new Set<string>() : null;
    const kept = meta ? new Map<string, string>() : null;
    this.skipBlanks();
    for (let c = this.peek(); c >= 0 && c !== GT && !(c === SLASH && this.peek(1) === GT); c = this.peek()) {
      const name = this.skipName();
      if (name < 0) {
        // A bogus attribute runs to the next blank or the end of the tag.
        while ((c = this.peek()) >= 0 && !isBlank(c) && c !== GT && !(c === SLASH && this.peek(1) === GT)) this.pos++;
      } else {
        let keep: string | null = null;
        if (names && kept && names.size < MAX_ATTRIBUTES && kept.size < KEPT_ATTRIBUTES.size) {
          const lowercase = this.html.slice(name, this.pos).toLowerCase();
          if (!names.has(lowercase)) {
            names.add(lowercase);
            if (KEPT_ATTRIBUTES.has(lowercase)) keep = lowercase;
          }
        }
        this.skipBlanks();
        let value = "";
        if (this.peek() === EQUALS) {
          this.pos++;
          this.skipBlanks();
          value = this.attributeValue(keep !== null);
        }
        if (keep !== null) kept?.set(keep, value);
      }
      this.skipBlanks();
    }
    const selfClosing = this.peek() === SLASH;
    if (selfClosing) this.pos += 2;
    else if (this.peek() === GT) this.pos++;
    if (rawText && !selfClosing) this.skipRawText(rawText);
    return kept;
  }

  /**
   * `htmlParseAttValue`: up to the quote, or unquoted, to a blank or `>`, with its references decoded
   * when it's kept. A reference never reaches past where the value ends, so that's found first.
   */
  private attributeValue(keep: boolean): string {
    const quote = this.peek();
    const quoted = quote === DOUBLE_QUOTE || quote === SINGLE_QUOTE;
    const start = quoted ? this.pos + 1 : this.pos;
    const end = quoted ? this.find(quote, start) : this.unquotedValueEnd(start);
    const value = keep ? this.attributeText(start, end) : "";
    this.pos = quoted ? Math.min(end + 1, this.end) : end;
    return value;
  }

  private unquotedValueEnd(start: number): number {
    const html = this.html;
    let i = start;
    while (i < this.end && html.charCodeAt(i) !== GT && !isBlank(html.charCodeAt(i))) i++;
    return i;
  }

  /** `htmlParseHTMLAttribute`: the text from `start` to `end`, with its references decoded. */
  private attributeText(start: number, end: number): string {
    const html = this.html;
    let value = "";
    const pieces: string[] = [];
    let from = start;
    for (let ampersand = this.find(AMPERSAND, from, end); ampersand < end; ampersand = this.find(AMPERSAND, from, end)) {
      pieces.push(html.slice(from, ampersand));
      this.pos = ampersand;
      const reference = this.peek(1) === HASH ? this.charRef() : this.entityRef();
      // The NUL libxml2 writes for an invalid character reference ends the value.
      if (reference === null) return value + pieces.join("");
      pieces.push(reference);
      from = this.pos;
      if (pieces.length >= PIECES_PER_JOIN) {
        value += pieces.join("");
        pieces.length = 0;
      }
    }
    pieces.push(html.slice(from, end));
    return value + pieces.join("");
  }

  /** `htmlParseCharRef`, from its `&#`: the character, or null for a value that isn't one XML allows. */
  private charRef(): string | null {
    const marker = this.peek(2);
    const radix = marker === 0x78 /* x */ || marker === 0x58 /* X */ ? 16 : 10;
    this.pos += radix === 16 ? 3 : 2;
    let value = 0;
    for (let c = this.peek(); c >= 0; c = this.peek()) {
      if (c === SEMICOLON) {
        this.pos++;
        break;
      }
      const digit = digitValue(c, radix);
      if (digit < 0) break;
      if (value < 0x110000) value = value * radix + digit;
      this.pos++;
    }
    return isXmlChar(value) ? String.fromCodePoint(value) : null;
  }

  /** `htmlParseEntityRef`, from its `&`: a known name followed by `;` decodes, and anything else stays as written. */
  private entityRef(): string {
    const ampersand = this.pos++;
    const first = this.peek();
    if (isAlpha(first) || first === UNDERSCORE || first === COLON) {
      while (isNameChar(this.peek())) this.pos++;
    }
    const length = this.pos - ampersand - 1;
    const codePoint =
      length > 0 && length <= LONGEST_ENTITY_NAME && this.peek() === SEMICOLON ? ENTITIES.get(this.html.slice(ampersand + 1, this.pos)) : undefined;
    if (codePoint === undefined) return this.html.slice(ampersand, this.pos);
    this.pos++;
    return String.fromCharCode(codePoint);
  }

  /** `htmlParseScript`: everything up to `</name`, in any case, is text. */
  private skipRawText(name: string): void {
    for (let lt = this.find(LT, this.pos); lt < this.end; lt = this.find(LT, lt + 1)) {
      this.pos = lt;
      if (this.peek(1) === SLASH && this.startsWithIgnoringCase(lt + 2, name)) return;
    }
    this.pos = this.end;
  }
}
