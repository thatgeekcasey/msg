import type { Account, AccountSettings, BotAnswer, BotSettings, Message, NewWorkspace, NotifiedCounts, RoomId, SpecialMention, WorkspaceServerFrame } from "@ember/protocol";
import { MENTION_CONTENT_TYPE } from "@ember/richtext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  connect,
  cookieOf,
  createRoom,
  direct,
  freshDeploy,
  freshRoom,
  openWorkspaceSocket,
  post,
  roomSql,
  shown,
  signIn,
  workspaceSql,
  workspaceStub,
  type Session,
  type Socket,
} from "./support";

// Slack's special mentions, @here, @channel and @everyone, which name no one but notify a room: whom a message
// making one notifies, and how edits change that. pushes.test.ts checks whom each pushes, and
// mentions.test.ts how the @ prompt offers them.

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
});

/** How a message makes the special mention `name`, as the composer writes one picked from the @ prompt. */
const special = (name: SpecialMention) => `<action-text-attachment sgid="${name}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;

/** How the room keeps the special mention `name` in a message's body. */
const stored = (name: SpecialMention) => `<action-text-attachment content-type="${MENTION_CONTENT_TYPE}" sgid="${name}"></action-text-attachment>`;

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Adds a bot as `administrator`, delivering to `webhookUrl` if it's given. */
async function addBot(administrator: Session, name: string, webhookUrl?: string): Promise<BotSettings> {
  const response = await api("/api/account/bots", { method: "POST", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ name, webhookUrl }) });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as BotAnswer).bot;
}

/** Replies to `parent` in its thread as `client`, sending the reply to the room too with `alsoSend`, and waits for the room to confirm it. */
async function reply(client: Socket, parent: Message, body: string, alsoSend = false): Promise<Message> {
  const clientMessageId = crypto.randomUUID();
  client.send({ type: "message.create", clientMessageId, body, parentId: parent.id, alsoSend });
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.clientMessageId === clientMessageId) return message;
  }
}

/** Edits `message` to `body` as `client`, and waits for the room to say how it is now. */
async function edit(client: Socket, message: Message, body: string): Promise<Message> {
  client.send({ type: "message.update", messageId: message.id, body });
  for (;;) {
    const { message: edited } = await client.next("message.updated");
    if (edited.id === message.id) return edited;
  }
}

/** Whom each of room `room`'s messages notifies, as it keeps them, oldest first. */
const notifiedIn = async (room: RoomId) => ((await roomSql(room, "SELECT notifies FROM messages WHERE room_id = ? ORDER BY id", room)) as Array<{ notifies: string | null }>).map(({ notifies }) => notifies);

describe("Notify a room", () => {
  it("notifies the room as the widest special mention a message sent to it makes, and says so to everyone who opens the room", async () => {
    const room = await freshRoom("Standup");
    const ada = await connect(room, "Ada");

    expect(await post(ada, `<p>${special("here")} ${special("channel")} Standup in 5</p>`)).toMatchObject({ notifies: "channel", plainText: "@here @channel Standup in 5" });
    expect(await post(ada, `<p>Back in 5 ${special("here")}</p>`)).toMatchObject({ notifies: "here", plainText: "Back in 5 @here" });
    expect((await post(ada, "<p>Nobody</p>")).notifies).toBeUndefined();
    expect((await connect(room, "Grace")).welcome.messages.map(({ notifies }) => notifies)).toEqual(["channel", "here", undefined]);
    expect(await notifiedIn(room)).toEqual(["channel", "here", null]);
  });

  it("notifies nobody with a message in a DM, which keeps its special mentions as text, or a reply in a thread, sent to the room too or not, whose show", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const dm = await direct(ada, grace);
    const inDm = await post(await connect(dm.id, ada), `<p>${special("here")} hi</p>`);
    expect(inDm).toMatchObject({ body: "<p>@here hi</p>", plainText: "@here hi" });
    expect(inDm.notifies).toBeUndefined();

    const room = await freshRoom("Threads");
    const adaThere = await connect(room, ada);
    const parent = await post(adaThere, "<p>Ship it?</p>");
    for (const alsoSend of [false, true]) {
      const sent = await reply(adaThere, parent, `<p>${special("channel")} yes</p>`, alsoSend);
      expect(sent).toMatchObject({ body: `<p>${stored("channel")} yes</p>`, plainText: "@channel yes", alsoSent: alsoSend });
      expect(sent.notifies).toBeUndefined();
    }
    expect(await notifiedIn(room)).toEqual([null, null, null]);
  });

  it("lets a bot notify the room through its key, as anyone can, but not with what it says back to a delivery, which is a reply", async () => {
    const ada = await setUp();
    const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
    const bot = await addBot(ada, "Build Bot", "https://bots.example.com/build");
    // The webhook says back a message making @channel, made in the room's own context, which reads it.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(`<p>${special("channel")} deployed</p>`, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const posted = await api(`/rooms/${general}/${bot.key}/messages`, { method: "POST", body: `<p>${special("here")} build passed</p>`, headers: { "Content-Type": "text/html" } });
    expect(posted.status, await posted.clone().text()).toBe(201);
    const client = await connect(general, ada);

    await post(client, `<p>Deploy, <action-text-attachment sgid="${bot.id}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment></p>`);
    expect((await client.next("message.created")).message).toMatchObject({ creator: { id: bot.id }, plainText: "@channel deployed" });
    expect(await notifiedIn(general)).toEqual(["here", null, null]);
  });

  it("lets anyone notify a room with @here and @channel, and an open room with @everyone too, but not a DM, nor an AI agent, which is a bot without a key", async () => {
    const [ada, grace, agent, bot] = [await signIn("Ada"), await signIn("Grace"), await signIn("Agent"), await signIn("Bot")];
    await workspaceSql("UPDATE users SET guest = 0 WHERE id IN (?, ?, ?)", ada.user.id, agent.user.id, bot.user.id);
    await workspaceSql("UPDATE users SET role = 2 WHERE id IN (?, ?)", agent.user.id, bot.user.id);
    await workspaceSql("UPDATE users SET bot_token = 'its-key' WHERE id = ?", bot.user.id);
    const open = await freshRoom("Everyone");
    const closed = (await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id, agent.user.id, bot.user.id], as: ada })).id;
    const dm = await direct(ada, grace);
    const workspace = workspaceStub();

    expect(await workspace.notifyingMentions(open, ada.user.id)).toEqual(["here", "channel", "everyone"]);
    expect(await workspace.notifyingMentions(open, bot.user.id)).toEqual(["here", "channel", "everyone"]);
    expect(await workspace.notifyingMentions(closed, ada.user.id)).toEqual(["here", "channel"]);
    expect(await workspace.notifyingMentions(closed, bot.user.id)).toEqual(["here", "channel"]);
    // Someone signed in with just a name is a guest, who can't use @everyone, as Slack's guests can't.
    expect(await workspace.notifyingMentions(open, grace.user.id)).toEqual(["here", "channel"]);
    for (const room of [open, closed]) expect(await workspace.notifyingMentions(room, agent.user.id)).toEqual([]);
    expect(await workspace.notifyingMentions(dm.id, ada.user.id)).toEqual([]);
    expect(await workspace.notifyingMentions("0000000000000000", ada.user.id)).toEqual([]);
  });

  it("notifies everyone with @everyone in an open room, but in a closed room or from a guest only as widely as the message's other special mentions do", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    await workspaceSql("UPDATE users SET guest = 0 WHERE id = ?", ada.user.id);
    const open = await freshRoom("Everyone");
    const closed = (await createRoom("Leads", { closedTo: [ada.user.id, grace.user.id], as: ada })).id;
    const [adaInOpen, graceInOpen, adaInClosed] = [await connect(open, ada), await connect(open, grace), await connect(closed, ada)];

    expect(await post(adaInOpen, `<p>${special("everyone")} ${special("here")} Lunch is here</p>`)).toMatchObject({ notifies: "everyone", plainText: "@everyone @here Lunch is here" });
    expect(await post(graceInOpen, `<p>${special("everyone")} ${special("here")} Lunch</p>`)).toMatchObject({ notifies: "here", plainText: "@everyone @here Lunch" });
    expect((await post(graceInOpen, `<p>${special("everyone")} Lunch</p>`)).notifies).toBeUndefined();
    expect(await post(adaInClosed, `<p>${special("everyone")} ${special("channel")} Lunch</p>`)).toMatchObject({ notifies: "channel", plainText: "@everyone @channel Lunch" });
    expect((await post(adaInClosed, `<p>${special("everyone")} Lunch</p>`)).notifies).toBeUndefined();
    expect(await notifiedIn(open)).toEqual(["everyone", "here", null]);
  });
});

describe("Who can notify a room", () => {
  /** Changes the account's `settings` as `session`, as workspace settings' switches do. */
  const limit = (session: Session, settings: AccountSettings) =>
    api("/api/account", { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify({ settings }) });

  /** The account's settings, as the Workspace keeps them. */
  const storedSettings = async () => JSON.parse(((await workspaceSql("SELECT settings FROM accounts")) as Array<{ settings: string }>)[0]!.settings) as unknown;

  it("keeps @channel and @here, and @everyone, to administrators once an administrator says so, each on its own, telling every open tab", async () => {
    const ada = await setUp();
    const grace = await signIn("Grace");
    await workspaceSql("UPDATE users SET guest = 0 WHERE id = ?", grace.user.id);
    const room = (await createRoom("Launch", { as: ada })).id;
    const tab = await openWorkspaceSocket(grace);
    const workspace = workspaceStub();
    expect(await workspace.notifyingMentions(room, grace.user.id)).toEqual(["here", "channel", "everyone"]);

    const response = await limit(ada, { restrictChannelMentions: true });
    expect(response.status).toBe(200);
    const { account } = (await response.json()) as { account: Account };
    expect(account).toMatchObject({ restrictChannelMentions: true, restrictEveryoneMention: false });
    expect(await tab.next()).toEqual({ type: "account.updated", account } satisfies WorkspaceServerFrame);
    expect(await workspace.notifyingMentions(room, grace.user.id)).toEqual(["everyone"]);
    expect(await workspace.notifyingMentions(room, ada.user.id)).toEqual(["here", "channel", "everyone"]);

    expect((await limit(ada, { restrictEveryoneMention: true })).status).toBe(200);
    expect(await workspace.notifyingMentions(room, grace.user.id)).toEqual([]);
    expect((await limit(ada, { restrictChannelMentions: false })).status).toBe(200);
    expect(await workspace.notifyingMentions(room, grace.user.id)).toEqual(["here", "channel"]);
    expect(await workspace.notifyingMentions(room, ada.user.id)).toEqual(["here", "channel", "everyone"]);
    expect(await storedSettings()).toEqual({
      restrict_room_creation_to_administrators: false,
      restrict_channel_mentions_to_administrators: false,
      restrict_everyone_mention_to_administrators: true,
    });
  });

  it("keeps a special mention its sender may not use as the text it shows, notifying nobody with it, and the ones they may use as they are", async () => {
    const ada = await setUp();
    const grace = await signIn("Grace");
    await workspaceSql("UPDATE users SET guest = 0 WHERE id = ?", grace.user.id);
    const room = (await createRoom("Launch", { as: ada })).id;
    expect((await limit(ada, { restrictChannelMentions: true })).status).toBe(200);
    const [adaThere, graceThere] = [await connect(room, ada), await connect(room, grace)];

    const refused = await post(graceThere, `<p>${special("here")} ${special("everyone")} ${special("channel")} Launch</p>`);
    expect(refused).toMatchObject({ body: `<p>@here ${stored("everyone")} @channel Launch</p>`, plainText: "@here @everyone @channel Launch", notifies: "everyone" });
    const none = await post(graceThere, `<p>${special("channel")} Launch</p>`);
    expect(none).toMatchObject({ body: "<p>@channel Launch</p>", plainText: "@channel Launch" });
    expect(none.notifies).toBeUndefined();
    expect(await post(adaThere, `<p>${special("channel")} Launch</p>`)).toMatchObject({ body: `<p>${stored("channel")} Launch</p>`, notifies: "channel" });
    expect(await notifiedIn(room)).toEqual(["everyone", null, "channel"]);
  });

  it("notifies nobody in a room whose settings turn them off, keeping them as text from an administrator too", async () => {
    const ada = await setUp();
    const [room, other] = [await createRoom("Announcements", { as: ada }), await createRoom("Design", { as: ada })];
    expect((await api(`/api/rooms/${room.id}`, { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ channelMentions: false }) })).status).toBe(200);
    expect(await workspaceStub().notifyingMentions(room.id, ada.user.id)).toEqual([]);

    const sent = await post(await connect(room.id, ada), `<p>${special("channel")} Read this</p>`);
    expect(sent).toMatchObject({ body: "<p>@channel Read this</p>", plainText: "@channel Read this" });
    expect(sent.notifies).toBeUndefined();
    expect((await post(await connect(other.id, ada), `<p>${special("channel")} Read this</p>`)).notifies).toBe("channel");
  });

  it("offers in a room's @ prompt only the special mentions that would notify it from whoever asks", async () => {
    const ada = await setUp();
    const grace = await signIn("Grace");
    await workspaceSql("UPDATE users SET guest = 0 WHERE id = ?", grace.user.id);
    const [room, quiet] = [await createRoom("Launch", { as: ada }), await createRoom("Quiet", { as: ada })];
    expect((await limit(ada, { restrictEveryoneMention: true })).status).toBe(200);
    expect((await api(`/api/rooms/${quiet.id}`, { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ channelMentions: false }) })).status).toBe(200);
    const offered = async (session: Session, roomId: RoomId) => {
      const response = await api(`/api/autocompletable/users?room_id=${roomId}&special_mentions=1`, { headers: { Cookie: session.cookie } });
      const searches = [...(await response.text()).matchAll(/<lexxy-prompt-item search="([^"]*)"/g)].map((match) => match[1]!);
      return searches.filter((search) => ["here", "channel", "everyone"].includes(search));
    };

    expect(await offered(ada, room.id)).toEqual(["here", "channel", "everyone"]);
    expect(await offered(grace, room.id)).toEqual(["here", "channel"]);
    expect(await offered(ada, quiet.id)).toEqual([]);
  });
});

describe("Ask before notifying a room", () => {
  /** What `GET /api/rooms/<id>/notified` answers `session`, or someone signed out, as the composer asks before sending. */
  const notified = async (session: Session | null, roomId: RoomId) => {
    const response = await api(`/api/rooms/${roomId}/notified`, { headers: session ? { Cookie: session.cookie } : {} });
    return { status: response.status, counts: response.ok ? ((await response.json()) as NotifiedCounts) : null };
  };

  it("counts the people in a room, but bots and those whose accounts aren't active, and whom each special mention would notify from whoever asks, @here those whose tabs are in use", async () => {
    const [ada, grace, lin, hopper, nina, bot] = [await signIn("Ada"), await signIn("Grace"), await signIn("Lin"), await signIn("Hopper"), await signIn("Nina"), await signIn("Bot")];
    await workspaceSql("UPDATE users SET guest = 0 WHERE id = ?", ada.user.id);
    await workspaceSql("UPDATE users SET role = 2 WHERE id = ?", bot.user.id);
    await workspaceSql("UPDATE users SET status = 1 WHERE id = ?", nina.user.id);
    const closed = (await createRoom("Launch", { closedTo: [ada, grace, lin, hopper, nina, bot].map(({ user }) => user.id), as: ada })).id;
    const open = (await createRoom("Everyone", { as: ada })).id;
    // Grace's tab is in use, and Lin's says it isn't.
    await openWorkspaceSocket(grace);
    const linsTab = await openWorkspaceSocket(lin);
    linsTab.send(JSON.stringify({ type: "presence.active", active: false }));
    while ((await linsTab.next()).type !== "presence");

    expect(await notified(ada, closed)).toEqual({ status: 200, counts: { members: 4, mentions: { here: 1, channel: 3 } } });
    expect(await notified(ada, open)).toEqual({ status: 200, counts: { members: 4, mentions: { here: 1, channel: 3, everyone: 3 } } });
    // Grace, a guest, can't use @everyone, and whoever asks is never counted as notified.
    expect(await notified(grace, open)).toEqual({ status: 200, counts: { members: 4, mentions: { here: 0, channel: 3 } } });
    expect(await notified(ada, (await direct(ada, grace)).id)).toEqual({ status: 200, counts: { members: 2, mentions: {} } });
  });

  it("warns until an administrator turns the warning off, telling every open tab", async () => {
    const ada = await setUp();
    const tab = await openWorkspaceSocket(ada);
    const change = async (settings: AccountSettings) => {
      const response = await api("/api/account", { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ settings }) });
      expect(response.status).toBe(200);
      return ((await response.json()) as { account: Account }).account;
    };

    expect((await change({ restrictRoomCreation: true })).warnBeforeNotifying).toBe(true);
    await tab.next();
    const account = await change({ warnBeforeNotifying: false });
    expect(account.warnBeforeNotifying).toBe(false);
    expect(await tab.next()).toEqual({ type: "account.updated", account } satisfies WorkspaceServerFrame);
    const [stored] = (await workspaceSql("SELECT settings FROM accounts")) as Array<{ settings: string }>;
    expect(JSON.parse(stored!.settings)).toMatchObject({ warn_before_notifying: false });
    expect((await change({ warnBeforeNotifying: true })).warnBeforeNotifying).toBe(true);
  });

  it("counts no special mention in a room whose settings turn them off, and answers only the room's members", async () => {
    const ada = await setUp();
    const grace = await signIn("Grace");
    const [quiet, closed] = [await createRoom("Quiet", { as: ada }), await createRoom("Leads", { closedTo: [ada.user.id], as: ada })];
    expect((await api(`/api/rooms/${quiet.id}`, { method: "PATCH", headers: { Cookie: ada.cookie }, body: JSON.stringify({ channelMentions: false }) })).status).toBe(200);

    expect(await notified(ada, quiet.id)).toEqual({ status: 200, counts: { members: 2, mentions: {} } });
    expect((await notified(grace, closed.id)).status).toBe(404);
    expect((await notified(ada, "0000000000000000")).status).toBe(404);
    expect((await notified(ada, "not-a-room")).status).toBe(404);
    expect((await notified(null, quiet.id)).status).toBe(401);
  });
});

describe("Edit a message that notifies a room", () => {
  it("notifies no more widely once edited, as an edit notifies nobody, and nobody once its special mentions are gone", async () => {
    const room = await freshRoom("Edits");
    const ada = await connect(room, "Ada");
    const sent = await post(ada, `<p>${special("channel")} ${special("here")} Standup</p>`);

    const steps = [
      `<p>${special("everyone")} ${special("channel")} Standup</p>`,
      `<p>${special("here")} Standup</p>`,
      `<p>${special("channel")} Standup</p>`,
      "<p>Standup</p>",
      `<p>${special("channel")} Standup</p>`,
    ];
    let message = sent;
    const notified = [];
    for (const body of steps) {
      message = await edit(ada, message, body);
      notified.push(message.notifies);
    }
    expect(notified).toEqual(["channel", "here", "here", undefined, undefined]);
    expect(await notifiedIn(room)).toEqual([null]);
  });

  it("keeps whom a message notifies when its link's preview is added after sending", async () => {
    const room = await freshRoom("Previews");
    const ada = await connect(room, "Ada");
    const sent = await post(ada, `<p>${special("here")} <a href="https://digg.com/tech/oe71bdha">https://digg.com/tech/oe71bdha</a></p>`);
    expect(sent.notifies).toBe("here");

    ada.send({ type: "message.preview", clientMessageId: sent.clientMessageId, preview: { title: "SignuDoc", url: "https://digg.com/tech/oe71bdha", image: "https://digg.com/og.png", description: "A signing app" } });
    const { message } = await ada.next("message.updated");
    expect(message).toMatchObject({ id: sent.id, notifies: "here", editedAt: null });
    expect(message.body).not.toBe(sent.body);
  });
});
