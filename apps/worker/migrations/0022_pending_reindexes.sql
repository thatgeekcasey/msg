-- The rooms whose messages the search index has yet to hear of, kept by the Workspace (scope
-- "workspace" in src/migrations.ts): every room there was before the index, and a room from before the
-- Workspace kept a list as it's registered. The Workspace's alarm asks each to log all its messages for
-- the index, as it delivers the rest of its outbox (src/workspace.ts).
CREATE TABLE IF NOT EXISTS pending_reindexes (
  room_id TEXT PRIMARY KEY,
  -- Failed deliveries in a row.
  attempts INTEGER NOT NULL DEFAULT 0,
  -- When to ask the room next, in milliseconds since the epoch.
  due_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS index_pending_reindexes_on_due_at ON pending_reindexes (due_at);
INSERT INTO pending_reindexes (room_id, due_at) SELECT id, 0 FROM rooms WHERE true ON CONFLICT DO NOTHING;
