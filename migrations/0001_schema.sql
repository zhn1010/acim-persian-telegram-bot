PRAGMA foreign_keys = ON;

CREATE TABLE lessons (
  lesson_number INTEGER PRIMARY KEY CHECK (lesson_number BETWEEN 1 AND 365),
  title_fa TEXT NOT NULL,
  reminder_fa TEXT NOT NULL,
  full_text_fa TEXT NOT NULL,
  text_url_fa TEXT NOT NULL,
  audio_url_fa TEXT,
  schedule_type TEXT NOT NULL,
  schedule_options_json TEXT NOT NULL CHECK (json_valid(schedule_options_json))
) STRICT;

CREATE TABLE users (
  telegram_user_id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  first_name TEXT,
  current_lesson INTEGER NOT NULL DEFAULT 1 CHECK (current_lesson BETWEEN 1 AND 365),
  selected_lesson INTEGER CHECK (selected_lesson BETWEEN 1 AND 365),
  start_date TEXT,
  state TEXT NOT NULL DEFAULT 'onboarding',
  pending_input TEXT,
  pending_json TEXT CHECK (pending_json IS NULL OR json_valid(pending_json)),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  delivery_blocked INTEGER NOT NULL DEFAULT 0 CHECK (delivery_blocked IN (0, 1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE daily_progress (
  user_id INTEGER NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
  course_date TEXT NOT NULL,
  lesson_number INTEGER NOT NULL REFERENCES lessons(lesson_number),
  status TEXT NOT NULL,
  lesson_sent_at_ms INTEGER,
  night_question_sent_at_ms INTEGER,
  tomorrow_action TEXT CHECK (tomorrow_action IN ('next', 'repeat', 'pause', 'complete', 'restart')),
  tomorrow_action_at_ms INTEGER,
  schedule_kind TEXT,
  schedule_value TEXT,
  schedule_slots_json TEXT CHECK (schedule_slots_json IS NULL OR json_valid(schedule_slots_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, course_date)
) STRICT;

CREATE TABLE reminder_jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
  course_date TEXT NOT NULL,
  lesson_number INTEGER NOT NULL REFERENCES lessons(lesson_number),
  ordinal INTEGER NOT NULL,
  total INTEGER NOT NULL,
  scheduled_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'acknowledged', 'cancelled', 'missed')),
  lease_until_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at_ms INTEGER,
  telegram_message_id INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (user_id, course_date, ordinal, scheduled_at_ms)
) STRICT;

CREATE INDEX reminder_jobs_due_idx ON reminder_jobs(status, scheduled_at_ms);
CREATE INDEX reminder_jobs_user_day_idx ON reminder_jobs(user_id, course_date, status);
CREATE INDEX users_start_idx ON users(paused, completed, start_date);

CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  received_at_ms INTEGER NOT NULL
) STRICT;
