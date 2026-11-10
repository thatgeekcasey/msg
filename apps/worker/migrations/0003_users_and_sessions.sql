-- People and their sessions, kept by the Workspace (scope "workspace" in src/migrations.ts). The columns
-- follow Campfire's users and sessions (db/schema.rb), with string ids, ISO times, and a digest of each
-- session's token where Campfire stores the token itself.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Guests have neither.
  email_address TEXT,
  password_digest TEXT,
  -- Campfire's values: 0 member, 1 administrator, 2 bot.
  role INTEGER NOT NULL DEFAULT 0,
  -- 0 active, 1 deactivated, 2 banned.
  status INTEGER NOT NULL DEFAULT 0,
  -- 1 for people who signed in with just a name, who are kept out while EMBER_GUEST_SIGN_IN is off.
  guest INTEGER NOT NULL DEFAULT 0,
  bio TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS index_users_on_email_address ON users (email_address);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  -- An HMAC of the cookie's token (src/auth.ts), so the table holds nothing anyone could sign in with.
  token_digest TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  last_active_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS index_sessions_on_token_digest ON sessions (token_digest);
CREATE INDEX IF NOT EXISTS index_sessions_on_user_id ON sessions (user_id);
