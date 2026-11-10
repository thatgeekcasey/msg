-- Bans, kept by the Workspace (scope "workspace" in src/migrations.ts).
--
-- A ban blocks each IP address recorded on its person's sessions when they were banned, as Campfire's
-- `bans` table does (db/schema.rb), with its indexes: by address, which a request's check finds, and by
-- person, which lifting the ban deletes.
CREATE TABLE IF NOT EXISTS bans (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  ip_address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS index_bans_on_ip_address ON bans (ip_address);
CREATE INDEX IF NOT EXISTS index_bans_on_user_id ON bans (user_id);

-- The rooms the Workspace has yet to ask to delete a banned person's messages, another outbox beside
-- pending_revocations (migration 0007): banning someone writes a row for each room they may have written
-- in, in the same batch, and the Workspace's alarm asks each room to delete their messages a page at a
-- time, as Campfire's `RemoveBannedContentJob` deletes them one by one, until it has none of theirs left
-- (src/workspace.ts). A room is asked only once it has no sockets left to close, so none of theirs can
-- write there after it's done.
CREATE TABLE IF NOT EXISTS pending_purges (
  -- What the alarm settles each purge by once its room has answered. AUTOINCREMENT never hands out an
  -- id again, so a ban while it waits can't give a new purge the id of the one it's asking about, which
  -- deleting that room deletes.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- When the ban was lifted, if it has been, as an ISO time. The room then deletes only what they wrote
  -- by then, so what they write once they're back stays, however late it answers. Until then it
  -- deletes all of theirs, what a socket of theirs sent before the room closed it too.
  lifted_at TEXT,
  -- Failed deliveries in a row.
  attempts INTEGER NOT NULL DEFAULT 0,
  -- When to ask the room next, in milliseconds since the epoch.
  due_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS index_pending_purges_on_due_at ON pending_purges (due_at);
