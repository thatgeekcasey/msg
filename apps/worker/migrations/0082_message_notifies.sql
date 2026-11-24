-- Whom a message's special mention notified (scope "room" in src/migrations.ts): "channel" for @channel,
-- everyone in its room, or "here" for @here, everyone active in it, the widest it makes, as the room
-- decided when it came. Only a message sent to a room that isn't a DM notifies, and not a reply in a
-- thread, so every other message has none, as messages from before this have. An edit can narrow it
-- or take it away, never widen it, since an edit notifies nobody.
ALTER TABLE messages ADD COLUMN notifies TEXT;
