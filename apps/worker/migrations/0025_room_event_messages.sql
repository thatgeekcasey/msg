-- A new message's event in its room's log names the message (scope "room" in src/migrations.ts), so
-- that as the room sends the Workspace the event it can send what pushing the message takes: its plain
-- text and whom it mentions, as the message is then, or nothing once it's deleted (src/room-log.ts).
-- Reads, and messages logged before this, name none.
ALTER TABLE room_events ADD COLUMN message_id TEXT;
