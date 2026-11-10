-- The codes Ember emails people who forgot their password, to choose a new one with, kept by the
-- Workspace (scope "workspace" in src/migrations.ts). A person has one at a time, the one emailed last,
-- which works for 15 minutes, for 5 tries, and only while their email address and password are still the
-- ones it was emailed for, so that changing either, however it's changed, ends it. Choosing a new
-- password with it deletes it. Asking for one counts in email_link_requests, as asking for a link to
-- join does, since both have Ember email an address.
CREATE TABLE IF NOT EXISTS password_resets (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  -- The code's HMAC under SESSION_SECRET, as a session token's is kept, since the code alone, with the
  -- address, chooses a new password.
  code_digest TEXT NOT NULL,
  -- The address it was emailed to, and the digest of the password it replaces, as users had them then.
  email_address TEXT NOT NULL,
  password_digest TEXT NOT NULL,
  -- When it was emailed, and when it stops working.
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- How many times it's been tried.
  attempts INTEGER NOT NULL DEFAULT 0
);
-- Saving a code deletes, through this, the codes that stopped working, which nobody used.
CREATE INDEX IF NOT EXISTS index_password_resets_on_expires_at ON password_resets (expires_at);
