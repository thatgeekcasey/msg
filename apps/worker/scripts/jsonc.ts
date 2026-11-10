// Reads wrangler.jsonc as wrangler does, comments and trailing commas included, for the scripts that run
// before anything is installed, as update-ember.ts does in a copy's Update Ember workflow.

interface Token {
  text: string;
  start: number;
  kind: "string" | "punctuation" | "scalar" | "comment" | "space";
}

/** JSONC's tokens: JSON's, and the comments between them. */
function tokensOf(text: string): Token[] {
  const tokens: Token[] = [];
  for (let at = 0; at < text.length; ) {
    const start = at;
    let kind: Token["kind"];
    if (text[at] === '"') {
      for (at++; at < text.length && text[at] !== '"'; at += text[at] === "\\" ? 2 : 1);
      at++;
      kind = "string";
    } else if (text.startsWith("//", at) || text.startsWith("/*", at)) {
      const end = text.startsWith("//", at) ? text.indexOf("\n", at) : text.indexOf("*/", at + 2) + 2;
      at = end > start ? end : text.length;
      kind = "comment";
    } else if ("{}[]:,".includes(text[at]!)) {
      at++;
      kind = "punctuation";
    } else {
      kind = /\s/.test(text[at]!) ? "space" : "scalar";
      const sameKind = kind === "space" ? /\s/ : /[^\s{}[\]:,"/]/;
      do at++;
      while (at < text.length && sameKind.test(text[at]!));
    }
    tokens.push({ text: text.slice(start, at), start, kind });
  }
  return tokens.filter((token) => token.kind !== "comment" && token.kind !== "space");
}

/** A JSONC file's data, without its comments or the commas it may have before a closing bracket. */
export function dataOf(text: string): unknown {
  const tokens = tokensOf(text);
  const json = tokens.filter((token, at) => !(token.text === "," && "}]".includes(tokens[at + 1]?.text || "}")));
  return JSON.parse(json.map((token) => token.text).join(""));
}

/** A string value in a JSONC file: its path, where its member starts (at its key, in an object), where it is, and what it says. */
export interface JsoncString {
  path: string;
  member: number;
  start: number;
  end: number;
  value: string;
}

/** Each string value in a JSONC file, with its path, such as `name` or `r2_buckets.0.bucket_name`. */
export function stringsOf(text: string): JsoncString[] {
  const strings = [];
  const open: { kind: string; segment: string; key?: string; keyStart?: number; index: number; expectingKey: boolean }[] = [];
  const segmentHere = () => {
    const container = open.at(-1);
    return container?.kind === "[" ? String(container.index) : (container?.key ?? "");
  };
  for (const token of tokensOf(text)) {
    const container = open.at(-1);
    if (token.text === "{" || token.text === "[") {
      open.push({ kind: token.text, segment: segmentHere(), index: 0, expectingKey: token.text === "{" });
    } else if (token.text === "}" || token.text === "]") {
      open.pop();
    } else if (container && token.text === ":") {
      container.expectingKey = false;
    } else if (container && token.text === ",") {
      container.index++;
      container.expectingKey = container.kind === "{";
    } else if (token.kind === "string" && container?.expectingKey) {
      container.key = JSON.parse(token.text) as string;
      container.keyStart = token.start;
    } else if (token.kind === "string") {
      const path = [...open.slice(1).map((outer) => outer.segment), segmentHere()].join(".");
      const member = container?.kind === "{" ? (container.keyStart ?? token.start) : token.start;
      strings.push({ path, member, start: token.start, end: token.start + token.text.length, value: JSON.parse(token.text) as string });
    }
  }
  return strings;
}
