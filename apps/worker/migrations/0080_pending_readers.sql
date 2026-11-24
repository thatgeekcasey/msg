-- The rooms whose kind has changed since the search index last heard who can read them
-- (search-migrations/0005_search_readers.sql), kept by the Workspace (scope "workspace" in
-- src/migrations.ts) as each changes. Nothing tells the index yet: the next release does, and has the
-- index ask who can read each room it holds messages of and hasn't heard about, so it misses no room
-- whose kind changed while a copy ran this release, before the next or after going back to it.
CREATE TABLE IF NOT EXISTS pending_readers (
  room_id TEXT PRIMARY KEY,
  -- How many times the room has been queued again, so that telling the index of the room as it was
  -- before then doesn't settle it.
  version INTEGER NOT NULL DEFAULT 0,
  -- Failed deliveries in a row.
  attempts INTEGER NOT NULL DEFAULT 0,
  -- When to tell the index next, in milliseconds since the epoch.
  due_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS index_pending_readers_on_due_at ON pending_readers (due_at);
