-- Rooms in the order they were made, kept by the Workspace (scope "workspace" in src/migrations.ts). The
-- workspace's first room is its oldest, as Campfire's `Room.original` finds it, and every sidebar asks
-- which that is. Ids sort in the order rooms were made, but the ids of rooms from before the Workspace
-- kept a list (LEGACY_ROOMS) don't, so this finds it at once rather than the primary key.
CREATE INDEX IF NOT EXISTS index_rooms_on_created_at_and_id ON rooms (created_at, id);
