-- The workspace itself, kept by the Workspace (scope "workspace" in src/migrations.ts). The columns
-- follow Campfire's accounts (db/schema.rb), with a string id and ISO times. First run creates the only
-- one, and the unique index on singleton_guard refuses a second.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- The code in the workspace's join link, such as aB3d-Ef5h-iJ7k.
  join_code TEXT NOT NULL,
  -- JSON, such as {"restrict_room_creation_to_administrators":false}.
  settings TEXT,
  custom_styles TEXT,
  singleton_guard INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS index_accounts_on_singleton_guard ON accounts (singleton_guard);
