-- Avatars people upload, kept by the Workspace (scope "workspace" in src/migrations.ts), as Campfire
-- attaches a user's `avatar` (`active_storage_attachments`). R2 keeps the file at `avatar_key`, and the
-- variant served of it beside it, which the uploader's browser made, unless it couldn't, or Campfire
-- doesn't resize a file of its type (src/files/pictures.ts).
ALTER TABLE users ADD COLUMN avatar_key TEXT;
-- The variant's type, or null when there's none to serve and the avatar is their initials.
ALTER TABLE users ADD COLUMN avatar_variant TEXT;

-- Pictures R2 is to delete, another outbox beside pending_revocations (migration 0007). Storing a
-- picture reserves its key here first, due in an hour, and whatever gives someone the picture takes it
-- out in the same batch, so a picture nobody got, however its request ended, is deleted once the hour
-- is up. Replacing or removing an avatar puts the old one's key here, due at once. The Workspace's
-- alarm has R2 delete each key's file and variants (src/workspace.ts).
CREATE TABLE IF NOT EXISTS pending_picture_deletions (
  object_key TEXT PRIMARY KEY,
  -- Failed deliveries in a row.
  attempts INTEGER NOT NULL DEFAULT 0,
  -- When to delete it, in milliseconds since the epoch.
  due_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS index_pending_picture_deletions_on_due_at ON pending_picture_deletions (due_at);
