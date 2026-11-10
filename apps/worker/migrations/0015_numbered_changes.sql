-- Each room numbers the changes to its messages (scope "room" in src/migrations.ts) for the tabs that
-- connect again: a tab names the latest change it has heard of, and the room answers with the
-- messages changed since, as they are now, and the ids of those deleted, rather than its newest page
-- (src/store.ts). A tab more than 100 changes behind (CHANGES_KEPT) gets the newest page, as a new
-- tab does.
--
-- A message keeps the number of its latest change: its creation, an edit, or a reaction added or
-- removed, written by the statement that makes the change, so a new message costs no other row.
-- Messages from before have none, and no tab can name a change from before the first.
ALTER TABLE messages ADD COLUMN change_seq INTEGER;
CREATE INDEX IF NOT EXISTS index_messages_on_room_id_and_change_seq ON messages (room_id, change_seq);

-- A deleted message leaves its id with the deletion's number, for as long as a tab could ask for it:
-- each deletion drops those that have fallen out of the latest 100 changes.
CREATE TABLE IF NOT EXISTS message_deletions (
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (room_id, seq)
);
