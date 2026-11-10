// The Nokogiri operations that take markup. Action Text serializes nodes and parses markup back in
// many places, and the output takes its shape from those round trips, so each one is reproduced
// in the context Nokogiri parses it in.

import { append, HTML_NAMESPACE, removeChildren, type Element, type Fragment, type Node, type Parent } from "./tree";

/**
 * Gumbo's defaults, past which Nokogiri raises `ArgumentError`
 * (`Nokogiri::Gumbo::DEFAULT_MAX_TREE_DEPTH`, `DEFAULT_MAX_ATTRIBUTES`).
 */
export const MAX_TREE_DEPTH = 400;
export const MAX_ATTRIBUTES = 400;

/**
 * Ember's own limit on the formatting elements a parse reopens, which Gumbo doesn't have. Each
 * paragraph after up to 400 unclosed formatting elements reopens them all, so a few KB could
 * otherwise parse into megabytes. A misnested message reopens a few per paragraph.
 */
export const MAX_REOPENED_ELEMENTS = 1_000;

const LIMIT_MESSAGES = {
  depth: "Document tree depth limit exceeded",
  attributes: "Attributes per element limit exceeded",
  reopened: "Reopened formatting elements limit exceeded",
};

export class ParseLimitError extends Error {
  constructor(readonly limit: keyof typeof LIMIT_MESSAGES) {
    super(LIMIT_MESSAGES[limit]);
    this.name = "ParseLimitError";
  }
}

/** Gumbo skips one byte order mark at the start of its input. */
export function withoutByteOrderMark(markup: string): string {
  return markup.startsWith("\uFEFF") ? markup.slice(1) : markup;
}

/** The element markup is parsed in place of. */
export interface Context {
  name: string;
  namespace: string;
}

/**
 * Parses markup as a fragment in a context, throwing `ParseLimitError` past Gumbo's limits:
 * `parseHtml` (parse5) on the server, `parseDom` in a browser.
 */
export type HtmlParser = (markup: string, context?: Context) => Fragment;

/** `Document#fragment` parses in a `body` context. */
export const BODY: Context = { name: "body", namespace: HTML_NAMESPACE };

/** The context `Node#fragment` parses in: the element itself, or a `body` for anything else. */
export function contextFor(parent: Parent): Context {
  return parent.kind === "element" ? { name: parent.name, namespace: parent.namespace } : BODY;
}

/**
 * What Nokogiri's `node.replace(markup)` puts in a node's place: the markup parsed in the context
 * of its parent. Replace nodes with `replaceEach`.
 */
export function parseReplacement(parse: HtmlParser, node: Node, markup: string): Node[] {
  return node.parent ? removeChildren(parse(markup, contextFor(node.parent))) : [];
}

/** Nokogiri's `node.inner_html = markup`, parsed in the node's own context. */
export function setInnerHtml(parse: HtmlParser, element: Element, markup: string): void {
  const children = removeChildren(parse(markup, contextFor(element)));
  removeChildren(element);
  for (const child of children) append(element, child);
}
