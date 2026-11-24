-- A message someone has scheduled in a room, as Slack's Schedule for later does (scope "room" in
-- src/migrations.ts), which the room's alarm sends as theirs once `send_at` comes, if they're in the room
-- still (src/scheduled-messages.ts). `body` is the markup the room keeps of a message, which it prepares
-- again as it sends it, and with `parent_id`, the message is a reply in that message's thread, which
-- `also_send` sends to the room too. `failure` says why the room couldn't send it, as when the thread's
-- message has been deleted since: it waits then, for its writer to edit or delete.
CREATE TABLE IF NOT EXISTS scheduled_messages (
  room_id TEXT NOT NULL,
  id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  body TEXT NOT NULL,
  parent_id TEXT,
  also_send INTEGER NOT NULL DEFAULT 0,
  send_at TEXT NOT NULL,
  failure TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (room_id, id)
);
CREATE INDEX IF NOT EXISTS scheduled_messages_creator ON scheduled_messages (room_id, creator_id, send_at);
CREATE INDEX IF NOT EXISTS scheduled_messages_due ON scheduled_messages (room_id, send_at) WHERE failure IS NULL;
