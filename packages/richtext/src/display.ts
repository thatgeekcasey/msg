// What a message shows (`MessagesHelper#message_presentation`): its stored form with addresses linked as
// rails_autolink linked them, as a tree of the elements and attributes a message can show, which the web
// app builds the page from rather than from markup.

import { ATTACHMENT_TAG, isTwitterAvatar, MENTION_CONTENT_TYPE, MISSING_ATTACHABLE, OPENGRAPH_EMBED_CONTENT_TYPE, opengraphEmbedFromNode } from "./attachments";
import { autoLink } from "./autolink";
import { sanitizeContentAttribute } from "./content";
import { BODY, type HtmlParser } from "./markup";
import { userIdFromSgid } from "./mentions";
import { removeSoloUnfurledLinkText } from "./previews";
import { truncate } from "./ruby";
import { AUTO_LINK, scrub, type SafeList } from "./sanitize";
import { toHtml } from "./serialize";
import { append, createElement, createFragment, createText, getAttr, isHtmlElement, type Element, type Fragment, type Node } from "./tree";

/** A message as it shows: text, the elements it's formatted with, the people it mentions, and its link previews. */
export type DisplayNode = DisplayText | DisplayElement | DisplayMention | DisplayPreview;

export interface DisplayText {
  kind: "text";
  value: string;
}

/** An element a message can show, with the attributes it can keep. */
export interface DisplayElement {
  kind: "element";
  name: string;
  attrs: Readonly<Record<string, string>>;
  children: DisplayNode[];
}

/** A mention of a user, who shows as they are now. */
export interface DisplayMention {
  kind: "mention";
  userId: string;
}

/**
 * A link preview, as Campfire's `_opengraph_embed` partial shows one, its text linked as the rest
 * of a message is.
 */
export interface DisplayPreview {
  kind: "preview";
  /** Its title, which links to `href` when it has one, and is otherwise linked as text is. */
  title: DisplayNode[];
  href?: string;
  description: DisplayNode[];
  /** Its image's address. */
  image?: string;
  /** Whether the image is someone's X avatar, which shows small and round. */
  avatar: boolean;
}

/**
 * What a message can show: auto_link's allowlist, the last Rails sanitizes with, less `img` and the
 * attributes only images have, which a stored body can't hold, and `class`, which it doesn't keep.
 */
const DISPLAYED: SafeList = {
  tags: new Set([...AUTO_LINK.tags].filter((tag) => tag !== "img")),
  attributes: new Set([...AUTO_LINK.attributes].filter((name) => !["alt", "class", "src"].includes(name))),
};

const isAttachment = (element: Element, contentType: string) => element.name === ATTACHMENT_TAG && getAttr(element, "content-type") === contentType;
const isMention = (element: Element) => isAttachment(element, MENTION_CONTENT_TYPE);
const isPreview = (element: Element) => isAttachment(element, OPENGRAPH_EMBED_CONTENT_TYPE);

/**
 * A stored body as it shows: only what a message can show, which is all a stored body holds unless
 * something stored it without `prepareBody`, without the text of a link that's all there is to a
 * message but its preview, and then its addresses linked. Linking comes last, as in Rails, so an
 * address with a scheme sanitizing takes out of links, such as `feed://`, is still linked.
 * `plainText` is the body's, and `host` the one the page is served from, which previews mustn't
 * name. Throws `ParseLimitError` past the parser's limits, and `RenderError` for a preview that
 * raises as Rails reads it, which `prepareBody` doesn't store.
 */
export function displayBody(parse: HtmlParser, html: string, plainText: string, host: string): DisplayNode[] {
  const stored = parse(html, BODY);
  removeSoloUnfurledLinkText(parse, stored, plainText, host);
  scrub(stored, DISPLAYED, (element) => isMention(element) || isPreview(element));
  const shown = toHtml(stored, { escapeAttributeBrackets: true });
  // What serializes back to the body as stored lost nothing to either step, since what they take out
  // would be missing from it, so it's still the tree parsing the body gave, as parsing it again would.
  return linked(parse, shown, host, shown === html ? stored : undefined);
}

/**
 * Markup serialized as `presentMessage` serializes it, as it shows, its addresses linked. `parsed` is
 * the markup parsed, where that's been done, for markup with no address to link, as most messages'
 * is, which then needn't be parsed again.
 */
function linked(parse: HtmlParser, html: string, host: string, parsed?: Fragment): DisplayNode[] {
  const displayed = (node: Node): DisplayNode[] => {
    if (node.kind === "text") return [{ kind: "text", value: node.value }];
    // Elements nothing allows can't come out of linking, but would go as `scrub` takes them out
    if (node.kind === "comment" || !isHtmlElement(node)) return [];
    if (isMention(node)) {
      const userId = userIdFromSgid(getAttr(node, "sgid") ?? "");
      return [userId === undefined ? { kind: "text", value: MISSING_ATTACHABLE } : { kind: "mention", userId }];
    }
    if (isPreview(node)) return [displayedPreview(parse, node, host)];
    const children = node.children.flatMap(displayed);
    if (!DISPLAYED.tags.has(node.name)) return children;
    const attrs = Object.fromEntries(node.attrs.filter(({ name }) => DISPLAYED.attributes.has(name)).map(({ name, value }) => [name, value]));
    return [{ kind: "element", name: node.name, attrs, children }];
  };
  const autoLinked = autoLink(parse, html);
  return (parsed !== undefined && autoLinked === html ? parsed : parse(autoLinked, BODY)).children.flatMap(displayed);
}

/**
 * A preview as its partial shows it, read as Rails reads it to render it, with its content
 * sanitized first. Its text is linked as the partial's is, by the auto_link the rest of the
 * message goes through, which leaves the title's own link as it is.
 */
function displayedPreview(parse: HtmlParser, attachment: Element, host: string): DisplayPreview {
  sanitizeContentAttribute(parse, attachment);
  const { href, url, filename, description } = opengraphEmbedFromNode(parse, attachment, host);
  const text = (value: string): DisplayNode[] => (value === "" ? [] : [{ kind: "text", value }]);
  const linkedText = (value: string) => linked(parse, toHtml(createText(value)), host);
  const title = filename === undefined ? (href ?? "") : truncate(filename, 280);
  return {
    kind: "preview",
    title: href === undefined ? linkedText(title) : text(title),
    href,
    description: linkedText(truncate(description ?? "", 560)),
    image: url,
    avatar: isTwitterAvatar(url),
  };
}

/**
 * The markup of what a message shows, with each mention as the text `mention` gives for it and
 * without its previews, as Reply quotes a message (reply_controller.js).
 */
export function displayMarkup(nodes: DisplayNode[], mention: (node: DisplayMention) => string): string {
  return toHtml(createFragment(nodes.flatMap((node) => treeOf(node, mention))), { escapeAttributeBrackets: true });
}

function treeOf(node: DisplayNode, mention: (node: DisplayMention) => string): Node[] {
  if (node.kind === "text") return [createText(node.value)];
  if (node.kind === "mention") return [createText(mention(node))];
  if (node.kind === "preview") return [];
  const element = createElement(node.name, Object.entries(node.attrs).map(([name, value]) => ({ name, value })));
  for (const child of node.children) for (const tree of treeOf(child, mention)) append(element, tree);
  return [element];
}
