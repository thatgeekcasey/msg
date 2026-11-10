-- How much @ember thinks before it answers each person, and how long its answers to them are, as they
-- pick on their profile, kept by the Workspace (scope "workspace" in src/migrations.ts): a level of each
-- dial, or null for where everyone starts. The most each goes to, which administrators set, is in the
-- account's settings.
ALTER TABLE users ADD COLUMN assistant_thinking TEXT;
ALTER TABLE users ADD COLUMN assistant_answer_length TEXT;
