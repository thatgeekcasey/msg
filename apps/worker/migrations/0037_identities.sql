-- Who signs in with an account elsewhere, kept by the Workspace (scope "workspace" in
-- src/migrations.ts): each account by its issuer, the address of the Memberful site it's on, and its
-- subject there, its member id, linked to the person it signs in as. Keyed by the issuer too, so a
-- member of another site never signs in as anyone here, and a person has at most one account at each
-- issuer.
CREATE TABLE IF NOT EXISTS identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (issuer, subject)
);
CREATE UNIQUE INDEX IF NOT EXISTS index_identities_on_user_id_and_issuer ON identities (user_id, issuer);
