-- Each room's change log, kept by the room (scope "room" in src/migrations.ts): the new messages, and
-- the times someone opened the room in a shown tab, that the Workspace marks rooms unread and read by
-- and has yet to hear of. The room logs each in the same transaction as the change it records, sends
-- the Workspace what's new, and forgets what the Workspace has applied (src/room-log.ts).
CREATE TABLE IF NOT EXISTS room_events (
  -- Numbered in the order they happen. AUTOINCREMENT never hands out a number again, even once every
  -- row has gone, so a room's numbers only grow, and the Workspace can tell which it has applied.
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  -- 'message' or 'read'.
  kind TEXT NOT NULL,
  -- Who wrote the message, or read the room.
  user_id TEXT NOT NULL,
  -- When, as an ISO time: a message's is its created_at.
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS index_room_events_on_room_id_and_seq ON room_events (room_id, seq);
