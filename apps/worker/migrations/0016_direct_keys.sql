-- One DM for each group of people, kept by the Workspace (scope "workspace" in src/migrations.ts). A
-- DM's direct_key is the JSON array of its members' ids, sorted, and null for any other room, so the
-- unique index finds the DM a group already has, and two requests to start the same DM at once make one
-- between them. A DM's members never change, so its key stays true.
ALTER TABLE rooms ADD COLUMN direct_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS index_rooms_on_direct_key ON rooms (direct_key);
