import { parseCards, showsAnything, type Card, type CardContextItem, type CardField, type CardPart, type CardTile } from "@ember/protocol";
import { cardAddress, prepareBody } from "@ember/richtext";

// A bot's cards as the room keeps them (packages/protocol/src/cards.ts): what `parseCards` keeps of them,
// their links and images on named hosts, as a link preview's are, and each text in the stored form, as
// `prepareBody` keeps a body, with the plain text they add to their message's. Which host is this Ember's
// is the page's to know, so each reader's app leaves out an address on it as it draws the card.

/** A message's cards, and their plain text: a line for each part that has text, a field's title before its value. */
export interface KeptCards {
  cards: Card[];
  plainText: string;
}

/** A part as the room keeps it, and the lines of plain text it adds. */
interface KeptPart {
  part: CardPart;
  plainText: string[];
}

/** The cards `value` lists as the room keeps them, leaving out a text that holds nothing, and a card left with nothing to show. */
export function keptCards(value: unknown): KeptCards {
  const lines: string[] = [];
  const cards = parseCards(value, (url) => cardAddress(url, "")).flatMap((card): Card[] => {
    const pretext = card.pretext === undefined ? undefined : keptText(card.pretext);
    const parts = card.parts.flatMap((part) => keptPart(part) ?? []);
    if (!showsAnything(parts.map(({ part }) => part)) && pretext === undefined) return [];
    if (pretext) lines.push(pretext.plainText);
    lines.push(...parts.flatMap(({ plainText }) => plainText));
    const { pretext: _, ...rest } = card;
    return [{ ...rest, ...(pretext && { pretext: pretext.html }), parts: parts.map(({ part }) => part) }];
  });
  return { cards, plainText: lines.join("\n") };
}

/** `part` with its text kept, and the lines of plain text it adds, or null when its text holds nothing. */
function keptPart(part: CardPart): KeptPart | null {
  switch (part.kind) {
    case "author":
      return { part, plainText: [part.name] };
    case "title":
    case "header":
      return { part, plainText: [part.text] };
    case "text": {
      const text = keptText(part.html);
      return text ? { part: { kind: "text", html: text.html }, plainText: [text.plainText] } : null;
    }
    case "section":
      return keptSection(part);
    case "fields": {
      const fields = keptFields(part.fields);
      return fields.fields.length === 0 ? null : { part: { kind: "fields", fields: fields.fields }, plainText: fields.plainText };
    }
    case "image":
      return { part, plainText: part.title === undefined ? [] : [part.title] };
    case "context":
      return keptContext(part.items);
    case "divider":
      return { part, plainText: [] };
    case "buttons":
      return { part, plainText: [part.buttons.map(({ text }) => text).join(" · ")] };
    case "table":
      return keptTable(part.rows, part.columns);
    case "tiles":
      return keptTiles(part.tiles);
    case "footer":
      return { part, plainText: part.text === undefined ? [] : [part.text] };
  }
}

/** A section with its text and fields kept, its lines their plain text and its button's, or null when they hold nothing. */
function keptSection(part: Extract<CardPart, { kind: "section" }>): KeptPart | null {
  const text = part.html === undefined ? undefined : keptText(part.html);
  const fields = keptFields(part.fields ?? []);
  if (text === undefined && fields.fields.length === 0) return null;
  const { html: _, fields: __, ...rest } = part;
  return {
    part: { ...rest, ...(text && { html: text.html }), ...(fields.fields.length > 0 && { fields: fields.fields }) },
    plainText: [...(text ? [text.plainText] : []), ...fields.plainText, ...(part.button ? [part.button.text] : [])],
  };
}

/** Fields with their values kept, leaving out one left with neither a title nor a value, and their lines of plain text. */
function keptFields(fields: CardField[]): { fields: CardField[]; plainText: string[] } {
  const kept = fields.flatMap((field) => {
    const value = field.html === "" ? undefined : keptText(field.html);
    if (field.title === undefined && value === undefined) return [];
    return [{ field: { ...field, html: value?.html ?? "" }, plainText: [field.title ?? "", value?.plainText ?? ""].filter((line) => line !== "") }];
  });
  return { fields: kept.map(({ field }) => field), plainText: kept.flatMap(({ plainText }) => plainText) };
}

/** A context row with its text kept, as one line of plain text, or null when it holds nothing. */
function keptContext(items: CardContextItem[]): KeptPart | null {
  const kept = items.flatMap((item): { item: CardContextItem; plainText?: string }[] => {
    if ("image" in item) return [{ item }];
    const text = keptText(item.html);
    return text ? [{ item: { html: text.html }, plainText: text.plainText }] : [];
  });
  if (kept.length === 0) return null;
  const line = kept.flatMap(({ plainText }) => plainText ?? []).join(" ");
  return { part: { kind: "context", items: kept.map(({ item }) => item) }, plainText: line === "" ? [] : [line] };
}

/** A table with its cells kept, a line of plain text for each row, or null when no cell holds anything. */
function keptTable(rows: string[][], columns: Extract<CardPart, { kind: "table" }>["columns"]): KeptPart | null {
  const kept = rows.map((row) => row.map((cell) => (cell === "" ? undefined : keptText(cell))));
  if (!kept.some((row) => row.some((cell) => cell !== undefined))) return null;
  return {
    part: { kind: "table", rows: kept.map((row) => row.map((cell) => cell?.html ?? "")), columns },
    plainText: kept.map((row) => row.map((cell) => (cell ? onOneLine(cell.plainText) : "")).join(" | ")),
  };
}

/**
 * `text` on one line, each run of whitespace that breaks a line made a space. Each run is matched whole:
 * a pattern for the whitespace on either side of a break would backtrack along a long run without one.
 */
function onOneLine(text: string): string {
  return text.replace(/\s+/g, (space) => (space.includes("\n") ? " " : space));
}

/** Small cards with their body and subtext kept, leaving out one left with nothing, and their lines of plain text. */
function keptTiles(tiles: CardTile[]): KeptPart | null {
  const kept = tiles.flatMap((tile) => {
    const body = tile.body === undefined ? undefined : keptText(tile.body);
    const subtext = tile.subtext === undefined ? undefined : keptText(tile.subtext);
    const { body: _, subtext: __, ...rest } = tile;
    const keptTile: CardTile = { ...rest, ...(body && { body: body.html }), ...(subtext && { subtext: subtext.html }) };
    if (!keptTile.hero && !keptTile.title && !keptTile.subtitle && !body && !subtext && !keptTile.buttons) return [];
    const buttons = tile.buttons?.map(({ text }) => text).join(" · ");
    return [{ tile: keptTile, plainText: [tile.title, tile.subtitle, body?.plainText, subtext?.plainText, buttons].filter((line) => line !== undefined) }];
  });
  return kept.length === 0 ? null : { part: { kind: "tiles", tiles: kept.map(({ tile }) => tile) }, plainText: kept.flatMap(({ plainText }) => plainText) };
}

/** Rich text as the room keeps a body, mentioning no one, with its plain text, or undefined when it holds nothing. */
function keptText(html: string): { html: string; plainText: string } | undefined {
  const body = prepareBody(html, () => undefined);
  return body === null || body.blank ? undefined : { html: body.html, plainText: body.plainText };
}
