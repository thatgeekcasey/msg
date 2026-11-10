import type { Message, Room, RoomId, UserId } from "./index.ts";
import { MAX_ID_LENGTH, SEARCHES_PATH } from "./pages.ts";

// Searching messages: for words, as Campfire's search matches them, narrowed by filters, as Slack's
// search modifiers narrow a search.

/** How many matches a page of search results has, at most. */
export const SEARCH_LIMIT = 100;

/** The longest search, in UTF-16 code units. */
export const MAX_SEARCH_LENGTH = 1_000;

export const SEARCH_TOO_LONG = `Searches can be up to ${MAX_SEARCH_LENGTH.toLocaleString("en-US")} characters.`;

/** How many recent searches someone keeps: the newest. */
export const RECENT_SEARCHES = 10;

/** What a search narrows its matches to besides its words, as Slack's search modifiers do: a message has to meet every one it has. */
export interface SearchFilters {
  /** Slack's `in:`, and "In this channel": only messages in this room. */
  in?: RoomId;
  /** `from:`, and "From me": only messages this person wrote. */
  from?: UserId;
  /** "Includes me": only messages that mention you, are in your DMs, or are in threads you've written in. */
  withMe?: true;
  /** `has:link`: only messages with a link in them. */
  hasLink?: true;
  /** `has:file`: only file messages. */
  hasFile?: true;
  /** `is:thread`, and "Threads only": only replies in threads, and the messages they reply to. */
  inThread?: true;
}

/** A search: the words typed, as typed, and its filters. */
export interface Search extends SearchFilters {
  q: string;
}

/** The orders search results come in: the newest first, as they do at first, or the oldest. */
export type SearchSort = "newest" | "oldest";

/** The filters that are on or off, as a search's address writes each: `key=value`. */
export const SEARCH_FLAGS = [
  { flag: "withMe", key: "with", value: "me" },
  { flag: "hasLink", key: "has", value: "link" },
  { flag: "hasFile", key: "has", value: "file" },
  { flag: "inThread", key: "is", value: "thread" },
] as const satisfies ReadonlyArray<{ flag: keyof SearchFilters; key: string; value: string }>;

export type SearchFlag = (typeof SEARCH_FLAGS)[number]["flag"];

/**
 * Turns every character but Ruby's word characters, which are letters, marks, decimal digits, connectors
 * such as `_`, and the joiners, into a space, one each, as Campfire's
 * `params[:q]&.gsub(/[^[:word:]]/, " ")` does. What's left can't be FTS5's syntax.
 */
export const sanitizeSearch = (q: string) => q.replace(/[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]/gu, " ");

/** Whether `q` has a word left in it once it's sanitized. */
export const hasWords = (q: string) => /\S/u.test(sanitizeSearch(q));

/** Whether `filters` has a filter on. */
export const hasFilters = (filters: SearchFilters) =>
  filters.in !== undefined || filters.from !== undefined || SEARCH_FLAGS.some(({ flag }) => filters[flag] === true);

/** Whether `search` can find anything: it needs a word, or a filter. */
export const isSearchable = (search: Search) => hasWords(search.q) || hasFilters(search);

/**
 * A sanitized search as FTS5 reads it: each word quoted as a string, so that none is read as FTS5's
 * syntax, such as NOT or NEAR, and all of them must match. NULs separate words too, since SQLite would
 * end the query at one.
 */
export const searchTerms = (query: string) =>
  query
    .split(/[\s\0]+/u)
    .filter((word) => word !== "")
    .map((word) => `"${word.replaceAll('"', '""')}"`)
    .join(" ");

/** `search` with only the filters it has on, in one order, and its words with their runs of spaces made one and none at either end. */
export function normalizedSearch({ q, in: roomId, from, ...flags }: Search): Search {
  const search: Search = { q: q.trim().replace(/\s+/gu, " ") };
  if (roomId !== undefined) search.in = roomId;
  if (from !== undefined) search.from = from;
  for (const { flag } of SEARCH_FLAGS) if (flags[flag] === true) search[flag] = true;
  return search;
}

/** What tells recent searches apart: two searches for the same words with the same filters have the same. */
export const searchKey = (search: Search) => JSON.stringify(normalizedSearch(search));

/**
 * The query of a search's address: its words, as `q`, its filters, and how its results are sorted and the
 * page they start at, unless they're the first page, newest first. Spaces become "+" and anything but
 * ASCII letters, digits and `-_.!~*'()` is escaped, as a form's query string reads them back.
 */
export function searchQuery(search: Search, sort: SearchSort = "newest", cursor?: number): string {
  const params: Array<[string, string]> = [["q", search.q]];
  if (search.in !== undefined) params.push(["in", search.in]);
  if (search.from !== undefined) params.push(["from", search.from]);
  for (const { flag, key, value } of SEARCH_FLAGS) if (search[flag] === true) params.push([key, value]);
  if (sort !== "newest") params.push(["sort", sort]);
  if (cursor !== undefined) params.push(["cursor", String(cursor)]);
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value).replaceAll("%20", "+")}`).join("&");
}

/** The search page's address for a search, sorted as `sort` says. */
export const searchPath = (search: Search, sort: SearchSort = "newest") => `${SEARCHES_PATH}?${searchQuery(search, sort)}`;

/** An id a filter can name: text, but not too long to be one. */
const isId = (value: unknown): value is string => typeof value === "string" && value !== "" && value.length <= MAX_ID_LENGTH;

/** An address's query, as a `URLSearchParams` reads it. */
export interface SearchParams {
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
}

/**
 * The search an address's query names, as `searchQuery` writes it, how its results are sorted, and the
 * page they start at, if it's not the first. What it doesn't know, it leaves out.
 */
export function searchOfQuery(params: SearchParams): { search: Search; sort: SearchSort; cursor: number | null } {
  const search: Search = { q: params.get("q") ?? "" };
  const roomId = params.get("in");
  const from = params.get("from");
  if (isId(roomId)) search.in = roomId;
  if (isId(from)) search.from = from;
  for (const { flag, key, value } of SEARCH_FLAGS) if (params.getAll(key).includes(value)) search[flag] = true;
  const cursor = Number(params.get("cursor") ?? "");
  return { search, sort: params.get("sort") === "oldest" ? "oldest" : "newest", cursor: params.has("cursor") && Number.isSafeInteger(cursor) ? cursor : null };
}

/**
 * Parses what `POST /api/searches` takes: a `Search`, typed in the search box, with `sort` too, if its
 * results are to be the oldest first. Returns why it's refused instead.
 */
export function parseSearch(data: unknown): { search: Search; sort: SearchSort } | string {
  if (typeof data !== "object" || data === null) return "Searches have to be text";
  const { q, in: roomId, from, sort, ...flags } = data as Record<string, unknown>;
  if (typeof q !== "string") return "Searches have to be text";
  if (q.length > MAX_SEARCH_LENGTH) return SEARCH_TOO_LONG;
  if (roomId !== undefined && !isId(roomId)) return "A search can only be in a room";
  if (from !== undefined && !isId(from)) return "A search can only be from a person";
  if (sort !== undefined && sort !== "newest" && sort !== "oldest") return "Search results are sorted by newest or oldest";
  const search: Search = { q };
  if (roomId !== undefined) search.in = roomId;
  if (from !== undefined) search.from = from;
  for (const { flag } of SEARCH_FLAGS) {
    const on = flags[flag];
    if (on !== undefined && typeof on !== "boolean") return "A search's filters are on or off";
    if (on === true) search[flag] = true;
  }
  return { search, sort: sort ?? "newest" };
}

/** A message a search found, and the words in its text that it matched, as they're written there, for results to mark. */
export interface SearchMatch {
  message: Message;
  words: string[];
}

/** What `GET /api/searches` answers, and `POST /api/searches` once it has recorded the search. */
export interface SearchResults {
  /** The search, normalized (`normalizedSearch`), or null when it had nothing to search for. */
  search: Search | null;
  /** A page of the messages it found in the rooms you're in, `SEARCH_LIMIT` at most, in the order asked for. */
  matches: SearchMatch[];
  /** The `cursor` of the next page, or null when this is the last. */
  next: number | null;
  /** The rooms they're in, as your sidebar lists them. */
  rooms: Room[];
  /** Your recent searches, up to `RECENT_SEARCHES`, newest first. */
  recent: Search[];
}
