-- What orders DMs and who's suggested for one, kept by the Workspace (scope "workspace" in
-- src/migrations.ts).
--
-- A room's last_message_at is when its latest message came, which the Workspace records as it applies
-- the room's log, and null until one has. DMs are listed by it, latest first, or by when they started
-- until they have one, as Campfire lists them by `rooms.updated_at`. Only a new message moves a DM, live
-- or not. DMs from before this have none, so they go by when they started until their next message.
ALTER TABLE rooms ADD COLUMN last_message_at TEXT;

-- The sidebar suggests the active people with the oldest accounts who share no DM with you, as
-- Campfire's `find_direct_placeholder_users` does, so it walks this index from the oldest account and
-- stops once it has enough, rather than sorting everyone. It leaves status out: with it first, SQLite
-- would read every active person through the index, for New room's list say, rather than reading the
-- table straight through.
CREATE INDEX IF NOT EXISTS index_users_on_created_at_and_id ON users (created_at, id);
