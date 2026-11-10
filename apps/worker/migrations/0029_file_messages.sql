-- File messages (scope "room" in src/migrations.ts). Once R2 has all of a file, the room posts it as its
-- uploader's message (src/files/uploads.ts). `attachment` holds, as JSON, the file as the message shows
-- it (src/files/blobs.ts `AttachedFile`): its key, its name as Active Storage keeps it, its type, its
-- size, and an image's width and height. Text messages have none. A message has at most one file, so
-- it's a column, where Campfire has active_storage_attachments, and a page of messages reads no other
-- table for it. An upload keeps the id the app gave its message, and the message once it's posted.
ALTER TABLE messages ADD COLUMN attachment TEXT;
ALTER TABLE blobs ADD COLUMN client_message_id TEXT;
ALTER TABLE blobs ADD COLUMN message_id TEXT;
