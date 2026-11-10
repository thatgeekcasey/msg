-- A room's icon, kept by the Workspace (scope "workspace" in src/migrations.ts): the name of a Lucide
-- icon in the icon picker's catalog, or null for the default #. A room's icon is read with the room, and
-- goes when the room does.
ALTER TABLE rooms ADD COLUMN icon TEXT;
