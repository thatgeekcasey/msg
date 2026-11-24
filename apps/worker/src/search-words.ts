import type { RoomId, RoomKind, UserId } from "@ember/protocol";

// The words the search index keeps of each message (search-migrations/0005_search_readers.sql). An open
// room's are kept as its messages have them, since everyone in Ember can read those. Those of a room
// that not everyone can read are each kept under a key: the room's own, for a private room or a DM of
// three people or more, or each person's, for a DM of one or two people, whose DMs all share it. So
// FTS5's list of the messages with a word, kept under a key, lists only the messages of that room, or
// that person's DMs, and a search reads the lists of the words its rooms keep and no others.

/**
 * Who can read a room's messages, which says how the index keeps their words: everyone, as in an open
 * room, the room's members, as in a private room or a DM of three people or more, or the one or two
 * people of a DM.
 */
export type Readers = "everyone" | "members" | UserId[];

/** Who can read a room, as the Workspace tells the index, or null for a room it no longer has. */
export interface RoomReaders {
  roomId: RoomId;
  readers: Readers | null;
}

/**
 * Who can read a room of `kind`, as the index keeps its words: everyone, for an open room, each of the
 * `people` of a DM of one or two people, whose DMs all share their keys, or its members.
 */
export function readersOf(kind: RoomKind, people: UserId[] | null): Readers {
  if (kind === "open") return "everyone";
  return kind === "direct" && people !== null && people.length <= 2 ? people : "members";
}

/**
 * The characters FTS5's tokenizer ends a word at though JavaScript counts them as letters, since the
 * Unicode it goes by, 6.1, called them marks: New Tai Lue's vowel signs and two Vedic signs. With them,
 * the two characters a key is put between.
 */
const ENDS_WORDS = /[ᦰ-ᧀᧈᧉᳲᳳ]/gu;

/**
 * A word as FTS5's tokenizer finds one, or part of one: a letter, number or character for private use,
 * then more of them and of the marks it keeps in a word as accents, though it starts none at one, as
 * U+0301 after an e writes é.
 */
const WORD = /[\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{Co}̀-̄̆-̛̣̌̏̑-̨̭̮̰̱]*/gu;

/**
 * The words of `text`, in order and spelled as it spells them, as FTS5's tokenizer finds them, or split
 * finer, at a character the Unicode it goes by didn't have, which it takes for a letter, as it takes the
 * newer emoji. A word kept under a key then never holds a character FTS5 would end it at, which would
 * leave the rest of it a word of its own, kept plainly, and a match's words are as its text has them.
 */
export const wordsOf = (text: string): string[] => text.replace(ENDS_WORDS, " ").match(WORD) ?? [];

/**
 * The digits a key is written in: decimal digits and consonants but y, which Porter's stemmer, which
 * stems the index's words, reads as consonants. So it stems a word under a key as it stems the word
 * alone, but for a word of one or two letters, which it stems only under a key.
 */
const KEY_DIGITS = "0123456789bcdfghjklmnpqrstvwxz";

/** Key `key`, a whole number from 1, in `KEY_DIGITS`. */
function keyText(key: number): string {
  let text = "";
  for (let rest = key; rest > 0; rest = Math.floor(rest / KEY_DIGITS.length)) text = KEY_DIGITS[rest % KEY_DIGITS.length] + text;
  return text;
}

/** What a key is put between, characters for private use that the index takes out of what it keeps plainly. */
const OPENING_KEY = "";
const CLOSING_KEY = "";

/** `word`, one of `wordsOf`'s, kept under key `key`: one word to FTS5's tokenizer, which no message's text has. */
const keyedWord = (key: number, word: string) => `${OPENING_KEY}${keyText(key)}${CLOSING_KEY}${word}`;

/** What the index keeps of `text` plainly: all of it, but for the characters a key is put between, which it makes spaces. */
export const plainText = (text: string) => text.replace(/[]/gu, " ");

/** What the index keeps of `text` under each of `keys`: its words, under the first, then all of them again under the next, and so on. */
export function keyedText(text: string, keys: number[]): string {
  const words = wordsOf(text);
  return keys.map((key) => words.map((word) => keyedWord(key, word)).join(" ")).join("\n");
}

/** `text` as an FTS5 string, which FTS5 reads as words to find, never as its syntax. */
const quoted = (text: string) => `"${text.replaceAll('"', '""')}"`;

/**
 * The FTS5 query for messages with every one of `words`, plainly or under one of `keys`, the keys of the
 * rooms a search looks in. A word FTS5 would find as several, as it does a_b, has to have them all in a
 * row, as FTS5 finds a quoted word. FTS5 takes two words in a row for both, but not two bracketed ORs.
 */
export function matchOf(words: string[], keys: number[]): string {
  return words
    .map((word) => {
      const parts = wordsOf(word);
      const keyed = parts.length === 0 ? [] : keys.map((key) => quoted(parts.map((part) => keyedWord(key, part)).join(" ")));
      return keyed.length === 0 ? quoted(word) : `(${[quoted(word), ...keyed].join(" OR ")})`;
    })
    .join(" AND ");
}

/**
 * The words of `marked`, a match FTS5 marked in what the index keeps of a message, as its text has them:
 * the match itself, or, where it's kept under a key, each of its words without it.
 */
export function unkeyed(marked: string): string[] {
  if (!marked.includes(CLOSING_KEY)) return [marked];
  return marked.split(/\s+/u).flatMap((word) => word.slice(word.lastIndexOf(CLOSING_KEY) + 1) || []);
}
