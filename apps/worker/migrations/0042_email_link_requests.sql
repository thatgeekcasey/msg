-- How often someone asked Ember lately to email each address a link to join with it, at the workspace's
-- email domains, kept by the Workspace (scope "workspace" in src/migrations.ts): an address is emailed
-- only so many times an hour, whoever asks, so that nobody can have Ember email someone over and over. A
-- count starts again once its hour is over, and asking deletes the counts whose hour is. Only the emails
-- sent, or being sent, are counted: an ask past the limit isn't, nor an email the provider refuses.
CREATE TABLE IF NOT EXISTS email_link_requests (
  -- The address asked for, in lowercase, so that its case keeps no count of its own.
  email_address TEXT PRIMARY KEY,
  -- When the hour this count is of began, and how many times the address was asked for since.
  counted_since TEXT NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS index_email_link_requests_on_counted_since ON email_link_requests (counted_since);

-- Saving a link someone asked for deletes, through this, the links of its kind that stopped working,
-- which nobody joined with, so that they don't pile up. Expired invitations stay, for administrators to
-- send again.
CREATE INDEX IF NOT EXISTS index_email_links_on_kind_and_expires_at ON email_links (kind, expires_at);
