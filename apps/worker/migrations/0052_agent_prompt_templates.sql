-- What Ember adds around each AI agent's instructions, as an administrator changed it on the agent's page,
-- kept by the Workspace (scope "workspace" in src/migrations.ts): a template whose placeholders Ember
-- fills in each time the agent is asked (`promptAround` in @ember/protocol/prompts), or null for Ember's
-- own, which changes as Ember does. What Ember adds around @ember's is in the account's settings.
ALTER TABLE agents ADD COLUMN prompt_template TEXT;
