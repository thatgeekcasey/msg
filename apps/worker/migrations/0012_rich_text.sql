-- Message bodies are rich text: the markup the room keeps of what was sent (prepareBody in
-- packages/richtext), with the plain text and the mentioned users' ids read from it when it was
-- written, and when its text last changed, which "(edited)" shows.
ALTER TABLE messages ADD COLUMN plain_text TEXT NOT NULL DEFAULT '';
-- A JSON array of user ids.
ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE messages ADD COLUMN edited_at TEXT;

-- Bodies until now were plain text. Each becomes the paragraph Lexxy sends for text typed into it,
-- its line breaks <br>s, as bodyFromPlainText writes it, and keeps its text, with each line break a
-- newline, as its plain text. Only edits have moved a message's updated_at.
UPDATE messages SET
  plain_text = replace(replace(body, char(13) || char(10), char(10)), char(13), char(10)),
  edited_at = CASE WHEN updated_at <> created_at THEN updated_at END,
  body = '<p>' || replace(
    replace(replace(
      replace(replace(replace(replace(body, '&', '&amp;'), char(160), '&nbsp;'), '<', '&lt;'), '>', '&gt;'),
      char(13) || char(10), char(10)), char(13), char(10)),
    char(10), '<br>') || '</p>';
