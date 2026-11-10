-- Numbers push subscriptions with AUTOINCREMENT, as Campfire's `push_subscriptions` does, so a deleted
-- subscription's number is never given to another: a push service answering late that a subscription is
-- gone can't then forget a browser's that has taken its number since. SQLite can't add AUTOINCREMENT to
-- a table, so the table is made again with its rows.
CREATE TABLE push_subscriptions_numbered (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users (id),
  endpoint TEXT NOT NULL,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO push_subscriptions_numbered (id, user_id, endpoint, p256dh_key, auth_key, user_agent, created_at, updated_at)
  SELECT id, user_id, endpoint, p256dh_key, auth_key, user_agent, created_at, updated_at FROM push_subscriptions;
DROP TABLE push_subscriptions;
ALTER TABLE push_subscriptions_numbered RENAME TO push_subscriptions;
CREATE UNIQUE INDEX index_push_subscriptions_on_user_id_and_keys ON push_subscriptions (user_id, endpoint, p256dh_key, auth_key);
