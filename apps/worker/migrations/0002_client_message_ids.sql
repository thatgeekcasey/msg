-- message.check finds a sender's messages by the ids their client gave them, which would otherwise
-- mean reading every message in the room.
CREATE INDEX IF NOT EXISTS index_messages_on_room_id_and_client_message_id ON messages (room_id, client_message_id);
