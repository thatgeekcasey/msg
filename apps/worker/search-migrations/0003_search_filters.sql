-- What search filters narrow a search by (@ember/protocol `SearchFilters`), for each message the index
-- holds: who wrote it, the thread it's in, which is its own id for a message with replies, and whether it
-- has a link or a file (src/store.ts `searchFactsOf`), and whom it mentions. A message the index took
-- before it kept them has none, so no filter finds it until the Workspace has every room index its
-- messages again (migrations/0047_search_filters.sql).
ALTER TABLE search_messages ADD COLUMN creator_id TEXT;
ALTER TABLE search_messages ADD COLUMN thread_id TEXT;
ALTER TABLE search_messages ADD COLUMN has_link INTEGER NOT NULL DEFAULT 0;
ALTER TABLE search_messages ADD COLUMN has_file INTEGER NOT NULL DEFAULT 0;

-- For a search of someone's messages, newest or oldest first, and the threads they've written in.
CREATE INDEX IF NOT EXISTS index_search_messages_on_creator_id_and_id ON search_messages (creator_id, id);
CREATE INDEX IF NOT EXISTS index_search_messages_on_thread_id_and_creator_id ON search_messages (thread_id, creator_id) WHERE thread_id IS NOT NULL;

-- For a search of the messages with links, or files, which few are.
CREATE INDEX IF NOT EXISTS index_search_messages_with_links ON search_messages (id) WHERE has_link = 1;
CREATE INDEX IF NOT EXISTS index_search_messages_with_files ON search_messages (id) WHERE has_file = 1;

-- Whom each message mentions, under its number, once each.
CREATE TABLE IF NOT EXISTS search_mentions (
  id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (id, user_id)
) WITHOUT ROWID;
