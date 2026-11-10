-- Revocations the Workspace has yet to deliver to rooms, its outbox (scope "workspace" in
-- src/migrations.ts). The change that ends someone's access writes them in the same batch, so none
-- is lost however the delivery goes, and the Workspace's alarm sends each room its own, trying again
-- later when a room can't be reached (src/workspace.ts).
CREATE TABLE IF NOT EXISTS pending_revocations (
  id INTEGER PRIMARY KEY,
  room_id TEXT NOT NULL,
  -- Whose sockets to close: a person's id, or "s:" and a session's id.
  tag TEXT NOT NULL,
  -- What to close them with: CloseCode in packages/protocol, 4001 to reconnect or 4003 not to.
  code INTEGER NOT NULL,
  -- Failed deliveries so far.
  attempts INTEGER NOT NULL DEFAULT 0,
  -- When to deliver it next, in milliseconds since the epoch.
  due_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS index_pending_revocations_on_due_at ON pending_revocations (due_at);
