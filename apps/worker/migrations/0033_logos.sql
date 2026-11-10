-- The workspace's logo, kept by the Workspace (scope "workspace" in src/migrations.ts), as Campfire
-- attaches an account's `logo` (`active_storage_attachments`). R2 keeps the file at `logo_key`, and
-- beside it the two variants served of it, which the uploader's browser made, unless Campfire doesn't
-- resize a file of its type (src/files/pictures.ts).
ALTER TABLE accounts ADD COLUMN logo_key TEXT;
-- The variants' type, or null when there are none to serve and the logo is Ember's stock icon.
ALTER TABLE accounts ADD COLUMN logo_variant TEXT;
