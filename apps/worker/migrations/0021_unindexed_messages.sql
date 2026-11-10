-- Each room's log of the messages the search index has yet to hear of (scope "room" in
-- src/migrations.ts): one written, edited or deleted, logged in the same transaction as the change, or
-- every message, once, when the room's messages are indexed afresh. The room sends the index each one
-- as it is when it sends it, and forgets what the index has taken (src/room-log.ts).
CREATE TABLE IF NOT EXISTS unindexed_messages (
  -- Numbered as room_events are, so that the index can tell a call that's late.
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS index_unindexed_messages_on_room_id_and_seq ON unindexed_messages (room_id, seq);
