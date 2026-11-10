// Rails' safe-list sanitizer (`Rails::HTML5::SafeListSanitizer` with a `PermitScrubber`, over Loofah's
// HTML5 scrubbing): every sanitizing layer is this one scrubber with a different pair of allowlists.

import { type HtmlParser, BODY } from "./markup";
import { strip } from "./ruby";
import { toHtml } from "./serialize";
import { isHtmlElement, setChildren, type Attr, type Element, type Node, type Parent } from "./tree";

/** `Rails::HTML::Concern::Scrubber::SafeList::DEFAULT_ALLOWED_TAGS` */
const DEFAULT_ALLOWED_TAGS = [
  "a", "abbr", "acronym", "address", "b", "big", "blockquote", "br", "cite", "code", "dd", "del", "dfn", "div", "dl", "dt", "em",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "samp", "small", "span",
  "strong", "sub", "sup", "time", "tt", "ul", "var",
];

/**
 * `DEFAULT_ALLOWED_ATTRIBUTES` without `name`, which Ember drops so a message can't clobber the page's
 * DOM globals (`<img name="body">` shadows `document.body`).
 */
const DEFAULT_ALLOWED_ATTRIBUTES = ["abbr", "alt", "cite", "class", "datetime", "height", "href", "lang", "src", "title", "width", "xml:lang"];

/** Campfire's `ContentFilters::EDITOR_FORMATTING_TAGS` and `_ATTRIBUTES` (app/helpers/content_filters.rb) */
const EDITOR_FORMATTING_TAGS = ["s", "u", "mark", "table", "thead", "tbody", "tfoot", "tr", "th", "td"];
const EDITOR_FORMATTING_ATTRIBUTES = ["data-language"];

/** `ActionText::Attachment::ATTRIBUTES` */
export const ATTACHMENT_ATTRIBUTES = [
  "sgid", "content-type", "url", "href", "filename", "filesize", "width", "height", "previewable", "presentation", "caption", "content",
];

/** The tags and attributes passed to `sanitize(html, tags:, attributes:)`. */
export interface SafeList {
  tags: ReadonlySet<string>;
  attributes: ReadonlySet<string>;
}

/** `ContentFilters::SanitizeTags::ALLOWED_TAGS`: Rails' default tags but `img`, and the editor's. */
const SANITIZE_TAGS_ALLOWED_TAGS = new Set([
  ...DEFAULT_ALLOWED_TAGS.filter((tag) => tag !== "img"),
  ...EDITOR_FORMATTING_TAGS,
  "action-text-attachment",
  "figure",
  "figcaption",
]);

/**
 * `ActionText::ContentHelper.allowed_tags` and `allowed_attributes` as configured at boot: Action Text's
 * defaults, then Lexxy's additions, then Campfire's (lib/rails_ext/action_text_allowed_tags.rb).
 */
export const ACTION_TEXT: SafeList = {
  tags: new Set([
    ...DEFAULT_ALLOWED_TAGS,
    ...["action-text-attachment", "figure", "figcaption"],
    ...["video", "audio", "source", "embed", "table", "tbody", "tr", "th", "td"],
    ...EDITOR_FORMATTING_TAGS,
  ]),
  attributes: new Set([
    ...DEFAULT_ALLOWED_ATTRIBUTES,
    ...ATTACHMENT_ATTRIBUTES,
    ...["controls", "poster", "data-language", "style", "value", "start"],
    ...EDITOR_FORMATTING_ATTRIBUTES,
  ]),
};

/** `ContentFilters::SanitizeAttributes`: SanitizeTags' tags, with Action Text's attributes and `class`. */
export const CONTENT_FILTER: SafeList = {
  tags: SANITIZE_TAGS_ALLOWED_TAGS,
  attributes: new Set([...ACTION_TEXT.attributes, "class"]),
};

/** `sanitize(html)` with Rails' defaults, as rails_autolink sanitizes each address it links. */
export const RAILS_DEFAULTS: SafeList = {
  tags: new Set(DEFAULT_ALLOWED_TAGS),
  attributes: new Set(DEFAULT_ALLOWED_ATTRIBUTES),
};

/** `MessagesHelper::AUTO_LINK_ALLOWED_TAGS` and `_ATTRIBUTES`: the last pass before a message shows. */
export const AUTO_LINK: SafeList = {
  tags: new Set([...DEFAULT_ALLOWED_TAGS, ...EDITOR_FORMATTING_TAGS]),
  attributes: new Set([...DEFAULT_ALLOWED_ATTRIBUTES, ...EDITOR_FORMATTING_ATTRIBUTES]),
};

/** `ContentFilters::SanitizeTags`: removes every element outside its allowlist, with its contents. */
export function sanitizeTags(root: Parent): void {
  setChildren(
    root,
    root.children.filter((node) => {
      if (node.kind !== "element") return true;
      if (!SANITIZE_TAGS_ALLOWED_TAGS.has(node.name)) return false;
      sanitizeTags(node);
      return true;
    }),
  );
}

/** `SafeListSanitizer#sanitize(html, tags:, attributes:)`, keeping the elements `opaque` picks as they are. */
export function sanitize(parse: HtmlParser, markup: string, list: SafeList, opaque?: (element: Element) => boolean): string {
  if (markup === "") return "";
  const fragment = parse(markup, BODY);
  scrub(fragment, list, opaque);
  return toHtml(fragment);
}

/**
 * The scrub `sanitize` runs, in place: children first, then the node. Elements `opaque` picks are
 * kept as they are, children and all.
 */
export function scrub(root: Parent, list: SafeList, opaque?: (element: Element) => boolean): void {
  setChildren(root, root.children.flatMap((child) => scrubbed(child, list, opaque)));
}

/**
 * `Rails::HTML::PermitScrubber#scrub`, bottom up: what a node leaves in its place. An allowed
 * element stays, a comment goes, another HTML element leaves its children, and a foreign (SVG or
 * MathML) one goes with them.
 */
function scrubbed(node: Node, list: SafeList, opaque?: (element: Element) => boolean): Node[] {
  if (node.kind === "text") return [node];
  if (node.kind === "comment") return [];
  if (opaque?.(node)) return [node];
  const children = node.children.flatMap((child) => scrubbed(child, list, opaque));
  if (!list.tags.has(node.name)) return isHtmlElement(node) ? children : [];
  setChildren(node, children);
  scrubAttributes(node, list);
  return [node];
}

/** `Loofah::HTML5::SafeList::ATTR_VAL_IS_URI` */
const ATTR_VAL_IS_URI = new Set(["action", "cite", "href", "longdesc", "poster", "preload", "src", "xlink:href", "xml:base"]);

/**
 * `PermitScrubber#scrub_attributes` with an attribute allowlist. Attributes are visited in order,
 * and each one kept re-escapes every URL attribute on the element as it goes, so a later URL is
 * checked in its re-escaped form (" javascript:" has become "%20javascript:" and passes).
 * `style` isn't scrubbed as Loofah's CSS scrubber would: the last pass drops it anyway.
 */
function scrubAttributes(element: Element, list: SafeList): void {
  const attrs = element.attrs;
  let i = 0;
  while (i < attrs.length) {
    const attr = attrs[i]!;
    if (!list.attributes.has(attr.name) || (ATTR_VAL_IS_URI.has(attr.name) && !allowedUri(attr.value))) {
      attrs.splice(i, 1);
      continue;
    }
    // A blank src goes, but the escaping still runs for the attributes after it
    if (attr.name === "src" && /^\p{White_Space}*$/u.test(attr.value)) attrs.splice(i, 1);
    else i++;
    forceCorrectAttributeEscaping(attrs, element.name === "a");
  }
}

/**
 * `Loofah::HTML5::Scrub.force_correct_attribute_escaping!` (libxml2 builds, which CRuby's are):
 * spaces and double quotes in `href`, `action`, `src` and an `a`'s `name` become `%20` and `%22`.
 * The value is written back through libxml2, which drops the C0 controls XML 1.0 doesn't allow.
 */
function forceCorrectAttributeEscaping(attrs: Attr[], isA: boolean): void {
  for (const attr of attrs) {
    const qualifies = attr.name === "href" || attr.name === "action" || attr.name === "src" || (attr.name === "name" && isA);
    if (qualifies && /[ "\0-\x08\x0b\x0c\x0e-\x1f]/.test(attr.value)) {
      attr.value = attr.value.replace(/[ "\0-\x08\x0b\x0c\x0e-\x1f]/g, (c) => (c === " " ? "%20" : c === '"' ? "%22" : ""));
    }
  }
}

// --- URLs ---------------------------------------------------------------------------------------

const ALLOWED_PROTOCOLS = new Set([
  "afs", "aim", "callto", "data", "ed2k", "fax", "ftp", "gopher", "http", "https", "irc", "line", "mailto", "modem", "news", "nntp",
  "rsync", "rtsp", "sftp", "sms", "ssh", "tag", "tel", "telnet", "urn", "webcal", "xmpp",
]);

const ALLOWED_URI_DATA_MEDIATYPES = new Set(["image/gif", "image/jpeg", "image/png", "text/css", "text/plain"]);

/** `Loofah::HTML5::Scrub::CONTROL_CHARACTERS` */
const CONTROL_CHARACTERS = /[`\0-\x20\x7f\x80-\u0101]/g;

/** `Loofah::HTML5::Scrub.allowed_uri?` */
export function allowedUri(uri: string): boolean {
  const decoded = decodeNumericCharacterReferences(cgiUnescapeHtml(uri.replace(CONTROL_CHARACTERS, "")));
  const value = decoded.replace(CONTROL_CHARACTERS, "").replaceAll("&Tab;", "").replaceAll("&NewLine;", "").replaceAll("&colon;", ":").toLowerCase();
  const protocol = /^([a-z][a-z0-9+\-.]*)(?::|&#0*58|&#x0*3a|%3a|&#37;3a)/.exec(value)?.[1];
  if (protocol === undefined) return true;
  if (!ALLOWED_PROTOCOLS.has(protocol)) return false;
  if (protocol === "data") return ALLOWED_URI_DATA_MEDIATYPES.has(dataUriMediatype(value) ?? "");
  return true;
}

/** `Loofah::HTML5::Scrub.data_uri_mediatype` */
function dataUriMediatype(uri: string): string | undefined {
  const rest = uri.startsWith("data:") ? uri.slice(5) : uri;
  const comma = rest.indexOf(",");
  if (comma < 0) return undefined;
  let metadata = rest.slice(0, comma);
  if (metadata.endsWith(";base64")) metadata = metadata.slice(0, -";base64".length);
  const mediatype = strip(metadata.split(";")[0]!);
  return /^[a-z0-9!#$%&'*+\-.^_`|~]+\/[a-z0-9!#$%&'*+\-.^_`|~]+$/i.test(mediatype) ? mediatype : "text/plain";
}

const NAMED_ENTITIES: [string, string][] = [
  ["&apos;", "'"],
  ["&amp;", "&"],
  ["&quot;", '"'],
  ["&gt;", ">"],
  ["&lt;", "<"],
];

const NUMERIC_REFERENCE = /&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));/y;

/** `CGI.unescapeHTML`: the five named entities, and terminated numeric references below U+10FFFF. */
export function cgiUnescapeHtml(value: string): string {
  let out = "";
  let i = 0;
  for (let amp = value.indexOf("&"); amp >= 0; amp = value.indexOf("&", i)) {
    out += value.slice(i, amp);
    const named = NAMED_ENTITIES.find(([entity]) => value.startsWith(entity, amp));
    NUMERIC_REFERENCE.lastIndex = amp;
    const numeric = named ? null : NUMERIC_REFERENCE.exec(value);
    const code = numeric ? numericReference(numeric[1] ?? numeric[2]!, numeric[1] === undefined ? 10 : 16) : undefined;
    if (named) {
      out += named[1];
      i = amp + named[0].length;
    } else if (numeric && code !== undefined) {
      out += String.fromCodePoint(code);
      i = amp + numeric[0].length;
    } else {
      out += "&";
      i = amp + 1;
    }
  }
  return out + value.slice(i);
}

/** A numeric reference's code point, when `CGI.unescapeHTML` decodes it: below U+10FFFF, and not a surrogate. */
function numericReference(digits: string, radix: number): number | undefined {
  const significant = digits.replace(/^0+/, "");
  if (significant.length > (radix === 16 ? 6 : 7)) return undefined;
  const code = significant === "" ? 0 : parseInt(significant, radix);
  return code < 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? code : undefined;
}

/**
 * `Loofah::HTML5::Scrub.decode_numeric_character_references`: `&#(x[0-9a-f]+|[0-9]+);?`, case
 * insensitive, leaving references with too many significant digits or invalid code points alone.
 */
function decodeNumericCharacterReferences(value: string): string {
  return value.replace(/&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?/g, (reference, hex: string | undefined, decimal: string | undefined) => {
    const digits = (hex ?? decimal)!.replace(/^0+/, "");
    if (digits.length > (hex === undefined ? 7 : 6)) return reference;
    const code = digits === "" ? 0 : parseInt(digits, hex === undefined ? 10 : 16);
    return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : reference;
  });
}
