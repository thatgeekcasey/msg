-- The model @ember answers each person with, as they pick on their profile from the models administrators
-- let people pick, kept by the Workspace (scope "workspace" in src/migrations.ts): a model's ID, or null
-- for the one administrators chose for everyone. A pick of a model no longer among them counts as null
-- until it's among them again. The models themselves are in the account's settings.
ALTER TABLE users ADD COLUMN assistant_model TEXT;
