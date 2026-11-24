import { describe, expect, it } from "vitest";
import { MISSING_ATTACHABLE, ROOM_MENTION_CONTENT_TYPE, type MentionRoom } from "./attachments";
import { plainText, prepareBody, writtenBody } from "./body";
import { attachmentNodes } from "./content";
import { displayBody, displayMarkup } from "./display";
import { editableBody, mentionsIn, mentionSgid, roomIdsIn, specialMentionsAsText, userIdsIn } from "./mentions";
import { parseHtml } from "./parse";
import { PRIVATE_ROOM_NAME, roomMentionContent, writtenRooms } from "./room-mentions";
import { testUserId, testUsers } from "./testing/users";
import { toHtml } from "./serialize";
import { getAttr } from "./tree";

const { resolve } = testUsers("David", "Jason");
/** Test room `n`'s id, shaped as people's are, as the Worker's `sortableId` makes both. */
const roomId = (n: number) => testUserId(100 + n);
const ROOMS = new Map<string, MentionRoom>([
  [roomId(1), { id: roomId(1), name: "All Talk" }],
  [roomId(2), { id: roomId(2), name: "R&D <team>" }],
]);
const rooms = (sgid: string) => ROOMS.get(sgid);
const attributeValue = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** A room mention as the composer writes it, with the content it shows, or as a stored body keeps it, without. */
const roomMention = (sgid: string, content?: string) =>
  `<action-text-attachment content-type="${ROOM_MENTION_CONTENT_TYPE}" sgid="${sgid}"${content === undefined ? "" : ` content="${attributeValue(content)}"`}></action-text-attachment>`;
const written = (n: number) => roomMention(roomId(n), roomMentionContent(ROOMS.get(roomId(n))));
/** `markup` as markup is written out, its attributes' brackets escaped. */
const serialized = (markup: string) => toHtml(parseHtml(markup), { escapeAttributeBrackets: true });
const contentAttachment = (content: string) => `<action-text-attachment content-type="text/html" content="${attributeValue(content)}"></action-text-attachment>`;

describe("Room mentions", () => {
  it("are stored as the room's id alone, which plain text names the room by", () => {
    const body = prepareBody(parseHtml, `<p>See ${written(1)} today</p>`, resolve, rooms);
    expect(body).toEqual({ html: `<p>See ${roomMention(roomId(1))} today</p>`, plainText: "See #All Talk today", mentions: [], specialMentions: [], blank: false });
    expect(prepareBody(parseHtml, body!.html, resolve, rooms)).toEqual(body);
  });

  it("name a room in plain text as its text, not as markup", () => {
    expect(plainText(parseHtml, `<p>${roomMention(roomId(2))}</p>`, resolve, rooms)).toBe("#R&D <team>");
  });

  it("show a room nobody finds as ☒, as a mention of someone nobody finds does", () => {
    for (const unknown of [roomMention(roomId(9)), `<action-text-attachment content-type="${ROOM_MENTION_CONTENT_TYPE}"></action-text-attachment>`]) {
      expect(prepareBody(parseHtml, `<p>See ${unknown}</p>`, resolve, rooms)).toMatchObject({ html: `<p>See ${MISSING_ATTACHABLE}</p>`, plainText: `See ${MISSING_ATTACHABLE}` });
    }
    // Without rooms to look up, as a bot's answer is read, every room is unknown
    expect(prepareBody(parseHtml, `<p>${written(1)}</p>`, resolve)?.html).toBe(`<p>${MISSING_ATTACHABLE}</p>`);
  });

  it("never mention a person or notify anyone, whatever their sgid looks like", () => {
    const body = `<p>${roomMention(testUserId(1))} ${roomMention("here")} ${contentAttachment(roomMention(roomId(2)))}</p>`;
    expect(mentionsIn(parseHtml, body)).toEqual({ userIds: [], specialMentions: [] });
    expect(userIdsIn(parseHtml, body)).toEqual([]);
    expect(roomIdsIn(parseHtml, body)).toEqual([testUserId(1), "here", roomId(2)]);
    const prepared = prepareBody(parseHtml, body, resolve, (sgid) => ({ id: sgid, name: sgid }));
    expect(prepared).toMatchObject({ mentions: [], specialMentions: [] });
    expect(specialMentionsAsText(parseHtml, prepared!.html, ["here"])).toBe(prepared!.html);
  });

  it("show as the room they mention, for each reader to see as they can", () => {
    const stored = prepareBody(parseHtml, `<p><strong>${written(1)}</strong> and ${written(2)}</p>`, resolve, rooms)!;
    const nodes = displayBody(parseHtml, stored.html, stored.plainText, "");
    expect(nodes).toEqual([
      {
        kind: "element",
        name: "p",
        attrs: {},
        children: [
          { kind: "element", name: "strong", attrs: {}, children: [{ kind: "room-mention", roomId: roomId(1) }] },
          { kind: "text", value: " and " },
          { kind: "room-mention", roomId: roomId(2) },
        ],
      },
    ]);
    // A quote keeps each one, shown in the editor as the quoting reader sees it, and as a private room
    // unless it's told otherwise, so its readers see the room as they can, and its text names none
    const quoted = displayMarkup(nodes, () => "", ({ roomId }) => roomMentionContent(rooms(roomId)));
    expect(quoted).toBe(serialized(`<p><strong>${written(1)}</strong> and ${written(2)}</p>`));
    const privateRoom = (n: number) => roomMention(roomId(n), roomMentionContent(undefined));
    expect(displayMarkup(nodes, () => "")).toBe(serialized(`<p><strong>${privateRoom(1)}</strong> and ${privateRoom(2)}</p>`));
    const sent = prepareBody(parseHtml, quoted, resolve, (sgid) => ({ id: sgid, name: PRIVATE_ROOM_NAME }));
    expect(sent).toMatchObject({ html: stored.html, plainText: `#${PRIVATE_ROOM_NAME} and #${PRIVATE_ROOM_NAME}` });
  });

  it("open for editing as the editor's writer sees the room, or as a private room, never dropped", () => {
    const editable = parseHtml(editableBody(parseHtml, `<p>${roomMention(roomId(1))} ${roomMention(roomId(3))}</p>`, () => undefined, "", rooms));
    const contents = attachmentNodes(editable).map((attachment) => [getAttr(attachment, "sgid"), getAttr(attachment, "content")]);
    expect(contents).toEqual([
      [roomId(1), roomMentionContent(ROOMS.get(roomId(1)))],
      [roomId(3), roomMentionContent(undefined)],
    ]);
    expect(roomMentionContent(ROOMS.get(roomId(2)))).toBe('<span class="room-mention">#R&amp;D &lt;team&gt;</span>');
    expect(roomMentionContent(undefined)).toBe(`<span class="room-mention room-mention--private">${PRIVATE_ROOM_NAME}</span>`);
  });

  it("read as the composer wrote them, by the names their content shows, until the room says", () => {
    const body = `<p>${written(1)} ${written(2)} ${written(1)} ${roomMention(roomId(4), roomMentionContent(undefined))} and ${roomMention(testUserId(1), `<span class="mention" sgid="${mentionSgid(testUserId(1))}">David</span>`)}</p>`;
    expect(writtenRooms(parseHtml, body)).toEqual([
      { id: roomId(1), name: "All Talk" },
      { id: roomId(2), name: "R&D <team>" },
      { id: roomId(4), name: PRIVATE_ROOM_NAME },
      { id: testUserId(1), name: "David" },
    ]);
    expect(writtenBody(parseHtml, body)).toEqual({ plainText: `#All Talk #R&D <team> #All Talk #${PRIVATE_ROOM_NAME} and #David`, mentions: [] });
    expect(writtenRooms(parseHtml, "<p>#general</p>")).toEqual([]);
  });
});
