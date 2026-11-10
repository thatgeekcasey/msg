// Message bodies as the composer sends them: rich text whose mentions and link previews are Action Text
// attachments, and the quote that Quote starts a message with. Each piece keeps what Quote would quote of it
// too, which names the people it mentions and leaves out its previews.

/** A message's markup, and what Quote quotes of it. */
export interface Markup {
  body: string;
  quoted: string;
}

/** A person or bot, as a mention or a quote's citation names them. */
export interface Named {
  id: string;
  name: string;
}

/** A link preview's details, as `POST /api/unfurl` answers them for the composer. */
export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image?: string;
}

const MENTION_CONTENT_TYPE = "application/vnd.campfire.mention";
const OPENGRAPH_EMBED_CONTENT_TYPE = "application/vnd.actiontext.opengraph-embed";

export const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const text = (value: string): Markup => ({ body: escapeHtml(value), quoted: escapeHtml(value) });

/** Markup from a template, whose values are text unless they're markup already. */
export function html(strings: TemplateStringsArray, ...values: (string | number | Markup)[]): Markup {
  return values.reduce<Markup>(
    (markup, value, index) => {
      const piece = typeof value === "object" ? value : text(String(value));
      const next = strings[index + 1]!;
      return { body: markup.body + piece.body + next, quoted: markup.quoted + piece.quoted + next };
    },
    { body: strings[0]!, quoted: strings[0]! },
  );
}

/** What's typed into the composer: a paragraph whose lines are kept. */
export function paragraph(typed: string): Markup {
  const lines = typed.split("\n").map(escapeHtml).join("<br>");
  return { body: `<p>${lines}</p>`, quoted: `<p>${lines}</p>` };
}

/** A code block in `language`, as the composer's toolbar writes one, its lines broken with `<br>`s. */
export function codeBlock(language: string, code: string): Markup {
  const body = `<pre data-language="${escapeHtml(language)}">${code.split("\n").map(escapeHtml).join("<br>")}</pre>`;
  return { body, quoted: body };
}

/** A mention of `person`, as the composer's prompt inserts one, which Quote quotes as their name. */
export const mention = (person: Named): Markup => ({
  body: `<action-text-attachment sgid="${escapeHtml(person.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`,
  quoted: escapeHtml(person.name),
});

/**
 * The preview the composer adds below a link it unfurls, with the markup `previewContent` in
 * packages/richtext writes as its content. Quote leaves it out.
 */
export function preview({ url, title, description, image }: LinkPreview): Markup {
  const imageMarkup = image === undefined ? "" : `<div class="og-embed__image"><img src="${escapeHtml(image)}" class="image center" alt=""></div>`;
  const content =
    `<actiontext-opengraph-embed><div class="og-embed gap"><div class="og-embed__content">` +
    `<div class="og-embed__title"><a href="${escapeHtml(url)}" rel="noreferrer" target="_blank">${escapeHtml(title)}</a></div>` +
    `<div class="og-embed__description">${escapeHtml(description)}</div></div>${imageMarkup}</div></actiontext-opengraph-embed>`;
  return { body: `<action-text-attachment content-type="${OPENGRAPH_EMBED_CONTENT_TYPE}" content="${escapeHtml(content)}"></action-text-attachment>`, quoted: "" };
}

/** A paragraph that links to `url` and the preview the composer adds below it. */
export function linkWithPreview(before: string, link: LinkPreview): Markup {
  return html`<p>${before} <a href="${link.url}">${link.url}</a></p>${preview(link)}`;
}

/**
 * What Quote writes, with `reply` typed on the line it leaves: what `original` said, quoted, then who
 * said it, with a link to it at `permalink`.
 */
export function replyMarkup(original: Markup, author: Named, permalink: string, reply: Markup): Markup {
  const quote = `<blockquote>${original.quoted}</blockquote><cite>${escapeHtml(author.name)} <a href="${escapeHtml(permalink)}">#</a></cite>`;
  return { body: quote + reply.body, quoted: quote + reply.quoted };
}
