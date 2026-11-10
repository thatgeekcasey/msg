-- The shared room order, kept by the Workspace (scope "workspace" in src/migrations.ts).
--
-- Administrators put rooms in an order on workspace settings that every sidebar lists them in, after
-- each person's stars. A room's shared_position is its place in it, from 0, or null for a room it
-- doesn't rank, so the sidebar reads it with each room, and a deleted room leaves it with its row.
ALTER TABLE rooms ADD COLUMN shared_position INTEGER;
