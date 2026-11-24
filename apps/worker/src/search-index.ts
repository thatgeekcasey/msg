import { SEARCH_LIMIT, type RoomId, type SearchSort, type UserId } from "@ember/protocol";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { migrate } from "./migrations";
import { keyedText, matchOf, plainText, unkeyed, type Readers, type RoomReaders } from "./search-words";
import { workspace } from "./workspace";

// The search index (search-migrations/): every message's plain text in one FTS5 table, an open room's as
// it is and the rest's words under keys (search-words.ts), what search results show of it and what
// search filters narrow a search by, which rooms keep up to date from their logs of the messages written,
// edited and deleted, and of their boosts (room-log.ts).

/** What search filters narrow a search by, of a message (store.ts `searchFactsOf`). */
export interface SearchFacts {
  creatorId: UserId;
  /** The id of the message whose thread it's in, its own for a message with replies, or null for one in none. */
  threadId: string | null;
  hasLink: boolean;
  hasFile: boolean;
  /** Everyone it mentions, once each. */
  mentionIds: UserId[];
}

/**
 * What the index keeps of a message: when it was written, which orders the index, its plain text, what
 * search results show of it, and what search filters narrow a search by.
 */
export interface IndexedMessage extends SearchFacts {
  id: string;
  createdAt: string;
  text: string;
  /** The message's row as its room keeps it, boosts and all, as JSON, or null for one too big to keep (store.ts `indexable`). */
  message: string | null;
}

/** What a search asks the index for: messages with its words that meet its filters, a page at a time. */
export interface IndexSearch {
  /** Its words (`searchWords`), every one of which a message has to have, or none for a search of filters alone. */
  words: string[];
  /** The rooms whose messages it can find. */
  roomIds: RoomId[];
  /** Whose search it is: someone in its rooms, whose key finds their DMs' words. */
  searcherId: UserId;
  /** Only messages this person wrote. */
  creatorId?: UserId;
  /** Only messages that include this person: that mention them, are in the rooms `directIds` lists, their DMs, or are in threads they've written in. */
  includes?: { userId: UserId; directIds: RoomId[] };
  hasLink?: boolean;
  hasFile?: boolean;
  inThread?: boolean;
  sort: SearchSort;
  /** Only the matches past this one's number, in the order sorted, for the page after the one it ends. */
  after: number | null;
}

/**
 * A message that has every word searched for and meets its filters, in a room, with what search results
 * show of it as the index last took it, or null when the index took it before it kept that, or it was too
 * big to keep, and the words it matched, as its text has them.
 */
export interface SearchHit {
  number: number;
  messageId: string;
  roomId: RoomId;
  message: string | null;
  words: string[];
}

/** A page of hits, and the number of the last when there are more after it. */
export interface SearchPage {
  hits: SearchHit[];
  next: number | null;
}

/** How many messages of a millisecond the index can number apart (search-migrations/0001_search_index.sql). */
const PER_MILLISECOND = 1024;

/** What a deleted room's place in its log becomes, past any call it made before. */
const FORGOTTEN = Number.MAX_SAFE_INTEGER;

/**
 * How long ago the messages the index keeps under their room's keys as soon as it hears who can read the
 * room can be from, and how many of them it takes at most: it keeps earlier ones under them a few at a
 * time (`REKEYED_PER_RUN`).
 */
const REKEYED_AT_ONCE_MS = 60 * 60 * 1000;
const MOST_REKEYED_AT_ONCE = 200;

/**
 * How many messages taken before their rooms' words were kept under keys the index keeps under them a
 * run, and how long it waits between runs: 3,000 a day, each writing about three rows, half what taking
 * a new message writes, so about a tenth of the 100,000 rows Workers Free lets a day write, which running
 * out of stops Ember until midnight UTC.
 */
const REKEYED_PER_RUN = 125;
const REKEY_RUNS_EVERY_MS = 60 * 60 * 1000;

/**
 * How many of the rooms the index holds messages of but hasn't heard about, as those it held before this
 * release, the walk asks about a run, and how many of the run's messages hearing about one takes: it
 * writes about nine rows, as keeping three messages under keys does.
 */
const ROOMS_HEARD_PER_RUN = 40;
const REKEYS_A_ROOM_HEARD = 3;

/** Where the index keeps when the walk's next run is due, in milliseconds since the epoch, while it has one. */
const REKEY_DUE = "rekeyDue";

/** How many rooms that send it messages it asks the Workspace about a call, how many calls it makes before it leaves the rest to its alarm, and how long it waits when one fails. */
const ROOMS_PER_ASK = 100;
const ASKS_PER_RUN = 10;
const ASK_AGAIN_MS = 60 * 1000;

/** A room the index holds messages of but hasn't heard about, and its place in its log, `FORGOTTEN` once it's deleted. */
type UnheardRoom = { room_id: RoomId; seq: number };

/** A statement's SQL and the values it binds, in order. */
export interface SearchStatement {
  sql: string;
  values: SqlStorageValue[];
}

/** A condition on a message, `search_messages`, with the values it binds, in order. */
type Condition = [sql: string, ...values: SqlStorageValue[]];

/**
 * A message that includes someone, ?1, ?2 and ?3 by turns: it mentions them, it's in a room the JSON
 * array ?2 lists, or it's in a thread they've written in.
 */
const INCLUDES = `(EXISTS (SELECT 1 FROM search_mentions WHERE search_mentions.id = search_messages.id AND search_mentions.user_id = ?)
    OR search_messages.room_id IN (SELECT value FROM json_each(?))
    OR EXISTS (SELECT 1 FROM search_messages AS theirs WHERE theirs.thread_id = search_messages.thread_id AND theirs.creator_id = ?))`;

/** What a search's filters say a message it finds is like: each condition, one a filter, so no statement has to skip one it doesn't have. */
function filtersOf({ creatorId, includes, hasLink, hasFile, inThread }: IndexSearch): Condition[] {
  const conditions: Condition[] = [];
  if (creatorId !== undefined) conditions.push(["search_messages.creator_id = ?", creatorId]);
  if (includes !== undefined) conditions.push([INCLUDES, includes.userId, JSON.stringify(includes.directIds), includes.userId]);
  if (hasLink) conditions.push(["search_messages.has_link = 1"]);
  if (hasFile) conditions.push(["search_messages.has_file = 1"]);
  if (inThread) conditions.push(["search_messages.thread_id IS NOT NULL"]);
  return conditions;
}

/** `conditions` as one, which a message meets when it meets them all, with the values they bind, in order. */
const allOf = (conditions: Condition[]) => ({ met: conditions.map(([sql]) => sql).join(" AND "), values: conditions.flatMap(([, ...values]) => values) });

/**
 * The index a search of filters alone reads a room's messages by, in the order of their numbers, and the
 * filter whose messages are all it holds, if it has one: someone's messages in the room, or the room's
 * with files, with links or in threads (search migration 0004), for the first of those filters the search
 * has, or else all the room's (0001). Each starts with the room, so reading one room's messages by it
 * reads none of another's, as an index of someone's messages in every room would.
 */
function walkOf({ creatorId, hasLink, hasFile, inThread }: IndexSearch): { index: string; holds: Condition[] } {
  if (creatorId !== undefined) return { index: "index_search_messages_on_room_id_and_creator_id_and_id", holds: [["search_messages.creator_id = ?", creatorId]] };
  if (hasFile) return { index: "index_search_messages_with_files_on_room_id_and_id", holds: [["search_messages.has_file = 1"]] };
  if (hasLink) return { index: "index_search_messages_with_links_on_room_id_and_id", holds: [["search_messages.has_link = 1"]] };
  if (inThread) return { index: "index_search_messages_in_threads_on_room_id_and_id", holds: [["search_messages.thread_id IS NOT NULL"]] };
  return { index: "index_search_messages_on_room_id_and_id", holds: [] };
}

const ORDERS = { newest: { direction: "DESC", past: "<" }, oldest: { direction: "ASC", past: ">" } } as const;

/** A message a search finds, before what results show of it is read. */
const FOUND = `search_messages.id AS number, search_messages.message_id AS messageId, search_messages.room_id AS roomId`;

/**
 * The statement a search runs to find a page of messages and one more, which says there's another page,
 * newest or oldest first, past the number it starts after, if any, finding its words plainly or under one
 * of `keys`. It's the one statement whatever the rooms it doesn't look in hold: were another to run when
 * their messages left the page short, the time a search took would tell the searcher what's written in
 * rooms they can't read. A search of filters alone reads nothing of those rooms, but one with words still
 * passes over their matches kept plainly, open rooms' and those it took before it heard who can read
 * their rooms and hasn't kept under keys yet (`hear`), so the time it takes grows with how many of those
 * have its words (`wordsStatement`).
 */
export function searchStatement(search: IndexSearch, keys: number[]): SearchStatement {
  const words = wordsSearched(search);
  return words.length === 0 ? filtersStatement(search) : wordsStatement(search, matchOf(words, keys));
}

/**
 * The words `search` has, split again at spaces and NULs, which a caller could leave in one: SQLite would
 * end a query at a NUL.
 */
const wordsSearched = ({ words }: IndexSearch) => words.flatMap((word) => word.split(/[\s\0]+/u)).filter((word) => word !== "");

/**
 * A search with words walks the messages that match `match`, its FTS5 query, in order, with nothing to
 * sort, and keeps the ones in its rooms that meet its filters. The words of open rooms are kept plainly,
 * in lists that don't tell rooms apart, so it passes over the matches in other rooms on its way, each a
 * row's read, as it does those in rooms whose words were kept plainly before they were kept under keys.
 */
function wordsStatement(search: IndexSearch, match: string): SearchStatement {
  const { met, values } = allOf([["search_messages.room_id IN (SELECT value FROM json_each(?))", JSON.stringify(search.roomIds)], ...filtersOf(search)]);
  const { direction, past } = ORDERS[search.sort];
  const startingAfter = search.after === null ? "" : ` AND search_index.rowid ${past} ?`;
  return {
    // A CROSS JOIN is read in the order written, so SQLite can't start from someone's messages instead, which it would have to sort.
    sql: `SELECT ${FOUND} FROM search_index CROSS JOIN search_messages ON search_messages.id = search_index.rowid
      WHERE ${met} AND search_index MATCH ?${startingAfter} ORDER BY search_index.rowid ${direction} LIMIT ${SEARCH_LIMIT + 1}`,
    values: [...values, match, ...(search.after === null ? [] : [search.after])],
  };
}

/**
 * A search of filters alone reads its rooms' messages in order and keeps the ones that meet its filters,
 * each room's through an index that starts with the room (`walkOf`). So it reads no message of a room it
 * doesn't look in, none of which has a say in how long it takes, and its own rooms' only as far as its
 * page goes, with nothing to sort. A recursive query puts the rooms' messages in one order: its queue,
 * ordered by number, starts with each room's first message, and whichever it takes, the next of that room
 * takes its place. Each is looked up on its own, since reading on through a room's messages would end on
 * the one after its last, another room's.
 */
function filtersStatement(search: IndexSearch): SearchStatement {
  const { direction, past } = ORDERS[search.sort];
  const { index, holds } = walkOf(search);
  /** The number of the first message the index holds that meets `conditions`, which say which room's and past which. */
  const firstOf = (...conditions: Condition[]) => {
    const { met, values } = allOf([...conditions, ...holds]);
    return { sql: `(SELECT search_messages.id FROM search_messages INDEXED BY ${index} WHERE ${met} ORDER BY search_messages.id ${direction} LIMIT 1)`, values };
  };
  const startingAfter: Condition[] = search.after === null ? [] : [[`search_messages.id ${past} ?`, search.after]];
  const first = firstOf(["search_messages.room_id = rooms.value"], ...startingAfter);
  const next = firstOf(["search_messages.room_id = walked.room_id"], [`search_messages.id ${past} walked.id`]);
  const filters = allOf(filtersOf(search));
  return {
    // A room with no message left has no number, which ends its walk. The CROSS JOIN keeps the walk's order.
    sql: `WITH RECURSIVE walked AS (
        SELECT ${first.sql} AS id, rooms.value AS room_id FROM json_each(?) AS rooms
        UNION ALL
        SELECT ${next.sql}, walked.room_id FROM walked WHERE walked.id IS NOT NULL
        ORDER BY id ${direction}
      )
      SELECT ${FOUND} FROM walked CROSS JOIN search_messages ON search_messages.id = walked.id${filters.met && ` WHERE ${filters.met}`}
      LIMIT ${SEARCH_LIMIT + 1}`,
    // Each room once, or its messages would be found as often as it's listed.
    values: [...first.values, JSON.stringify([...new Set(search.roomIds)]), ...next.values, ...filters.values],
  };
}

/**
 * What results show of each of the messages whose numbers the JSON array ?2 lists, with their text as the
 * index has it, each word that matches the FTS5 query ?1 between the control characters U+0001 and U+0002.
 */
const MARKED_PAGE = `SELECT search_index.rowid AS number, search_messages.message, highlight(search_index, 0, char(1), char(2)) AS marked
  FROM search_index JOIN search_messages ON search_messages.id = search_index.rowid
  WHERE search_index MATCH ?1 AND search_index.rowid IN (SELECT value FROM json_each(?2))`;

/** What results show of each of the messages whose numbers the JSON array ?1 lists, for a search of filters alone. */
const PAGE = `SELECT id AS number, message, NULL AS marked FROM search_messages WHERE id IN (SELECT value FROM json_each(?1))`;

/** The most words a hit says it matched. */
const MOST_WORDS = 20;

/** The marks `MARKED_PAGE` has each matching word between. */
const OPENING_MARK = "\u0001";
const CLOSING_MARK = "\u0002";

/**
 * What `marked` has between each opening mark and the first closing mark after it, where that's anything,
 * in order. A message's own text can have the marks too, as many as it likes, so each is looked for from
 * where the last was found, and an opening mark that nothing closes ends the walk: a regular expression
 * would read on to the end of the text from every opening mark after it as well.
 */
function* betweenMarks(marked: string): Generator<string> {
  let closing = -1;
  for (let opening = marked.indexOf(OPENING_MARK); opening !== -1; opening = marked.indexOf(OPENING_MARK, closing + 1)) {
    closing = marked.indexOf(CLOSING_MARK, opening + 1);
    if (closing === -1) return;
    if (closing > opening + 1) yield marked.slice(opening + 1, closing);
  }
}

/** The words `marked` has between marks, as its text has them, once each however they're cased. */
function wordsMarked(marked: string | null): string[] {
  const words = new Map<string, string>();
  for (const match of betweenMarks(marked ?? "")) {
    for (const word of unkeyed(match)) {
      if (words.size === MOST_WORDS) return [...words.values()];
      if (!words.has(word.toLowerCase())) words.set(word.toLowerCase(), word);
    }
  }
  return [...words.values()];
}

/**
 * The keys room ?1's messages keep their words under (search-migrations/0005_search_readers.sql): its own,
 * for its members, or those of the people it lists, in order. None for a room everyone can read.
 */
const KEYS_OF_ROOM = `SELECT search_keys.key FROM search_readers JOIN search_keys ON search_keys.room_id = search_readers.room_id
    WHERE search_readers.room_id = ?1 AND search_readers.people IS NULL
  UNION ALL
  SELECT search_keys.key FROM search_readers, json_each(search_readers.people) AS people JOIN search_keys ON search_keys.user_id = people.value
    WHERE search_readers.room_id = ?1
  ORDER BY 1`;

/**
 * The keys of the words a search in the rooms the JSON array ?1 lists can find, in order: each room's
 * that has one, whoever can read it now, as its words may still be kept under it, and searcher ?2's, when
 * one of the rooms keeps its words under its people's.
 */
const KEYS_FOR_SEARCH = `SELECT key FROM search_keys WHERE room_id IN (SELECT value FROM json_each(?1))
  UNION
  SELECT key FROM search_keys
    WHERE user_id = ?2 AND EXISTS (SELECT 1 FROM search_readers WHERE room_id IN (SELECT value FROM json_each(?1)) AND people IS NOT NULL)
  ORDER BY 1`;

/**
 * The largest number given yet to a message of each millisecond the JSON array ?1 lists as its first
 * number, if any has one.
 */
const LATEST_NUMBERS = `SELECT firsts.value AS first, (SELECT max(id) FROM search_messages WHERE id BETWEEN firsts.value AND firsts.value + ${PER_MILLISECOND - 1}) AS latest
  FROM json_each(?1) AS firsts`;

/**
 * Up to ?4 of room ?1's messages numbered below ?2 and from ?3 whose words the index keeps plainly,
 * newest first, with what it keeps of them.
 */
const PLAIN_MESSAGES = `SELECT search_messages.id AS number, search_index.body FROM search_messages JOIN search_index ON search_index.rowid = search_messages.id
  WHERE search_messages.room_id = ?1 AND search_messages.id < ?2 AND search_messages.id >= ?3 AND search_messages.keyed = 0
  ORDER BY search_messages.id DESC LIMIT ?4`;

/** The first number a message of the millisecond of `createdAt` can have. */
const firstNumber = (createdAt: string) => Date.parse(createdAt) * PER_MILLISECOND;

const byTime = (a: IndexedMessage, b: IndexedMessage) => firstNumber(a.createdAt) - firstNumber(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Searches every room's messages at once, so a search costs one query however many rooms someone is in.
 * It has an object of its own, as an FTS5 query over a large index can take milliseconds, which nothing
 * else should wait for, and its tables live in its own storage even when everyone else's are in D1
 * (`SEARCH_MIGRATIONS`). So it reads and writes them through the storage's own SQL, whose queries run at
 * once and whose results can be read a row at a time.
 */
export class SearchIndex extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** The rooms that have sent the index messages before it heard who can read them, which it asks about at once (`hearNow`). */
  private readonly sending = new Set<RoomId>();
  /** The Workspace being asked who can read rooms, while it is (`hearSending`, `hearSome`). */
  private asking: Promise<void> | null = null;
  /** When the index asks about the rooms that have sent it messages again, after a question about them failed, or 0. */
  private askAgainAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage, "search");
    this.sql = ctx.storage.sql;
    // A copy that updates, or comes back to this release, holds rooms it hasn't heard about, which its walk asks about.
    void ctx.blockConcurrencyWhile(async () => {
      if (this.unheard() && ctx.storage.kv.get(REKEY_DUE) === undefined) ctx.storage.kv.put(REKEY_DUE, Date.now());
      await this.wakeForNext();
    });
  }

  /**
   * Takes room `roomId`'s log up to its change `seq`: `messages`, as they are now, and the messages
   * `deletedIds` names, which are gone. A message keeps its number when it's edited. A call the room made
   * before one the index has taken, or after the room was deleted, changes nothing. It's one transaction,
   * and nothing can run between its reads and its writes, which never wait. The index then asks who can
   * read the room, if it hasn't heard, and until it does keeps its words plainly.
   */
  apply(roomId: RoomId, seq: number, messages: IndexedMessage[], deletedIds: string[]): void {
    const unheard = this.ctx.storage.transactionSync(() => {
      const [taken] = this.sql.exec<{ seq: number; heard: number }>(`SELECT seq, heard FROM search_rooms WHERE room_id = ?`, roomId).toArray();
      if (taken && taken.seq >= seq) return false;
      const listed = JSON.stringify(messages.map(({ id }) => id));
      const indexed = this.sql.exec<{ id: number; message_id: string }>(`SELECT id, message_id FROM search_messages WHERE message_id IN (SELECT value FROM json_each(?))`, listed);
      const known = new Map(indexed.toArray().map((row) => [row.message_id, row.id]));
      const added = this.numbered(messages.filter(({ id }) => !known.has(id)));
      const replaced = JSON.stringify([...known.keys(), ...deletedIds]);
      const keys = this.keysOf(roomId);
      this.sql.exec(`DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_messages WHERE message_id IN (SELECT value FROM json_each(?)))`, replaced);
      this.sql.exec(`DELETE FROM search_mentions WHERE id IN (SELECT id FROM search_messages WHERE message_id IN (SELECT value FROM json_each(?)))`, replaced);
      this.sql.exec(`DELETE FROM search_messages WHERE message_id IN (SELECT value FROM json_each(?))`, JSON.stringify(deletedIds));
      // A message each, since a JSON array of them all could pass the 2 MB a value can take.
      for (const { id, text, message, creatorId, threadId, hasLink, hasFile, mentionIds } of messages) {
        const number = known.get(id) ?? added.get(id);
        if (number === undefined) continue;
        const facts = [creatorId, threadId, hasLink ? 1 : 0, hasFile ? 1 : 0, keys.length > 0 ? 1 : 0];
        if (known.has(id)) this.sql.exec(`UPDATE search_messages SET message = ?, creator_id = ?, thread_id = ?, has_link = ?, has_file = ?, keyed = ? WHERE id = ?`, message, ...facts, number);
        else this.sql.exec(`INSERT INTO search_messages (id, message_id, room_id, message, creator_id, thread_id, has_link, has_file, keyed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, number, id, roomId, message, ...facts);
        this.sql.exec(`INSERT INTO search_index (rowid, body) VALUES (?, ?)`, number, keys.length > 0 ? keyedText(text, keys) : plainText(text));
        this.sql.exec(`INSERT OR IGNORE INTO search_mentions (id, user_id) SELECT ?, value FROM json_each(?)`, number, JSON.stringify(mentionIds));
      }
      this.sql.exec(`INSERT INTO search_rooms (room_id, seq) VALUES (?, ?) ON CONFLICT (room_id) DO UPDATE SET seq = excluded.seq`, roomId, seq);
      return !taken?.heard;
    });
    if (unheard) this.hearNow(roomId);
  }

  /**
   * Numbers each of `messages` after the latest number of its millisecond, or as its first, oldest first,
   * by id. A millisecond can number 1,024 apart; one with more leaves the rest out, as it does a message
   * whose time can't be read.
   */
  private numbered(messages: IndexedMessage[]): Map<string, number> {
    const firsts = JSON.stringify([...new Set(messages.map(({ createdAt }) => firstNumber(createdAt)))]);
    const numbers = this.sql.exec<{ first: number; latest: number | null }>(LATEST_NUMBERS, firsts).toArray();
    const latest = new Map(numbers.map(({ first, latest }) => [first, latest]));
    const added = new Map<string, number>();
    for (const message of messages.sort(byTime)) {
      const first = firstNumber(message.createdAt);
      if (Number.isNaN(first)) {
        console.warn(`Left message ${message.id} out of the search index: its time, ${message.createdAt}, can't be read`);
        continue;
      }
      const previous = latest.get(first);
      const number = previous === null || previous === undefined ? first : previous + 1;
      if (number >= first + PER_MILLISECOND) {
        console.warn(`Left message ${message.id} out of the search index: more than ${PER_MILLISECOND} were written in its millisecond`);
        continue;
      }
      latest.set(first, number);
      added.set(message.id, number);
    }
    return added;
  }

  /**
   * Keeps the words of each room `rooms` lists as who can read it says from now on, as the Workspace
   * tells the index as a room's kind changes (`hear`), but for a room the Workspace no longer has.
   */
  async setReadersOf(rooms: RoomReaders[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const { roomId, readers } of rooms) if (readers !== null) this.hear(roomId, readers);
    });
    await this.wakeForNext();
  }

  /**
   * Notes the index has heard who can read room `roomId`, unless it's deleted, and keeps its words as
   * `readers` says from now on. When that changes how it keeps them, it keeps the room's messages of the
   * last hour under its keys at once, up to `MOST_REKEYED_AT_ONCE` of them, and leaves any earlier ones it
   * keeps plainly to the walk (`walk`), or ends the room's walk once everyone can read it.
   */
  private hear(roomId: RoomId, readers: Readers): void {
    const [room] = this.sql.exec<{ seq: number; heard: number }>(`SELECT seq, heard FROM search_rooms WHERE room_id = ?`, roomId).toArray();
    if (room?.seq === FORGOTTEN) return;
    // A room it holds no messages of takes them from its log's first change on, numbered from 1.
    if (!room) this.sql.exec(`INSERT INTO search_rooms (room_id, seq, heard) VALUES (?, 0, 1)`, roomId);
    else if (room.heard === 0) this.sql.exec(`UPDATE search_rooms SET heard = 1 WHERE room_id = ?`, roomId);
    if (!this.setReaders(roomId, readers)) return;
    const keys = this.keysOf(roomId);
    const since = (Date.now() - REKEYED_AT_ONCE_MS) * PER_MILLISECOND;
    const rekeyed = keys.length === 0 ? [] : this.rekey(roomId, keys, FORGOTTEN, since, MOST_REKEYED_AT_ONCE);
    const newest = keys.length === 0 ? null : this.newestPlain(roomId, rekeyed.at(-1) ?? FORGOTTEN);
    if (newest === null) {
      this.sql.exec(`DELETE FROM search_rekeys WHERE room_id = ?`, roomId);
      return;
    }
    this.sql.exec(`INSERT INTO search_rekeys (room_id, before) VALUES (?, ?) ON CONFLICT (room_id) DO UPDATE SET before = excluded.before`, roomId, newest + 1);
    if (this.ctx.storage.kv.get(REKEY_DUE) === undefined) this.ctx.storage.kv.put(REKEY_DUE, Date.now());
  }

  /**
   * Keeps the words of room `roomId`'s messages from now on as who can read them, `readers`, says: plainly
   * for everyone, under the room's key for its members, or under each person's. A key, once given, stays
   * the room's or the person's. Answers whether that changes how it keeps them.
   */
  private setReaders(roomId: RoomId, readers: Readers): boolean {
    const [kept] = this.sql.exec<{ people: string | null }>(`SELECT people FROM search_readers WHERE room_id = ?`, roomId).toArray();
    if (readers === "everyone") {
      if (kept) this.sql.exec(`DELETE FROM search_readers WHERE room_id = ?`, roomId);
      return kept !== undefined;
    }
    const people = readers === "members" ? null : JSON.stringify([...new Set(readers)]);
    if (kept && kept.people === people) return false;
    this.sql.exec(`INSERT INTO search_readers (room_id, people) VALUES (?, ?) ON CONFLICT (room_id) DO UPDATE SET people = excluded.people`, roomId, people);
    if (people === null) this.sql.exec(`INSERT INTO search_keys (room_id) VALUES (?) ON CONFLICT DO NOTHING`, roomId);
    else this.sql.exec(`INSERT INTO search_keys (user_id) SELECT value FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`, people);
    return true;
  }

  /**
   * Keeps up to `limit` of room `roomId`'s messages numbered below `before` and from `since` whose words
   * the index keeps plainly under `keys` instead, newest first, and answers their numbers in that order.
   */
  private rekey(roomId: RoomId, keys: number[], before: number, since: number, limit: number): number[] {
    const plain = this.sql.exec<{ number: number; body: string }>(PLAIN_MESSAGES, roomId, before, since, limit).toArray();
    if (plain.length === 0) return [];
    for (const { number, body } of plain) {
      this.sql.exec(`DELETE FROM search_index WHERE rowid = ?`, number);
      this.sql.exec(`INSERT INTO search_index (rowid, body) VALUES (?, ?)`, number, keyedText(body, keys));
    }
    const numbers = plain.map(({ number }) => number);
    this.sql.exec(`UPDATE search_messages SET keyed = 1 WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(numbers));
    return numbers;
  }

  /** The number of room `roomId`'s newest message numbered below `before` whose words the index keeps plainly, if any. */
  private newestPlain(roomId: RoomId, before: number): number | null {
    const [row] = this.sql.exec<{ id: number }>(`SELECT id FROM search_messages WHERE room_id = ? AND id < ? AND keyed = 0 ORDER BY id DESC LIMIT 1`, roomId, before).toArray();
    return row?.id ?? null;
  }

  /**
   * Keeps up to `limit` of the messages taken before their rooms' words were kept under keys under them,
   * newest first, whatever their rooms: those of the room whose walk has the newest left, down to the
   * newest another room's has left, then that room's, and so on. Answers whether any walk has further to
   * go.
   */
  private walk(limit: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      for (let left = limit; left > 0; ) {
        const [first, second] = this.sql.exec<{ room_id: RoomId; before: number }>(`SELECT room_id, before FROM search_rekeys ORDER BY before DESC LIMIT 2`).toArray();
        if (!first) return false;
        const keys = this.keysOf(first.room_id);
        // An edit since may have kept the walk's newest under keys already, and so another room's go first.
        const newest = keys.length === 0 ? null : this.newestPlain(first.room_id, first.before);
        if (newest === null) {
          this.sql.exec(`DELETE FROM search_rekeys WHERE room_id = ?`, first.room_id);
          continue;
        }
        if (second && newest + 1 < second.before) {
          this.sql.exec(`UPDATE search_rekeys SET before = ? WHERE room_id = ?`, newest + 1, first.room_id);
          continue;
        }
        const rekeyed = this.rekey(first.room_id, keys, newest + 1, Math.min(second?.before ?? 0, newest), left);
        left -= rekeyed.length;
        const next = this.newestPlain(first.room_id, rekeyed.at(-1)!);
        if (next === null) this.sql.exec(`DELETE FROM search_rekeys WHERE room_id = ?`, first.room_id);
        else this.sql.exec(`UPDATE search_rekeys SET before = ? WHERE room_id = ?`, next + 1, first.room_id);
      }
      return this.sql.exec(`SELECT 1 FROM search_rekeys LIMIT 1`).toArray().length > 0;
    });
  }

  /**
   * Asks who can read room `roomId`, which has sent the index messages before it heard, at once rather
   * than once its alarm goes off, and without the room waiting for the answer, then sets the alarm for
   * what that leaves. Asking already, it asks about this room too before it's done, and waiting to ask
   * again, it asks about it then.
   */
  private hearNow(roomId: RoomId): void {
    this.sending.add(roomId);
    if (this.asking || Date.now() < this.askAgainAt) return;
    void this.hearSending()
      .catch((error) => console.error("Could not ask the Workspace who can read rooms; trying again later", error))
      .then(() => this.wakeForNext())
      .catch((error) => console.error("Could not set the search index's alarm", error));
  }

  /**
   * Asks about the rooms that have sent the index messages before it heard (`askAboutSending`), unless
   * it's asking already, and answers once it has. When the question fails, it asks again a minute on.
   */
  private hearSending(): Promise<void> {
    this.asking ??= this.askAboutSending()
      .then(
        () => {
          this.askAgainAt = 0;
        },
        (error: unknown) => {
          this.askAgainAt = Date.now() + ASK_AGAIN_MS;
          throw error;
        },
      )
      .finally(() => {
        this.asking = null;
      });
    return this.asking;
  }

  /**
   * Asks the Workspace who can read the rooms that have sent the index messages before it heard,
   * `ROOMS_PER_ASK` at a time, up to `ASKS_PER_RUN` times, those that send it more as it asks among
   * them, and forgets each once it has.
   */
  private async askAboutSending(): Promise<void> {
    for (let asks = 0; asks < ASKS_PER_RUN && this.sending.size > 0; asks++) {
      const roomIds = [...this.sending].slice(0, ROOMS_PER_ASK);
      await this.askAbout(this.sql.exec<UnheardRoom>(`SELECT room_id, seq FROM search_rooms WHERE heard = 0 AND room_id IN (SELECT value FROM json_each(?))`, JSON.stringify(roomIds)).toArray());
      for (const roomId of roomIds) this.sending.delete(roomId);
    }
  }

  /**
   * Asks the Workspace who can read up to `limit` of the rooms the index holds messages of but hasn't
   * heard about, and answers how many it asked about. Its alarm asks once it's done asking about the
   * rooms that have sent it messages (`hearSending`), so it's the one question then, and a room that
   * sends it messages meanwhile waits for it.
   */
  private async hearSome(limit: number): Promise<number> {
    const rooms = this.sql.exec<UnheardRoom>(`SELECT room_id, seq FROM search_rooms WHERE heard = 0 LIMIT ?`, limit).toArray();
    if (rooms.length === 0) return 0;
    this.asking = this.askAbout(rooms).finally(() => {
      this.asking = null;
    });
    await this.asking;
    return rooms.length;
  }

  /**
   * Asks the Workspace who can read the rooms `rooms` lists, but for deleted ones, which need no asking,
   * and hears each as it answers, but for one it has been told of since it asked, as the room's kind
   * changed, which the answer may be from before.
   */
  private async askAbout(rooms: UnheardRoom[]): Promise<void> {
    const deleted = rooms.filter(({ seq }) => seq === FORGOTTEN).map(({ room_id }) => room_id);
    const asked = rooms.filter(({ seq }) => seq !== FORGOTTEN).map(({ room_id }) => room_id);
    const answers = asked.length === 0 ? [] : await workspace(this.env).roomReaders(asked);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE search_rooms SET heard = 1 WHERE room_id IN (SELECT value FROM json_each(?))`, JSON.stringify(deleted));
      for (const { roomId, readers } of answers) {
        const [room] = this.sql.exec<{ heard: number }>(`SELECT heard FROM search_rooms WHERE room_id = ?`, roomId).toArray();
        if (room?.heard !== 0) continue;
        if (readers === null) this.sql.exec(`UPDATE search_rooms SET heard = 1 WHERE room_id = ?`, roomId);
        else this.hear(roomId, readers);
      }
    });
  }

  /** Whether the index holds messages of a room it hasn't heard about. */
  private unheard(): boolean {
    return this.sql.exec(`SELECT 1 FROM search_rooms WHERE heard = 0 LIMIT 1`).toArray().length > 0;
  }

  /**
   * Asks about the rooms that have sent the index messages before it heard who can read them, then takes
   * the walk a run further, if that's due, and sets the alarm for what's next.
   */
  override async alarm(): Promise<void> {
    try {
      await this.hearSending();
    } catch (error) {
      console.error("Could not ask the Workspace who can read rooms; trying again later", error);
    }
    const due = this.ctx.storage.kv.get<number>(REKEY_DUE);
    if (due !== undefined && due <= Date.now()) await this.walkOn();
    await this.wakeForNext();
  }

  /**
   * Takes the walk a run further: asks about some of the rooms the index hasn't heard about, each taking
   * `REKEYS_A_ROOM_HEARD` of the run's messages, keeps the rest of them under keys, and puts the next run
   * off an hour while either has further to go.
   */
  private async walkOn(): Promise<void> {
    let heard = 0;
    try {
      heard = await this.hearSome(ROOMS_HEARD_PER_RUN);
    } catch (error) {
      console.error("Could not ask the Workspace who can read rooms; trying again later", error);
    }
    const further = this.walk(REKEYED_PER_RUN - heard * REKEYS_A_ROOM_HEARD);
    if (further || this.unheard()) this.ctx.storage.kv.put(REKEY_DUE, Date.now() + REKEY_RUNS_EVERY_MS);
    else this.ctx.storage.kv.delete(REKEY_DUE);
  }

  /**
   * Sets the alarm for what the index has next to do, unless it's set sooner: ask about the rooms that
   * have sent it messages before it heard, now or when it asks again, and take the walk further, when
   * that's due.
   */
  private async wakeForNext(): Promise<void> {
    const askAt = Math.max(this.askAgainAt, Date.now());
    const next = Math.min(this.sending.size > 0 ? askAt : Infinity, this.ctx.storage.kv.get<number>(REKEY_DUE) ?? Infinity);
    if (next !== Infinity) await this.wake(next);
  }

  /** Sets the alarm for `at`, or now, once that has passed, unless it's set sooner. */
  private async wake(at: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at) await this.ctx.storage.setAlarm(Math.max(at, Date.now()));
  }

  /** The keys room `roomId`'s messages keep their words under, in order, or none when they keep them plainly. */
  private keysOf(roomId: RoomId): number[] {
    return this.sql.exec<{ key: number }>(KEYS_OF_ROOM, roomId).toArray().map(({ key }) => key);
  }

  /**
   * The keys of the words `search` can find: those of its rooms' that have a key, and its searcher's,
   * which their DMs of one or two people keep their words under, when it looks in one of those.
   */
  private keysFor({ roomIds, searcherId }: IndexSearch): number[] {
    return this.sql.exec<{ key: number }>(KEYS_FOR_SEARCH, JSON.stringify(roomIds), searcherId).toArray().map(({ key }) => key);
  }

  /**
   * Forgets up to `limit` of room `roomId`'s messages, as deleting the room has it do a batch at a time,
   * so that no call holds up the other rooms' for long, and answers whether any are left. The first keeps
   * any call the room made before from putting them back.
   */
  forget(roomId: RoomId, limit: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO search_rooms (room_id, seq, heard) VALUES (?, ?, 1) ON CONFLICT (room_id) DO UPDATE SET seq = excluded.seq, heard = 1`, roomId, FORGOTTEN);
      this.sql.exec(`DELETE FROM search_readers WHERE room_id = ?`, roomId);
      this.sql.exec(`DELETE FROM search_rekeys WHERE room_id = ?`, roomId);
      const ids = this.sql.exec<{ id: number }>(`SELECT id FROM search_messages WHERE room_id = ? LIMIT ?`, roomId, limit + 1).toArray();
      const forgotten = JSON.stringify(ids.slice(0, limit).map(({ id }) => id));
      this.sql.exec(`DELETE FROM search_index WHERE rowid IN (SELECT value FROM json_each(?))`, forgotten);
      this.sql.exec(`DELETE FROM search_mentions WHERE id IN (SELECT value FROM json_each(?))`, forgotten);
      this.sql.exec(`DELETE FROM search_messages WHERE id IN (SELECT value FROM json_each(?))`, forgotten);
      return ids.length > limit;
    });
  }

  /**
   * A page of the messages `search` finds, up to `SEARCH_LIMIT`, newest or oldest first, each with what
   * results show of it and the words it matched: what its statement finds, which is one more than the
   * page holds when there's another.
   */
  search(search: IndexSearch): SearchPage {
    const words = wordsSearched(search);
    const match = words.length === 0 ? null : matchOf(words, this.keysFor(search));
    const { sql, values } = match === null ? filtersStatement(search) : wordsStatement(search, match);
    const hits = this.sql.exec<Pick<SearchHit, "number" | "messageId" | "roomId">>(sql, ...values).toArray();
    const page = hits.slice(0, SEARCH_LIMIT);
    const numbers = JSON.stringify(page.map(({ number }) => number));
    const shown = match === null ? this.sql.exec<PageRow>(PAGE, numbers) : this.sql.exec<PageRow>(MARKED_PAGE, match, numbers);
    const rows = new Map(shown.toArray().map((row) => [row.number, row]));
    return {
      hits: page.map((hit) => ({ ...hit, message: rows.get(hit.number)?.message ?? null, words: wordsMarked(rows.get(hit.number)?.marked ?? null) })),
      next: hits.length > SEARCH_LIMIT ? page.at(-1)!.number : null,
    };
  }
}

/** What results show of a message, and its text with the words it matched marked, if its search has words. */
type PageRow = {
  number: number;
  message: string | null;
  marked: string | null;
};

export const searchIndex = (env: Env) => env.SEARCH_INDEX.getByName("search");
