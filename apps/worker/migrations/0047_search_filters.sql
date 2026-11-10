-- The search index keeps what search filters narrow a search by (search-migrations/0003_search_filters.sql),
-- so the Workspace's alarm has every room log all its messages for it once more, as 0040 had them do,
-- and the index takes each again.
INSERT INTO pending_reindexes (room_id, due_at) SELECT id, 0 FROM rooms WHERE true ON CONFLICT DO NOTHING;
