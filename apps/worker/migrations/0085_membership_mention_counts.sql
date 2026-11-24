-- How many of the messages that marked a room unread for its member mention them, by name or as @channel,
-- @here or @everyone notifies them, kept by the Workspace (scope "workspace" in src/migrations.ts) with
-- the mark: the count the sidebar shows on the room's row, as Slack's badge counts a channel's mentions.
-- 0 until a message mentions them while they aren't viewing the room, and 0 again once they read it. A DM
-- counts every message in unread_count instead, and never this.
ALTER TABLE memberships ADD COLUMN mention_count INTEGER NOT NULL DEFAULT 0;
