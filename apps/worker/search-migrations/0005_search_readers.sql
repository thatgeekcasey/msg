-- Who can read each room's messages, as the search index keeps their words (src/search-words.ts): an
-- open room's plainly, as everyone in Ember can read them, and the rest's under keys, so that FTS5's list
-- of the messages with a word kept under a key lists only those of the rooms that keep it.

-- The keys words are kept under: each room's that its members read, a private room or a DM of three people
-- or more, and each person's, which all their DMs of one or two people keep their words under. A key is
-- the room's or the person's for good, and one a deleted room had finds nothing.
CREATE TABLE IF NOT EXISTS search_keys (
  key INTEGER PRIMARY KEY,
  room_id TEXT UNIQUE,
  user_id TEXT UNIQUE,
  CHECK ((room_id IS NULL) <> (user_id IS NULL))
);

-- The rooms that not everyone can read, which keep their messages' words under keys from when the index
-- hears so: their own, for their members, or each person's, of the one or two people a JSON array lists.
-- A room it hasn't heard of keeps them plainly, as an open room does.
CREATE TABLE IF NOT EXISTS search_readers (
  room_id TEXT PRIMARY KEY,
  people TEXT
);

-- Whether a message's words are kept under its room's keys, as they were when the index took it, or
-- plainly, as every message's were before.
ALTER TABLE search_messages ADD COLUMN keyed INTEGER NOT NULL DEFAULT 0;
