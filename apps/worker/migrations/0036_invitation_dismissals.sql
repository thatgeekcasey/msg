-- When each person dismissed the welcome card, kept by the Workspace (scope "workspace" in
-- src/migrations.ts), or null while they haven't. Only administrators are given it, and each can dismiss
-- it for good, on every device they sign in on.
ALTER TABLE users ADD COLUMN invitation_dismissed_at TEXT;
