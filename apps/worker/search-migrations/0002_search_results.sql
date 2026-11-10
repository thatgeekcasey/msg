-- What search results show of each message: its row as its room keeps it, boosts and all, as JSON
-- (src/store.ts `indexable`), so a search answers from the index alone, rather than asking each room it
-- matched. Null for a message the index took before it kept them, which a search reads from its room
-- until the Workspace has every room index its messages again (migrations/0040_search_results.sql).
ALTER TABLE search_messages ADD COLUMN message TEXT;
