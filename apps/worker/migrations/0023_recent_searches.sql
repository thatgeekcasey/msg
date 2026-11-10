-- Each person's recent searches, kept by the Workspace (scope "workspace" in src/migrations.ts), as
-- Campfire's `searches` keeps them (db/schema.rb): what they searched for with the search page's form,
-- sanitized, up to RECENT_SEARCHES (@ember/protocol) of the newest. Campfire looks a search up before
-- touching it or adding it, and orders them by when they were last searched for; here each person has a
-- search once, so recording one is an upsert, and its position orders them.
CREATE TABLE IF NOT EXISTS searches (
  user_id TEXT NOT NULL REFERENCES users (id),
  query TEXT NOT NULL,
  -- One past the highest of the person's when they last searched for it, so the newest is the highest.
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, query)
);
CREATE INDEX IF NOT EXISTS index_searches_on_user_id_and_position ON searches (user_id, position);
