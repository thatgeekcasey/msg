// The small tree rich text is parsed into: what Nokogiri's HTML5 documents give Action Text,
// whichever parser built it (parse5 on the server, the browser's own in the web app).

export const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";

/** An attribute under the name Nokogiri reports and serializes: "href", "xlink:href". */
export interface Attr {
  name: string;
  value: string;
}

export interface Element {
  kind: "element";
  /** The local name, lowercase for HTML and case-adjusted for SVG ("clipPath"). */
  name: string;
  namespace: string;
  attrs: Attr[];
  children: Node[];
  parent: Parent | null;
}

export interface Text {
  kind: "text";
  value: string;
  parent: Parent | null;
}

export interface Comment {
  kind: "comment";
  value: string;
  parent: Parent | null;
}

export interface Fragment {
  kind: "fragment";
  children: Node[];
  parent: null;
}

export type Node = Element | Text | Comment;
export type Parent = Element | Fragment;

export function createElement(name: string, attrs: Attr[] = [], namespace = HTML_NAMESPACE): Element {
  return { kind: "element", name, namespace, attrs, children: [], parent: null };
}

export function createText(value: string): Text {
  return { kind: "text", value, parent: null };
}

export function createComment(value: string): Comment {
  return { kind: "comment", value, parent: null };
}

export function createFragment(children: Node[] = []): Fragment {
  const fragment: Fragment = { kind: "fragment", children: [], parent: null };
  for (const child of children) append(fragment, child);
  return fragment;
}

export function isElement(node: Node | Parent | null | undefined, name?: string): node is Element {
  return node?.kind === "element" && (name === undefined || node.name === name);
}

export function isHtmlElement(node: Node | Parent | null | undefined): node is Element {
  return isElement(node) && node.namespace === HTML_NAMESPACE;
}

/** Nokogiri's `Node#name`: an element's local name, "text" for text and "comment" for comments. */
export function nodeName(node: Node): string {
  return node.kind === "element" ? node.name : node.kind;
}

export function getAttr(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

export function hasAttr(element: Element, name: string): boolean {
  return element.attrs.some((attr) => attr.name === name);
}

/** Nokogiri's `node[name] = value`: changes the attribute in place, or appends it. */
export function setAttr(element: Element, name: string, value: string): void {
  const attr = element.attrs.find((a) => a.name === name);
  if (attr) attr.value = value;
  else element.attrs.push({ name, value });
}

export function removeAttr(element: Element, name: string): string | undefined {
  const index = element.attrs.findIndex((attr) => attr.name === name);
  if (index < 0) return undefined;
  return element.attrs.splice(index, 1)[0]!.value;
}

export function detach(node: Node): void {
  const parent = node.parent;
  if (!parent) return;
  parent.children.splice(parent.children.lastIndexOf(node), 1);
  node.parent = null;
}

export function append(parent: Parent, node: Node): void {
  detach(node);
  node.parent = parent;
  parent.children.push(node);
}

export function insertBefore(reference: Node, node: Node): void {
  detach(node);
  const parent = reference.parent;
  if (!parent) throw new Error("insertBefore needs a reference node with a parent");
  node.parent = parent;
  parent.children.splice(parent.children.lastIndexOf(reference), 0, node);
}

/**
 * Puts each node's replacements, which have no parent, where it was, and detaches it, as replacing
 * them one at a time would, but rebuilding each parent's children once: one at a time, many
 * siblings took time quadratic in their number. A node without a parent stays as is.
 */
export function replaceEach(replacements: ReadonlyMap<Node, readonly Node[]>): void {
  const parents = new Set<Parent>();
  for (const node of replacements.keys()) {
    if (node.parent) parents.add(node.parent);
    node.parent = null;
  }
  for (const parent of parents) setChildren(parent, parent.children.flatMap((child) => replacements.get(child) ?? child));
}

export function removeChildren(parent: Parent): Node[] {
  const children = parent.children;
  parent.children = [];
  for (const child of children) child.parent = null;
  return children;
}

/** Makes `children`, which have no other parent, the parent's. */
export function setChildren(parent: Parent, children: Node[]): void {
  for (const child of children) child.parent = parent;
  parent.children = children;
}

/** Every node below `root` in document order, as it is when called. */
export function descendants(root: Parent): Node[] {
  const out: Node[] = [];
  const stack = [...root.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    if (node.kind === "element") for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
  }
  return out;
}

export function ancestors(node: Node): Parent[] {
  const out: Parent[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) out.push(parent);
  return out;
}

export function elementChildren(parent: Parent): Element[] {
  return parent.children.filter((node) => node.kind === "element");
}

/** libxml2's `xmlNodeGetContent`: a text or comment's own text, or all the text below an element. */
export function textContent(node: Node | Parent): string {
  if (node.kind === "text" || node.kind === "comment") return node.value;
  let out = "";
  for (const descendant of descendants(node)) if (descendant.kind === "text") out += descendant.value;
  return out;
}
