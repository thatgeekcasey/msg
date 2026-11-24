-- The sidebar's sections, kept by the Workspace (scope "workspace" in src/migrations.ts): names that
-- rooms are listed under in everyone's sidebar, after the rooms in none, in the order position puts
-- them, from 0, a new one last. Administrators make, rename, order and delete them, and whoever can
-- change a room puts it in one in its settings, which rooms.section_id keeps, null for none, as every
-- room starts. Deleting a section leaves its rooms in none.
CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE rooms ADD COLUMN section_id TEXT;
