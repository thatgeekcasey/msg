-- A bot's cards (scope "room" in src/migrations.ts): what a Slack incoming webhook's attachments show
-- under the message a bot posts (src/bots/slack.ts), kept as JSON beside its body, as a file message
-- keeps its file in `attachment` (0029), so a page of messages reads no other table for them. `cards` is
-- a JSON array of `Card`s (packages/protocol/src/cards.ts), whose text the room keeps in the stored
-- form, as a body's. Other messages have none.
ALTER TABLE messages ADD COLUMN cards TEXT;
