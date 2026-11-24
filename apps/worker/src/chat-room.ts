import { DurableObject } from "cloudflare:workers";
import {
  ASSISTANT_ID,
  CloseCode,
  DELETED_PERSON_NAME,
  HISTORY_PAGE_SIZE,
  isMessageTooLong,
  isRoomId,
  LATE_PREVIEW_MS,
  MAX_BOOST_LENGTH,
  MAX_MESSAGE_HTML_LENGTH,
  MAX_SCHEDULED_MESSAGES,
  MESSAGE_TOO_LONG,
  parseClientFrame,
  parseRoomSocketParams,
  ROOM_PROTOCOL,
  SCHEDULE_AHEAD_MS,
  SCHEDULE_TIME_REFUSED,
  SCHEDULED_GONE,
  THREAD_DELETED,
  TOO_MANY_SCHEDULED,
  type Boost,
  type Card,
  type CardAction,
  type ClientFrame,
  type EphemeralMessage,
  type LinkPreview,
  type Message,
  type NewUpload,
  type RoomId,
  type ScheduledMessage,
  type ServerFrame,
  type TimelinePage,
  type User,
  type UserId,
} from "@ember/protocol";
import { BLOCKED_WORDS_REFUSED } from "@ember/protocol/blocked-words";
import { parseHuddleSocketParams } from "@ember/protocol/huddles";
import {
  hasPreview,
  prepareBody,
  roomIdsIn,
  specialMentionsAsText,
  userIdFromSgid,
  userIdsIn,
  type MentionRoom,
  type PreparedBody,
  type ResolveRoom,
  type SpecialMention,
} from "@ember/richtext";
import {
  AGENT_NOTES,
  allOf,
  AnswerError,
  answerOf,
  BLOCKED_ANSWER,
  NOTES,
  PICKED_MODEL_NOTES,
  previewAttachment,
  questionFor,
  readable,
  ROOM_MESSAGES_READ,
  ROOM_MESSAGES_READ_BEFORE_THREAD,
  THREAD_REPLIES_READ,
  waitFor,
  writtenBy,
  type Answer,
  type Conversation,
} from "./assistant/answers";
import { askWaiting, goOn, type Answered, type Asking, type GatewayRefusal, type Question } from "./assistant/gateway";
import { takesEmbersTools } from "./assistant/offered";
import { nothingRead, roomTools, type RoomRead, type RoomReader } from "./assistant/room-tools";
import { ToolError, type EmberTool } from "./assistant/tool-calls";
import { saidCard, toolCallOf, toolCards, type CardCall } from "./apps/cards";
import {
  appTool,
  callCard,
  callDecisionOf,
  CALL_OUTCOMES,
  calledFromCard,
  givenAs,
  givenTools,
  ToolGone,
  type AllowsCall,
  type GivenTool,
  type PickedTool,
  type ShowsCard,
} from "./apps/tools";
import { CALL_WAITS_MS, fits, WaitingCalls, type WaitingCall } from "./apps/waiting-calls";
import { eachAtMost, JobQueue } from "./at-once";
import { isFresh, keptBlockedWords, NO_BLOCKED_WORDS, outdated, type KeptBlockedWords } from "./blocked-words";
import { type ActingButton, actingButton, clickPayload } from "./bots/clicks";
import { payloadOf, slackMessage, type SlackMessage, type SlackPayload } from "./bots/slack";
import { postClick, postWebhook, WebhookError, webhookPayload, type ClickAnswer, type Reply } from "./bots/webhooks";
import { keptCards } from "./cards";
import { Courier, ENTRIES_PER_CALL } from "./courier";
import { openDb, type Db } from "./db";
import type { Env } from "./env";
import { attachedFile, Blobs, objectKey, previewKey, type Identified, type RoomBlob, type UploadedPart } from "./files/blobs";
import type { ImageSize } from "./files/images";
import { storeArriving, withPreview, type ArrivingFile, type StreamedFile } from "./files/streamed";
import { NO_STORAGE, type Uploader } from "./files/uploads";
import { HuddleMessage, type HuddleMessageFrame, type HuddleNow } from "./huddles/message";
import { Huddle, HUDDLE_CHECK_MS, HUDDLE_TAG } from "./huddles/room";
import { base36, sortableId } from "./ids";
import { pushesInChunks, sendPushes } from "./push/delivery";
import { urlOf } from "./request-url";
import { addressTag, EVERYONE, heldUpTooLong, REVOCATIONS_KEPT_MS, Revocations, sessionTag, type Revocation } from "./revocations";
import { RoomLog, type RoomEvent } from "./room-log";
import { listed, ScheduledMessages, type KeptScheduled } from "./scheduled-messages";
import { searchIndex } from "./search-index";
import { narrowed, widestOf } from "./special-mentions";
import { CLOSE_REASONS, closedAtOnce, closeTooLarge, isTooLarge, MAX_ROOM_FRAME_SIZE, RESERVED_CLOSE_CODES } from "./sockets";
import { MessageStore, type Deletion, type InThread, type PageCursor, type PostedFile, type StoredBody } from "./store";
import { unfurler } from "./unfurl";
import { viewersOf, type Viewing } from "./viewing";
import { workspace, type AssistantAccess, type BotAccess, type OutsideSender, type WebhookAccess } from "./workspace";
import type { AssistantAsk, InvitationPush, MessagePush, MessageWebhook } from "./workspace-store";

/** What each socket remembers across hibernation. */
interface Attachment extends Viewing {
  roomId: RoomId;
  /** The revision of the room protocol its tab speaks, as its address said. Absent on sockets let in before the room asked. */
  protocol?: number;
  /** Set once the room has closed the socket for a revocation, which announced that it left. */
  revoked?: true;
  /** Set when a ban blocks the IP address the socket comes from: it can read, but not change anything. */
  banned?: true;
  /** Set while the tab is typing, from its typing.start until its typing.stop or message, so closing it stops only typing it did. */
  typing?: true;
}

export const USER_HEADER = "X-Ember-User";
export const ROOM_HEADER = "X-Ember-Room";
export const SESSION_HEADER = "X-Ember-Session";
/** When the Workspace checked the socket's session and membership, in milliseconds since the epoch. */
export const AUTHORIZED_AT_HEADER = "X-Ember-Authorized-At";
/** The IP address the socket comes from, which the room tags it with, so banning the address can find it. */
export const ADDRESS_HEADER = "X-Ember-Address";
/** "true" when a ban blocks the IP address the socket comes from. */
export const BANNED_HEADER = "X-Ember-Banned";
/** "true" on a socket for the room's huddle, rather than for the room itself. */
export const HUDDLE_HEADER = "X-Ember-Huddle";

/** What a deleted room's object keeps in its own storage until its alarm: the room's id, whose records the alarm erases. */
const DELETED_ROOM = "deletedRoom";
/**
 * What it keeps beside that once its alarm has been set for sooner, to have the SFU close what's left
 * of the room's huddle: when the alarm was to erase the room, which it doesn't before.
 */
const ERASE_DUE = "eraseDue";
/** What a room's object keeps in its own storage while its alarm is to send its logs: the room's id. */
const UNDELIVERED_ROOM = "undeliveredRoom";
/**
 * What it keeps beside that: when the logs are to be sent, since while a huddle goes on the alarm rings
 * sooner than that, to check the huddle.
 */
const LOGS_DUE = "logsDue";

/** What an error frame adds for a message refused for `why`: that its writer is to change it, when it's for a word Blocked words keeps out. */
const rewriting = (why: string) => (why === BLOCKED_WORDS_REFUSED ? { rewrite: true as const } : {});

/**
 * What the writer of `body` wrote of it, which Blocked words checks: its plain text with each mention of
 * someone `named` names read as "@" alone, and of a room `rooms` finds as "#" alone, since a name isn't
 * the writer's words, nor part of a word the writer wrote beside it.
 */
function writtenText(body: PreparedBody, named: (sgid: string) => User | undefined, rooms: ResolveRoom, mentionsRooms: boolean): string {
  if (body.mentions.length === 0 && !mentionsRooms) return body.plainText;
  const unnamed = <T extends { name: string }>(found: T | undefined) => found && { ...found, name: "" };
  // Its html prepares as it did, so this reads all of it but the names, or failing that, all of it.
  return prepareBody(body.html, (sgid) => unnamed(named(sgid)), (sgid) => unnamed(rooms(sgid)))?.plainText ?? body.plainText;
}

/** Why the room keeps nothing of a message: it couldn't show it, or there's nothing in it. `MESSAGE_TOO_LONG` says when there's too much. */
const UNREADABLE = "That message couldn't be saved.";
export const EMPTY = "Your message is empty.";
/** Why the room changes nothing of a bot's message with cards that a person edits, as the editor can't hold a card. */
const HAS_CARDS = "Messages with cards can't be edited.";
/** Why it changes nothing of a huddle's message that a person edits: the room writes it, and it shows its huddle rather than its text. */
const OF_A_HUDDLE = "A huddle's message can't be edited.";
/** What the room tells a tab running an app older than its protocol, whose messages and edits it refuses. */
const OUTDATED = "Ember has been updated. Reload the page to keep chatting.";
/**
 * What the room tells a socket from a banned IP address that tries to change something, as the app says
 * of the 429 the Worker answers such a request with.
 */
const BANNED = "Request failed (429)";
/** The frames that change something, which a banned address's sockets can't send. */
const CHANGES = new Set<ClientFrame["type"]>([
  "message.create",
  "message.schedule",
  "scheduled.edit",
  "scheduled.reschedule",
  "scheduled.send",
  "scheduled.delete",
  "message.update",
  "message.preview",
  "message.delete",
  "boost.create",
  "boost.delete",
  "card.click",
]);
/** What an error answering `frame` names of what it was about: the message it sends, those it checks, the scheduled message or the click. */
function aboutOf(frame: ClientFrame): Pick<Extract<ServerFrame, { type: "error" }>, "clientMessageId" | "clientMessageIds" | "scheduledId" | "clickId"> {
  switch (frame.type) {
    case "message.create":
    case "message.schedule":
      return { clientMessageId: frame.clientMessageId };
    case "message.check":
      return { clientMessageIds: frame.clientMessageIds };
    case "scheduled.edit":
    case "scheduled.reschedule":
    case "scheduled.send":
    case "scheduled.delete":
      return { scheduledId: frame.scheduledId };
    case "card.click":
      return { clickId: frame.clickId };
    default:
      return {};
  }
}
/** Whether a message can be scheduled for `time`: one to come, and no further ahead than `SCHEDULE_AHEAD_MS`. */
const isSchedulable = (time: number, now = Date.now()) => time > now && time <= now + SCHEDULE_AHEAD_MS;
/** Whether `ws`'s tab runs an app older than the room protocol. */
const isOutdated = (ws: WebSocket) => ((ws.deserializeAttachment() as Attachment).protocol ?? 1) < ROOM_PROTOCOL;

/**
 * Whether `message` can still take the preview of its link that its sender's tab had once it had gone
 * (`message.preview`): it's text, not edited since it was sent, with no preview yet, and sent within
 * `LATE_PREVIEW_MS` of `now`.
 */
function takesLatePreview(message: Message, now: string): boolean {
  if (message.deleted || message.editedAt !== null || message.attachment || message.cards || message.huddle) return false;
  return Date.parse(now) - Date.parse(message.createdAt) <= LATE_PREVIEW_MS && !hasPreview(message.body);
}

/** Keeps in `ws`'s attachment whether its tab is typing, writing it only when that changes. */
function markTyping(ws: WebSocket, typing: boolean): void {
  const attachment = ws.deserializeAttachment() as Attachment;
  if ((attachment.typing === true) === typing) return;
  const { typing: _, ...rest } = attachment;
  ws.serializeAttachment((typing ? { ...rest, typing: true } : rest) satisfies Attachment);
}

/** A page of a room's messages as the bot API reads it, with how many messages the room has. */
export interface BotPage extends Omit<TimelinePage, "around"> {
  total: number;
}

/** A file R2 has all of for the room, which it's to post: its key, and what it came to as it arrived. */
export interface KeptFile {
  key: string;
  file: StreamedFile;
}

/** How `ChatRoom.create` posts a message: as a reply, which goes to no bot, as a bot's to a webhook delivery is, with a file, or in a thread. */
interface Posting {
  kind?: "message" | "reply";
  posted?: PostedFile;
  inThread?: InThread;
}

/** A message as someone wrote it, which `message.create` sends, and a scheduled message keeps. */
type Written = Pick<ScheduledMessage, "clientMessageId" | "body" | "parentId" | "alsoSend">;

/** How long the alarm waits to send the messages scheduled in a room again, once one couldn't be sent for now. */
const SCHEDULED_RETRY_MS = 60_000;

/** What the room answers a bot that names a message it doesn't have. */
export const NOT_FOUND = "not found";
/** What the room answers a bot that names someone else's message, which it can't change. */
export const FORBIDDEN = "forbidden";
/** What the room answers a bot whose boost has nothing in it. */
export const BLANK = "blank";
/** Why the room keeps no reply in a thread whose message it no longer has. */
export const MESSAGE_GONE = "That message no longer exists";
/** Why the room keeps no longer boost. */
const BOOST_TOO_LONG = `Boosts can be up to ${MAX_BOOST_LENGTH} characters.`;

/**
 * How many of a room's deliveries to bots' webhooks run at once, and how many more can wait.
 */
const WEBHOOKS_AT_ONCE = 2;
const WEBHOOKS_WAITING = 1024;

/**
 * How many pushes a room sends itself, out of those the Workspace answers one call of its log with:
 * Workers Free lets an invocation make 50 requests to the internet, and the room's other work, such as
 * bots' webhooks, makes some. It hands the rest to the Workspace, as many a call, each call an invocation
 * of its own, a couple of calls at a time.
 */
const PUSHES_PER_INVOCATION = 40;
const PUSH_CALLS_AT_ONCE = 2;

/** Why a delivery sends nothing: the Workspace finds no webhook for its bot in the room now. */
const NO_WEBHOOK = "the bot has been deleted, has left the room or has no webhook";
/** Why the room posts nothing of what a bot says back: it was deleted or left the room, or its webhook changed, while the delivery ran. */
const WEBHOOK_CHANGED = "the bot has been deleted, has left the room or its webhook has changed";
/** Why the room posts nothing of what a bot says back to a reply in a thread: the thread's message was deleted while the delivery ran. */
const THREAD_GONE = "the thread's message has been deleted";

/** How many clicks on bots' buttons each person can have waiting in a room, so that no one fills its webhook queue. */
const CLICKS_WAITING_EACH = 3;
/** Why a click goes nowhere: its message, or the button on it, went before the click's turn came. */
const BUTTON_GONE = "That button is no longer there";
const TOO_MANY_CLICKS = "Wait for your earlier clicks to be answered";
const WEBHOOKS_FULL = "Too much is waiting for bots here. Try again in a moment.";
/** What whoever clicked is told when the click's delivery fails without saying why. */
const CLICK_FAILED = "That click couldn't be delivered";

/** Why a click came to nothing: what the room tells whoever clicked, and what it logs. */
class ClickError extends WebhookError {
  constructor(
    readonly told: string,
    logged: string,
  ) {
    super(logged);
  }
}

/** A click on a button that acts, as a socket sends it. */
type CardClick = Extract<ClientFrame, { type: "card.click" }>;

/** The button `click` says was clicked, as a card names one. */
const clickedIn = ({ actionId, blockId, value }: CardClick): CardAction => ({ id: actionId, blockId, value });

/** How many of a room's questions for @ember and the agents it answers at once, and how many more can wait, as each waits on a model. */
const ANSWERS_AT_ONCE = 4;
const ANSWERS_WAITING = 100;

/** How often @ember says again that it's typing while it answers, as apps forget typing they haven't heard of for 5 seconds. */
const TYPING_AGAIN_MS = 3_000;

/** How `typists` and `doings` name a bot typing in thread `threadId`, or in the room. */
const typistOf = (bot: User, threadId: string | undefined) => `${bot.id} ${threadId ?? ""}`;

/** What the room's typing line says an answerer is doing, after its name, while a call of an app's tool it's making runs. */
const usingApp = ({ appName, name }: GivenTool) => `is using ${appName}: ${name}`;

/** Why the room posts nothing for a question for @ember: Ember AI was turned off, or @ember taken out of the room. */
const ASSISTANT_GONE = "Ember AI has been turned off, or @ember is no longer in the room";
/** Why it posts nothing for a question for an agent: Ember AI was turned off, or the agent deleted or taken out of the room. */
const AGENT_GONE = "Ember AI has been turned off, or the agent has been deleted or is no longer in the room";

/** Why the room posts nothing for a question for the bot `botId`, @ember or an agent, which is no longer there to answer. */
const answererGone = (botId: UserId) => (botId === ASSISTANT_ID ? ASSISTANT_GONE : AGENT_GONE);

/** Who answers as the bot `botId`, as the room's logs name them: Ember AI, as @ember, or an agent, by its id. */
const answererOf = (botId: UserId) => (botId === ASSISTANT_ID ? "Ember AI" : `Agent ${botId}`);

/**
 * What the room keeps of what an answerer says in place of an answer with a blocked word. They're Ember's
 * words, so they're not checked, and the answerer always says why it didn't answer.
 */
const blockedAnswerBody = (): PreparedBody | string => prepareBody(answerOf(BLOCKED_ANSWER).markup, () => undefined) ?? UNREADABLE;

/**
 * What @ember or an agent says to a question: its model's answer, or the note saying why it has none, the
 * pages the answer came from, if it used the web, and what people wrote in the conversation it read
 * (`writtenBy`).
 */
interface Said extends Pick<Answered, "text" | "sources"> {
  written?: string[];
}

/**
 * What a question comes to: what its answerer says, or the call of an app's tool its answer waits at, with
 * the apps' tools its model was given and what its calls have read of the room.
 */
type Outcome = Said | { asking: Asking; given: GivenTool[]; read: RoomRead };

/** What the room tells whoever clicks a call's card that isn't waiting any more, as someone answered it first. */
const CALL_ANSWERED = "Someone has answered that already";
/** What it tells them once the call waited too long to be allowed. */
const CALL_LATE = "That waited too long to be allowed. Ask again";
/** What it tells them while the room has no turn left for the answer to go on in. */
const ROOM_BUSY = "Too many questions are waiting for answers in this room. Try again in a moment";
/** What it tells whoever clicks a button of a tool's card while another click on the card is being answered. */
const CARD_BUSY = "That card is answering another click. Try again in a moment";
/** The most characters of why a click's call came to nothing that whoever clicked is told, as an app's server may write it. */
const MAX_TOLD_LENGTH = 300;

/** What whoever clicked is told of `why` a click's call came to nothing, as a model would be told: without what says so to a model, and cut short. */
const toldOf = (why: string) => {
  const told = why.replace(/^Not run: /, "");
  return told.length > MAX_TOLD_LENGTH ? `${told.slice(0, MAX_TOLD_LENGTH - 1)}…` : told;
};

/** The names of the tools of the app `appId` among `picked`, an answerer's. */
const toolsOf = (picked: readonly PickedTool[], appId: string) => new Set(picked.filter((tool) => tool.appId === appId).map(({ name }) => name));
/** Whether `picked`, an answerer's tools in a room, have its calls of `tool`, as its model was given it, made without asking first there. */
const isAlwaysAllowed = (picked: readonly PickedTool[], tool: GivenTool) =>
  picked.some(({ appId, name, fingerprint, alwaysAllowed }) => alwaysAllowed && appId === tool.appId && name === tool.name && fingerprint === tool.fingerprint);
/** Why a call made without asking first isn't shown, and so isn't made, once its answerer's calls of its tool ask first in the room, as they do in a DM or a private room. */
const ASKS_FIRST_NOW = "each call of the tool asks first here now";
/** `question`, asked in a room as the answerer `access` finds it: in a DM or a private room, without AI Gateway's logs keeping what's asked or answered. */
const loggedIn = <Asked extends Omit<Question, "tools">>(question: Asked, { inPrivate }: AssistantAccess): Asked => (inPrivate ? { ...question, unlogged: true } : question);
/** What an answerer says when its model isn't the one that made the call that waited. */
const MODEL_CHANGED = "I can't go on from that call: my model was changed while it waited. Ask me again.";
/** What an answerer says, by its tool's app, when what it has read is too much to keep while a call waits. */
const tooMuchToWait = (app: string) => `I wanted to use ${app}, but this conversation is too long for me to wait while someone allows it. Ask me again in a new thread.`;

/** How long an Active Storage key is: `MINIMUM_TOKEN_LENGTH`. */
const KEY_LENGTH = 28;

/**
 * How many messages deleting the room deletes in each write, and has the search index forget in each
 * call, so that a large room holds up neither the rooms sharing D1 or the index for long, nor fails for
 * its size each time it's tried. A page of history's worth.
 */
export const MESSAGES_DELETED_AT_ONCE = 100;

/** How long an upload may go unfinished, after which the room deletes what R2 has of it. */
export const UNFINISHED_UPLOAD_KEPT_MS = 24 * 60 * 60 * 1000;

/** How long a deleted room waits to erase itself again when R2 couldn't delete its files. */
const ERASE_RETRY_MS = 5 * 60 * 1000;

/** What sends each of a room's logs (see `couriersFor`). */
interface Couriers {
  /** Sends the Workspace the room's events, which it marks the room unread and read by. */
  workspace: Courier;
  /** Sends the search index the messages written, edited, boosted and deleted. */
  index: Courier;
  /** Has R2 delete the files the room has marked deleted. */
  files: Courier;
  /** Sends the Workspace the huddles' messages its list of the huddles that are over has yet to hear of. */
  huddles: Courier;
}

/**
 * One chat room: its WebSockets, who is present and typing, and its messages.
 * Uses the hibernation API, so an idle room costs nothing while sockets stay open.
 */
export class ChatRoom extends DurableObject<Env> {
  private db: Db | null = null;
  private store: MessageStore | null = null;
  private revocations: Revocations | null = null;
  private log: RoomLog | null = null;
  private blobs: Blobs | null = null;
  private waitingCalls: WaitingCalls | null = null;
  private scheduled: ScheduledMessages | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private couriers: Couriers | null = null;
  /** Whether the alarm has erased the room, whose storage no longer says it was deleted. */
  private erased = false;
  private readonly webhooks = new JobQueue(WEBHOOKS_AT_ONCE, WEBHOOKS_WAITING);
  /** How many clicks each person has waiting on bots' webhooks. */
  private readonly clicking = new Map<UserId, number>();
  private readonly answers = new JobQueue(ANSWERS_AT_ONCE, ANSWERS_WAITING);
  /** The tools' cards a click's call is being made for, by their messages' ids: one at a time each, as what it answers takes the card's place. */
  private readonly calling = new Set<string>();
  /** How many jobs each bot is typing for, by its id and the thread it's typing in, if it's in one. */
  private readonly typists = new Map<string, number>();
  /**
   * What each bot that's typing is doing meanwhile, as `typists` names them, if it's more than writing:
   * the calls of its tools it's making, for each of its answers there, in the order they began, the room
   * told of the latest.
   */
  private readonly doings = new Map<string, string[]>();
  /**
   * Who has read the room since its latest message, as far as this object has seen. Only a new message
   * in the room marks it unread, so until one comes another read of theirs would change nothing, and
   * isn't logged.
   */
  private readonly readers = new Set<UserId>();
  /**
   * Who was viewing the room as each of its new messages in the room came, by the message's id, until its
   * event goes to the Workspace, with who was viewing its thread, for a reply sent to the room too.
   * Someone who saw a message come in has seen it, though they may have left the room by the time the
   * Workspace hears of it. Kept in memory only: a message the object restarted since is judged by who's
   * viewing the room as it's sent, as before.
   */
  private readonly seenBy = new Map<string, UserId[]>();
  /**
   * The blocked words the room checks what it saves against, as the Workspace last gave them, or null
   * until it asks (`hasBlockedWord`). Kept in memory only.
   */
  private blockedWords: KeptBlockedWords | null = null;
  /** The room's huddle, whose sockets it keeps beside the room's own. */
  private readonly huddle: Huddle;
  /** The message the room keeps of its huddle, among its own. */
  private readonly huddleMessage: HuddleMessage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeats are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    this.huddle = new Huddle(ctx, env, (time) => this.serially(() => this.checkHuddleBy(time)), (pushes) => this.push(pushes), (huddle) => this.serially(() => this.keepHuddleMessage(huddle)));
    this.huddleMessage = new HuddleMessage(ctx.storage);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const user = JSON.parse(request.headers.get(USER_HEADER) ?? "null") as User | null;
    const roomId = request.headers.get(ROOM_HEADER);
    const sessionId = request.headers.get(SESSION_HEADER);
    const authorizedAt = Number(request.headers.get(AUTHORIZED_AT_HEADER) ?? NaN);
    if (!user || !roomId || !sessionId || !Number.isFinite(authorizedAt)) return new Response("Missing user, room, session or time", { status: 400 });
    const address = request.headers.get(ADDRESS_HEADER);
    const banned = request.headers.get(BANNED_HEADER) === "true";
    const tags = [user.id, sessionTag(sessionId), ...(address ? [addressTag(address)] : [])];
    if (request.headers.get(HUDDLE_HEADER) === "true") {
      // A banned address reads the room and changes nothing in it, and the Worker turns it away from the huddle.
      if (banned) return closedAtOnce(CloseCode.NotFound);
      return this.joinHuddle(user, roomId, tags, authorizedAt, parseHuddleSocketParams(urlOf(request).searchParams).muted);
    }
    const { visible, since, around, apart, protocol } = parseRoomSocketParams(urlOf(request).searchParams);

    return this.serially(async () => {
      // Read side by side, so a room that has just woken waits on D1 once.
      const [refused, opening, cards] = await Promise.all([
        this.revocationsFor(roomId).refuse(tags, authorizedAt),
        this.opening(roomId, user.id, since, around),
        this.waitingCallsFor(roomId).cardsFor(user.id),
      ]);
      if (refused) return closedAtOnce(CloseCode.Reconnect);
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server, tags);
      server.serializeAttachment({ user, roomId, visible, protocol, heardAt: Date.now(), ...(apart && { apart }), ...(banned && { banned }) } satisfies Attachment);

      // With the cards of the calls asked in the room's timeline that wait on them, which only they see, in
      // the place of any the tab showed. A thread's come with its `thread.opened`. A tab too old to know of
      // them is told to reload.
      const ephemeral = protocol < ROOM_PROTOCOL ? [] : cards.filter((message) => message.parentId === undefined);
      this.send(server, { ...opening, you: user, present: this.present(), ...(ephemeral.length > 0 && { ephemeral }) });
      // A tab running an older app hears at once that it has to reload, rather than once it sends something.
      if (protocol < ROOM_PROTOCOL) this.send(server, { type: "error", message: OUTDATED });
      // Everyone else has the list from their own welcome, so they only hear who's new: nobody is, for
      // a socket that shows a thread apart from the room's timeline.
      if (!apart && !this.isPresent(user.id, server)) this.broadcast({ type: "presence.joined", user }, server);
      const couriers = this.couriersFor(roomId);
      // Opening the room in a shown tab reads it, which sends the Workspace the log. Logged next,
      // rather than before the socket is let in, so the welcome doesn't wait on it. A socket that shows
      // a thread apart from the room's timeline reads nothing of the room.
      if (visible && !apart) void this.serially(() => this.read(roomId, user.id)).catch((error) => console.error("Could not log a read", error));
      // Otherwise the first socket since the object started sends whatever a restart left in the log.
      else if (!couriers.workspace.checked) couriers.workspace.deliver();
      // And the search index's, which nothing else here sends, the files to delete, and the huddles
      // there were before the Workspace listed them, which their log starts with.
      if (!couriers.index.checked) couriers.index.deliver();
      if (!couriers.files.checked) couriers.files.deliver();
      if (!couriers.huddles.checked) couriers.huddles.deliver();
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  /**
   * Lets `user` into the room's huddle on a socket of its own, which carries the tags a socket of the
   * room's does, so whatever ends their access to the room takes them out of its huddle. Like one of the
   * room's, it's turned away when the Workspace's word for it is too old, or older than a revocation.
   */
  private async joinHuddle(user: User, roomId: RoomId, tags: string[], authorizedAt: number, muted: boolean): Promise<Response> {
    // Cloudflare is asked for the relay's servers before the join takes its turn, so that nothing else the room does waits on its answer.
    const iceServers = await this.huddle.iceServers(roomId);
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse(tags, authorizedAt)) return closedAtOnce(CloseCode.Reconnect);
      const response = await this.huddle.join(user, roomId, tags, muted, iceServers, await this.huddleMessage.resumed(user.id));
      if (this.huddle.live) await this.checkHuddleBy(Date.now() + HUDDLE_CHECK_MS);
      return response;
    });
  }

  /**
   * What `userId`'s socket starts with: what changed since `since`, the latest change its tab has seen, if
   * it names one and the room keeps every change after it, or else a welcome's page, which is the one
   * around the message `around` names, for a tab opened at its permalink, or the newest, with what they
   * have scheduled here, if anything.
   */
  private async opening(roomId: RoomId, userId: UserId, since: number | undefined, around: string | undefined) {
    const store = this.storeFor(roomId);
    const [changes, scheduled] = await Promise.all([since === undefined ? null : store.changesSince(since), this.scheduledFor(roomId).of(userId)]);
    const theirs = scheduled.length > 0 && { scheduled: scheduled.map(listed) };
    if (changes) return { type: "resumed" as const, ...changes, ...theirs };
    return { type: "welcome" as const, ...(await store.opening(HISTORY_PAGE_SIZE, around)), ...theirs };
  }

  /** Resolves once the room's messages can be read. */
  async health(roomId: RoomId): Promise<void> {
    await this.serially(() => this.storeFor(roomId).page(1));
  }

  /**
   * Closes the sockets each of `revocations` names here, with its code, once the Workspace has saved
   * the change that ended their access, and turns away their sockets that it let through at or
   * before `revokedAt`, which may have been checked before the change. Queued behind the events
   * before it, so a socket it was opening is closed too. Whoever loses their last socket here leaves
   * at once, rather than when their app answers the close, which it may never do.
   */
  async revoke(roomId: RoomId, revocations: Revocation[], revokedAt: number): Promise<void> {
    await this.serially(async () => {
      await this.revocationsFor(roomId).record(
        revocations.map(({ tag }) => tag),
        revokedAt,
      );
      const deletion = revocations.find(({ tag }) => tag === EVERYONE);
      if (deletion) return this.destroy(roomId, deletion.code);
      const leaving = new Map<UserId, User>();
      for (const { tag, code } of revocations) {
        for (const socket of this.ctx.getWebSockets(tag)) {
          if (this.huddle.has(socket)) {
            this.huddle.remove(socket, code);
            continue;
          }
          const user = this.close(socket, code);
          if (user) leaving.set(user.id, user);
        }
      }
      for (const user of leaving.values()) this.depart(user);
    });
  }

  /**
   * Closes every socket in a room the Workspace has deleted, with `code`, its huddle's among them, which
   * the SFU stops carrying, and deletes its messages, with their files, and has the search index forget
   * them, each `MESSAGES_DELETED_AT_ONCE` at a time, and the messages scheduled there. Nobody is left to hear who leaves. The record that
   * the room was deleted stays, turning away sockets let through before then, until none of those could
   * still arrive, when the alarm erases it. A failure has the Workspace ask again, which goes on from
   * the batch that failed.
   */
  private async destroy(roomId: RoomId, code: CloseCode): Promise<void> {
    this.huddle.end(code, true);
    for (const socket of this.roomSockets()) this.close(socket, code);
    await this.huddleMessage.forget();
    while (await this.storeFor(roomId).deleteMessages(MESSAGES_DELETED_AT_ONCE));
    await this.logFor(roomId).forget();
    await this.waitingCallsFor(roomId).forget();
    await this.scheduledFor(roomId).forget();
    while (await searchIndex(this.env).forget(roomId, MESSAGES_DELETED_AT_ONCE));
    await this.ctx.storage.put(DELETED_ROOM, roomId);
    // Asked again, as after a failure, the room is to be erased later than it was.
    await this.ctx.storage.delete(ERASE_DUE);
    await this.ctx.storage.setAlarm(Date.now() + REVOCATIONS_KEPT_MS);
    this.couriersFor(roomId).files.deliver();
  }

  /**
   * Erases what's left of a deleted room, once R2 has deleted its files. Otherwise, checks the room's
   * huddle, and comes back to check it while one goes on, and sends the room's logs. While a huddle
   * goes on, the alarm rings far more often than a log that failed is sent again, so the logs wait
   * until they're due, as they do while the room's message of a huddle has yet to catch up with it.
   */
  override async alarm(): Promise<void> {
    const [deleted, undelivered, logsDue] = await this.serially(() =>
      Promise.all([this.ctx.storage.get<RoomId>(DELETED_ROOM), this.ctx.storage.get<RoomId>(UNDELIVERED_ROOM), this.ctx.storage.get<number>(LOGS_DUE)]),
    );
    if (deleted !== undefined) return this.erase(deleted);
    const nextCheck = await this.checkHuddle();
    const logsWait = nextCheck !== null && logsDue !== undefined && logsDue > Date.now();
    if (undelivered !== undefined && !logsWait) await this.sendLogs(undelivered);
    // Logs that waited are due before the huddle's next check, or after it. Logs just sent have set the alarm for whatever is left of them.
    if (nextCheck !== null) await this.serially(() => this.checkHuddleBy(logsWait ? Math.min(nextCheck, logsDue) : nextCheck));
  }

  /**
   * Checks the room's huddle, and brings the room's message of it in step with it, which is what makes
   * up for a message that couldn't be written, or was left saying that a huddle goes on which ended as
   * the room's object did. Answers when to check next, or null when nothing is left to come back for.
   */
  private async checkHuddle(): Promise<number | null> {
    const nextCheck = await this.huddle.check().catch((error: unknown) => {
      console.error("Checking the room's huddle failed:", error instanceof Error ? error.name : "unknown error");
      return Date.now() + HUDDLE_CHECK_MS;
    });
    const inStep = await this.serially(() => this.keepHuddleMessage(this.huddle.now()));
    return inStep ? nextCheck : Math.min(nextCheck ?? Infinity, Date.now() + HUDDLE_CHECK_MS);
  }

  /**
   * Sends room `roomId`'s logs, which a call that failed left, or which `reindex` filled, and has R2
   * delete the files the room has marked deleted, and the uploads a day old that are still unfinished,
   * coming back for the next of those once it's a day old. Forgets the calls of apps' tools that waited
   * too long to be allowed, too, coming back for the next of those once it has, and sends the messages
   * scheduled here that are due, coming back for the next once it is.
   */
  private async sendLogs(roomId: RoomId): Promise<void> {
    // Whatever is left to send after this says when it's due.
    await this.serially(() => this.ctx.storage.delete(LOGS_DUE));
    // Before the logs are sent, which then send what these post.
    const scheduledRetry = await this.sendDueScheduled(roomId);
    const couriers = this.couriersFor(roomId);
    await Promise.all([couriers.workspace.retry(), couriers.index.retry(), couriers.files.retry(), couriers.huddles.retry()]);
    // Whatever the couriers came to, so that a call is forgotten in time while a delivery keeps failing.
    const nextLateCall = await this.forgetLateCalls(roomId);
    // Kept until then, so an alarm cut off as it sends, as a deploy can do, sends the rest when it's
    // retried. A courier whose last call failed has set the alarm again, for its next try, which comes
    // sooner for a call that will have waited too long by then, or a message due by then.
    if (couriers.workspace.failing || couriers.index.failing || couriers.files.failing || couriers.huddles.failing) {
      const next = Math.min(nextLateCall ?? Infinity, await this.serially(() => this.nextScheduled(roomId, scheduledRetry)));
      if (next !== Infinity) await this.wakeAt(roomId, next);
      return;
    }
    // Looked for and forgotten in one turn, so that a call that starts to wait meanwhile, an upload that
    // starts, or a message scheduled, which each set the alarm, isn't left without it.
    const next = await this.serially(async () => {
      const [unfinished, lateCall, scheduled] = await Promise.all([
        this.blobsFor(roomId).oldestUnfinished(),
        this.waitingCallsFor(roomId).nextLate(),
        this.nextScheduled(roomId, scheduledRetry),
      ]);
      const next = Math.min(unfinished === null ? Infinity : Date.parse(unfinished) + UNFINISHED_UPLOAD_KEPT_MS, lateCall ?? Infinity, scheduled);
      if (next === Infinity) await this.ctx.storage.delete(UNDELIVERED_ROOM);
      return next;
    });
    if (next !== Infinity) await this.wakeAt(roomId, next);
  }

  /**
   * Erases what's left of deleted room `roomId` once R2 has deleted its files: its revocations, and the
   * object's own storage, which on DO SQLite is everything it kept. An object with nothing stored ceases
   * to exist. Until R2 has, the alarm tries again later, since the room's record of its files goes too.
   * So does the list of what the SFU has yet to close of the room's huddle, which the alarm comes
   * sooner for: it asks the SFU again, and erases nothing before the room was to be erased.
   */
  private async erase(roomId: RoomId): Promise<void> {
    if (await this.huddle.closeUnclosed()) return this.ctx.storage.setAlarm(Date.now() + HUDDLE_CHECK_MS);
    const due = await this.ctx.storage.get<number>(ERASE_DUE);
    if (due !== undefined && due > Date.now()) return this.ctx.storage.setAlarm(due);
    const { workspace, index, files, huddles } = this.couriersFor(roomId);
    await files.retry();
    if (files.failing) return this.ctx.storage.setAlarm(Date.now() + ERASE_RETRY_MS);
    // A call still out would read its log once the tables are gone, which makes them again.
    await Promise.all([workspace.settled(), index.settled(), huddles.settled()]);
    await this.serially(async () => {
      await this.revocationsFor(roomId).forget();
      await this.ctx.storage.deleteAll();
      // Its tables went too, so anything after this would open the database afresh, making them again.
      this.db = this.store = this.revocations = this.log = this.blobs = this.waitingCalls = this.scheduled = null;
      this.erased = true;
    });
  }

  /**
   * Deletes up to `limit` of `userId`'s messages here, with their boosts, telling everyone in the room
   * of each, and answers whether any of theirs are left. Once the ban has been lifted, at `liftedAt`,
   * only those written by then count.
   */
  async removeMessagesBy(roomId: RoomId, userId: UserId, limit: number, liftedAt: string | null): Promise<boolean> {
    return this.serially(async () => {
      const store = this.storeFor(roomId);
      const ids = await store.messageIdsBy(userId, limit + 1, liftedAt);
      const removed = ids.slice(0, limit);
      if (removed.length === 0) return false;
      await this.deleteEach(store, removed);
      const couriers = this.couriersFor(roomId);
      couriers.index.deliver();
      couriers.files.deliver();
      return ids.length > limit;
    });
  }

  /**
   * Forgets what `userId`, who deleted their account, has scheduled here, which nobody is to send now,
   * then deletes up to `limit` of their messages here, whenever they wrote them, as `removeMessagesBy`
   * does, then once none are left, up to `limit` of the boosts they gave others' messages, telling
   * everyone in the room of each, and answers whether any of theirs are left. Once none are, what's kept
   * of their messages for their threads' replies takes the name a deleted account goes by.
   */
  async removeEverythingBy(roomId: RoomId, userId: UserId, limit: number): Promise<boolean> {
    return this.serially(async () => {
      await this.scheduledFor(roomId).forgetBy(userId);
      const store = this.storeFor(roomId);
      const ids = await store.messageIdsBy(userId, limit + 1, null);
      if (ids.length > 0) {
        await this.deleteEach(store, ids.slice(0, limit));
        const couriers = this.couriersFor(roomId);
        couriers.index.deliver();
        couriers.files.deliver();
        if (ids.length > limit) return true;
      }
      const boosts = await store.boostsBy(userId, limit + 1);
      if (boosts.length > 0) {
        await this.removeBoosts(store, boosts.slice(0, limit));
        if (boosts.length > limit) return true;
      }
      await store.renameAuthor(userId, DELETED_PERSON_NAME);
      return false;
    });
  }

  /**
   * Has the search index take every message the room has afresh, as the Workspace asks of each room
   * once the index is new: logs them all for it, and has the alarm send them, which a restart can't
   * stop.
   */
  async reindex(roomId: RoomId): Promise<void> {
    await this.serially(() => this.logFor(roomId).reindex());
    await this.wakeAt(roomId, Date.now());
  }

  /**
   * The messages `ids` names, for search results, leaving out any the room no longer has: the search
   * index can name one deleted since it last heard from the room.
   */
  async messagesWithIds(roomId: RoomId, ids: string[]): Promise<Message[]> {
    return this.serially(() => this.storeFor(roomId).withIds(ids));
  }

  /** Everyone who wrote or reacted in the room, for the Workspace to keep when it registers a legacy room. */
  async authors(roomId: RoomId): Promise<User[]> {
    return this.serially(() => this.storeFor(roomId).authors());
  }

  /**
   * Posts `markup` as a message from the bot the Workspace let in: as a socket's message.create does,
   * with a client message id of its own, as Campfire gives one (`Random.uuid`, message.rb), and with
   * `cards` under its text, as a Slack incoming webhook's attachments show, and with `threadId` in that
   * message's thread, only there, as a reply to a delivery goes. Answers the message, why the room keeps
   * nothing of it, or null once the room has heard that the bot's access ended, or the room was deleted,
   * after the Workspace checked, as it turns away a socket then, or when it has no such thread.
   */
  async createBotMessage(roomId: RoomId, { bot, authorizedAt }: BotAccess, markup: string, cards: Card[] = [], threadId?: string): Promise<Message | string | null> {
    return this.serially(async () => {
      const now = new Date().toISOString();
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return null;
      const store = this.storeFor(roomId);
      const inThread = threadId === undefined ? undefined : await this.inThread(store, threadId, false);
      if (inThread === null) return null;
      const body = await this.prepareWithCards(markup, cards);
      if (typeof body === "string") return body;
      return this.create(store, bot, crypto.randomUUID(), body, now, { inThread });
    });
  }

  /**
   * Posts `markup` as a message from the person an AI app is connected as (`outside/tools`), whom the
   * Workspace found in the room: as their socket's message.create does, in the thread of the message
   * `threadId` names, only there, if it names one, but as a reply is posted, which goes to no bot. So
   * an app calls neither a webhook, @ember nor an agent, even in a direct message with one, where a
   * message needs no mention to. Answers the message, why the room keeps nothing of it, `MESSAGE_GONE`
   * when it has no such thread, or null once the room has heard that they were taken out of it, that it
   * was made private, for an app that reaches only open rooms, or that it was deleted, after the
   * Workspace checked, as it turns away a socket then.
   */
  async createOutsideMessage(roomId: RoomId, { user, tags, authorizedAt }: OutsideSender, markup: string, threadId?: string): Promise<Message | string | null> {
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse(tags, authorizedAt)) return null;
      const store = this.storeFor(roomId);
      const inThread = threadId === undefined ? undefined : await this.inThread(store, threadId, false);
      if (inThread === null) return MESSAGE_GONE;
      const body = await this.prepare(markup);
      if (typeof body === "string") return body;
      return this.create(store, user, crypto.randomUUID(), body, new Date().toISOString(), { kind: "reply", inThread });
    });
  }

  /**
   * A page of the room's messages for the bot API: the page `cursor` names, with how many messages the
   * room has, or null when the cursor isn't one of them.
   */
  async botPage(roomId: RoomId, cursor: PageCursor): Promise<BotPage | null> {
    return this.serially(async () => {
      const store = this.storeFor(roomId);
      const [page, total] = await Promise.all([store.pageAt(cursor, HISTORY_PAGE_SIZE), store.count()]);
      return page && { ...page, total };
    });
  }

  /**
   * A page of the room's messages for an AI app that reads it as someone in it (`outside/tools`), or for
   * @ember and the agents (`roomTools`): the page `cursor` names, or null when the cursor isn't one of
   * them. The room isn't counted, as it is for a bot, since on D1 counting reads a row for every message.
   */
  async outsidePage(roomId: RoomId, cursor: PageCursor): Promise<Omit<TimelinePage, "around"> | null> {
    return this.serially(() => this.storeFor(roomId).pageAt(cursor, HISTORY_PAGE_SIZE));
  }

  /**
   * The thread of the message `parentId` names, for a bot or an AI app reading the room: the message and
   * its newest replies, oldest first, or null when the room has no such message or it's a reply, which
   * has no thread.
   */
  async botThread(roomId: RoomId, parentId: string): Promise<Message[] | null> {
    return this.serially(async () => {
      const { parent, messages } = await this.storeFor(roomId).thread(parentId, HISTORY_PAGE_SIZE);
      return parent && [parent, ...messages];
    });
  }

  /**
   * Replaces the text of the bot's message `messageId` with `markup`, and its cards with `cards`: as a
   * socket's message.update does, answering the message as it is now. Answers `NOT_FOUND` when the room
   * turns the bot away, as `createBotMessage` does, or has no such message, `FORBIDDEN` when it's someone
   * else's, then why the room keeps nothing of `markup` and `cards`.
   */
  async editBotMessage(roomId: RoomId, { bot, authorizedAt }: BotAccess, messageId: string, markup: string, cards: Card[] = []): Promise<Message | string> {
    return this.serially(async () => {
      const now = new Date().toISOString();
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return NOT_FOUND;
      const store = this.storeFor(roomId);
      const message = await this.botsOwn(store, bot, messageId);
      if (typeof message === "string") return message;
      const body = await this.prepareWithCards(markup, cards);
      return typeof body === "string" ? body : this.edit(store, message, body, now);
    });
  }

  /**
   * Deletes the bot's message `messageId`, with its boosts: as a socket's message.delete does, answering
   * null, or `NOT_FOUND` when the room turns the bot away, as `createBotMessage` does, or has no such
   * message, and `FORBIDDEN` when it's someone else's.
   */
  async deleteBotMessage(roomId: RoomId, { bot, authorizedAt }: BotAccess, messageId: string): Promise<string | null> {
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return NOT_FOUND;
      const store = this.storeFor(roomId);
      const message = await this.botsOwn(store, bot, messageId);
      if (typeof message === "string") return message;
      await this.deleteMessage(store, message);
      return null;
    });
  }

  /**
   * Deletes message `messageId`, with its boosts, as an administrator's message.delete does, for an
   * administrator who handled a report of it by deleting it, unless the room has deleted it already.
   */
  async deleteReportedMessage(roomId: RoomId, messageId: string): Promise<void> {
    return this.serially(async () => {
      const store = this.storeFor(roomId);
      const message = await this.findUndeleted(store, messageId);
      if (message) await this.deleteMessage(store, message);
    });
  }

  /**
   * Adds the bot's boost of `content`, trimmed, to the message `messageId`: as a socket's boost.create
   * does, but even when the bot has added the same one, as there, answering it. Answers `NOT_FOUND` when
   * the room turns the bot away, as `createBotMessage` does, or has no such message, then `BLANK` when
   * `content` is only spaces, or why the room keeps no boost of it, as when it has a blocked word.
   */
  async addBotBoost(roomId: RoomId, { bot, authorizedAt }: BotAccess, messageId: string, content: string): Promise<Boost | string> {
    return this.serially(async () => {
      const now = new Date().toISOString();
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return NOT_FOUND;
      const store = this.storeFor(roomId);
      if (!(await this.findUndeleted(store, messageId))) return NOT_FOUND;
      const trimmed = content.trim();
      if (trimmed === "") return BLANK;
      if (trimmed.length > MAX_BOOST_LENGTH) return BOOST_TOO_LONG;
      if (await this.hasBlockedWord(trimmed)) return BLOCKED_WORDS_REFUSED;
      return this.addBoost(store, messageId, bot, trimmed, now);
    });
  }

  /**
   * Removes the bot's boost `boostId` from the message `messageId`: as a socket's boost.delete does,
   * answering whether it did, which it does only when the boost is the bot's own, on that message, and
   * the room doesn't turn the bot away, as `createBotMessage` does.
   */
  async removeBotBoost(roomId: RoomId, { bot, authorizedAt }: BotAccess, messageId: string, boostId: string): Promise<boolean> {
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return false;
      const store = this.storeFor(roomId);
      const boost = await store.findBoost(boostId);
      if (!boost || boost.messageId !== messageId || boost.booster.id !== bot.id) return false;
      await this.removeBoost(store, boost);
      return true;
    });
  }

  /**
   * Starts `uploader`'s upload of `file` to the room, as a reply in the thread it names if it names one,
   * answering the file's key, or null once the room has heard that their access ended, or the room was
   * deleted, after the Workspace checked, as it turns away a socket then, `MESSAGE_GONE` when it has no
   * such thread, or `BLOCKED_WORDS_REFUSED` for a name with a word Blocked words keeps out. The alarm
   * comes back once it's a day old, to delete it from R2 if it's unfinished.
   */
  async startUpload(roomId: RoomId, uploader: Uploader, file: NewUpload): Promise<{ key: string } | typeof MESSAGE_GONE | typeof BLOCKED_WORDS_REFUSED | null> {
    const startedAt = Date.now();
    const started = await this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse(uploader.tags, uploader.authorizedAt)) return null;
      if (file.parentId !== undefined && !(await this.inThread(this.storeFor(roomId), file.parentId, false))) return MESSAGE_GONE;
      if (await this.hasBlockedWord(file.name)) return BLOCKED_WORDS_REFUSED;
      const key = base36(KEY_LENGTH);
      const blob = {
        id: key,
        uploaderId: uploader.user.id,
        filename: file.name,
        contentType: file.type,
        byteSize: file.size,
        clientMessageId: file.clientMessageId,
        parentId: file.parentId ?? null,
        alsoSent: file.alsoSend === true,
      };
      await this.blobsFor(roomId).create(blob, new Date(startedAt).toISOString());
      return { key };
    });
    if (typeof started === "object" && started) await this.wakeAt(roomId, startedAt + UNFINISHED_UPLOAD_KEPT_MS);
    return started;
  }

  /** `uploaderId`'s upload `key` to the room, as far as it has come, or null if they have no such upload. */
  async uploadOf(roomId: RoomId, uploaderId: UserId, key: string): Promise<RoomBlob | null> {
    return this.serially(async () => {
      const blob = await this.blobsFor(roomId).find(key);
      return blob?.uploaderId === uploaderId ? blob : null;
    });
  }

  /**
   * Records what the first part of `uploader`'s upload `key`, in more than one part, says the file is,
   * with the multipart upload R2 has started and the part it has, unless another request has recorded
   * its own first part, answering the upload as it is then. Answers null when the room turns the uploader
   * away, as `startUpload` does, or they have no such upload.
   */
  async identifyUpload(roomId: RoomId, uploader: Uploader, key: string, identified: Identified, multipartUploadId: string, part: UploadedPart): Promise<RoomBlob | null> {
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse(uploader.tags, uploader.authorizedAt)) return null;
      const blobs = this.blobsFor(roomId);
      const blob = await blobs.find(key);
      if (blob?.uploaderId !== uploader.user.id) return null;
      return (await blobs.identify(key, identified, multipartUploadId, part)) ?? blob;
    });
  }

  /**
   * Records `part` of `uploader`'s upload `key` in more than one part, answering the upload as it is
   * then, or null as `identifyUpload` answers it, or when the upload hasn't started in R2.
   */
  async recordUploadPart(roomId: RoomId, uploader: Uploader, key: string, part: UploadedPart): Promise<RoomBlob | null> {
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse(uploader.tags, uploader.authorizedAt)) return null;
      const blobs = this.blobsFor(roomId);
      const blob = await blobs.find(key);
      if (blob?.uploaderId !== uploader.user.id || blob.multipartUploadId === null) return null;
      return blob.completedAt ? blob : blobs.recordPart(blob, part);
    });
  }

  /**
   * Records that `uploader`'s upload `key` has a preview of `size`, unless the room has posted the file
   * already, answering the upload as it is then, or null as `identifyUpload` answers it.
   */
  async recordUploadPreview(roomId: RoomId, uploader: Uploader, key: string, size: ImageSize): Promise<RoomBlob | null> {
    return this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse(uploader.tags, uploader.authorizedAt)) return null;
      return this.blobsFor(roomId).recordPreview(key, uploader.user.id, size);
    });
  }

  /**
   * Posts `uploader`'s upload `key`, which R2 has all of, as their message: records that the upload has
   * finished, what its one part said the file is when `identified` says, and the message, in one
   * transaction, then tells everyone in the room and sends the Workspace and the search index their
   * logs, as for any new message, in the thread the upload was started in, if it was. Answers the message,
   * with whether this posted it, or the message an earlier request posted it as, which was, unless it's
   * been deleted since. Answers null when the room turns the uploader away, as `startUpload` does, or they
   * have no such upload, and `MESSAGE_GONE` when the room no longer has its thread.
   */
  async finishUpload(roomId: RoomId, uploader: Uploader, key: string, identified?: Identified): Promise<{ message: Message; posted: boolean } | typeof MESSAGE_GONE | null> {
    return this.serially(async () => {
      const now = new Date().toISOString();
      if (await this.revocationsFor(roomId).refuse(uploader.tags, uploader.authorizedAt)) return null;
      const blobs = this.blobsFor(roomId);
      const blob = await blobs.find(key);
      if (blob?.uploaderId !== uploader.user.id) return null;
      const store = this.storeFor(roomId);
      if (blob.completedAt) {
        const message = blob.messageId === null ? null : await store.find(blob.messageId);
        return message && { message, posted: false };
      }
      const inThread = blob.parentId === null ? undefined : await this.inThread(store, blob.parentId, blob.alsoSent);
      if (inThread === null) return MESSAGE_GONE;
      const posted: PostedFile = { file: attachedFile(blob, identified), finished: (messageId) => blobs.finished(key, messageId, now, identified) };
      return { message: await this.postFile(store, uploader.user, blob, posted, now, { inThread }), posted: true };
    });
  }

  /**
   * Starts the bot's upload of a file named `filename`, of `declaredType` as it says, to the room, for a
   * form that brings it to R2 as it arrives, as `startUpload` starts someone's, or, with `messageId`, one
   * to give the bot's message in place of its file. Answers the file's key, or `NOT_FOUND` when the room
   * turns the bot away, as `createBotMessage` does, or has no such message, `FORBIDDEN` when it's
   * someone else's, and `BLOCKED_WORDS_REFUSED` for a name with a word Blocked words keeps out.
   */
  async startBotUpload(
    roomId: RoomId,
    { bot, authorizedAt }: BotAccess,
    file: Pick<ArrivingFile, "filename" | "declaredType">,
    messageId?: string,
  ): Promise<{ key: string } | typeof NOT_FOUND | typeof FORBIDDEN | typeof BLOCKED_WORDS_REFUSED> {
    const startedAt = Date.now();
    const started = await this.serially(async () => {
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return NOT_FOUND;
      const message = messageId === undefined ? null : await this.botsOwn(this.storeFor(roomId), bot, messageId);
      if (message === NOT_FOUND || message === FORBIDDEN) return message;
      if (await this.hasBlockedWord(file.filename)) return BLOCKED_WORDS_REFUSED;
      return { key: await this.startArriving(roomId, bot.id, file, startedAt) };
    });
    if (typeof started === "object") await this.wakeAt(roomId, startedAt + UNFINISHED_UPLOAD_KEPT_MS);
    return started;
  }

  /**
   * Posts the bot's file `key`, which R2 has all of, as it came to in `file`, as the bot's message,
   * recording that its upload has finished and the message in one transaction, as `finishUpload` does.
   * With `messageId`, gives it to the bot's message in place of the file that had, as `update` does, and
   * otherwise posts it in the thread `threadId` names, if it names one, as `createBotMessage` posts text.
   * Answers the message, or `NOT_FOUND` when the room turns the bot away, as `createBotMessage` does, or
   * has no such upload, message or thread, and `FORBIDDEN` when the message is someone else's.
   */
  async finishBotUpload(roomId: RoomId, { bot, authorizedAt }: BotAccess, { key, file }: KeptFile, messageId?: string, threadId?: string): Promise<Message | string> {
    return this.serially(async () => {
      const now = new Date().toISOString();
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return NOT_FOUND;
      const blob = await this.blobsFor(roomId).find(key);
      if (blob?.uploaderId !== bot.id) return NOT_FOUND;
      const store = this.storeFor(roomId);
      if (messageId === undefined) {
        const inThread = threadId === undefined ? undefined : await this.inThread(store, threadId, false);
        if (inThread === null) return NOT_FOUND;
        return this.postFile(store, bot, blob, this.streamed(roomId, blob, file, now), now, { inThread });
      }
      const message = await this.botsOwn(store, bot, messageId);
      return typeof message === "string" ? message : this.attach(store, message, this.streamed(roomId, blob, file, now), now);
    });
  }

  /**
   * Takes the file away from the bot's message `messageId`, answering the message as it is now, or
   * `NOT_FOUND` or `FORBIDDEN` as `editBotMessage` does. A message without a file stays as it was.
   */
  async removeBotFile(roomId: RoomId, { bot, authorizedAt }: BotAccess, messageId: string): Promise<Message | string> {
    return this.serially(async () => {
      const now = new Date().toISOString();
      if (await this.revocationsFor(roomId).refuse([bot.id], authorizedAt)) return NOT_FOUND;
      const store = this.storeFor(roomId);
      const message = await this.botsOwn(store, bot, messageId);
      if (typeof message === "string" || !message.attachment) return message;
      return this.attach(store, message, null, now);
    });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (this.huddle.has(ws)) return this.huddle.message(ws, raw);
    if (isTooLarge(raw, MAX_ROOM_FRAME_SIZE)) return closeTooLarge(ws);
    const frame = typeof raw === "string" ? parseClientFrame(raw) : null;
    if (!frame) return this.send(ws, { type: "error", message: "Unrecognized frame" });

    const { user, roomId } = ws.deserializeAttachment() as Attachment;
    await this.serially(async () => {
      // A socket the room has closed, as when its access was revoked, can't change anything, even
      // with frames it sent before it heard.
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        await this.handle(ws, user, this.storeFor(roomId), frame);
      } catch (error) {
        console.error("ChatRoom frame failed", frame.type, error);
        this.send(ws, { type: "error", message: "Something went wrong", ...aboutOf(frame), failed: frame.type });
      }
    });
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(RESERVED_CLOSE_CODES.has(code) ? 1000 : code, "Closing");
    if (this.huddle.has(ws)) return this.huddle.left(ws);
    await this.serially(async () => this.leave(ws));
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    if (this.huddle.has(ws)) return this.huddle.left(ws);
    await this.serially(async () => this.leave(ws));
  }

  /**
   * Runs one event at a time. Durable Object storage holds other events back while it works,
   * but D1 queries are network calls that don't, so without this a joining socket could get
   * live frames before its snapshot, or an edit could broadcast reactions it read too early.
   */
  private serially<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  private async handle(ws: WebSocket, user: User, store: MessageStore, frame: ClientFrame): Promise<void> {
    const now = new Date().toISOString();
    if (CHANGES.has(frame.type) && (ws.deserializeAttachment() as Attachment).banned) {
      return this.send(ws, { type: "error", message: BANNED, ...aboutOf(frame), failed: frame.type });
    }

    switch (frame.type) {
      case "message.create": {
        if (isOutdated(ws)) return this.send(ws, { type: "error", message: OUTDATED, clientMessageId: frame.clientMessageId, failed: frame.type });
        const refused = await this.postWritten(store, user, frame, now);
        if (refused !== null) return this.send(ws, { type: "error", message: refused, clientMessageId: frame.clientMessageId, failed: frame.type, ...rewriting(refused) });
        // Everyone else takes the message as its author's stop.
        markTyping(ws, false);
        return;
      }
      case "message.schedule": {
        if (isOutdated(ws)) return this.send(ws, { type: "error", message: OUTDATED, clientMessageId: frame.clientMessageId, failed: frame.type });
        const refused = await this.schedule(store, user, frame);
        if (refused !== null) return this.send(ws, { type: "error", message: refused, clientMessageId: frame.clientMessageId, failed: frame.type });
        return;
      }
      case "scheduled.edit":
      case "scheduled.reschedule":
      case "scheduled.send":
      case "scheduled.delete": {
        if (frame.type === "scheduled.edit" && isOutdated(ws)) return this.send(ws, { type: "error", message: OUTDATED, scheduledId: frame.scheduledId, failed: frame.type });
        const refused = await this.changeScheduled(store, user, frame);
        // Their tabs hear what they have scheduled now, whatever it came to, naming the message to the tab that
        // asked for an edit the room has made. A refusal comes last, so that nothing the tab hears after its
        // answer is taken for the answer to its next edit of the message.
        const edited = frame.type === "scheduled.edit" && refused === null;
        await this.tellScheduled(store.roomId, user.id, edited ? { by: ws, scheduledId: frame.scheduledId } : undefined);
        if (refused !== null) this.send(ws, { type: "error", message: refused, scheduledId: frame.scheduledId, failed: frame.type });
        return;
      }
      case "message.update": {
        const message = await this.findUndeleted(store, frame.messageId);
        if (!message || !(await this.canAdminister(user, message))) return this.refuse(ws, "You can only edit your own messages");
        if (isOutdated(ws)) return this.send(ws, { type: "error", message: OUTDATED, failed: frame.type });
        if (message.cards) return this.send(ws, { type: "error", message: HAS_CARDS, failed: frame.type });
        if (message.huddle) return this.send(ws, { type: "error", message: OF_A_HUDDLE, failed: frame.type });
        const body = await this.prepare(frame.body);
        if (typeof body === "string") return this.send(ws, { type: "error", message: body, failed: frame.type });
        await this.edit(store, message, body, now);
        return;
      }
      case "message.preview": {
        // The tab sends it of its own accord, so a message that can't take it any more takes nothing, without a word.
        const message = await store.findSent(user, frame.clientMessageId);
        if (!message || !takesLatePreview(message, now)) return;
        const markup = `${message.body}${previewAttachment(frame.preview)}`;
        const body = markup.length > MAX_MESSAGE_HTML_LENGTH ? null : await this.prepare(markup);
        if (body && typeof body !== "string") await this.addPreview(store, message, body, now);
        return;
      }
      case "message.delete": {
        const message = await this.findUndeleted(store, frame.messageId);
        if (!message || !(await this.canAdminister(user, message))) return this.refuse(ws, "You can only delete your own messages");
        return this.deleteMessage(store, message);
      }
      case "boost.create": {
        const message = await this.findUndeleted(store, frame.messageId);
        if (!message) return this.refuse(ws, "That message no longer exists");
        // A person adds each reaction once, so one they've already added is a repeated click.
        if (message.boosts.some((b) => b.booster.id === user.id && b.content === frame.content)) return;
        if (await this.hasBlockedWord(frame.content)) return this.send(ws, { type: "error", message: BLOCKED_WORDS_REFUSED, failed: frame.type });
        await this.addBoost(store, frame.messageId, user, frame.content, now);
        return;
      }
      case "boost.delete": {
        const boost = await store.findBoost(frame.boostId);
        if (!boost || boost.booster.id !== user.id) return this.refuse(ws, "You can only remove your own reactions");
        return this.removeBoost(store, boost);
      }
      case "typing.start":
      case "typing.stop": {
        const typing = frame.type === "typing.start";
        markTyping(ws, typing);
        return this.broadcast({ type: "typing", user, typing }, ws);
      }
      case "history.before": {
        const { messages, hasMore } = await store.page(frame.limit ?? HISTORY_PAGE_SIZE, frame.before);
        return this.send(ws, { type: "history", before: frame.before, messages, hasMore });
      }
      case "history.after": {
        const { messages, hasNewer } = await store.after(frame.limit ?? HISTORY_PAGE_SIZE, frame.after);
        return this.send(ws, { type: "history.after", after: frame.after, messages, hasNewer });
      }
      case "history.around":
        return this.send(ws, { type: "history.around", ...(await store.timeline(HISTORY_PAGE_SIZE, frame.messageId)) });
      case "message.check": {
        const stored = await store.storedClientMessageIds(user, frame.clientMessageIds);
        const missing = frame.clientMessageIds.filter((id) => !stored.includes(id));
        return this.send(ws, { type: "message.checked", stored, missing });
      }
      case "thread.open": {
        const attachment = ws.deserializeAttachment() as Attachment;
        ws.serializeAttachment({ ...attachment, thread: frame.parentId } satisfies Attachment);
        const [thread, cards] = await Promise.all([store.thread(frame.parentId, HISTORY_PAGE_SIZE), this.waitingCallsFor(store.roomId).cardsFor(user.id)]);
        // With the cards of the calls asked in the thread that wait on them, as a welcome brings the room's.
        const ephemeral = isOutdated(ws) ? [] : cards.filter((message) => message.parentId === frame.parentId);
        return this.send(ws, { type: "thread.opened", parentId: frame.parentId, ...thread, ...(ephemeral.length > 0 && { ephemeral }) });
      }
      case "thread.close": {
        const { thread, ...attachment } = ws.deserializeAttachment() as Attachment;
        if (thread === frame.parentId) ws.serializeAttachment(attachment satisfies Attachment);
        return;
      }
      case "thread.before": {
        const { messages, hasMore } = await store.repliesBefore(frame.parentId, frame.before, frame.limit ?? HISTORY_PAGE_SIZE);
        return this.send(ws, { type: "thread.history", parentId: frame.parentId, before: frame.before, messages, hasMore });
      }
      case "presence.visible": {
        const attachment = ws.deserializeAttachment() as Attachment;
        ws.serializeAttachment({ ...attachment, visible: frame.visible, heardAt: Date.now() } satisfies Attachment);
        // Coming back to a tab showing the room reads it.
        if (frame.visible && !attachment.apart) await this.read(store.roomId, user.id);
        return;
      }
      case "card.click": {
        const button = await this.clickedButton(store, frame);
        const waiting = this.clicking.get(user.id) ?? 0;
        const refused = !button ? BUTTON_GONE : waiting >= CLICKS_WAITING_EACH ? TOO_MANY_CLICKS : null;
        if (refused) return this.send(ws, { type: "error", message: refused, clickId: frame.clickId, failed: frame.type });
        this.clicking.set(user.id, waiting + 1);
        // The bot answers in its own time, which nothing else in the room waits for. A click that calls an app's tool waits on the app, as an answer does, not among the bots' deliveries.
        this.ctx.waitUntil(this.deliverClick(store.roomId, ws, user, frame, button && toolCallOf(button.action) ? this.answers : this.webhooks));
        return;
      }
      case "ping":
        return this.send(ws, { type: "pong" });
    }
  }

  /**
   * Who sees a message in the room as it comes: everyone viewing the room, and for a reply sent there
   * from the thread it's `inThread`, everyone viewing that thread too, as someone is who has it open
   * apart from the room, in its huddle.
   */
  private viewersOfNew(inThread?: InThread): UserId[] {
    const viewers = viewersOf(this.ctx);
    return inThread ? [...new Set([...viewers, ...viewersOf(this.ctx, undefined, inThread.parent.id)])] : viewers;
  }

  /**
   * Posts `written` as `user`'s message at `now`, in its thread if it names one, as `create` posts one,
   * and answers why the room keeps nothing of it, if it doesn't.
   */
  private async postWritten(store: MessageStore, user: User, written: Written, now: string): Promise<string | null> {
    const inThread = written.parentId === undefined ? undefined : await this.inThread(store, written.parentId, written.alsoSend === true);
    if (inThread === null) return MESSAGE_GONE;
    const body = await this.prepare(written.body);
    if (typeof body === "string") return body;
    await this.create(store, user, written.clientMessageId, body, now, { inThread });
    return null;
  }

  /**
   * Keeps the message `frame` schedules, `user`'s, to send at its time, which is to come, while they have
   * fewer than `MAX_SCHEDULED_MESSAGES` scheduled here, telling their tabs here, and has the alarm come
   * for it. Answers why the room keeps nothing of it, if it doesn't. A frame sent again keeps its message
   * once.
   */
  private async schedule(store: MessageStore, user: User, frame: Extract<ClientFrame, { type: "message.schedule" }>): Promise<string | null> {
    const sendAt = Date.parse(frame.sendAt);
    if (!isSchedulable(sendAt)) return SCHEDULE_TIME_REFUSED;
    const scheduled = this.scheduledFor(store.roomId);
    const theirs = await scheduled.of(user.id);
    if (!theirs.some(({ clientMessageId }) => clientMessageId === frame.clientMessageId)) {
      if (theirs.length >= MAX_SCHEDULED_MESSAGES) return TOO_MANY_SCHEDULED;
      if (frame.parentId !== undefined && !(await this.inThread(store, frame.parentId, false))) return MESSAGE_GONE;
      const body = await this.prepare(frame.body);
      if (typeof body === "string") return body;
      const { clientMessageId, parentId, alsoSend } = frame;
      const message = { id: crypto.randomUUID(), creatorId: user.id, clientMessageId, body: body.html, sendAt: frame.sendAt, ...(parentId !== undefined && { parentId, alsoSend: alsoSend === true }) };
      await scheduled.keep(message, new Date().toISOString());
      await this.wakeInTurnAt(store.roomId, sendAt);
    }
    await this.tellScheduled(store.roomId, user.id);
    return null;
  }

  /** Edits, moves, sends or deletes the scheduled message `frame` names, if it's `user`'s, and answers why nothing changed, if nothing did. */
  private async changeScheduled(
    store: MessageStore,
    user: User,
    frame: Extract<ClientFrame, { type: "scheduled.edit" | "scheduled.reschedule" | "scheduled.send" | "scheduled.delete" }>,
  ): Promise<string | null> {
    const scheduled = this.scheduledFor(store.roomId);
    const message = await scheduled.find(frame.scheduledId);
    if (!message || message.creatorId !== user.id) return SCHEDULED_GONE;
    switch (frame.type) {
      case "scheduled.edit": {
        const body = await this.prepare(frame.body);
        if (typeof body === "string") return body;
        await scheduled.edit(message.id, body.html);
        return null;
      }
      case "scheduled.reschedule": {
        const sendAt = Date.parse(frame.sendAt);
        if (!isSchedulable(sendAt)) return SCHEDULE_TIME_REFUSED;
        await scheduled.move(message.id, frame.sendAt);
        await this.wakeInTurnAt(store.roomId, sendAt);
        return null;
      }
      case "scheduled.send":
        return this.sendScheduled(store, user, message);
      case "scheduled.delete":
        await scheduled.remove(message.id);
        return null;
    }
  }

  /**
   * Sends `message`, scheduled here, as `writer`'s, now, as `message.create` would have, and forgets it, or
   * keeps it saying why it couldn't be sent, which it answers. One sent already isn't sent again, as when an
   * alarm that sent it was cut off before it could forget it, or a batch D1 said had failed had saved it.
   */
  private async sendScheduled(store: MessageStore, writer: User, message: KeptScheduled): Promise<string | null> {
    const scheduled = this.scheduledFor(store.roomId);
    const [sent] = await store.storedClientMessageIds(writer, [message.clientMessageId]);
    const refused = sent === undefined ? await this.postWritten(store, writer, message, new Date().toISOString()) : null;
    const failure = refused === MESSAGE_GONE ? THREAD_DELETED : refused;
    if (failure === null) await scheduled.remove(message.id);
    else await scheduled.fail(message.id, failure);
    return failure;
  }

  /**
   * Sends the messages scheduled here that are due, the soonest `SCHEDULED_SENT_AT_ONCE`, each as its
   * writer's, if the Workspace has them in the room still (`sendDue`), telling each writer's tabs here, and
   * answers when the alarm may come back for those due then: a minute later, rather than at once, after
   * one couldn't be sent for now, as when the Workspace couldn't be asked.
   */
  private async sendDueScheduled(roomId: RoomId): Promise<number> {
    const due = await this.serially(() => this.scheduledFor(roomId).due(new Date().toISOString()));
    const writers = new Set<UserId>();
    let retryAt = 0;
    for (const message of due) {
      try {
        // Asked first, for each, as the room's turn waits on nobody, and checked in its turn against revocations since.
        const authorizedAt = Date.now();
        const writer = await workspace(this.env).scheduledWriter(roomId, message.creatorId);
        await this.serially(() => this.sendDue(roomId, message, writer, authorizedAt));
        writers.add(message.creatorId);
      } catch (error) {
        console.error(`Couldn't send scheduled message ${message.id}; trying again later`, error);
        retryAt = Date.now() + SCHEDULED_RETRY_MS;
        break;
      }
    }
    await this.serially(async () => {
      for (const writerId of writers) await this.tellScheduled(roomId, writerId);
    });
    return retryAt;
  }

  /**
   * Sends `due`, a scheduled message that was due, as `writer`'s, whom the Workspace had in the room at
   * `authorizedAt`, unless it's been moved, sent or deleted since, as from its writer's tab. Forgets it once
   * its writer isn't in the room: the Workspace had them in it no longer, or they've lost access since. The
   * Workspace's word, held up too long to trust, as by a busy room, is asked for again later, as when the
   * Workspace couldn't be asked, rather than taken as its writer gone.
   */
  private async sendDue(roomId: RoomId, due: KeptScheduled, writer: User | null, authorizedAt: number): Promise<void> {
    if (await this.isDeleted()) return;
    const scheduled = this.scheduledFor(roomId);
    const message = await scheduled.find(due.id);
    if (!message || message.failure !== undefined || message.sendAt > new Date().toISOString()) return;
    if (heldUpTooLong(authorizedAt)) throw new Error("The Workspace's word on who's in the room was held up too long to trust");
    if (!writer || (await this.revocationsFor(roomId).refuse([message.creatorId], authorizedAt))) return scheduled.remove(message.id);
    await this.sendScheduled(this.storeFor(roomId), writer, message);
  }

  /**
   * Tells `userId`'s tabs here what they have scheduled here now, and the socket that `asked` for an edit the
   * room has made, if one did, which one it edited.
   */
  private async tellScheduled(roomId: RoomId, userId: UserId, asked?: { by: WebSocket; scheduledId: string }): Promise<void> {
    const sockets = this.roomSockets(userId).filter((socket) => socket !== asked?.by);
    if (sockets.length === 0 && !asked) return;
    const messages = (await this.scheduledFor(roomId).of(userId)).map(listed);
    for (const socket of sockets) this.send(socket, { type: "scheduled", messages });
    if (asked) this.send(asked.by, { type: "scheduled", messages, edited: asked.scheduledId });
  }

  /** When the alarm is to come back for the messages scheduled here, not before `notBefore`: Infinity while none is to be sent. */
  private async nextScheduled(roomId: RoomId, notBefore: number): Promise<number> {
    const due = await this.scheduledFor(roomId).nextDue();
    return due === null ? Infinity : Math.max(due, notBefore);
  }

  /**
   * Stores a message from `user`, as `posting` says, notifying whom its special mentions do, tells
   * everyone in the room, and its parent as it is now for a reply in a thread, and sends the Workspace
   * and the search index their logs, which the message is in, answering it.
   */
  private async create(store: MessageStore, user: User, clientMessageId: string, body: StoredBody, now: string, posting: Posting = {}): Promise<Message> {
    const { kind, posted, inThread } = posting;
    const notifying = await this.notifying(store.roomId, user, body, posting);
    // Before the batch, which on D1 may save the message even when it fails.
    if (!inThread || inThread.alsoSend) this.readers.clear();
    const { message, seq, parent } = await store.create(sortableId(), clientMessageId, user, notifying, now, kind, posted, inThread);
    if (!inThread || inThread.alsoSend) this.seenBy.set(message.id, this.viewersOfNew(inThread));
    this.broadcast({ type: "message.created", message, seq });
    if (parent) this.broadcast({ type: "message.updated", ...parent });
    const couriers = this.couriersFor(store.roomId);
    couriers.workspace.deliver();
    couriers.index.deliver();
    // A reply in a huddle's thread is counted in the list of the huddles that are over, once it is.
    if (inThread?.parent.huddle) couriers.huddles.deliver();
    return message;
  }

  /**
   * `body` as a new message from `user`, posted as `posting` says, keeps it, with whom it notifies with
   * the special mentions it makes: the widest of those the Workspace says notify the room from them, as
   * Slack notifies each person once, and the rest kept as the plain text they show, as Slack keeps a
   * mention its sender may not use. Only a message sent to the room notifies, not a reply in a thread,
   * nor a reply to a bot's delivery, an AI's answer or what an AI app sends (a "reply"), and none does
   * while the Workspace can't say.
   */
  private async notifying(roomId: RoomId, user: User, body: StoredBody, { kind = "message", inThread }: Posting): Promise<StoredBody> {
    const made = body.specialMentions ?? [];
    if (made.length === 0 || kind !== "message" || inThread) return body;
    let notifying: SpecialMention[];
    try {
      notifying = await workspace(this.env).notifyingMentions(roomId, user.id);
    } catch (error) {
      console.error("Could not ask whom a message's special mentions notify, so it notifies nobody", error);
      return body;
    }
    const allowed = made.filter((mention) => notifying.includes(mention));
    const refused = made.filter((mention) => !notifying.includes(mention));
    const kept = refused.length === 0 ? body : { ...body, html: specialMentionsAsText(body.html, refused), specialMentions: allowed };
    return { ...kept, notifies: widestOf(allowed) };
  }

  /**
   * Posts `posted`'s file, `blob`, as `user`'s message, as `create` posts one. A file message's text is
   * empty, and its plain text, which search, pushes and webhooks read, is its file's name. An upload
   * started without an id for its message, as one from before files were messages or a bot's is, gets
   * one, as a bot's text does.
   */
  private postFile(store: MessageStore, user: User, blob: RoomBlob, posted: PostedFile, now: string, posting: Omit<Posting, "posted"> = {}): Promise<Message> {
    const body = { html: "", plainText: posted.file.name, mentions: [] };
    return this.create(store, user, blob.clientMessageId ?? crypto.randomUUID(), body, now, { ...posting, posted });
  }

  /**
   * Records that `uploaderId` has started a file named `filename`, of `declaredType` as they say, at
   * `startedAt`, which is to come to R2 as it arrives, so its size is only known once it has, and answers
   * its key. The alarm deletes it if it's still unfinished a day later, as it does an upload's.
   */
  private async startArriving(roomId: RoomId, uploaderId: UserId, { filename, declaredType }: Pick<ArrivingFile, "filename" | "declaredType">, startedAt: number): Promise<string> {
    const key = base36(KEY_LENGTH);
    const blob = { id: key, uploaderId, filename, contentType: declaredType, byteSize: 0, clientMessageId: null, parentId: null, alsoSent: false };
    await this.blobsFor(roomId).create(blob, new Date(startedAt).toISOString());
    return key;
  }

  /** `blob`, which R2 has all of now, as it came to in `file`, as the message it's posted as keeps it, at `now`. */
  private streamed(roomId: RoomId, blob: RoomBlob, file: StreamedFile, now: string): PostedFile {
    const blobs = this.blobsFor(roomId);
    return { file: attachedFile({ ...blob, byteSize: file.byteSize, preview: file.preview ?? null }, file.identified), finished: (messageId) => blobs.streamed(blob.id, messageId, now, file) };
  }

  /**
   * Gives `message` the file `posted` brings, in place of any it had, or takes its file away with null,
   * telling everyone in the room, sending the search index its log and having R2 delete the file it had,
   * and answers the message as it is now.
   */
  private async attach(store: MessageStore, message: Message, posted: PostedFile | null, now: string): Promise<Message> {
    const { message: attached, seq } = await store.updateAttachment(message, posted, now);
    this.broadcast({ type: "message.updated", message: attached, seq });
    const couriers = this.couriersFor(store.roomId);
    couriers.index.deliver();
    if (message.attachment) couriers.files.deliver();
    return attached;
  }

  /**
   * Replaces `message`'s text with `body`, and its cards with `body`'s, or none, telling everyone in the
   * room and sending the search index its log, and answers the message as it is now. Saved as it was, it
   * stays as it was, its update time included, as Rails saves nothing then. An edit notifies nobody, and
   * the message notifies only as widely as both its first text and the edited one do.
   */
  private async edit(store: MessageStore, message: Message, body: StoredBody, now: string): Promise<Message> {
    if (body.html === message.body && JSON.stringify(body.cards) === JSON.stringify(message.cards)) return message;
    const { message: edited, seq } = await store.updateBody(message, { ...body, notifies: narrowed(message.notifies, body.specialMentions ?? []) }, now);
    this.broadcast({ type: "message.updated", message: edited, seq });
    this.couriersFor(store.roomId).index.deliver();
    return edited;
  }

  /**
   * Gives the card `message` the text and cards `body` once it's answered, as `edit` does, but without
   * marking it edited: a call's card once it's answered or has waited too long, or what a click on a
   * card comes to in its place.
   */
  private async answerCard(store: MessageStore, message: Message, body: StoredBody, now: string): Promise<void> {
    if (body.html === message.body && JSON.stringify(body.cards) === JSON.stringify(message.cards)) return;
    const { message: answered, seq } = await store.answerCard(message, body, now);
    this.broadcast({ type: "message.updated", message: answered, seq });
    this.couriersFor(store.roomId).index.deliver();
  }

  /**
   * Gives `message` the text `body`, its own with the preview of its link below it, which its sender's tab
   * had once the message had gone, telling everyone in the room, as Slack shows a link's preview a moment
   * after its message, and sending the search index its log. It isn't marked edited.
   */
  private async addPreview(store: MessageStore, message: Message, body: StoredBody, now: string): Promise<void> {
    const { message: previewed, seq } = await store.addPreview(message, { ...body, notifies: message.notifies }, now);
    this.broadcast({ type: "message.updated", message: previewed, seq });
    this.couriersFor(store.roomId).index.deliver();
  }

  /**
   * Deletes `message`, with its boosts, or keeps it for its thread's replies without them, telling
   * everyone in the room and sending the search index its log, and has R2 delete its file, if it has one.
   */
  private async deleteMessage(store: MessageStore, message: Message): Promise<void> {
    await this.deleteEach(store, [message.id]);
    const couriers = this.couriersFor(store.roomId);
    couriers.index.deliver();
    if (message.attachment) couriers.files.deliver();
  }

  /** Adds `user`'s boost of `content` to the message `messageId`, telling everyone in the room, and answers it. */
  private async addBoost(store: MessageStore, messageId: string, user: User, content: string, now: string): Promise<Boost> {
    const { boost, seq } = await store.addBoost(sortableId(), messageId, user, content, now);
    this.broadcast({ type: "boost.created", boost, seq });
    // Search results show a message's boosts, so the index takes it again.
    this.couriersFor(store.roomId).index.deliver();
    return boost;
  }

  /** Removes `boost`, telling everyone in the room. */
  private async removeBoost(store: MessageStore, boost: Boost): Promise<void> {
    const seq = await store.removeBoost(boost);
    this.broadcast({ type: "boost.deleted", boostId: boost.id, messageId: boost.messageId, seq });
    this.couriersFor(store.roomId).index.deliver();
  }

  /** Deletes each of `boosts`, as `MessageStore.removeBoosts` does, telling everyone in the room. */
  private async removeBoosts(store: MessageStore, boosts: Boost[]): Promise<void> {
    const seq = await store.removeBoosts(boosts);
    boosts.forEach((boost, index) => this.broadcast({ type: "boost.deleted", boostId: boost.id, messageId: boost.messageId, seq: seq + index }));
    this.couriersFor(store.roomId).index.deliver();
  }

  /**
   * Deletes each message `ids` names, as `MessageStore.delete` does, telling everyone in the room, and
   * the Workspace's list of the huddles that are over when a huddle's message is deleted, or its thread
   * loses replies. The room's message of its huddle stays deleted when it's one of them, though the room
   * has yet to hear that it was written (./huddles/message.ts).
   */
  private async deleteEach(store: MessageStore, ids: string[]): Promise<void> {
    const deletion = await store.delete(ids);
    this.broadcastDeletion(deletion);
    if (deletion.huddles) this.couriersFor(store.roomId).huddles.deliver();
    await this.huddleMessage.deleted(deletion.deletedIds);
  }

  /** Tells everyone in the room what deleting messages did: the deletions, then the messages it changed. */
  private broadcastDeletion({ deletedIds, changed, seq }: Deletion): void {
    // A deleted message's event no longer names it, nor does that of one kept for its thread's replies, so
    // their viewers are dropped here rather than when the event goes.
    for (const messageId of deletedIds) this.seenBy.delete(messageId);
    for (const { message } of changed) if (message.deleted) this.seenBy.delete(message.id);
    deletedIds.forEach((messageId, index) => this.broadcast({ type: "message.deleted", messageId, seq: seq + index }));
    for (const { message, seq } of changed) this.broadcast({ type: "message.updated", message, seq });
  }

  /** The message `messageId`, or null when the room has no such message, or keeps it deleted for its thread's replies. */
  private async findUndeleted(store: MessageStore, messageId: string): Promise<Message | null> {
    const message = await store.find(messageId);
    return message?.deleted ? null : message;
  }

  /**
   * A new reply's place in the thread of the message `parentId`, sent to the room too when `alsoSend`
   * says so, or null when the room has no such message, or it's a reply, which has no thread. A thread
   * whose message was deleted while it had replies still takes them.
   */
  private async inThread(store: MessageStore, parentId: string, alsoSend: boolean): Promise<InThread | null> {
    const parent = await store.find(parentId);
    return parent && parent.parentId === undefined ? { parent, alsoSend } : null;
  }

  /**
   * The bot `bot`'s message `messageId`, or `NOT_FOUND` or `FORBIDDEN` when the room has no such message
   * or it's someone else's. A bot is never an administrator, so the only messages it can change are its
   * own.
   */
  private async botsOwn(store: MessageStore, bot: User, messageId: string): Promise<Message | string> {
    const message = await this.findUndeleted(store, messageId);
    if (!message) return NOT_FOUND;
    return message.creator.id === bot.id ? message : FORBIDDEN;
  }

  /**
   * Whether `user` may edit or delete `message`: its author or an administrator. Only someone else's
   * message asks the Workspace.
   */
  private async canAdminister(user: User, message: Message): Promise<boolean> {
    return message.creator.id === user.id || (await workspace(this.env).isAdministrator(user.id));
  }

  /**
   * What the room keeps of a body a client sent, naming the people it mentions as they are now, or
   * why it keeps nothing, which is `BLOCKED_WORDS_REFUSED` when what its writer wrote has a blocked word.
   */
  private async prepare(markup: string): Promise<PreparedBody | string> {
    const read = await this.readBody(markup);
    if (typeof read === "string") return read;
    return (await this.hasBlockedWord(read.written)) ? BLOCKED_WORDS_REFUSED : read.body;
  }

  /**
   * A body a client sent as the room keeps it, naming the people it mentions as they are now, and the
   * rooms as `mentionedRooms` names them, with what its writer wrote (`writtenText`), not yet checked for
   * blocked words, or why the room can't keep it.
   */
  private async readBody(markup: string): Promise<{ body: PreparedBody; written: string } | string> {
    const ids = userIdsIn(markup);
    const roomIds = roomIdsIn(markup).filter(isRoomId);
    const [mentioned, mentionedRooms] = await Promise.all([
      ids.length === 0 ? [] : workspace(this.env).mentionedPeople(ids),
      roomIds.length === 0 ? [] : workspace(this.env).mentionedRooms(roomIds),
    ]);
    const people = new Map<UserId, User>(mentioned.map((person) => [person.id, person]));
    const rooms = new Map<RoomId, MentionRoom>(mentionedRooms.map((room) => [room.id, room]));
    const named = (sgid: string) => people.get(userIdFromSgid(sgid) ?? "");
    const roomNamed = (sgid: string) => rooms.get(sgid);
    const body = prepareBody(markup, named, roomNamed);
    if (body === null) return UNREADABLE;
    if (body.blank) return EMPTY;
    if (isMessageTooLong(body.plainText)) return MESSAGE_TOO_LONG;
    return { body, written: writtenText(body, named, roomNamed, rooms.size > 0) };
  }

  /**
   * What the room keeps of a bot's message with `cards`: its text, as `prepare` keeps a body, though it may
   * be empty once the room keeps a card, and the cards, as `keptCards` keeps them, whose plain text
   * follows the text's, together no longer than a message's, or why it keeps nothing. The text and the
   * cards are checked for blocked words together, so that a phrase split between them is found.
   */
  private async prepareWithCards(markup: string, cards: Card[]): Promise<StoredBody | string> {
    const kept = cards.length === 0 ? null : keptCards(cards);
    if (!kept || kept.cards.length === 0) return this.prepare(markup);
    if (JSON.stringify(kept.cards).length > MAX_MESSAGE_HTML_LENGTH) return MESSAGE_TOO_LONG;
    const read = await this.readBody(markup);
    if (typeof read === "string" && read !== EMPTY) return read;
    const { body: text, written } = typeof read === "string" ? { body: { html: "", plainText: "", mentions: [] }, written: "" } : read;
    const plainText = [text.plainText, kept.plainText].filter((line) => line !== "").join("\n");
    if (isMessageTooLong(plainText)) return MESSAGE_TOO_LONG;
    return (await this.hasBlockedWord(`${written}\n${kept.plainText}`)) ? BLOCKED_WORDS_REFUSED : { ...text, plainText, cards: kept.cards };
  }

  /**
   * Whether `text` has a word Blocked words keeps out, as the list the room keeps has them, which it asks
   * the Workspace for once it's a minute old, or once a message the room saved has come back from the
   * Workspace with another version of it (`sendEvents`), so that messages don't wait on the
   * Workspace. A change reaches a room by its next message saved, then, or within a minute.
   */
  private async hasBlockedWord(text: string): Promise<boolean> {
    const now = Date.now();
    const kept = isFresh(this.blockedWords, now) ? this.blockedWords : (this.blockedWords = await this.blockedWordsAt(now));
    return kept.check(text);
  }

  /**
   * The blocked words as the Workspace gives them at `now`. While it can't be reached, as when it's
   * restarting, the room goes by the list it had, or by none, for another minute, rather than turn every
   * message away, as its log waits for the Workspace to send it (`sendEvents`).
   */
  private async blockedWordsAt(now: number): Promise<KeptBlockedWords> {
    try {
      return keptBlockedWords(await workspace(this.env).blockedWords(), now);
    } catch (error) {
      console.error("Could not ask for the blocked words; going by those the room had", error);
      return { ...(this.blockedWords ?? keptBlockedWords(NO_BLOCKED_WORDS, now)), heardAt: now };
    }
  }

  /** The room's database, with its migrations applied first if its storage needs them. */
  private dbFor(): Db {
    return (this.db ??= openDb(this.env, this.ctx.storage, "room"));
  }

  private storeFor(roomId: RoomId): MessageStore {
    return (this.store ??= new MessageStore(this.dbFor(), roomId, this.env.SESSION_SECRET));
  }

  private revocationsFor(roomId: RoomId): Revocations {
    return (this.revocations ??= new Revocations(this.dbFor(), roomId));
  }

  private logFor(roomId: RoomId): RoomLog {
    return (this.log ??= new RoomLog(this.dbFor(), roomId));
  }

  private blobsFor(roomId: RoomId): Blobs {
    return (this.blobs ??= new Blobs(this.dbFor(), roomId));
  }

  private waitingCallsFor(roomId: RoomId): WaitingCalls {
    return (this.waitingCalls ??= new WaitingCalls(this.dbFor(), roomId));
  }

  private scheduledFor(roomId: RoomId): ScheduledMessages {
    return (this.scheduled ??= new ScheduledMessages(this.dbFor(), roomId));
  }

  /**
   * Logs that `userId` has read the room, unless they have since its latest message, for the Workspace
   * to clear their mark, and sends it the log.
   */
  private async read(roomId: RoomId, userId: UserId): Promise<void> {
    if (this.readers.has(userId)) return;
    await this.logFor(roomId).read(userId, new Date().toISOString());
    this.readers.add(userId);
    this.couriersFor(roomId).workspace.deliver();
  }

  /**
   * What sends each of the room's logs. Each has a call of its own out at a time, and waits on its own
   * failures. The search index's is patient, since a search can find a message a moment late: its call
   * doesn't go with the Workspace's as a message is written, so the unread marks the Workspace sends
   * everyone away don't wait behind its queries, as on D1 they would. The huddles' is too, as the list
   * of the huddles that are over can be a moment late.
   */
  private couriersFor(roomId: RoomId): Couriers {
    return (this.couriers ??= {
      workspace: new Courier(() => this.sendEvents(roomId), (time) => this.wakeAt(roomId, time), `room ${roomId}'s log to the Workspace`),
      index: new Courier(() => this.sendMessages(roomId), (time) => this.wakeAt(roomId, time), `room ${roomId}'s messages to the search index`, true),
      files: new Courier(() => this.purgeFiles(roomId), (time) => this.wakeAt(roomId, time), `room ${roomId}'s deleted files to R2`, true),
      huddles: new Courier(() => this.sendHuddles(roomId), (time) => this.wakeAt(roomId, time), `room ${roomId}'s huddles to the Workspace`, true),
    });
  }

  /**
   * Sends the Workspace the oldest events it hasn't taken, as many as one call takes, with who is viewing
   * the room now, for it to mark the room unread for the members who aren't and read for those who've
   * opened it, and forgets them once it has. Answers how many it sent. A reply sent only to its thread
   * goes with who is viewing the thread, who see it, where those viewing the room only see it counted.
   */
  private async sendEvents(roomId: RoomId): Promise<number> {
    const log = this.logFor(roomId);
    const logged = await log.undelivered(ENTRIES_PER_CALL);
    if (logged.length === 0) return 0;
    const now = Date.now();
    const viewers = viewersOf(this.ctx, now);
    const threads = new Map<string, UserId[]>();
    const viewingThread = (parentId: string) => {
      if (!threads.has(parentId)) threads.set(parentId, viewersOf(this.ctx, now, parentId));
      return threads.get(parentId)!;
    };
    // A message in the room goes with everyone who was viewing it as it came, as well as those viewing it now.
    const seeing = (event: RoomEvent): RoomEvent => {
      const seen = event.message && this.seenBy.get(event.message.id);
      return seen ? { ...event, viewerIds: [...new Set([...seen, ...viewers])] } : event;
    };
    const events = logged.map((event) => (event.threadOnly && event.message?.parentId !== undefined ? { ...event, viewerIds: viewingThread(event.message.parentId) } : seeing(event)));
    const { pushes, webhooks, asks, blockedWords } = await workspace(this.env).applyRoomEvents(roomId, events, viewers);
    // Blocked words that have changed since the room heard of them are asked for again before the next check.
    if (this.blockedWords && this.blockedWords.version !== blockedWords) this.blockedWords = outdated(this.blockedWords);
    // The Workspace answers a message's pushes, webhooks and question for @ember once, so they're sent
    // whatever happens next, and the log's next call doesn't wait on push services, bots or models.
    if (pushes.length > 0) this.ctx.waitUntil(this.push(pushes));
    for (const webhook of webhooks) this.ctx.waitUntil(this.deliver(roomId, webhook));
    for (const question of asks) this.ctx.waitUntil(this.answer(roomId, question));
    await log.delivered(events.at(-1)!.seq);
    for (const { message } of events) if (message) this.seenBy.delete(message.id);
    return events.length;
  }

  /**
   * Delivers a new message to a bot's webhook in its turn: the message as it is by then, to the bot's
   * webhook as the Workspace finds it then, and nothing once either is gone, and posts what the bot says
   * back, text or a file. The Workspace finds no webhook for a bot deleted or taken out of the room
   * since, so deleting a bot, taking it out of a room or removing its webhook stops what was on its way
   * to it, and a new URL or key takes effect at once. Each delivery is logged, without its URL or the
   * bot's key, and one the queue has no room for is dropped.
   */
  private async deliver(roomId: RoomId, delivery: MessageWebhook): Promise<void> {
    const job = `Bot::WebhookJob of message ${delivery.messageId} to bot ${delivery.botId}`;
    const ran = await this.webhooks.run(async () => {
      try {
        const message = (await this.isDeleted()) ? null : await this.storeFor(roomId).find(delivery.messageId);
        if (!message) throw new WebhookError("the message is gone");
        const webhook = await workspace(this.env).botWebhook(roomId, delivery.botId);
        if (!webhook) throw new WebhookError(NO_WEBHOOK);
        const keep = (file: ArrivingFile) => this.keepReplyFile(roomId, webhook.bot, file);
        const { status, reply } = await postWebhook(webhook.url, webhookPayload(roomId, delivery, webhook, message), keep);
        const refused = reply && (await this.postReply(roomId, webhook, reply, message.parentId));
        if (refused) throw new WebhookError(`its reply wasn't posted: ${refused}`);
        console.log(`${job} performed: ${status ?? "no answer in time"}`);
      } catch (error) {
        console.error(`${job} failed:`, error instanceof WebhookError ? error.message : error);
      }
    });
    if (!ran) console.error(`${job} dropped: the room's webhook queue is full`);
  }

  /** The button `click` is on, on a message in the room or on the card of a call that waits, which only whoever asked sees, if it's still there. */
  private async clickedButton(store: MessageStore, click: CardClick): Promise<ActingButton | undefined> {
    const message = await this.findUndeleted(store, click.messageId);
    if (message) return message.cards && actingButton(message.cards, clickedIn(click));
    const waiting = await this.waitingCallsFor(store.roomId).find(click.messageId);
    return waiting?.card && actingButton(waiting.card.cards, clickedIn(click));
  }

  /**
   * Reports the click `click`, which `user` sent on `ws`, to the webhook of the bot whose message it's on,
   * in its turn among the room's deliveries, or among its answers, as `queue` is, and does what the bot
   * answers, then tells `ws` it's done, or why it came to nothing. Each is logged as a delivery is, and
   * one the queue has no room for is dropped.
   */
  private async deliverClick(roomId: RoomId, ws: WebSocket, user: User, click: CardClick, queue: JobQueue): Promise<void> {
    const job = `Bot::WebhookJob of ${user.id}'s click on message ${click.messageId}`;
    let failed: string | null = null;
    try {
      const ran = await queue.run(async () => {
        try {
          console.log(`${job} performed: ${await this.reportClick(roomId, user, click)}`);
        } catch (error) {
          console.error(`${job} failed:`, error instanceof WebhookError ? error.message : error);
          failed = error instanceof ClickError ? error.told : CLICK_FAILED;
        }
      });
      if (!ran) {
        console.error(`${job} dropped: the room's queue is full`);
        failed = queue === this.answers ? ROOM_BUSY : WEBHOOKS_FULL;
      }
    } finally {
      const waiting = (this.clicking.get(user.id) ?? 1) - 1;
      if (waiting > 0) this.clicking.set(user.id, waiting);
      else this.clicking.delete(user.id);
      this.send(ws, failed === null ? { type: "card.clicked", clickId: click.clickId } : { type: "error", message: failed, clickId: click.clickId, failed: click.type });
    }
  }

  /**
   * Delivers `user`'s click to the bot's webhook, as `deliver` delivers a message: the button as its
   * message has it by then, to the webhook as the Workspace finds it then, for whoever clicked, while
   * they're in the room, and does what the bot answers. Answers the webhook's status, or throws why the
   * click came to nothing. A click that answers a call that waits goes to no webhook (`decideCall`),
   * and neither does one that calls a tool, on a tool's card (`callFromCard`).
   */
  private async reportClick(roomId: RoomId, user: User, click: CardClick): Promise<number | string> {
    const message = (await this.isDeleted()) ? null : await this.findUndeleted(this.storeFor(roomId), click.messageId);
    if (!message) return this.answerAskersCard(roomId, user, click);
    const button = message.cards && actingButton(message.cards, clickedIn(click));
    if (!button) throw new ClickError(BUTTON_GONE, "the button is gone");
    const decision = callDecisionOf(button.action);
    const decided = decision && (await this.decideCall(roomId, user, message.id, decision));
    if (decided) return decided;
    if (toolCallOf(button.action)) return this.callFromCard(roomId, user, click);
    const { name } = message.creator;
    const webhook = await workspace(this.env).clickWebhook(roomId, message.creator.id, user.id);
    if (!webhook) throw new ClickError(`${name} isn't taking clicks here`, `${NO_WEBHOOK}, or whoever clicked has left the room`);
    const keep = (file: ArrivingFile) => this.keepReplyFile(roomId, webhook.bot, file);
    const { status, answer } = await postClick(webhook.url, clickPayload(roomId, webhook, webhook, message, button, Date.now()), keep);
    if (status === null) throw new ClickError(`${name} didn't answer in time`, "no answer in time");
    if (status < 200 || status > 299) throw new ClickError(`${name} couldn't take that click`, `its webhook answered ${status}`);
    const refused = answer && (await this.postClickAnswer(roomId, webhook, message, answer));
    if (refused) throw new ClickError(`${name}'s answer couldn't be shown`, `its answer wasn't kept: ${refused}`);
    return status;
  }

  /**
   * Makes the call `user`'s `click` on a button of a tool's card asks for, one click a card at a time.
   * The click has the card to itself before its button is looked for again, so one that waited while
   * another's answer took the card's place calls nothing the card no longer offers. Answers what came
   * of it, or throws why the click came to nothing, which whoever clicked is told.
   */
  private async callFromCard(roomId: RoomId, user: User, click: CardClick): Promise<string> {
    if (this.calling.has(click.messageId)) throw new ClickError(CARD_BUSY, "another click on the card is being answered");
    this.calling.add(click.messageId);
    try {
      const message = (await this.isDeleted()) ? null : await this.findUndeleted(this.storeFor(roomId), click.messageId);
      const button = message?.cards && actingButton(message.cards, clickedIn(click));
      const call = button ? toolCallOf(button.action) : undefined;
      if (!message || !button || !call) throw new ClickError(BUTTON_GONE, "the button is gone");
      return await this.callForClick(roomId, user, message, button.text, call);
    } finally {
      this.calling.delete(click.messageId);
    }
  }

  /**
   * Makes the call `call`, which `user`'s click on the button `label` of the tool's card `message`
   * asks for: of a tool the card's answerer still has, of the app whose tool answered with the card,
   * for someone in the room, while Ember AI is on and the answerer there. The card the tool answers
   * with takes the clicked one's place, saying who clicked what, and what a tool only says is the
   * answerer's new message beside it. Answers what came of it, or throws why the click came to nothing,
   * which whoever clicked is told: a tool's own word for it, cut short.
   */
  private async callForClick(roomId: RoomId, user: User, message: Message, label: string, call: CardCall): Promise<string> {
    const { name } = message.creator;
    const [clicker, access] = await Promise.all([workspace(this.env).callDecider(roomId, user.id), workspace(this.env).answererIn(roomId, message.creator.id, user.id)]);
    if (!clicker || !access) throw new ClickError(`${name} isn't answering here`, `${answererGone(message.creator.id)}, or whoever clicked has left the room`);
    const tool = givenTools(access.appTools).find(({ appId, name }) => appId === call.appId && name === call.name);
    if (!tool) throw new ClickError(`${name} no longer has that tool`, "the tool isn't the answerer's any more");
    try {
      const clicked = { who: clicker.member.name, button: label };
      const { text, card } = await calledFromCard(this.env, access.bot.id, givenAs(tool), call.input, clicked, { roomId, askerId: user.id });
      const cards = card && toolCards(card, tool.appId, toolsOf(access.appTools, tool.appId));
      const unshown = await this.showCalled(roomId, access, message, cards ?? slackMessage(saidCard(tool, text, clicked)), cards !== null);
      if (unshown !== null) throw new ClickError(`${tool.appName}'s answer couldn't be shown`, `its answer wasn't kept: ${unshown}`);
      return cards ? "its card was replaced" : "its tool's answer was posted";
    } catch (error) {
      if (error instanceof ToolGone) throw new ClickError(`${name} no longer has that tool`, "the tool isn't the answerer's any more");
      // What a server says of a call isn't logged, as it could write the token there.
      if (error instanceof ToolError) throw new ClickError(toldOf(error.message), "the call came to nothing");
      throw error;
    }
  }

  /**
   * Shows what a click's call was answered with, `shown`, for the tool's card `message`, the answerer
   * `access` finds's own: in its place, `replacing` it, or as the answerer's new message beside it.
   * Answers why the room keeps nothing of it, if it doesn't.
   */
  private showCalled(roomId: RoomId, access: AssistantAccess, message: Message, shown: SlackMessage | string, replacing: boolean): Promise<string | null> {
    return this.serially(async () => {
      if (typeof shown === "string") return shown;
      if (await this.isDeleted()) return "the room is gone";
      if (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt)) return answererGone(access.bot.id);
      const store = this.storeFor(roomId);
      const current = await this.botsOwn(store, access.bot, message.id);
      if (typeof current === "string") return "the card is gone";
      if (!replacing) return this.postBeside(store, access.bot, current, shown);
      const body = await this.prepareWithCards(shown.markup, shown.cards);
      if (typeof body === "string") return body;
      await this.answerCard(store, current, body, new Date().toISOString());
      return null;
    });
  }

  /**
   * Does what a bot answers a click on its `message` with: what it says back, text or a file, is its
   * reply, as `postReply` posts one to a delivery, and a Slack payload takes the message's place, as
   * Slack has an interactive message's answer do, or, with `replace_original` false, is a new message
   * beside it, and `delete_original` deletes the message. A payload that shows nothing does nothing, as an
   * answer without one does, and as blank text does, which is a webhook's bare 200. Answers why the room
   * keeps nothing of it, if it doesn't.
   */
  private async postClickAnswer(roomId: RoomId, webhook: WebhookAccess, message: Message, answer: ClickAnswer<KeptFile>): Promise<string | null> {
    if ("text" in answer && answer.text.trim() === "") return null;
    if (!("payload" in answer)) return this.postReply(roomId, webhook, answer, message.parentId);
    if (answer.payload.trim() === "") return null;
    const payload = payloadOf(answer.payload);
    if (!payload) return "it isn't a JSON object";
    const posted = payload.delete_original === true ? null : slackMessage(payload, true);
    if (posted === "no_text") return null;
    if (typeof posted === "string") return posted;
    const found = await workspace(this.env).botWebhook(roomId, webhook.bot.id);
    const access = found?.url === webhook.url ? found : null;
    return this.serially(async () => {
      if (await this.isDeleted()) return "the room is gone";
      if (!access || (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt))) return WEBHOOK_CHANGED;
      const store = this.storeFor(roomId);
      if (posted && payload.replace_original === false) return this.postBeside(store, access.bot, message, posted);
      const current = await this.botsOwn(store, access.bot, message.id);
      if (typeof current === "string") return "the message is gone";
      if (!posted) return this.deleteMessage(store, current).then(() => null);
      const body = await this.prepareWithCards(posted.markup, posted.cards);
      if (typeof body === "string") return body;
      await this.answerCard(store, current, body, new Date().toISOString());
      return null;
    });
  }

  /**
   * Posts `posted` as `bot`'s new message beside `message`, in its thread when it's in one, only there, as
   * a reply to a delivery goes, and to no webhook. Answers why the room keeps nothing of it, if it doesn't.
   */
  private async postBeside(store: MessageStore, bot: User, message: Message, { markup, cards }: SlackMessage): Promise<string | null> {
    const inThread = message.parentId === undefined ? undefined : await this.inThread(store, message.parentId, false);
    if (inThread === null) return THREAD_GONE;
    const body = await this.prepareWithCards(markup, cards);
    if (typeof body === "string") return body;
    await this.create(store, bot, crypto.randomUUID(), body, new Date().toISOString(), { kind: "reply", inThread });
    return null;
  }

  /**
   * Posts what a bot says back to a delivery to `webhook`, text or a file, as the bot by its name then,
   * once the Workspace has found it still in the room, delivering to the same URL: one deleted, taken
   * out of the room or sent elsewhere while the delivery ran posts nothing, where Campfire posts it
   * (`Webhook#deliver`). A reply to a message in a thread, `threadId`'s, goes in the thread, only there.
   * Answers why the room keeps nothing of it, if it doesn't, and has R2 delete a file it couldn't ask the
   * Workspace about, as `replyWithFile` has it delete one it refuses.
   */
  private async postReply(roomId: RoomId, webhook: WebhookAccess, reply: Reply<KeptFile>, threadId?: string): Promise<string | null> {
    const found = await workspace(this.env)
      .botWebhook(roomId, webhook.bot.id)
      .catch(async (error: unknown) => {
        if ("kept" in reply) await this.env.FILES?.delete([objectKey(reply.kept.key), previewKey(reply.kept.key)]);
        throw error;
      });
    const access = found?.url === webhook.url ? found : null;
    return "text" in reply ? this.reply(roomId, access, reply.text, threadId) : this.replyWithFile(roomId, access, reply.kept, threadId);
  }

  /**
   * Posts `text` as the bot's reply to a delivery, as Campfire's `receive_text_reply_to` does: as the
   * bot's message, which reaches the room as any message does but is delivered to no webhook. Answers why
   * the room keeps nothing of it, if it doesn't: as `createBotMessage` refuses a bot's post, it refuses
   * one without `access`, or that the room has heard was taken out since the Workspace checked, and one
   * to thread `threadId` that the room no longer has.
   */
  private async reply(roomId: RoomId, access: BotAccess | null, text: string, threadId?: string): Promise<string | null> {
    return this.serially(async () => {
      if (await this.isDeleted()) return "the room is gone";
      if (!access || (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt))) return WEBHOOK_CHANGED;
      const store = this.storeFor(roomId);
      const inThread = threadId === undefined ? undefined : await this.inThread(store, threadId, false);
      if (inThread === null) return THREAD_GONE;
      const body = await this.prepare(text);
      if (typeof body === "string") return body;
      await this.create(store, access.bot, crypto.randomUUID(), body, new Date().toISOString(), { kind: "reply", inThread });
      return null;
    });
  }

  /**
   * Has R2 keep the file a bot replies with, as it arrives, as an upload of the bot's the room starts for
   * it, for `replyWithFile` to post, and answers what it came to, or null once it's more than its limit.
   */
  private async keepReplyFile(roomId: RoomId, bot: User, file: ArrivingFile): Promise<KeptFile | null> {
    const files = this.env.FILES;
    if (!files) throw new WebhookError(`its reply, ${file.filename} (${file.declaredType}), is a file, and ${NO_STORAGE}`);
    const startedAt = Date.now();
    const key = await this.serially(async () => {
      if (await this.isDeleted()) throw new WebhookError("the room is gone");
      return this.startArriving(roomId, bot.id, file, startedAt);
    });
    await this.wakeAt(roomId, startedAt + UNFINISHED_UPLOAD_KEPT_MS);
    const stored = await storeArriving(files, objectKey(key), file);
    return stored && { key, file: await withPreview(this.env, files, key, file.filename, stored) };
  }

  /**
   * Posts the file `kept` as the bot's reply to a delivery, as Campfire's `receive_attachment_reply_to`
   * does, as `reply` posts text, refusing it as `reply` does. Answers why the room keeps nothing of it, if
   * it doesn't, having R2 delete it at once: nothing else would once the room is deleted, and otherwise it
   * would wait for the alarm to find it unfinished.
   */
  private async replyWithFile(roomId: RoomId, access: BotAccess | null, { key, file }: KeptFile, threadId?: string): Promise<string | null> {
    const refused = await this.serially(async () => {
      const now = new Date().toISOString();
      const blob = (await this.isDeleted()) ? null : await this.blobsFor(roomId).find(key);
      if (!blob) return "the room is gone";
      if (!access || (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt))) return WEBHOOK_CHANGED;
      const store = this.storeFor(roomId);
      const inThread = threadId === undefined ? undefined : await this.inThread(store, threadId, false);
      if (inThread === null) return THREAD_GONE;
      await this.postFile(store, access.bot, blob, this.streamed(roomId, blob, file, now), now, { kind: "reply", inThread });
      return null;
    });
    if (refused) await this.env.FILES?.delete([objectKey(key), previewKey(key)]);
    return refused;
  }

  /**
   * Answers a question for @ember or an agent, the bot `question` names, in its turn: the message as it
   * is by then, while Ember AI is on and the bot is in the room, and nothing once either isn't, typing
   * while it works, and posting what the model answers, or a note saying why it can't. Each is logged,
   * without what was asked or answered, and one the queue has no room for is dropped.
   */
  private async answer(roomId: RoomId, question: AssistantAsk): Promise<void> {
    const job = `${answererOf(question.botId)}'s answer to message ${question.messageId}`;
    const ran = await this.answers.run(async () => {
      try {
        const message = (await this.isDeleted()) ? null : await this.findUndeleted(this.storeFor(roomId), question.messageId);
        if (!message) throw new AnswerError("the message is gone");
        const access = await workspace(this.env).answererIn(roomId, question.botId, question.author.id);
        if (!access) throw new AnswerError(answererGone(question.botId));
        const refused = await this.typingWhile(access.bot, message.parentId, async () => this.post(roomId, access, question.author, message, await this.saidTo(roomId, access, question, message)));
        if (refused) throw new AnswerError(`it wasn't posted: ${refused}`);
        console.log(`${job} posted`);
      } catch (error) {
        console.error(`${job} failed:`, error instanceof AnswerError ? error.message : error);
      }
    });
    if (!ran) console.error(`${job} dropped: the room's queue of questions for @ember and the agents is full`);
  }

  /**
   * What the bot `access` finds, @ember or an agent, says to `message`, `question`'s message, with what
   * it reads of the conversation, as its instructions say, using the web as Search the web lets it, and
   * searching and reading the room past that, and the connected apps' tools picked for it, where its
   * model takes Ember's tools: its answer in Markdown, at its levels, @ember's the asker's, with the model
   * they picked, if they did (`outcomeOf`), or the call of an app's tool it waits at.
   */
  private async saidTo(roomId: RoomId, access: AssistantAccess, { author, roomName }: AssistantAsk, message: Message): Promise<Outcome> {
    const { bot, gateway, instructions, promptTemplate, community, levels, webTools, webSearchOn } = access;
    if (!gateway) return { text: NOTES["unopened token"] };
    const [conversation, takesTools] = await Promise.all([this.conversationOf(this.storeFor(roomId), message), takesEmbersTools(this.env, gateway.model)]);
    const where = { community, roomName, inThread: message.parentId !== undefined };
    const read = allOf(readable(conversation, where.inThread));
    const given = takesTools ? givenTools(access.appTools) : [];
    const askedBy = { roomId, askerId: author.id };
    const appTools = given.map((tool) =>
      this.sayingWhile(bot, message, usingApp(tool), appTool(this.env, bot.id, tool, askedBy, { described: tool, allows: this.allowsCallsOf(roomId, access, message, tool), cards: this.showsCardsOf(roomId, bot, message, tool) })),
    );
    const roomRead = nothingRead();
    const tools = takesTools ? [...this.roomToolsFor(roomId, bot, message, author.id, read, roomRead), ...appTools] : [];
    const asked = loggedIn({ ...questionFor({ ...bot, instructions, promptTemplate }, conversation, author, where, levels, new Date(), webTools, webSearchOn), tools }, access);
    const [answered, people] = await Promise.all([askWaiting(this.env, gateway, asked, waitFor(asked)), this.peopleWhoWrote(allOf(conversation))]);
    return this.outcomeOf(access, message, answered, writtenBy(people, conversation, where.inThread), given.map(givenAs), roomRead);
  }

  /**
   * What the bot `access` finds says to `message` once the call its answer waited at, `call`, is
   * `allowed` or isn't: as `saidTo` answers, going on from where its model stopped, with the room's
   * tools, reading what was left for them to read, and the apps' tools the model was given then, each
   * called only while it's still picked for the bot, and without asking first where its calls of it are
   * always allowed by now. A model changed since can't go on from another's answer, which the bot says.
   */
  private async wentOn(roomId: RoomId, access: AssistantAccess, message: Message, call: WaitingCall, allowed: boolean): Promise<Outcome> {
    const { bot, gateway } = access;
    if (!gateway) return { text: NOTES["unopened token"] };
    if (gateway.model !== call.paused.model || gateway.format !== call.paused.format) return { text: MODEL_CHANGED };
    const conversation = await this.conversationOf(this.storeFor(roomId), message);
    const inThread = message.parentId !== undefined;
    const read = allOf(readable(conversation, inThread));
    const asked = { roomId, askerId: call.asker.id };
    const appTools = call.tools.map((tool) =>
      this.sayingWhile(bot, message, usingApp(tool), appTool(this.env, bot.id, tool, asked, { allows: this.allowsCallsOf(roomId, access, message, tool), cards: this.showsCardsOf(roomId, bot, message, tool) })),
    );
    // A call that began to wait before the room's tools shared what they read has all of it left.
    const roomRead = call.read ?? nothingRead();
    const tools = [...this.roomToolsFor(roomId, bot, message, call.asker.id, read, roomRead), ...appTools];
    const paused = { ...call.paused, question: loggedIn(call.paused.question, access) };
    const [answered, people] = await Promise.all([goOn(this.env, gateway, tools, paused, allowed, waitFor(paused.question)), this.peopleWhoWrote(allOf(conversation))]);
    return this.outcomeOf(access, message, answered, writtenBy(people, conversation, inThread), call.tools, roomRead);
  }

  /**
   * What says whether room `roomId` still allows each call of `tool` that the bot `access` finds makes,
   * answering `message`, without asking first, or undefined unless its calls of it are always allowed
   * there: not once they ask first in the room, as they do once it's private, nor once the bot is gone
   * from it, or the question or its thread is, as then nothing it answers would be posted.
   */
  private allowsCallsOf(roomId: RoomId, { bot, appTools }: AssistantAccess, message: Message, tool: GivenTool): AllowsCall | undefined {
    if (!isAlwaysAllowed(appTools, tool)) return undefined;
    return async () => {
      const access = await workspace(this.env).answererIn(roomId, bot.id, message.creator.id);
      if (access && !isAlwaysAllowed(access.appTools, tool)) return ASKS_FIRST_NOW;
      return this.serially(async () => {
        if (await this.isDeleted()) return "the room is gone";
        if (!access || (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt))) return answererGone(bot.id);
        const store = this.storeFor(roomId);
        if (!(await this.findUndeleted(store, message.id))) return "the message is gone";
        return message.parentId !== undefined && (await this.inThread(store, message.parentId, false)) === null ? THREAD_GONE : null;
      });
    };
  }

  /**
   * The tools that search and read room `roomId` for `bot`, @ember or an agent, as it answers `message`,
   * which `askerId` asked, as they'd read it, past `given`, what it was given with it, reading as much as
   * `read` has left, each of whose calls the room's typing line says, after the bot's name, while it runs.
   */
  private roomToolsFor(roomId: RoomId, bot: User, message: Message, askerId: UserId, given: readonly Message[], read: RoomRead): EmberTool[] {
    const reading = { env: this.env, roomId, askerId, question: message, given, reader: this.readerOf(roomId), read };
    return roomTools(reading).map(({ tool, doing }) => this.sayingWhile(bot, message, doing, tool));
  }

  /** What reads room `roomId` for the tools of @ember and the agents, a page at a time, as it reads itself for bots and AI apps. */
  private readerOf(roomId: RoomId): RoomReader {
    const reading = <T>(read: (store: MessageStore) => Promise<T>) => this.serially(() => read(this.storeFor(roomId)));
    return {
      page: (cursor) => this.outsidePage(roomId, cursor),
      find: (id) => reading((store) => store.find(id)),
      replies: (parentId, before) => reading((store) => (before === undefined ? store.thread(parentId, HISTORY_PAGE_SIZE) : store.repliesBefore(parentId, before, HISTORY_PAGE_SIZE))),
    };
  }

  /**
   * `tool`, whose every call has the room's typing line say, after the name of `bot`, who's typing as it
   * answers `message`, that it's `doing` it, while it runs.
   */
  private sayingWhile(bot: User, message: Message, doing: string, tool: EmberTool): EmberTool {
    return { ...tool, run: (input) => this.doingWhile(bot, message.parentId, doing, () => tool.run(input)) };
  }

  /**
   * What shows room `roomId` the cards that `tool` answers `bot`'s calls with, as it answers
   * `message`: each as `bot`'s reply, where its answer goes, with the buttons that call a tool of the
   * same app that `bot` has by then (`toolCards`).
   */
  private showsCardsOf(roomId: RoomId, bot: User, message: Message, tool: GivenTool): ShowsCard {
    return (card) => this.postCallCard(roomId, bot, message, ({ appTools }) => toolCards(card, tool.appId, toolsOf(appTools, tool.appId)) ?? "it shows nothing here");
  }

  /**
   * What `answered`, which the model of the bot `access` finds came to for `message`, has it say: its
   * answer, ending with an ellipsis when the model was cut short, the pages it came from, and what
   * people wrote in what it read, `written`, or the note it posts when its model doesn't answer, saying
   * why, which the room logs, or the call it waits at, with the apps' tools it was `given` and what
   * what its calls have `read` of the room.
   */
  private outcomeOf(access: AssistantAccess, message: Message, answered: Answered | GatewayRefusal | Asking, written: string[], given: GivenTool[], read: RoomRead): Outcome {
    const { bot, gateway, picked } = access;
    if ("asks" in answered) return { asking: answered, given, read };
    if (!("refusal" in answered)) {
      const text = answered.cut ? `${answered.text}\n\n…` : answered.text;
      return { text, ...(answered.sources && { sources: answered.sources }), written };
    }
    console.error(`${answererOf(bot.id)}'s model ${gateway?.model} didn't answer message ${message.id}: ${answered.refusal}`);
    const agent = bot.id !== ASSISTANT_ID;
    return { text: (picked && PICKED_MODEL_NOTES[answered.reason]) || (agent && AGENT_NOTES[answered.reason]) || NOTES[answered.reason] };
  }

  /**
   * Posts what a question to the bot `access` finds came to, `outcome`, for `message`, which `asker`
   * asked: its answer (`postAnswer`), or the card that asks whether its call may run (`askFirst`).
   * Answers why the room keeps nothing of it, if it doesn't.
   */
  private async post(roomId: RoomId, access: AssistantAccess, asker: User, message: Message, outcome: Outcome): Promise<string | null> {
    if (!("asking" in outcome)) return this.postAnswer(roomId, access.bot, outcome, message, access.addresses);
    const { asks, paused } = outcome.asking;
    const tool = outcome.given.find(({ as }) => as === asks.name);
    if (!tool) return `${asks.name} asks first, and is no app's tool`;
    const call: WaitingCall = { questionId: message.id, botId: access.bot.id, asker, tool, input: asks.input, tools: outcome.given, paused, read: outcome.read, askedAt: Date.now() };
    return fits(call) ? this.askFirst(roomId, access.bot, message, call) : this.postAnswer(roomId, access.bot, { text: tooMuchToWait(tool.appName) }, message, access.addresses);
  }

  /**
   * Shows whoever asked alone the card that asks whether `call`, which `bot`'s answer to `message` waits
   * at, may run, as a message only they see, as a Slack app's ephemeral message is, and keeps the call, with
   * the card, for the click that answers it (`decideCall`). Answers why the room keeps nothing of it, if it
   * doesn't.
   */
  private async askFirst(roomId: RoomId, bot: User, message: Message, call: WaitingCall): Promise<string | null> {
    const card = ({ bot }: AssistantAccess) => slackMessage(callCard(bot.name, call.tool, call.input), true);
    const refused = await this.showAsker(roomId, bot, message, call.asker, card, (shown) => this.waitingCallsFor(roomId).keep(shown.id, { ...call, card: shown }));
    // The alarm forgets it once it has waited too long (`forgetLateCalls`).
    if (refused === null) await this.wakeAt(roomId, call.askedAt + CALL_WAITS_MS + 1);
    return refused;
  }

  /**
   * Shows `asker` alone, as a message only they see, the card `cardFor` gives for `bot` as the Workspace finds
   * it then, where `postAnswer` would post its answer to `message` and while it would, on each socket they
   * have in the room. It first does `kept` with the message it is, in the same turn. Answers why there's
   * none to show, if there isn't.
   */
  private async showAsker(
    roomId: RoomId,
    bot: User,
    message: Message,
    asker: User,
    cardFor: (access: AssistantAccess) => SlackMessage | string,
    kept: (shown: EphemeralMessage) => Promise<void>,
  ): Promise<string | null> {
    const access = await workspace(this.env).answererIn(roomId, bot.id, asker.id);
    const card = access && cardFor(access);
    if (typeof card === "string") return card;
    return this.serially(async () => {
      if (await this.isDeleted()) return "the room is gone";
      if (!access || !card || (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt))) return answererGone(bot.id);
      const store = this.storeFor(roomId);
      if (!(await this.findUndeleted(store, message.id))) return "the message is gone";
      if (message.parentId !== undefined && (await this.inThread(store, message.parentId, false)) === null) return THREAD_GONE;
      const body = await this.prepareWithCards(card.markup, card.cards);
      if (typeof body === "string") return body;
      const shown: EphemeralMessage = {
        id: crypto.randomUUID(),
        roomId,
        creator: access.bot,
        body: body.html,
        plainText: body.plainText,
        cards: body.cards ?? [],
        createdAt: new Date().toISOString(),
        ...(message.parentId !== undefined && { parentId: message.parentId }),
      };
      await kept(shown);
      this.showOnly(asker.id, shown);
      return null;
    });
  }

  /** Sends `message`, which only `userId` sees, to each socket they have in the room. */
  private showOnly(userId: UserId, message: EphemeralMessage): void {
    const data = JSON.stringify({ type: "message.ephemeral", message } satisfies ServerFrame);
    // A tab too old to know of it has been told to reload.
    for (const socket of this.roomSockets(userId).filter((socket) => !isOutdated(socket))) {
      try {
        socket.send(data);
      } catch {
        // As in `broadcast`.
      }
    }
  }

  /**
   * Posts the card a call was answered with as `bot`'s reply to `message`, where `postAnswer` would post the
   * answer and while it would: what `cardFor` gives for `bot` as the Workspace finds it then, or why there's
   * none to post. Answers why the room keeps nothing of it, if it doesn't.
   */
  private async postCallCard(roomId: RoomId, bot: User, message: Message, cardFor: (access: AssistantAccess) => SlackMessage | string): Promise<string | null> {
    const access = await workspace(this.env).answererIn(roomId, bot.id, message.creator.id);
    const card = access && cardFor(access);
    if (typeof card === "string") return card;
    return this.serially(async () => {
      if (await this.isDeleted()) return "the room is gone";
      if (!access || !card || (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt))) return answererGone(bot.id);
      const store = this.storeFor(roomId);
      if (!(await this.findUndeleted(store, message.id))) return "the message is gone";
      const inThread = message.parentId === undefined ? undefined : await this.inThread(store, message.parentId, false);
      if (inThread === null) return THREAD_GONE;
      const body = await this.prepareWithCards(card.markup, card.cards);
      if (typeof body === "string") return body;
      await this.create(store, access.bot, crypto.randomUUID(), body, new Date().toISOString(), { kind: "reply", inThread });
      return null;
    });
  }

  /**
   * Forgets the calls that have waited too long to be allowed in room `roomId`, a few at a time, each
   * card saying so in place of its buttons, and answers when the next will have, if any still waits.
   */
  private async forgetLateCalls(roomId: RoomId): Promise<number | null> {
    const { late, next } = await this.serially(() => this.waitingCallsFor(roomId).takeLate(Date.now()));
    for (const { messageId, call } of late) {
      const unchanged = await this.showDecided(roomId, messageId, call, CALL_OUTCOMES.late());
      if (unchanged !== null) console.error(`The card of a call that waited too long, message ${messageId}, wasn't changed: ${unchanged}`);
    }
    return next;
  }

  /**
   * Answers the call that waits on the card `message` as `user`'s click on its button says, `allow` or
   * `deny`, for whoever asked the question or an administrator, once: the card says who answered and
   * how, in place of its buttons, and the answer goes on in its turn (`goOnFrom`). Answers what was
   * decided, or null when no call waits on that message, and throws why the click came to nothing: with
   * no turn left for the answer to go on in, the call waits on, to be answered again.
   */
  private async decideCall(roomId: RoomId, user: User, cardId: string, decision: "allow" | "deny"): Promise<string | null> {
    const calls = this.waitingCallsFor(roomId);
    const waiting = await calls.find(cardId);
    if (!waiting) return null;
    // Only whoever asked sees a card that's theirs alone. Anyone in the room saw one that was a message in it, which an administrator could answer too.
    const decider = await workspace(this.env).callDecider(roomId, user.id);
    const mayAnswer = decider !== null && (user.id === waiting.asker.id || (waiting.card === undefined && decider.administrator));
    if (!mayAnswer) throw new ClickError(waiting.card ? `Only ${waiting.asker.name} can answer that` : `Only ${waiting.asker.name} or an administrator can answer that`, "whoever clicked may not answer it");
    const call = await this.serially(() => calls.take(cardId));
    if (!call) throw new ClickError(CALL_ANSWERED, "the call was answered meanwhile");
    if (Date.now() - call.askedAt > CALL_WAITS_MS) {
      await this.showDecided(roomId, cardId, call, CALL_OUTCOMES.late());
      throw new ClickError(CALL_LATE, "the call waited too long");
    }
    if (this.answers.full) {
      // Kept to be answered again, as an answer nobody goes on with would be lost with its call allowed.
      await this.serially(() => calls.keep(cardId, call));
      throw new ClickError(ROOM_BUSY, "the room's queue of questions for @ember and the agents is full");
    }
    // The answer takes its turn before anything else can take the queue's last place.
    const going = this.goOnFrom(roomId, call, decision === "allow");
    const shown = await this.showDecided(roomId, cardId, call, CALL_OUTCOMES[decision](call.card ? "you" : decider.member.name));
    this.ctx.waitUntil(going);
    return `${decision}${shown === null ? "" : `, though its card wasn't changed: ${shown}`}`;
  }

  /**
   * Answers `user`'s click on the card `click` names that only they see, a call's that waits on them, as
   * `decideCall` does, or throws why it came to nothing: the call has been answered, or forgotten.
   */
  private async answerAskersCard(roomId: RoomId, user: User, click: CardClick): Promise<string> {
    const waiting = (await this.isDeleted()) ? null : await this.waitingCallsFor(roomId).find(click.messageId);
    const button = waiting?.card && actingButton(waiting.card.cards, clickedIn(click));
    const decision = button ? callDecisionOf(button.action) : undefined;
    const decided = decision && (await this.decideCall(roomId, user, click.messageId, decision));
    if (!decided) throw new ClickError(BUTTON_GONE, "the button is gone");
    return decided;
  }

  /**
   * Has the card `cardId`, which asked whether `call` may run, say `outcome` in place of its buttons: on the
   * sockets of whoever asked, for a card only they see, or else in the room. Answers why it's left as it was,
   * if it is.
   */
  private showDecided(roomId: RoomId, cardId: string, call: WaitingCall, outcome: string): Promise<string | null> {
    const { card } = call;
    if (!card) return this.changeCallCard(roomId, cardId, (botName) => callCard(botName, call.tool, call.input, outcome));
    return this.serially(async () => {
      const decided = slackMessage(callCard(card.creator.name, call.tool, call.input, outcome));
      if (typeof decided === "string") return decided;
      const body = await this.prepareWithCards(decided.markup, decided.cards);
      if (typeof body === "string") return body;
      this.showOnly(call.asker.id, { ...card, body: body.html, plainText: body.plainText, cards: body.cards ?? [] });
      return null;
    });
  }

  /** Has the message `messageId`, a call's card, be the card `cardFor` gives for the bot that posted it, by its name now. Answers why it's left as it was, if it is. */
  private changeCallCard(roomId: RoomId, messageId: string, cardFor: (botName: string) => SlackPayload): Promise<string | null> {
    return this.serially(async () => {
      const store = this.storeFor(roomId);
      const current = (await this.isDeleted()) ? null : await this.findUndeleted(store, messageId);
      if (!current) return "the message is gone";
      const card = slackMessage(cardFor(current.creator.name));
      if (typeof card === "string") return card;
      const body = await this.prepareWithCards(card.markup, card.cards);
      if (typeof body === "string") return body;
      await this.answerCard(store, current, body, new Date().toISOString());
      return null;
    });
  }

  /**
   * Goes on with the answer that waited at `call`, once it's `allowed` or isn't, in its turn among the
   * room's answers, as `answer` answers a question: for the message asked, as it is by then, while Ember
   * AI is on and the bot in the room, typing while it works, and posting what the model answers, the
   * note saying why it can't, or the card for the next call it waits at.
   */
  private async goOnFrom(roomId: RoomId, call: WaitingCall, allowed: boolean): Promise<void> {
    const job = `${answererOf(call.botId)}'s answer to message ${call.questionId}, going on from a call ${allowed ? "allowed" : "not allowed"}`;
    const ran = await this.answers.run(async () => {
      try {
        const message = (await this.isDeleted()) ? null : await this.findUndeleted(this.storeFor(roomId), call.questionId);
        if (!message) throw new AnswerError("the message is gone");
        const access = await workspace(this.env).answererIn(roomId, call.botId, call.asker.id);
        if (!access) throw new AnswerError(answererGone(call.botId));
        const refused = await this.typingWhile(access.bot, message.parentId, async () => this.post(roomId, access, call.asker, message, await this.wentOn(roomId, access, message, call, allowed)));
        if (refused) throw new AnswerError(`it wasn't posted: ${refused}`);
        console.log(`${job} posted`);
      } catch (error) {
        console.error(`${job} failed:`, error instanceof AnswerError ? error.message : error);
      }
    });
    if (!ran) console.error(`${job} dropped: the room's queue of questions for @ember and the agents is full`);
  }

  /**
   * Which of those who wrote `conversation` are people, not bots, as @ember is one, as the Workspace has
   * them now, or nobody when it can't say.
   */
  private async peopleWhoWrote(conversation: Message[]): Promise<Set<UserId>> {
    const writers = [...new Set(conversation.map(({ creator }) => creator.id))];
    const entries = await workspace(this.env)
      .directoryEntries(writers)
      .catch((error: unknown) => {
        console.error("Could not find who wrote what Ember AI read", error);
        return [];
      });
    return new Set(entries.flatMap(({ id, role }) => (role === "bot" ? [] : [id])));
  }

  /**
   * The conversation @ember reads to answer `message`, oldest first, ending with it: the thread it's in,
   * its first message and latest replies, after the room's messages before it, or else the room's latest
   * messages.
   */
  private async conversationOf(store: MessageStore, message: Message): Promise<Conversation<Message>> {
    if (message.parentId === undefined) return { messages: [...(await store.page(ROOM_MESSAGES_READ - 1, message.id)).messages, message] };
    const [parent, replies, before] = await Promise.all([
      store.find(message.parentId),
      store.repliesBefore(message.parentId, message.id, THREAD_REPLIES_READ - 1),
      store.page(ROOM_MESSAGES_READ_BEFORE_THREAD, message.parentId),
    ]);
    return { messages: [...(parent ? [parent] : []), ...replies.messages, message], before: before.messages };
  }

  /**
   * Posts what `bot`, @ember or an agent, `said` to `message`, its answer in Markdown, as its reply: in
   * `message`'s thread when it's in one, only there, with the pictures it shows in a card under it and
   * the cards of the Slack payloads it writes after that, the pages it came from after it, and a preview
   * of its first web link below it, as the composer adds one, the pictures, in its cards too, and the
   * link only at addresses people wrote or of the pages it came from, and the link
   * on none of Ember's own `addresses` (`answerOf`). Like a bot's reply, it reaches the room as any
   * message does, but goes to no bot, @ember and the agents among them. It's posted only while Ember AI
   * is on and the bot in the room, and `message` still there, so that turning Ember AI off, deleting the
   * agent, taking the bot out of the room or deleting the question while the model answers posts
   * nothing. Answers why the room keeps nothing of it, if it doesn't.
   */
  private async postAnswer(roomId: RoomId, bot: User, said: Said, message: Message, addresses: readonly string[]): Promise<string | null> {
    const answer = answerOf(said.text, said.sources, said.written, addresses, bot.name);
    const preview = answer.firstLink === null ? null : await this.previewOf(answer.firstLink);
    const access = await workspace(this.env).answererIn(roomId, bot.id, message.creator.id);
    return this.serially(async () => {
      if (await this.isDeleted()) return "the room is gone";
      if (!access || (await this.revocationsFor(roomId).refuse([access.bot.id], access.authorizedAt))) return answererGone(bot.id);
      const store = this.storeFor(roomId);
      if (!(await this.findUndeleted(store, message.id))) return "the message is gone";
      const inThread = message.parentId === undefined ? undefined : await this.inThread(store, message.parentId, false);
      if (inThread === null) return THREAD_GONE;
      const answered = await this.answerBody(answer, preview);
      // An answer with a blocked word isn't posted: the answerer says why it can't answer instead.
      const body = answered === BLOCKED_WORDS_REFUSED ? blockedAnswerBody() : answered;
      if (typeof body === "string") return body;
      await this.create(store, access.bot, crypto.randomUUID(), body, new Date().toISOString(), { kind: "reply", inThread });
      return null;
    });
  }

  /** What the room keeps of `answer`, with `preview` below it, unless the room can't keep the preview, or why it keeps nothing. */
  private async answerBody({ markup, cards }: Answer, preview: LinkPreview | null): Promise<StoredBody | string> {
    const previewed = preview && (await this.prepareWithCards(`${markup}${previewAttachment(preview)}`, cards));
    return previewed && typeof previewed !== "string" ? previewed : this.prepareWithCards(markup, cards);
  }

  /** The preview of `url`, as the composer would show one, or null when it has none, or none can be had. */
  private async previewOf(url: string): Promise<LinkPreview | null> {
    return unfurler(this.env)
      .unfurl(url)
      .catch((error: unknown) => {
        console.error("Could not unfurl the link in Ember AI's answer", error);
        return null;
      });
  }

  /**
   * Runs `work`, the room hearing that `bot` is typing until it's done: in thread `threadId`, if there is
   * one, else in the room, and again every few seconds, as apps forget typing they've stopped hearing of.
   * While other work of the bot's goes on there, it's still typing once this is done, which the room says
   * again, as apps stop showing someone typing once a message of theirs arrives.
   */
  private async typingWhile<T>(bot: User, threadId: string | undefined, work: () => Promise<T>): Promise<T> {
    const typist = typistOf(bot, threadId);
    this.typists.set(typist, (this.typists.get(typist) ?? 0) + 1);
    this.sayTyping(bot, threadId);
    const again = setInterval(() => this.sayTyping(bot, threadId), TYPING_AGAIN_MS);
    try {
      return await work();
    } finally {
      clearInterval(again);
      const jobs = this.typists.get(typist)! - 1;
      if (jobs === 0) this.typists.delete(typist);
      else this.typists.set(typist, jobs);
      this.sayTyping(bot, threadId);
    }
  }

  /**
   * Runs `work`, a call of one of the tools of `bot`, which is typing as it answers in thread `threadId`,
   * if there is one, else in the room: the room hears, beside its typing, that it's `doing` it, until
   * it's done, and then what a call it's making for another answer there is doing, if one still runs, or
   * that it's only typing again, while it still is.
   */
  private async doingWhile<T>(bot: User, threadId: string | undefined, doing: string, work: () => Promise<T>): Promise<T> {
    const typist = typistOf(bot, threadId);
    this.doings.set(typist, [...(this.doings.get(typist) ?? []), doing]);
    this.sayTyping(bot, threadId);
    try {
      return await work();
    } finally {
      const doings = this.doings.get(typist)!;
      const left = doings.toSpliced(doings.lastIndexOf(doing), 1);
      if (left.length === 0) this.doings.delete(typist);
      else this.doings.set(typist, left);
      this.sayTyping(bot, threadId);
    }
  }

  /** Tells the room whether `bot` is typing in thread `threadId`, or in the room, and what it's doing meanwhile, if it's more than writing. */
  private sayTyping(bot: User, threadId: string | undefined): void {
    const typist = typistOf(bot, threadId);
    const typing = this.typists.has(typist);
    const doing = typing ? this.doings.get(typist)?.at(-1) : undefined;
    this.broadcast({ type: "typing", user: bot, typing, ...(threadId !== undefined && { threadId }), ...(doing !== undefined && { doing }) });
  }

  /**
   * Sends new messages' pushes, or those of an invitation into the huddle, as the Workspace still allows
   * each when its turn comes, and has it forget the subscriptions they found gone: the first
   * `PUSHES_PER_INVOCATION` itself, and the rest through the Workspace, as many a call, so that a message
   * that notifies a big room reaches everyone in it.
   */
  private async push(pushes: Array<MessagePush | InvitationPush>): Promise<void> {
    const [own = [], ...handed] = pushesInChunks(pushes, PUSHES_PER_INVOCATION);
    await Promise.all([this.sendOwnPushes(own), eachAtMost(handed, PUSH_CALLS_AT_ONCE, (chunk) => this.handPushes(chunk))]);
  }

  /** Sends `pushes` from the room, as `push` does those it sends itself. */
  private async sendOwnPushes(pushes: Array<MessagePush | InvitationPush>): Promise<void> {
    const gone = await sendPushes(this.env, pushes, (id) => workspace(this.env).pushable(id));
    if (gone.length === 0) return;
    await workspace(this.env)
      .forgetPushSubscriptions(gone)
      .catch((error: unknown) => console.error(`Error in WebPush::Pool.invalid_subscription_handler: ${error}`));
  }

  /** Has the Workspace send `pushes`, which the room has no requests left for, logging why when it can't. */
  private async handPushes(pushes: Array<MessagePush | InvitationPush>): Promise<void> {
    await workspace(this.env)
      .sendRoomPushes(pushes)
      .catch((error: unknown) => console.error("Could not have the Workspace send a room's pushes", error));
  }

  /**
   * Sends the search index the messages written, edited, boosted or deleted longest ago that it hasn't
   * taken, as many as one call takes, as they are now, and forgets them once it has. Answers how many it
   * sent.
   */
  private async sendMessages(roomId: RoomId): Promise<number> {
    const log = this.logFor(roomId);
    const logged = await log.unindexed(ENTRIES_PER_CALL);
    if (logged.length === 0) return 0;
    // Read after the log, so each is as new as the change that logged it, or newer.
    const ids = [...new Set(logged.map(({ messageId }) => messageId))];
    const messages = await this.storeFor(roomId).indexable(ids);
    const kept = new Set(messages.map(({ id }) => id));
    const seq = logged.at(-1)!.seq;
    await searchIndex(this.env).apply(roomId, seq, messages, ids.filter((id) => !kept.has(id)));
    await log.indexed(seq);
    return logged.length;
  }

  /**
   * Sends the Workspace the huddles' messages changed longest ago that its list of the huddles that are
   * over hasn't taken, as many as one call takes, each once, as it is now, and forgets them once it has.
   * Answers how many it read.
   */
  private async sendHuddles(roomId: RoomId): Promise<number> {
    const log = this.logFor(roomId);
    const logged = await log.changedHuddles(ENTRIES_PER_CALL);
    if (logged.length === 0) return 0;
    const changes = new Map(logged.map(({ change }) => [change.messageId, change]));
    await workspace(this.env).applyHuddleChanges(roomId, [...changes.values()]);
    await log.huddlesListed(logged.at(-1)!.seq);
    return logged.length;
  }

  /**
   * Has R2 delete the files the room has marked deleted, as many as one call takes, with their previews,
   * then forgets them, and answers how many. Uploads still unfinished a day after they started are
   * marked first, and their uploads in parts aborted. Without a bucket, the room only forgets them.
   */
  private async purgeFiles(roomId: RoomId): Promise<number> {
    const blobs = this.blobsFor(roomId);
    const deleted = await this.serially(async () => {
      const now = Date.now();
      await blobs.deleteUnfinished(new Date(now - UNFINISHED_UPLOAD_KEPT_MS).toISOString(), new Date(now).toISOString());
      return blobs.deleted(ENTRIES_PER_CALL);
    });
    if (deleted.length === 0) return 0;
    const files = this.env.FILES;
    if (files) {
      // An abort that fails, as one of an upload R2 has put together or forgotten does, is left to R2,
      // which aborts an unfinished upload a week after it started.
      const aborting = deleted.map(({ id, unfinishedUploadId }) => unfinishedUploadId && files.resumeMultipartUpload(objectKey(id), unfinishedUploadId).abort().catch(() => {}));
      await Promise.all(aborting);
      await files.delete(deleted.flatMap(({ id }) => [objectKey(id), previewKey(id)]));
    }
    await this.serially(() => blobs.forget(deleted.map(({ id }) => id)));
    return deleted.length;
  }

  /**
   * Sets the alarm to send the room's logs at `time`, unless it's set for sooner, and answers whether it
   * did. A deleted room's alarm is for erasing it, so it's left as it is; this runs one event at a time
   * with deleting it, so the deletion's alarm can't be overtaken.
   */
  private wakeAt(roomId: RoomId, time: number): Promise<boolean> {
    return this.serially(() => this.wakeInTurnAt(roomId, time));
  }

  /** `wakeAt`, from the turn the room is taking. */
  private async wakeInTurnAt(roomId: RoomId, time: number): Promise<boolean> {
    if (await this.isDeleted()) return false;
    await this.ctx.storage.put(UNDELIVERED_ROOM, roomId);
    const due = await this.ctx.storage.get<number>(LOGS_DUE);
    if (due === undefined || due > time) await this.ctx.storage.put(LOGS_DUE, time);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > time) await this.ctx.storage.setAlarm(time);
    return true;
  }

  /**
   * Sets the alarm to check the room's huddle by `time`, unless it's set for sooner. A deleted room's
   * alarm is left as it is, as `wakeAt` leaves it, unless the SFU has tracks of its huddle to close
   * still: the alarm then comes sooner, to ask it again, and when it was to erase the room is kept.
   * Like `wakeAt`, this runs one event at a time with deleting the room.
   */
  private async checkHuddleBy(time: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm !== null && alarm <= time) return;
    if (await this.isDeleted()) {
      if (!(await this.huddle.hasUnclosed())) return;
      if (alarm !== null && (await this.ctx.storage.get(ERASE_DUE)) === undefined) await this.ctx.storage.put(ERASE_DUE, alarm);
    }
    await this.ctx.storage.setAlarm(time);
  }

  /**
   * Brings the room's message of its huddle in step with `huddle`, the huddle as it is, or null with
   * nobody in one, telling everyone in the room of what that writes, and sending the search index its
   * log and the Workspace the huddles': the message as a huddle starts, and what it says once the
   * huddle is over. The huddle has this done whenever who's in it changes, with the huddle as that left
   * it, since someone can have left again by the time the room gets to it, and the alarm with each
   * check of the huddle. The message of a huddle that nobody joined is deleted instead, once the huddle
   * is over, as the room deletes any. Answers whether it could: the alarm comes back when not. A room
   * deleted by then has forgotten the message of its last huddle, and gets no other.
   */
  private async keepHuddleMessage(huddle: HuddleNow | null): Promise<boolean> {
    try {
      if (await this.isDeleted()) return true;
      const roomId = huddle?.roomId ?? (await this.huddleMessage.roomId());
      // No huddle here has had a message.
      if (roomId === undefined) return true;
      const [store, couriers] = [this.storeFor(roomId), this.couriersFor(roomId)];
      const tell = (frames: HuddleMessageFrame[]) => {
        for (const frame of frames) this.broadcast(frame);
        if (frames.length === 0) return;
        couriers.index.deliver();
        couriers.huddles.deliver();
      };
      await this.huddleMessage.keepUp(store, huddle, tell, (message) => this.deleteMessage(store, message));
      return true;
    } catch (error) {
      console.error("Keeping the message of the room's huddle failed:", error instanceof Error ? error.name : "unknown error");
      return false;
    }
  }

  /**
   * Whether the Workspace has deleted the room, which a request it let through just before can still
   * find, as can a delivery to a bot's webhook still waiting its turn once the alarm has erased the room.
   */
  private async isDeleted(): Promise<boolean> {
    return this.erased || (await this.ctx.storage.get(DELETED_ROOM)) !== undefined;
  }

  /**
   * The room's own sockets, all of them or those carrying `tag`: every socket but the huddle's, whose
   * people hear of the huddle alone, and aren't in the room for being in it.
   */
  private roomSockets(tag?: string): WebSocket[] {
    const sockets = tag === undefined ? this.ctx.getWebSockets() : this.ctx.getWebSockets(tag);
    const inHuddle = this.ctx.getWebSockets(HUDDLE_TAG);
    if (inHuddle.length === 0) return sockets;
    const huddle = new Set(inHuddle);
    return sockets.filter((socket) => !huddle.has(socket));
  }

  /**
   * Everyone with at least one open socket that has them in the room, once each. A socket that shows a
   * thread apart from the room's timeline doesn't, any more than the huddle's does whose thread it is.
   */
  private present(): User[] {
    const users = new Map<string, User>();
    for (const socket of this.roomSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const { user, apart } = socket.deserializeAttachment() as Attachment;
      if (!apart) users.set(user.id, user);
    }
    return [...users.values()];
  }

  /** Whether someone has the room open in a socket other than `except`, and not just a thread apart from its timeline. */
  private isPresent(userId: UserId, except?: WebSocket): boolean {
    return this.roomSockets(userId).some((socket) => socket !== except && socket.readyState === WebSocket.OPEN && !(socket.deserializeAttachment() as Attachment).apart);
  }

  /** Closes `socket` with `code` for a revocation, if it's open, and answers whose it was, if it had them in the room. */
  private close(socket: WebSocket, code: CloseCode): User | null {
    if (socket.readyState !== WebSocket.OPEN) return null;
    const attachment = socket.deserializeAttachment() as Attachment;
    socket.serializeAttachment({ ...attachment, revoked: true } satisfies Attachment);
    socket.close(code, CLOSE_REASONS[code]);
    return attachment.apart ? null : attachment.user;
  }

  /**
   * Lets everyone know a socket has closed, unless the room closed it for a revocation and said so
   * already, or it never had its person in the room, showing a thread apart from the room's timeline.
   */
  private leave(ws: WebSocket): void {
    const { user, revoked, typing, apart } = ws.deserializeAttachment() as Attachment;
    if (!revoked && !apart) this.depart(user, ws, typing === true);
  }

  /**
   * Tells the room that `user` closed a socket, `closed` if it's just the one, and has left if it was
   * their last. Closing one of several tabs stops the typing it was doing, if it was: telling everyone
   * whenever any tab closes was a message to everyone in a busy room for each room someone switched
   * away from, and cleared the typing another of their tabs was doing.
   */
  private depart(user: User, closed?: WebSocket, typing = true): void {
    if (!this.isPresent(user.id, closed)) this.broadcast({ type: "presence.left", userId: user.id }, closed);
    else if (typing) this.broadcast({ type: "typing", user, typing: false }, closed);
  }

  private refuse(ws: WebSocket, message: string): void {
    this.send(ws, { type: "error", message });
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // The socket closed between lookup and send; its close handler cleans up.
    }
  }

  private broadcast(frame: ServerFrame, except?: WebSocket): void {
    const data = JSON.stringify(frame);
    for (const socket of this.roomSockets()) {
      if (socket === except) continue;
      try {
        socket.send(data);
      } catch {
        // As above.
      }
    }
  }
}
