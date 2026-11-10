-- When a room last revoked access by each socket tag, a person's id or "s:" and a session's id, kept
-- by the room (scope "room" in src/migrations.ts). The Workspace checks every socket before it
-- reaches the room, so one it let through just before a revocation can arrive after the room has
-- closed that tag's sockets; comparing the two times, the room turns it away (src/revocations.ts).
-- Rows go once no authorization could be that old.
CREATE TABLE IF NOT EXISTS revocations (
  room_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  -- Milliseconds since the epoch, by the Workspace's clock, as authorizations are.
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, tag)
);
