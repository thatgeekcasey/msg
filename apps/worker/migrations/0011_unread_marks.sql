-- Unread marks, kept by the Workspace (scope "workspace" in src/migrations.ts). A membership's unread_at
-- is when the first message its person hasn't seen was written, and null once they've read the room. A
-- room's applied_seq is the last event of its change log (migration 0010) that the Workspace has
-- applied, so one delivered again changes nothing.
ALTER TABLE memberships ADD COLUMN unread_at TEXT;
ALTER TABLE rooms ADD COLUMN applied_seq INTEGER NOT NULL DEFAULT 0;
