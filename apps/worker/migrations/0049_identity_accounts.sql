-- What each linked account elsewhere says of itself, kept by the Workspace (scope "workspace" in
-- src/migrations.ts): its name and email address at its issuer, as Memberful described the member
-- when the account was connected, or last signed its person in, so their profile can name the account
-- that's connected. Null for an account linked before these were kept, until it signs them in again.
-- Only shown: accounts are never matched by email address (migration 0037).
ALTER TABLE identities ADD COLUMN name TEXT;
ALTER TABLE identities ADD COLUMN email_address TEXT;
