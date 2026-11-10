-- The search index, which the SearchIndex object keeps in its own storage whatever STORAGE_BACKEND says
-- (`SEARCH_MIGRATIONS` in src/migrations.ts): the plain text of every message in an FTS5 table with the
-- porter tokenizer, as Campfire's `message_search_index` (db/schema.rb), and how much of each room's log
-- it has taken (src/search-index.ts).

-- The messages it holds, each numbered as its row in the FTS5 table, which needs an integer: its time in
-- milliseconds since the epoch, times 1024, plus its place among the messages of that millisecond. So
-- walking the index from its largest number goes from the newest message, however late a room's messages
-- reach it.
CREATE TABLE IF NOT EXISTS search_messages (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  room_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS index_search_messages_on_room_id_and_id ON search_messages (room_id, id);

-- Each message's plain text, under its number. A regular FTS5 table, which keeps a copy of the text, as
-- Campfire's does, so an edit is a delete and an insert, and nothing else has to stay in step.
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5 (body, tokenize = 'porter');

-- The last of each room's changes the index has taken (room migration 0021), so that a call a room made
-- before another changes nothing if it arrives after it. A deleted room's is the largest safe integer.
CREATE TABLE IF NOT EXISTS search_rooms (
  room_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);
