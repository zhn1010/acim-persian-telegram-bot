ALTER TABLE users ADD COLUMN last_ephemeral_message_ids_json TEXT
  CHECK (last_ephemeral_message_ids_json IS NULL OR json_valid(last_ephemeral_message_ids_json));
ALTER TABLE users ADD COLUMN ephemeral_generation INTEGER NOT NULL DEFAULT 0;

ALTER TABLE daily_progress ADD COLUMN studied_at_ms INTEGER;
