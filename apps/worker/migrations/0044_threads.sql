-- Threads (scope "room" in src/migrations.ts), as Slack has them: a reply in a thread names the message
-- it replies to, its parent, and shows in the room's timeline only when its author also sent it there.
-- A thread's summary under its parent, how many replies it has, when the newest came and who wrote them,
-- is read with the parent (src/store.ts), so nothing keeps it up to date. Campfire has no threads.
ALTER TABLE messages ADD COLUMN parent_id TEXT;
-- 1 for a message the room's timeline shows: every message but a reply sent only to its thread.
ALTER TABLE messages ADD COLUMN in_room INTEGER NOT NULL DEFAULT 1;
-- 1 for a message deleted while replies in its thread are left, which keeps its place for them without its
-- text, file, cards or boosts, until its last reply goes too.
ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
-- A page of the timeline reads only the messages it shows, however many replies a room's threads hold.
CREATE INDEX IF NOT EXISTS index_messages_on_room_id_and_in_room_and_id ON messages (room_id, in_room, id);
-- A thread's replies, and its summary. Messages that aren't replies, most of them, aren't in it.
CREATE INDEX IF NOT EXISTS index_messages_on_parent_id_and_id ON messages (parent_id, id) WHERE parent_id IS NOT NULL;

-- 0 for a reply sent only to its thread, which marks the room unread for nobody and isn't its latest
-- activity, even once the reply is deleted (src/room-log.ts).
ALTER TABLE room_events ADD COLUMN in_room INTEGER NOT NULL DEFAULT 1;

-- A file uploaded as a reply in a thread: the thread's parent, and whether it's also sent to the room.
ALTER TABLE blobs ADD COLUMN parent_id TEXT;
ALTER TABLE blobs ADD COLUMN also_sent INTEGER NOT NULL DEFAULT 0;
