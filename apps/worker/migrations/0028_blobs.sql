-- Files uploaded to a room (scope "room" in src/migrations.ts), as Active Storage keeps blobs
-- (Campfire's active_storage_blobs in db/schema.rb), with what an upload in parts needs
-- (src/files/uploads.ts). `id` is the blob's key, by which R2 keeps the file too, and `filename` its
-- name as it was given. `content_type` is the type the browser declared until the file's first bytes
-- identify it, when `metadata` records that, and an image's size, as Active Storage writes it. A file in
-- more than one part has an R2 multipart upload, and `parts` is the JSON list of those R2 has, which
-- `completed_at` says it has put together.
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  metadata TEXT,
  multipart_upload_id TEXT,
  parts TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS index_blobs_on_room_id ON blobs (room_id);
