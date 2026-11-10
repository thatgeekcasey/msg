// `ActionText::Content`: loading a body (canonicalized as Action Text loads a stored one) and its plain
// text.

import { ATTACHMENT_TAG, attachmentFromNode, attachmentPlainText, type ResolveMention } from "./attachments";
import { BODY, parseReplacement, type HtmlParser } from "./markup";
import { nodeToPlainText } from "./plain-text";
import { isBlank, strip } from "./ruby";
import { ACTION_TEXT, sanitize } from "./sanitize";
import { innerHtml } from "./serialize";
import { descendants, getAttr, removeAttr, removeChildren, replaceEach, setAttr, type Element, type Fragment, type Node } from "./tree";

/**
 * How deep content attachments render inside one another. Each level parses and sanitizes everything
 * below it again, so Rails' unbounded nesting makes rendering quadratic in the body's size; deeper ones
 * render empty.
 */
export const MAX_CONTENT_ATTACHMENT_DEPTH = 8;

/**
 * `ActionText::Content.new(html)`, which is also how a stored body loads: attachments emptied and
 * galleries reduced to plain divs. Unlike Action Text, Trix's attachment figures stay figures:
 * Campfire's earlier editor wrote them, and nothing Ember stores was written with it.
 */
export function loadContent(parse: HtmlParser, markup: string): Fragment {
  const fragment = parse(strip(markup), BODY);
  for (const attachment of attachmentNodes(fragment)) removeChildren(attachment);
  const galleries = attachmentGalleryNodes(fragment);
  replaceEach(new Map(galleries.map((gallery) => [gallery, parseReplacement(parse, gallery, `<div>${innerHtml(gallery)}</div>`)])));
  return fragment;
}

export function attachmentNodes(root: Fragment | Element): Element[] {
  return descendants(root).filter((node): node is Element => node.kind === "element" && node.name === ATTACHMENT_TAG);
}

const isGalleryAttachment = (node: Element) => node.name === ATTACHMENT_TAG && getAttr(node, "presentation") === "gallery";

/**
 * `AttachmentGallery.find_attachment_gallery_nodes`: divs holding two or more gallery attachments
 * in a row, and nothing else but spaces and newlines.
 */
export function attachmentGalleryNodes(root: Fragment | Element): Element[] {
  const nodes = descendants(root);
  const followers = galleryAttachmentsAfterAnother(nodes);
  return nodes.filter(
    (div): div is Element =>
      div.kind === "element" &&
      div.name === "div" &&
      div.children.every((child) =>
        child.kind === "text" ? /^[\n ]*$/.test(child.value) : child.kind === "element" && isGalleryAttachment(child),
      ) &&
      descendants(div).some((node) => followers.has(node)),
  );
}

/** The gallery attachments whose previous element sibling is one too (CSS's `A + A`). */
function galleryAttachmentsAfterAnother(nodes: Node[]): Set<Node> {
  const followers = new Set<Node>();
  for (const parent of nodes) {
    if (parent.kind !== "element") continue;
    let previous: Element | undefined;
    for (const child of parent.children) {
      if (child.kind !== "element") continue;
      if (previous && isGalleryAttachment(previous) && isGalleryAttachment(child)) followers.add(child);
      previous = child;
    }
  }
  return followers;
}

/** `ActionText::Content#to_plain_text`, on a loaded body (which it changes). */
export function contentToPlainText(parse: HtmlParser, content: Fragment, resolve: ResolveMention): string {
  const representations = new Map<Node, Node[]>();
  for (const node of attachmentNodes(content)) {
    sanitizeContentAttribute(parse, node);
    const representation = attachmentPlainText(attachmentFromNode(parse, node, resolve));
    representations.set(
      node,
      typeof representation === "string"
        ? parseReplacement(parse, node, representation)
        : removeChildren(loadContent(parse, representation.content)),
    );
  }
  replaceEach(representations);
  return nodeToPlainText(content);
}

/**
 * `render_attachments`' first step, which plain text takes too: an attachment's `content` is
 * sanitized with Action Text's allowlist, and dropped if that leaves nothing.
 */
export function sanitizeContentAttribute(parse: HtmlParser, attachment: Element): void {
  const content = removeAttr(attachment, "content");
  if (content === undefined) return;
  const sanitized = sanitize(parse, content, ACTION_TEXT);
  if (!isBlank(sanitized)) setAttr(attachment, "content", sanitized);
}
