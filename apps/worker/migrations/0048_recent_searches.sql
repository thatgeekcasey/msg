-- Each person's recent searches with their filters, which take over from the words alone that 0023's
-- `searches` keeps: each search as its key (@ember/protocol `searchKey`), the JSON of its words and the
-- filters it has on, ordered as 0023 orders them, starting with a copy of those, words alone. 0023's stay
-- for the release before, and go with these when someone clears them or is removed.
CREATE TABLE IF NOT EXISTS recent_searches (
  user_id TEXT NOT NULL REFERENCES users (id),
  search TEXT NOT NULL,
  -- One past the highest of the person's when they last searched for it, so the newest is the highest.
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, search)
);
CREATE INDEX IF NOT EXISTS index_recent_searches_on_user_id_and_position ON recent_searches (user_id, position);

-- 0023 kept a search with each character but a word's made a space, so its words are copied as `searchKey`
-- keys them, trimmed and with each run of spaces made one, halving the runs until none is left, and
-- searching for them again moves them. Searches that are the same once they're copied keep the newer's place.
WITH RECURSIVE collapsed (user_id, query, position) AS (
  SELECT user_id, query, position FROM searches
  UNION ALL
  SELECT user_id, replace(query, '  ', ' '), position FROM collapsed WHERE instr(query, '  ') > 0
)
INSERT INTO recent_searches (user_id, search, position)
  SELECT user_id, json_object('q', trim(query, ' ')), position FROM collapsed WHERE instr(query, '  ') = 0
  ON CONFLICT (user_id, search) DO UPDATE SET position = max(position, excluded.position);
