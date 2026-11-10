-- The links Ember emails people to join with, kept by the Workspace (scope "workspace" in
-- src/migrations.ts): an administrator's invitation to an email address. A link works once, until it
-- expires, and only by submitting the join form, which deletes its row as it adds the person, so the
-- mail filters that open the links in incoming mail never spend one. Resending replaces the link, so
-- only the newest works, and an address has one of each kind.
CREATE TABLE IF NOT EXISTS email_links (
  id TEXT PRIMARY KEY,
  -- The link's secret's HMAC under SESSION_SECRET, as a session token's is kept, since the secret alone joins.
  token_digest TEXT NOT NULL UNIQUE,
  -- What the link is: 'invitation'.
  kind TEXT NOT NULL,
  -- The address it's for, as given, which joining with it gives the account.
  email_address TEXT NOT NULL,
  -- The administrator who sent it last.
  invited_by TEXT REFERENCES users (id),
  -- When its newest link was made, and when that stops working.
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- When Ember emailed it, or else why the provider didn't send it. Both are null while Ember can't send
  -- email, when an administrator sends the link themselves.
  sent_at TEXT,
  send_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS index_email_links_on_kind_and_email_address ON email_links (kind, lower(email_address));

-- Who invited someone who joined with an invitation, which lets them sign in with a password while
-- Memberful is members only.
ALTER TABLE users ADD COLUMN invited_by TEXT REFERENCES users (id);

-- Email addresses are kept as typed, under a unique index that tells Ann@x.com from ann@x.com, so an
-- invitation finds an account with its address whatever the case through this one.
CREATE INDEX IF NOT EXISTS index_users_on_lower_email_address ON users (lower(email_address));
