-- The memberships the Workspace has yet to check with the Memberful site's admin API, and when it next
-- checks everyone's, kept by the Workspace (scope "workspace" in src/migrations.ts). Memberful's
-- webhooks say that a member's account, subscription or order changed, in any order, so the Workspace's
-- alarm asks Memberful what their membership is now, as Memberful advises
-- (memberful.com/docs/api-reference/webhooks), and suspends a member whose membership has lapsed, or
-- lets one back whose membership is renewed. Once a day it checks everyone linked to the site, in case a
-- webhook never came.
CREATE TABLE IF NOT EXISTS membership_checks (
  -- The linked account to check, as identities names it.
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  -- When the latest reason to check it came, in milliseconds since the epoch: a check that asked
  -- Memberful before then asks again.
  queued_at INTEGER NOT NULL,
  -- Failed checks in a row.
  attempts INTEGER NOT NULL DEFAULT 0,
  -- When to check next, in milliseconds since the epoch.
  due_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX IF NOT EXISTS index_membership_checks_on_due_at ON membership_checks (due_at);

-- When the Workspace next checks the membership of everyone linked to a Memberful site, in milliseconds
-- since the epoch.
CREATE TABLE IF NOT EXISTS membership_catch_ups (
  issuer TEXT PRIMARY KEY,
  due_at INTEGER NOT NULL
);

-- When each linked account's membership was last read, in milliseconds since the epoch by the
-- Workspace's clock, as a sign-in began or a check asked Memberful: a read from before then is older than
-- what the Workspace went by, so it changes nothing.
ALTER TABLE identities ADD COLUMN checked_at INTEGER NOT NULL DEFAULT 0;
