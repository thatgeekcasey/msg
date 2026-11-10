import type { LinkPreview } from "@ember/protocol";
import { defaultTreeAdapter, html, parseFragment, type DefaultTreeAdapterMap, type TreeAdapter } from "parse5";
import { fetchContentType, isValidLocation, readHtml, type Outbound } from "./fetch";
import { metaElements, type Attributes } from "./html";
import { parseHttpUri, uriToString } from "./uri";

// A link's preview, from its page's OpenGraph tags: Campfire's `Opengraph::Metadata` and
// `Opengraph::Document`. For a URL Ruby can't parse, an X post fxtwitter can't read, or markup Gumbo
// refuses, there's no preview.

/** `Opengraph::Metadata::ATTRIBUTES` */
const ATTRIBUTES = ["title", "url", "image", "description"] as const;
type Attribute = (typeof ATTRIBUTES)[number];

const TWITTER_HOSTS = new Set(["twitter.com", "www.twitter.com", "x.com", "www.x.com"]);
const FX_TWITTER_HOST = "fxtwitter.com";
const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Gumbo's limits, past which Nokogiri raises: elements open at once, not counting a fragment's `html`, and attributes on one tag. */
const MAX_TREE_DEPTH = 400;
const MAX_ATTRIBUTES = 400;
/**
 * How much of a title or description has its tags stripped, since the HTML parser does quadratic work on
 * some markup, and the app shows at most 280 and 560 characters.
 */
export const MAX_CLEANED_LENGTH = 4096;

/** `String#blank?`: empty or only Unicode whitespace. */
export const isBlank = (text: string) => /^\p{White_Space}*$/u.test(text);

/** `Metadata.from_url(url)`, then `valid?`: the preview, or null when the page doesn't make one. */
export async function linkPreview(outbound: Outbound, url: string): Promise<LinkPreview | null> {
  const page = await readHtml(outbound, pageUrl(url));
  const found = page === null ? {} : opengraphAttributes(page);
  const canonicalUrl = found.url !== undefined && (await isValidLocation(outbound, found.url)) ? found.url : url;
  // The image is checked before the title and description are.
  const image = await validImage(outbound, found.image);
  const title = found.title === undefined ? "" : cleanText(found.title);
  const description = found.description === undefined ? "" : cleanText(found.description);
  if (title === null || description === null || isBlank(title) || isBlank(description)) return null;
  // `valid?` checks the image's location again, but it passed the guard to answer the HEAD.
  return { title, url: canonicalUrl, image, description };
}

/**
 * `fetch_document`'s URL: X and Twitter posts are read from fxtwitter.com, which serves their tags.
 * Their host matches in any case.
 */
function pageUrl(url: string): string {
  const uri = parseHttpUri(url);
  const post = uri !== null && TWITTER_HOSTS.has(uri.host.toLowerCase()) && uri.path !== "" && uri.path !== "/";
  return post ? uriToString({ ...uri, host: FX_TWITTER_HOST }) : url;
}

/**
 * `opengraph_attributes`: from each `<meta>` whose `property` or `name` starts with "og:", the key is
 * that attribute (`property` when it has one) with every "og:" removed, and the value its non-blank
 * `content`. Later tags win. Campfire also drops every non-ASCII character from a page without a meta
 * charset, which this keeps.
 */
export function opengraphAttributes(page: Uint8Array): Partial<Record<Attribute, string>> {
  const found: Partial<Record<Attribute, string>> = {};
  for (const meta of metaElements(page)) {
    if (!isOpengraphTag(meta)) continue;
    const key = (meta.get("property") ?? meta.get("name") ?? "").replaceAll("og:", "");
    const content = meta.get("content");
    if (isAttribute(key) && content !== undefined && !isBlank(content)) found[key] = content;
  }
  return found;
}

const isOpengraphTag = (meta: Attributes) => meta.get("property")?.startsWith("og:") || meta.get("name")?.startsWith("og:");
const isAttribute = (key: string): key is Attribute => (ATTRIBUTES as readonly string[]).includes(key);

/** `valid_image_content_type`: the image, when a HEAD for it answers a JPEG, PNG, GIF or WebP content type, whatever its status. */
async function validImage(outbound: Outbound, image: string | undefined): Promise<string | null> {
  if (image === undefined) return null;
  const contentType = await fetchContentType(outbound, image);
  return contentType !== null && IMAGE_CONTENT_TYPES.has(contentType.toLowerCase()) ? image : null;
}

/** Thrown to stop parsing markup that Gumbo would refuse. */
class TooComplex extends Error {}

/**
 * Rails' `strip_tags`, then `sanitize`: the text of `value` parsed as an HTML5 fragment in a body, with
 * scripting off, script text included and comments left out, answered as plain text rather than escaped,
 * so "Tom & Jerry" shows as written. Null for markup Gumbo refuses.
 */
export function cleanText(value: string): string | null {
  let depth = 0;
  const checkAttributes = (attrs: unknown[]) => {
    if (attrs.length > MAX_ATTRIBUTES) throw new TooComplex();
  };
  const limited: TreeAdapter<DefaultTreeAdapterMap> = {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      checkAttributes(attrs);
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    adoptAttributes(recipient, attrs) {
      checkAttributes(attrs);
      defaultTreeAdapter.adoptAttributes(recipient, attrs);
    },
    // The fragment's own `html` element is the first one pushed.
    onItemPush() {
      if (++depth > MAX_TREE_DEPTH + 1) throw new TooComplex();
    },
    onItemPop() {
      depth--;
    },
  };
  const body = defaultTreeAdapter.createElement("body", html.NS.HTML, []);
  try {
    // Gumbo drops a byte order mark at the start.
    const fragment = parseFragment(body, truncate(value.replace(/^\uFEFF/, "")), { scriptingEnabled: false, treeAdapter: limited });
    return textContent(fragment);
  } catch (error) {
    if (error instanceof TooComplex) return null;
    throw error;
  }
}

/** The first `MAX_CLEANED_LENGTH` UTF-16 code units, or one fewer rather than half a surrogate pair. */
function truncate(value: string): string {
  if (value.length <= MAX_CLEANED_LENGTH) return value;
  const last = value.charCodeAt(MAX_CLEANED_LENGTH - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_CLEANED_LENGTH - 1 : MAX_CLEANED_LENGTH);
}

const isTemplate = (element: DefaultTreeAdapterMap["element"]): element is DefaultTreeAdapterMap["template"] =>
  defaultTreeAdapter.getTagName(element) === "template" && defaultTreeAdapter.getNamespaceURI(element) === html.NS.HTML;

/** The text of every text node under `root`, in document order. A template's contents count, as Nokogiri keeps them as its children. */
function textContent(root: DefaultTreeAdapterMap["parentNode"]): string {
  const adapter = defaultTreeAdapter;
  let text = "";
  const pending = [...adapter.getChildNodes(root)].reverse();
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (adapter.isTextNode(node)) text += adapter.getTextNodeContent(node);
    else if (adapter.isElementNode(node)) {
      const children = adapter.getChildNodes(isTemplate(node) ? adapter.getTemplateContent(node) : node);
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
    }
  }
  return text;
}
