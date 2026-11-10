-- Previews of files (scope "room" in src/migrations.ts): an image's thumbnail or a video's poster, which
-- its uploader's browser makes and sends before the upload's last part (src/files/uploads.ts), where
-- Campfire makes them on the server. R2 keeps the preview by the file's key, and `preview` holds its
-- width and height, as JSON, once the room has it. The message the file is posted as shows it
-- (src/files/blobs.ts `attachedFile`).
ALTER TABLE blobs ADD COLUMN preview TEXT;
