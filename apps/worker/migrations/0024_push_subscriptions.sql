-- Push subscriptions, kept by the Workspace (scope "workspace" in src/migrations.ts): each browser that
-- turned notifications on for someone, with the keys its pushes are encrypted for and the browser's user
-- agent, as Campfire's `push_subscriptions` keeps them (db/schema.rb). Unlike there, the endpoint and
-- keys are required, and a person has each set once, so a browser saving its subscription again is an
-- upsert; the unique index also finds a person's subscriptions, as Campfire's by person does.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  endpoint TEXT NOT NULL,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS index_push_subscriptions_on_user_id_and_keys ON push_subscriptions (user_id, endpoint, p256dh_key, auth_key);
