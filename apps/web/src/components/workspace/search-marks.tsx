import { createContext, createElement, Fragment, useContext, type ReactNode } from "react";
import type { DisplayNode, DisplayText } from "@ember/richtext/dom";

/**
 * What to mark in the messages inside it, as a search's results mark the words it matched (`marksFor`),
 * or null for nothing: in their text, their code and their bots' cards, as all of it was searched.
 */
export const SearchMarks = createContext<RegExp | null>(null);

/** Where a match starts and ends in a text. */
type Range = readonly [start: number, end: number];

/** Where a search's matches are in a message's text, by each text node they're in. */
export type Matches = Map<DisplayText, Range[]>;

/** Elements whose text runs on into the text around them, as a word can run through a bold part of it. */
const INLINE = new Set(["a", "abbr", "b", "cite", "code", "del", "dfn", "em", "i", "ins", "kbd", "mark", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "u", "var"]);

/**
 * Where `marks` matches in `nodes`' text, read as it shows, by each text node it's in: a word that runs
 * through formatting is marked in each part of it, and a part of a longer word isn't. A block, a line
 * break, a mention or a link preview ends a word.
 */
export function matchesIn(nodes: readonly DisplayNode[], marks: RegExp): Matches {
  const texts: { node: DisplayText; at: number }[] = [];
  let shown = "";
  const read = (node: DisplayNode) => {
    if (node.kind === "text") {
      texts.push({ node, at: shown.length });
      shown += node.value;
    } else if (node.kind === "element" && INLINE.has(node.name)) {
      node.children.forEach(read);
    } else {
      shown += "\n";
      if (node.kind === "element") node.children.forEach(read);
      shown += "\n";
    }
  };
  nodes.forEach(read);
  const found: Matches = new Map();
  // The matches come in order, as the texts do, so each text is passed once it ends before a match.
  let first = 0;
  for (const match of shown.matchAll(marks)) {
    const [start, end] = [match.index, match.index + match[0].length];
    while (first < texts.length && texts[first]!.at + texts[first]!.node.value.length <= start) first++;
    for (let index = first; index < texts.length && texts[index]!.at < end; index++) {
      const { node, at } = texts[index]!;
      const range: Range = [Math.max(start, at) - at, Math.min(end, at + node.value.length) - at];
      if (range[0] === range[1]) continue;
      const ranges = found.get(node);
      if (ranges) ranges.push(range);
      else found.set(node, [range]);
    }
  }
  return found;
}

/** `text` with each of `ranges`, in order, in a `<mark>`. */
export function markedRanges(text: string, ranges: readonly Range[] | undefined): ReactNode {
  if (!ranges || ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const [start, end] of ranges) {
    parts.push(text.slice(from, start), createElement("mark", { key: start, "data-search-match": "" }, text.slice(start, end)));
    from = end;
  }
  return createElement(Fragment, null, ...parts, text.slice(from));
}

/** `text` with each match of `marks` in a `<mark>`. */
export function marked(text: string, marks: RegExp | null): ReactNode {
  if (!marks) return text;
  return markedRanges(text, [...text.matchAll(marks)].map((match): Range => [match.index, match.index + match[0].length]));
}

/** Text that isn't rich text, as a card's title is, with what the search matched marked. */
export function Marked({ children }: { children: string }) {
  return marked(children, useContext(SearchMarks));
}
