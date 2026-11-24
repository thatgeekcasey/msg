import { hasWords, HISTORY_PAGE_SIZE, MAX_SEARCH_LENGTH, MAX_USER_NAME_LENGTH, searchWords, type Message, type RoomId, type TimelinePage, type User, type UserId } from "@ember/protocol";
import { MAX_CONVERSATION_LENGTH } from "@ember/protocol/assistant";
import type { Env } from "../env";
import { searchIndex } from "../search-index";
import { matchesOf } from "../searches";
import type { PageCursor } from "../store";
import { workspace } from "../workspace";
import { NAMESAKES } from "../workspace-store";
import { ToolError, type EmberTool, type Unlogged } from "./tool-calls";

// The tools Ember runs for @ember and the agents that read the room they're asked in past the messages
// they're given with a question: a search of it, for words or for what someone wrote, and pages of its
// messages and of its threads, read back from the question or from a message they name. They read only
// that room, which everyone who sees the answer can read, as someone in it reads it, and an answer's calls
// of them read at most `MAX_ROOM_READ_LENGTH` of it between them. What they read once the room is a DM or
// a private room, as it may be made while the answer works, is kept out of AI Gateway's logs, with the
// rest of the answer.

/** The most messages a search answers with, the newest that match. */
export const MESSAGES_FOUND = 10;

/** The most characters of a message a search answers with, about a long paragraph. */
export const MAX_FOUND_LENGTH = 600;

/** The most characters of a message a page of the room or of a thread answers with, about a page of a book. */
export const MAX_READ_LENGTH = 2_000;

/**
 * The most characters of the room's messages an answer's calls of the tools answer with between them:
 * twice what it's given with its question, about 20,000 tokens, as each turn of its model after a call is
 * sent everything before it again.
 */
export const MAX_ROOM_READ_LENGTH = 2 * MAX_CONVERSATION_LENGTH;

/** What a call is told once its answer has read as much of the room as it may. */
export const READ_ENOUGH = "Not read: this answer has read as much of the room as it may. Answer with what you have.";

const NO_MESSAGE = "The room has no message with that id.";

/** What reads the room for the tools, as it reads itself for its bots and AI apps, in its turn. */
export interface RoomReader {
  /** The page of the room's messages `cursor` names, oldest first, or null when the room has no message it names. */
  page(cursor: PageCursor): Promise<Omit<TimelinePage, "around"> | null>;
  find(id: string): Promise<Message | null>;
  /** The newest replies in the thread under the message `parentId`, or those before the reply `before`, oldest first, with whether it has older ones. */
  replies(parentId: string, before?: string): Promise<{ messages: Message[]; hasMore: boolean }>;
}

/**
 * What an answer's calls of the tools have read of the room, which they share: how many more characters
 * of its messages they may answer with, and who wrote those they did, by the names those messages give
 * them, which they may have changed since.
 */
export interface RoomRead {
  left: number;
  writers: User[];
}

/** What an answer's calls have read of the room before the first: nothing, with all they may read left. */
export const nothingRead = (): RoomRead => ({ left: MAX_ROOM_READ_LENGTH, writers: [] });

/** What the tools read for: the room an answer is asked in, who asked, as whom they search it, the question, what the answer was given with it, and what its calls have read. */
export interface RoomReading {
  env: Env;
  roomId: RoomId;
  askerId: UserId;
  question: Message;
  /** The messages the answer was given with the question, as its model has them. */
  given: readonly Message[];
  reader: RoomReader;
  read: RoomRead;
}

/** One of the tools, with what the room's typing line says the answerer is doing, after its name, while a call of it runs. */
export interface RoomTool {
  tool: EmberTool;
  doing: string;
}

const SEARCH = {
  name: "search_messages",
  description: [
    "Searches the messages of the room you're asked in, its threads too, and answers the newest that have every word you give, or that someone wrote, or both, leaving out the messages of the conversation you were given.",
    "Each comes with when it was written, its id, which read_room and read_thread take, who wrote it and what it says.",
    "Use it when the answer depends on something written in the room outside that conversation, such as what was decided, what someone asked for, or a link or a number someone shared.",
    "It finds whole words as they were written, not meanings, so give one or two words the message would have, and search again with other words when nothing is found.",
  ].join(" "),
  takes: {
    type: "object",
    properties: {
      words: { type: "string", description: "The words to find: a message matches when it has them all, in any order." },
      from: { type: "string", description: "The name of whoever wrote the messages to find, as the conversation names them." },
    },
    additionalProperties: false,
  },
};

const READ_ROOM = {
  name: "read_room",
  description: [
    `Reads the messages of the room you're asked in, oldest first: the ${HISTORY_PAGE_SIZE} before the message you're asked, or before the thread you're asked in, which take in those of the conversation you were given, or the ${HISTORY_PAGE_SIZE} before or after a message you name.`,
    "Each comes with when it was written, its id, how many replies its thread has, if it has one, who wrote it and what it says, and the answer ends with how to read on.",
    "Use it when the answer depends on more of what led up to the question than you were given, or on what was said around a message the search found.",
  ].join(" "),
  takes: {
    type: "object",
    properties: {
      before: { type: "string", description: "A message's id, to read the messages before it, such as the first that read_room answered, to read further back." },
      after: { type: "string", description: "A message's id, to read the messages after it." },
    },
    additionalProperties: false,
  },
};

const READ_THREAD = {
  name: "read_thread",
  description: [
    `Reads a thread in the room you're asked in: the message it's under, then its newest ${HISTORY_PAGE_SIZE} replies, oldest first, each as read_room gives it, or the ${HISTORY_PAGE_SIZE} replies before a reply you name.`,
    "Use it for what was said in reply to a message, which the room's messages leave out.",
  ].join(" "),
  takes: {
    type: "object",
    properties: {
      message_id: { type: "string", description: "The id of the message the thread is under, or of a reply in it. Leave it out for the thread you're asked in." },
      before: { type: "string", description: "A reply's id, to read the replies before it, such as the first reply that read_thread answered." },
    },
    additionalProperties: false,
  },
};

/** The tools that read the room for an answer, as `reading` says. */
export function roomTools(reading: RoomReading): RoomTool[] {
  const given = new Set(reading.given.map(({ id }) => id));
  return [
    { tool: { ...SEARCH, run: (input) => searched(reading, given, input) }, doing: "is searching this room" },
    { tool: { ...READ_ROOM, run: (input) => readRoom(reading, input) }, doing: "is reading this room" },
    { tool: { ...READ_THREAD, run: (input) => readThread(reading, input) }, doing: "is reading a thread" },
  ];
}

/**
 * What a search of the room answers: its newest messages with every word of `words`, if it's given, that
 * whoever `from` names wrote, if that's given (`writersNamed`), but those `given` with the question, or
 * that there are none. A page of the search holds more matches than a question's conversation has
 * messages, so what's left of a full one is enough to answer with, and of the few people a name may mean,
 * each one's page is.
 */
async function searched(reading: RoomReading, given: ReadonlySet<string>, { words, from }: Record<string, unknown>): Promise<string | Unlogged> {
  const { env, roomId, askerId, read } = reading;
  if (words !== undefined && typeof words !== "string") throw new ToolError("Give the words to find as `words`, a string.");
  if (typeof words === "string" && words.length > MAX_SEARCH_LENGTH) throw new ToolError("That's too much to search for. Give one or two words.");
  if (from !== undefined && (typeof from !== "string" || from.trim() === "" || from.length > MAX_USER_NAME_LENGTH)) throw new ToolError("Give `from` as the name of whoever wrote the messages, as the conversation names them.");
  const wanted = typeof words === "string" && hasWords(words) ? searchWords(words) : [];
  const writer = typeof from === "string" ? from.trim() : undefined;
  if (wanted.length === 0 && writer === undefined) throw new ToolError("Give the words to find, as `words`, or the name of whoever wrote the messages, as `from`.");
  const writers = writer === undefined ? [undefined] : await writersNamed(reading, writer);
  const pages = await Promise.all(
    writers.map((creatorId) => searchIndex(env).search({ words: wanted, roomIds: [roomId], searcherId: askerId, ...(creatorId !== undefined && { creatorId }), sort: "newest", after: null })),
  );
  // The index numbers its matches in the order they were written, so each writer's are put in order together.
  const hits = pages.flatMap(({ hits }) => hits).sort((one, other) => other.number - one.number);
  // Every other match is read before the newest are taken, as one the room no longer has is left out.
  const ungiven = hits.filter(({ messageId }) => !given.has(messageId));
  const others = await matchesOf(env, ungiven);
  const lines = taken(
    read,
    others.slice(0, MESSAGES_FOUND).map(({ message }) => message),
    (message) => lineOf(message, MAX_FOUND_LENGTH),
  );
  const none = writer === undefined ? "No message in this room has those words" : wanted.length === 0 ? `No message in this room is from anyone named ${writer}` : `No message in this room from anyone named ${writer} has those words`;
  if (lines.length === 0) return ungiven.length === hits.length ? `${none}.` : `${none}, but for those of the conversation you were given.`;
  const what = writer === undefined ? "with those words" : wanted.length === 0 ? `from ${writer}` : `from ${writer} with those words`;
  const more = pages.some(({ next }) => next !== null) || others.length > lines.length;
  const count = more ? `The newest ${lines.length} messages ${what}, of more` : lines.length === 1 ? `The only message ${what}` : `All ${lines.length} messages ${what}, newest first`;
  return readFrom(env, roomId, [`${count}:`, ...lines].join("\n\n"));
}

/**
 * Who `name` may mean, a few at most: whoever wrote what the answer was given or its calls have read under
 * that name, which they may have changed since, then whoever has it now, with ASCII letters in either case
 * alike, as `peopleNamed` finds them.
 */
async function writersNamed({ env, given, read }: RoomReading, name: string): Promise<UserId[]> {
  const sought = folded(name);
  const wrote = [...given.map(({ creator }) => creator), ...read.writers].filter((writer) => folded(writer.name) === sought);
  const named = await workspace(env).peopleNamed(name);
  return [...new Set([...wrote.map(({ id }) => id), ...named])].slice(0, NAMESAKES);
}

/** `name` with its ASCII capitals made small, as SQLite's NOCASE compares names. */
const folded = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * A page of the room's messages, oldest first: those before the message `before` names, or after the one
 * `after` names, or else before the question, or before the thread it's in, which takes in what the answer
 * was given with it, so that the model learns their ids and threads. It's as much of the page as the
 * answer has left to read, nearest where it starts, with where to read on.
 */
async function readRoom({ env, roomId, question, reader, read }: RoomReading, { before, after }: Record<string, unknown>): Promise<string | Unlogged> {
  if (before !== undefined && typeof before !== "string") throw new ToolError("Give `before` as a message's id.");
  if (after !== undefined && typeof after !== "string") throw new ToolError("Give `after` as a message's id.");
  if (before !== undefined && after !== undefined) throw new ToolError("Give `before` or `after`, not both.");
  const page = await reader.page(after !== undefined ? { after } : { before: before ?? question.parentId ?? question.id });
  if (!page) throw new ToolError(before === undefined && after === undefined ? "The message you're asked is gone from the room." : NO_MESSAGE);
  const { messages } = page;
  const lineIn = (message: Message) => lineOf(message, MAX_READ_LENGTH);
  if (after !== undefined) {
    if (messages.length === 0) return `The room has no messages after message ${after}.`;
    const lines = taken(read, messages, lineIn);
    const last = messages[lines.length - 1]!;
    const on = page.hasNewer || lines.length < messages.length ? `To read on, call read_room with \`after\` set to ${last.id}.` : "That's the room's newest message.";
    return readFrom(env, roomId, [`The room's ${counted(lines.length)} after message ${after}, oldest first:`, ...lines, on].join("\n\n"));
  }
  const from = before === undefined ? (question.parentId === undefined ? "the message you're asked" : "the thread you're asked in") : `message ${before}`;
  if (messages.length === 0) return `The room has no messages before ${from}.`;
  const lines = taken(read, messages.toReversed(), lineIn).reverse();
  const first = messages[messages.length - lines.length]!;
  const back = page.hasMore || lines.length < messages.length ? `To read further back, call read_room with \`before\` set to ${first.id}.` : "That's the start of the room.";
  return readFrom(env, roomId, [`The room's ${counted(lines.length)} before ${from}, oldest first:`, ...lines, back].join("\n\n"));
}

/**
 * A thread: the message it's under, then its newest replies, oldest first, or else the replies before the
 * reply `before` names, of the thread under the message `message_id` names, or that it's a reply in, or
 * else the thread the question is in. It's as much of the thread as the answer has left to read, the
 * message it's under first, then the replies nearest where it starts, with where to read on.
 */
async function readThread({ env, roomId, question, reader, read }: RoomReading, { message_id: messageId, before }: Record<string, unknown>): Promise<string | Unlogged> {
  if (messageId !== undefined && typeof messageId !== "string") throw new ToolError("Give `message_id` as a message's id.");
  if (before !== undefined && typeof before !== "string") throw new ToolError("Give `before` as a reply's id.");
  const id = messageId ?? question.parentId;
  if (id === undefined) throw new ToolError("You weren't asked in a thread, so give the id of the message whose thread to read, as `message_id`.");
  const message = await reader.find(id);
  const parent = message?.parentId === undefined ? message : await reader.find(message.parentId);
  if (!parent) throw new ToolError(NO_MESSAGE);
  if (before !== undefined && (await reader.find(before))?.parentId !== parent.id) throw new ToolError(`The thread under message ${parent.id} has no reply with the id given as \`before\`.`);
  const { messages: replies, hasMore } = await reader.replies(parent.id, before);
  // The replies leave out the thread they're in, which the answer names, and the message it's under is in none.
  const lineIn = (message: Message) => lineOf(message, MAX_READ_LENGTH, parent.id);
  if (before !== undefined) {
    if (replies.length === 0) return `The thread under message ${parent.id} has no replies before reply ${before}.`;
    const lines = taken(read, replies.toReversed(), lineIn).reverse();
    const older = hasMore || lines.length < replies.length ? [olderIn(parent, replies[replies.length - lines.length]!)] : [];
    return readFrom(env, roomId, [`The ${lines.length === 1 ? "reply" : `${lines.length} replies`} before reply ${before} in the thread under message ${parent.id}, oldest first:`, ...lines, ...older].join("\n\n"));
  }
  if (replies.length === 0) return readFrom(env, roomId, [`Message ${parent.id} has no replies:`, ...taken(read, [parent], lineIn)].join("\n\n"));
  // The message it's under comes first, then as many of the newest replies as fit, but never it alone.
  const [head, ...newest] = taken(read, [parent, ...replies.toReversed()], lineIn, 2);
  const shown = newest.reverse();
  const cut = hasMore || shown.length < replies.length;
  const which = cut ? `its newest ${shown.length === 1 ? "reply" : `${shown.length} replies`}` : shown.length === 1 ? "its only reply" : `all ${shown.length} of its replies`;
  const older = cut ? [olderIn(parent, replies[replies.length - shown.length]!)] : [];
  return readFrom(env, roomId, [`The thread under message ${parent.id}: the message, then ${which}, oldest first:`, head!, ...shown, ...older].join("\n\n"));
}

/** How a page of the thread under `parent` that starts with `first` tells the model to read the replies before it. */
const olderIn = (parent: Message, first: Message) => `To read older replies, call read_thread with \`message_id\` set to ${parent.id} and \`before\` set to ${first.id}.`;

/** `count` messages, in words. */
const counted = (count: number) => (count === 1 ? "1 message" : `${count} messages`);

/**
 * The lines, by `lineIn`, of as many of `messages` as fit in what the answer's calls have left to read, in
 * order, which they then take of it, as their writers join those `read` has, or, when fewer than `least`
 * of them fit, none, telling the model it has read enough.
 */
function taken(read: RoomRead, messages: readonly Message[], lineIn: (message: Message) => string, least = 1): string[] {
  let left = read.left;
  const lines: string[] = [];
  for (const message of messages) {
    const line = lineIn(message);
    if (line.length > left) break;
    left -= line.length;
    lines.push(line);
  }
  if (lines.length < Math.min(least, messages.length)) throw new ToolError(READ_ENOUGH);
  read.left = left;
  for (const { creator } of messages.slice(0, lines.length)) {
    if (!read.writers.some(({ id, name }) => id === creator.id && name === creator.name)) read.writers.push({ id: creator.id, name: creator.name });
  }
  return lines;
}

/** What a tool answers with `text`, read from room `roomId`: unlogged once the room's private, as it may have been made since the answer began in the open. */
async function readFrom(env: Env, roomId: RoomId, text: string): Promise<string | Unlogged> {
  return (await workspace(env).isPrivateRoom(roomId)) ? { text, unlogged: true } : text;
}

/**
 * A message as the tools answer with it, on a line: when it was written, in UTC, its id, which they take,
 * the thread it's a reply in, unless it's the thread `shown`, how many replies its own thread has, who
 * wrote it, and its text, or its file's name, cut to `longest` characters, or that it was deleted, as one
 * with replies keeps its place for them.
 */
function lineOf(message: Message, longest: number, shown?: string): string {
  const { id, createdAt, creator, plainText, attachment, parentId, thread, deleted } = message;
  const facts = [`${createdAt.slice(0, 10)} ${createdAt.slice(11, 16)} UTC`, `id ${id}`];
  if (parentId !== undefined && parentId !== shown) facts.push(`a reply in the thread under ${parentId}`);
  if (thread) facts.push(thread.count === 1 ? "1 reply in its thread" : `${thread.count} replies in its thread`);
  if (deleted) return `[${facts.join(", ")}] (This message was deleted.)`;
  const text = attachment ? `(shares a file, ${plainText})` : plainText.trim();
  return `[${facts.join(", ")}] ${creator.name}: ${text.length > longest ? `${text.slice(0, longest - 1).trimEnd()}…` : text}`;
}
