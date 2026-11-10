-- How a room finds someone's messages (scope "room" in src/migrations.ts): `message.check` looks up a
-- sender's by the ids their client gave them, and banning someone deletes all of theirs, which Campfire
-- finds through `index_messages_on_creator_id` (db/schema.rb). One index serves both, in place of
-- migration 0002's, so a new message writes no more than it did.
DROP INDEX IF EXISTS index_messages_on_room_id_and_client_message_id;
CREATE INDEX IF NOT EXISTS index_messages_on_room_id_and_creator_id_and_client_message_id ON messages (room_id, creator_id, client_message_id);
