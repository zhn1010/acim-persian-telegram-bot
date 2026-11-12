ALTER TABLE users ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'Asia/Tehran';
ALTER TABLE users ADD COLUMN time_zone_confirmed_at_ms INTEGER;
ALTER TABLE users ADD COLUMN pending_time_zone TEXT;
ALTER TABLE users ADD COLUMN pending_time_zone_effective_at_ms INTEGER;
ALTER TABLE users ADD COLUMN audio_delivery TEXT NOT NULL DEFAULT 'on_demand' CHECK (audio_delivery IN ('on_demand', 'automatic'));
ALTER TABLE users ADD COLUMN next_lesson_at_ms INTEGER;
ALTER TABLE users ADD COLUMN next_night_at_ms INTEGER;

ALTER TABLE lessons ADD COLUMN telegram_audio_file_id TEXT;
ALTER TABLE lessons ADD COLUMN telegram_audio_file_unique_id TEXT;
ALTER TABLE lessons ADD COLUMN telegram_audio_duration INTEGER;
ALTER TABLE lessons ADD COLUMN telegram_audio_uploading_at_ms INTEGER;

ALTER TABLE daily_progress ADD COLUMN audio_sent_at_ms INTEGER;
ALTER TABLE daily_progress ADD COLUMN audio_message_id INTEGER;

CREATE INDEX users_next_lesson_idx ON users(paused, completed, delivery_blocked, next_lesson_at_ms);
CREATE INDEX users_next_night_idx ON users(paused, completed, delivery_blocked, next_night_at_ms);
CREATE INDEX users_pending_time_zone_idx ON users(pending_time_zone_effective_at_ms);
