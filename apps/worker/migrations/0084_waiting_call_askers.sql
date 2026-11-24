-- Who asked for each call that waits (scope "room" in src/migrations.ts), whose card only they see now,
-- as a Slack app's ephemeral message is: the room shows it to their tabs alone, and again to each tab of
-- theirs that opens the room while the call waits, which finds the calls that wait on them by this. A call
-- that started to wait before this has none, and its card is a message in the room, as cards were then.
ALTER TABLE waiting_calls ADD COLUMN asker_id TEXT;
CREATE INDEX waiting_calls_by_asker ON waiting_calls (room_id, asker_id);
