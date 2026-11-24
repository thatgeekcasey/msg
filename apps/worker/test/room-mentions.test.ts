import type { RoomId } from "@ember/protocol";
import { PRIVATE_ROOM_NAME, ROOM_MENTION_CONTENT_TYPE, roomMentionContent } from "@ember/richtext";
import { beforeEach, describe, expect, it } from "vitest";
import { api, connect, createRoom, direct, freshDeploy, post, signIn, type Session } from "./support";

// #room mentions, Slack's links to a channel. A message keeps only the room's id, which each reader's app
// shows as they can see the room, and its plain text, which notifications, search and agents read, names
// only an open room, which everyone is in: a private room's name is for the people in it.

beforeEach(freshDeploy);

/** A mention of room `roomId`, as the composer writes one, with the content it shows, which the room drops. */
const roomMention = (roomId: string, name = "") =>
  `<action-text-attachment content-type="${ROOM_MENTION_CONTENT_TYPE}" sgid="${roomId}" content="${roomMentionContent({ id: roomId, name }).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></action-text-attachment>`;

/** A mention of room `roomId`, as a message keeps it. */
const stored = (roomId: string) => `<action-text-attachment content-type="${ROOM_MENTION_CONTENT_TYPE}" sgid="${roomId}"></action-text-attachment>`;

const as = (session: Session) => ({ Cookie: session.cookie });

const rename = (roomId: RoomId, session: Session, name: string) => api(`/api/rooms/${roomId}`, { method: "PATCH", headers: as(session), body: JSON.stringify({ name }) });

/** Ada, signed in, writing in a room of her own, answering her socket to it. */
async function adaWriting() {
  const ada = await signIn("Ada");
  const lounge = await createRoom("Lounge", { as: ada });
  return { ada, client: await connect(lounge.id, ada) };
}

describe("#room mentions", () => {
  it("keep only the room's id, naming an open room in plain text as it's named when the message is written", async () => {
    const { ada, client } = await adaWriting();
    const pond = await createRoom("Otter Pond", { as: ada });
    const message = await post(client, `<p>See ${roomMention(pond.id, "Otter Pond")} today</p>`);
    expect(message).toMatchObject({ body: `<p>See ${stored(pond.id)} today</p>`, plainText: "See #Otter Pond today", mentions: [] });

    // Renamed, it's named as it is now, whatever the composer showed
    expect((await rename(pond.id, ada, "Beaver Dam")).status).toBe(200);
    expect((await post(client, `<p>${roomMention(pond.id, "Otter Pond")}</p>`)).plainText).toBe("#Beaver Dam");
    client.send({ type: "message.update", messageId: message.id, body: `<p>See ${stored(pond.id)} tomorrow</p>` });
    const { message: edited } = await client.next("message.updated");
    expect(edited).toMatchObject({ body: `<p>See ${stored(pond.id)} tomorrow</p>`, plainText: "See #Beaver Dam tomorrow" });
  });

  it("name a private room only as a private room, even for its members, since whoever reads the message may not be one", async () => {
    const { ada, client } = await adaWriting();
    const plans = await createRoom("Moonshot plans", { closedTo: [ada.user.id], as: ada });
    const message = await post(client, `<p>Details in ${roomMention(plans.id, "Moonshot plans")}</p>`);
    expect(message).toMatchObject({ body: `<p>Details in ${stored(plans.id)}</p>`, plainText: `Details in #${PRIVATE_ROOM_NAME}` });
    expect(JSON.stringify(message)).not.toContain("Moonshot");
  });

  it("show a room that isn't there as ☒: one that never was, a DM, or one deleted since", async () => {
    const { ada, client } = await adaWriting();
    const dm = await direct(ada, await signIn("Grace"));
    const gone = await createRoom("Gone", { as: ada });
    expect((await api(`/api/rooms/${gone.id}`, { method: "DELETE", headers: as(ada) })).status).toBe(204);
    for (const roomId of ["0000000000000000", dm.id, gone.id, "Not a room", ""]) {
      expect(await post(client, `<p>See ${roomMention(roomId)}</p>`), roomId).toMatchObject({ body: "<p>See ☒</p>", plainText: "See ☒" });
    }
  });

  it("never mention anyone, even by an id that's a person's or a special mention's", async () => {
    const { client } = await adaWriting();
    const grace = await signIn("Grace");
    const message = await post(client, `<p>${roomMention(grace.user.id)} ${roomMention("here")}</p>`);
    expect(message).toMatchObject({ body: "<p>☒ ☒</p>", plainText: "☒ ☒", mentions: [] });
  });
});
