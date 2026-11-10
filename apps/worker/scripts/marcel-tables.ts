// Writes src/files/marcel-tables.ts from a dump of Marcel 1.1.0's tables: its extensions, type parents
// and magic numbers, written out as Rust literals. The magic numbers keep the dump's order and its
// escapes, so the two files can be compared line for line. Run it with the path to the dump:
//
//   node apps/worker/scripts/marcel-tables.ts <path to the dump>

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One of `Marcel::MAGIC`'s matches, as the dump has it. */
interface Match {
  offset: number;
  rangeEnd: number | null;
  /** Each character a byte, or null for a match that never hits. */
  value: string | null;
  children: Match[];
}

/** Reads the Rust literals the dump writes, from the start of `text`. */
class Reader {
  private readonly text: string;
  private at = 0;

  constructor(text: string) {
    this.text = text;
  }

  expect(literal: string): void {
    this.skipSpace();
    if (!this.text.startsWith(literal, this.at)) throw new Error(`Expected ${JSON.stringify(literal)} at ${JSON.stringify(this.text.slice(this.at, this.at + 40))}`);
    this.at += literal.length;
  }

  /** Whether `literal` comes next, taking it if it does. */
  take(literal: string): boolean {
    this.skipSpace();
    if (!this.text.startsWith(literal, this.at)) return false;
    this.at += literal.length;
    return true;
  }

  number(): number {
    this.skipSpace();
    const digits = /^\d+/.exec(this.text.slice(this.at))?.[0];
    if (!digits) throw new Error(`Expected a number at ${JSON.stringify(this.text.slice(this.at, this.at + 40))}`);
    this.at += digits.length;
    return Number(digits);
  }

  /** A string as Ruby's `inspect` writes one, with `\u{…}` for what isn't printable. */
  string(): string {
    this.expect('"');
    let value = "";
    for (;;) {
      const c = this.text[this.at++];
      if (c === undefined) throw new Error("Unterminated string");
      if (c === '"') return value;
      if (c !== "\\") {
        value += c;
        continue;
      }
      const escaped = this.text[this.at++];
      if (escaped === "u") {
        const hex = /^\{([0-9a-fA-F]+)\}/.exec(this.text.slice(this.at));
        if (!hex) throw new Error("Bad \\u escape");
        value += String.fromCodePoint(Number.parseInt(hex[1]!, 16));
        this.at += hex[0].length;
      } else if (escaped === '"' || escaped === "\\") value += escaped;
      else throw new Error(`Unexpected escape \\${escaped}`);
    }
  }

  /** A byte string, `b"…"`, whose only escapes are `\xNN`, as each character's code. */
  bytes(): string {
    this.expect('b"');
    let value = "";
    for (;;) {
      const c = this.text[this.at++];
      if (c === undefined) throw new Error("Unterminated byte string");
      if (c === '"') return value;
      if (c !== "\\") {
        value += c;
        continue;
      }
      if (this.text[this.at] !== "x") throw new Error(`Unexpected escape \\${this.text[this.at]}`);
      value += String.fromCharCode(Number.parseInt(this.text.slice(this.at + 1, this.at + 3), 16));
      this.at += 3;
    }
  }

  matches(): Match[] {
    this.expect("&[");
    const matches: Match[] = [];
    while (!this.take("]")) {
      this.expect("Match {");
      this.expect("offset:");
      const offset = this.number();
      this.expect(", range_end:");
      let rangeEnd: number | null = null;
      if (this.take("Some(")) {
        rangeEnd = this.number();
        this.expect(")");
      } else this.expect("None");
      this.expect(", value:");
      let value: string | null = null;
      if (this.take("Some(")) {
        value = this.bytes();
        this.expect(")");
      } else this.expect("None");
      this.expect(", children:");
      const children = this.matches();
      this.expect("}");
      matches.push({ offset, rangeEnd, value, children });
      this.take(",");
    }
    return matches;
  }

  private skipSpace(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at]!)) this.at++;
  }
}

/** The lines of the table `name` declares, one entry each. */
function entries(source: string, name: string): string[] {
  const start = source.indexOf(`pub static ${name}:`);
  if (start < 0) throw new Error(`No ${name} table`);
  const body = source.slice(source.indexOf("\n", start) + 1, source.indexOf("\n];", start));
  return body.split("\n").filter((line) => line.trim() !== "");
}

/** A JavaScript string literal of `bytes`, escaped as the dump escapes them. */
function bytesLiteral(bytes: string): string {
  let literal = '"';
  for (const c of bytes) {
    const code = c.charCodeAt(0);
    literal += code >= 0x20 && code < 0x7f && c !== '"' && c !== "\\" ? c : `\\x${code.toString(16).padStart(2, "0")}`;
  }
  return `${literal}"`;
}

function matchesLiteral(matches: Match[]): string {
  const literals = matches.map(({ offset, rangeEnd, value, children }) => {
    const parts = [String(offset), String(rangeEnd), value === null ? "null" : bytesLiteral(value)];
    if (children.length > 0) parts.push(matchesLiteral(children));
    return `[${parts.join(", ")}]`;
  });
  return `[${literals.join(", ")}]`;
}

const tablesPath = process.argv[2];
if (!tablesPath) {
  console.error("Usage: node apps/worker/scripts/marcel-tables.ts <path to the dump of Marcel's tables>");
  process.exit(1);
}
const source = readFileSync(tablesPath, "utf8");

const extensions = entries(source, "EXTENSIONS").map((line) => {
  const reader = new Reader(line);
  reader.expect("(");
  const extension = reader.string();
  reader.expect(",");
  return [extension, reader.string()] as const;
});
const parents = entries(source, "TYPE_PARENTS").map((line) => {
  const reader = new Reader(line);
  reader.expect("(");
  const type = reader.string();
  reader.expect(", &[");
  const types: string[] = [];
  while (!reader.take("]")) {
    types.push(reader.string());
    reader.take(",");
  }
  return [type, types] as const;
});
const magic = entries(source, "MAGIC").map((line) => {
  const reader = new Reader(line);
  reader.expect("(");
  const type = reader.string();
  reader.expect(",");
  return [type, reader.matches()] as const;
});

const output = `// Generated by apps/worker/scripts/marcel-tables.ts from a dump of Marcel ${/from marcel (\d+(?:\.\d+)*)/.exec(source)?.[1] ?? "?"}'s tables.
// Don't edit it by hand.

/**
 * One of \`Marcel::MAGIC\`'s matches: the bytes \`value\`, each character a byte, at \`offset\`, or
 * anywhere from there to \`end\` when it's a range, then any one of \`children\`. A null \`value\`
 * never matches.
 */
export type Match = readonly [offset: number, end: number | null, value: string | null, children?: readonly Match[]];

/** \`Marcel::EXTENSIONS\`: extension => type. */
export const EXTENSIONS: readonly (readonly [string, string])[] = [
${extensions.map(([extension, type]) => `  [${JSON.stringify(extension)}, ${JSON.stringify(type)}],`).join("\n")}
];

/** \`Marcel::TYPE_PARENTS\`: type => parent types. */
export const TYPE_PARENTS: readonly (readonly [string, readonly string[]])[] = [
${parents.map(([type, types]) => `  [${JSON.stringify(type)}, [${types.map((t) => JSON.stringify(t)).join(", ")}]],`).join("\n")}
];

/** \`Marcel::MAGIC\`, in lookup order: the first type whose matches hit wins. */
export const MAGIC: readonly (readonly [string, readonly Match[]])[] = [
${magic.map(([type, matches]) => `  [${JSON.stringify(type)}, ${matchesLiteral(matches)}],`).join("\n")}
];
`;

const outputPath = fileURLToPath(new URL("../src/files/marcel-tables.ts", import.meta.url));
writeFileSync(outputPath, output);
console.log(`Wrote ${extensions.length} extensions, ${parents.length} parents and ${magic.length} magic types to ${outputPath}`);
