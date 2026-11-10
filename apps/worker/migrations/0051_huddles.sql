-- The huddle going on in each room, as the room's object last reported it, kept by the Workspace (scope
-- "workspace" in src/migrations.ts) so that it can show the huddle to everyone in the room, in it or not:
-- who's in it, a JSON list of their ids in the order they joined, and when it started. A room with no
-- huddle going on has nobody in it ('[]') and no start ('').
--
-- A room reports its huddle whenever who's in it changes, with its own time for the report, which
-- huddle_reported_at keeps. A report no later than that changes nothing, so of two that arrive out of
-- order the later stands, and one from before a huddle ended can't bring it back.
ALTER TABLE rooms ADD COLUMN huddle_reported_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN huddle_started_at TEXT NOT NULL DEFAULT '';
ALTER TABLE rooms ADD COLUMN huddle_user_ids TEXT NOT NULL DEFAULT '[]';
