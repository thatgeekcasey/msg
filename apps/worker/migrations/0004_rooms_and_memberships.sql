-- Rooms and who is in them, kept by the Workspace (scope "workspace" in src/migrations.ts). The columns
-- follow Campfire's rooms and memberships (db/schema.rb), with string ids and ISO times. A room's id
-- also names its ChatRoom object, which keeps the room's messages.
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  -- Campfire's type, without Rails' class names: 'open', 'closed' or 'direct'.
  kind TEXT NOT NULL,
  -- Direct messages have none.
  name TEXT,
  -- Rooms from before the Workspace kept a list (LEGACY_ROOMS) have none.
  creator_id TEXT REFERENCES users (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Campfire's connections and connected_at are left out: each room's object knows who's connected.
CREATE TABLE IF NOT EXISTS memberships (
  room_id TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id),
  -- How much of the room reaches the person: 'invisible', 'nothing', 'mentions' or 'everything'.
  involvement TEXT NOT NULL DEFAULT 'mentions',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS index_memberships_on_user_id_and_room_id ON memberships (user_id, room_id);
