-- The search index keeps what search results show of each message (search-migrations/0002_search_results.sql),
-- so the Workspace's alarm has every room log all its messages for it once more, as 0022 had every room
-- from before the index do, and the index takes each again.
INSERT INTO pending_reindexes (room_id, due_at) SELECT id, 0 FROM rooms WHERE true ON CONFLICT DO NOTHING;
