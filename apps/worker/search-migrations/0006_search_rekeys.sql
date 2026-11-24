-- Whether the search index has heard who can read each room it holds messages of, and the rooms whose
-- earlier messages it has still to keep under keys (src/search-index.ts). It asks the Workspace about
-- each room it hasn't heard of, every room it held before this among them, and the Workspace tells it
-- of each room whose kind changes (migrations/0080_pending_readers.sql).

-- 0 until the index has heard who can read the room, and so for every room it held before this, and for
-- each room it takes the first messages of after, whatever release takes them.
ALTER TABLE search_rooms ADD COLUMN heard INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS index_search_rooms_unheard ON search_rooms (room_id) WHERE heard = 0;

-- The rooms with messages taken before their words were kept under keys, which it keeps under them a few
-- at a time, newest first, and one more than the number of the newest of them each room has left, so
-- that a room's walk goes on where it stopped, and the room with the newest left goes first.
CREATE TABLE IF NOT EXISTS search_rekeys (
  room_id TEXT PRIMARY KEY,
  before INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS index_search_rekeys_on_before ON search_rekeys (before);
