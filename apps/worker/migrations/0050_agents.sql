-- The AI agents administrators make beside @ember, kept by the Workspace (scope "workspace" in
-- src/migrations.ts). Each is a bot user without a token, so no key opens anything as it, and this row is
-- what makes it an agent: what it does, its instructions, the model it answers with, that model's name
-- and the API format it took its test question in, how much it thinks and how long it answers, what it
-- may do on the web, a JSON list of 'search' and 'read', or null for nothing, and who made it and who
-- last changed it, and when. Deleting an agent deletes its row and deactivates its user, as deleting a
-- bot does, so its messages stay.
--
-- An agent is in the rooms its memberships say. One in every open room (every_open_room 1) joins new
-- ones as everyone does; one kept to the open rooms an administrator picked (0) doesn't. Turning Ember
-- AI off takes every agent out of every room but its DMs. One kept to the rooms picked keeps the open
-- rooms it was in as kept_rooms, a JSON list of their IDs, null while Ember AI is on and for the others,
-- so that turning it on again puts it back in those still open, as it puts the others in every open
-- room. Neither goes back to the closed rooms it was in.
CREATE TABLE IF NOT EXISTS agents (
  user_id TEXT PRIMARY KEY REFERENCES users (id),
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  model TEXT NOT NULL,
  model_name TEXT NOT NULL,
  format TEXT NOT NULL,
  thinking TEXT NOT NULL,
  answer_length TEXT NOT NULL,
  web_tools TEXT,
  every_open_room INTEGER NOT NULL,
  kept_rooms TEXT,
  created_by TEXT NOT NULL REFERENCES users (id),
  updated_by TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
