-- The accounts elsewhere people are on their way to connect to theirs, kept by the Workspace (scope
-- "workspace" in src/migrations.ts): someone whose password checked out, on their profile or as they
-- signed in, has gone to sign in at the Memberful site, which sends their browser back with the state it
-- went with. The account they signed in to there is linked to theirs (identities) if the state's digest
-- is here still, for ten minutes, and only once, and only while their password is still the one that
-- checked out.
CREATE TABLE IF NOT EXISTS pending_identities (
  -- The state's HMAC under SESSION_SECRET, as a session token's is kept, since the state alone connects.
  state_digest TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  -- The digest of the password that checked out, as users.password_digest had it, or '' without one.
  password_digest TEXT NOT NULL,
  -- When it was started, in milliseconds since the epoch.
  created_at INTEGER NOT NULL
);
