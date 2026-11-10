-- The rooms deleted so far, kept by the Workspace (scope "workspace" in src/migrations.ts). Campfire
-- deletes a room outright, but a room from before the Workspace kept a list (LEGACY_ROOMS) is registered
-- whenever the Workspace starts and finds it missing, so without this a deleted one would come back.
CREATE TABLE IF NOT EXISTS deleted_rooms (
  id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);
