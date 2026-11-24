-- Whether a room lets @channel, @here and @everyone notify it, kept by the Workspace (scope "workspace" in
-- src/migrations.ts) with the room, as a Slack channel's settings keep it: 1 in every room until an
-- administrator turns them off in its settings, which is 0, and then a message's special mentions there
-- are kept as plain text that notifies nobody. A direct message has no settings, and never notifies
-- with one.
ALTER TABLE rooms ADD COLUMN channel_mentions_allowed INTEGER NOT NULL DEFAULT 1;
