UPDATE users
SET next_night_at_ms = NULL
WHERE current_lesson < 365 AND next_night_at_ms IS NOT NULL;

UPDATE daily_progress
SET status = CASE
  WHEN schedule_kind IS NOT NULL THEN 'reminders_configured'
  ELSE 'lesson_delivered'
END
WHERE lesson_number < 365 AND status = 'awaiting_tomorrow_choice';
