-- Files leaving with their messages (scope "room" in src/migrations.ts), as Campfire purges a blob once
-- the message it's attached to is destroyed (`dependent: :purge_later`). Deleting a file message, a
-- banned person's messages or the room marks their files with `deleted_at` in the same write, and the
-- room then deletes each from R2, with its preview, and forgets it (src/chat-room.ts `purgeFiles`).
-- Uploads still unfinished a day after they started are marked too.
ALTER TABLE blobs ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS index_blobs_on_deleted ON blobs (room_id) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS index_blobs_on_unfinished ON blobs (room_id, created_at) WHERE completed_at IS NULL;
