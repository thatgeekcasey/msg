// Room mentions, Slack's links to a channel: `<action-text-attachment>` elements of the room mention
// content type whose `sgid` is a room's id. They notify no one. A body keeps only the room's id, so each
// reader sees the room as they can: by its name, linking to it, when they're in it, and otherwise as a
// private room, as Slack shows a private channel to those outside it. Plain text names only open rooms,
// which everyone is in, since everyone who reads it may not be in a private one.

import { isRoomMention, type MentionRoom } from "./attachments";
import { attachmentNodes } from "./content";
import { BODY, type HtmlParser } from "./markup";
import { isPlainParagraph } from "./plain-paragraph";
import { htmlEscape } from "./ruby";
import { getAttr, textContent } from "./tree";

/** What a room shows as to someone who can't see it, and what plain text names a private room. */
export const PRIVATE_ROOM_NAME = "private room";

/**
 * A room mention as the editor shows it, the content of its attachment: the room's name after a #, or,
 * for a room the writer can't see, "private room", after a lock (rich-text-editor.css).
 */
export function roomMentionContent(room: MentionRoom | undefined): string {
  if (!room) return `<span class="room-mention room-mention--private">${PRIVATE_ROOM_NAME}</span>`;
  return `<span class="room-mention">#${htmlEscape(room.name)}</span>`;
}

/**
 * Which rooms markup the editor wrote mentions, once each, in order, named as their mentions show them:
 * by the text of each one's content, after its # (`roomMentionContent`). Throws `ParseLimitError` past
 * the parser's limits.
 */
export function writtenRooms(parse: HtmlParser, markup: string): MentionRoom[] {
  if (isPlainParagraph(markup)) return [];
  const rooms = new Map<string, MentionRoom>();
  for (const attachment of attachmentNodes(parse(markup, BODY))) {
    const id = getAttr(attachment, "sgid");
    if (!isRoomMention(attachment) || id === undefined || rooms.has(id)) continue;
    const shown = textContent(parse(getAttr(attachment, "content") ?? "", BODY)).trim();
    rooms.set(id, { id, name: shown.replace(/^#/, "") });
  }
  return [...rooms.values()];
}
