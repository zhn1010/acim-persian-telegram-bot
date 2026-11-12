import type { DailyRow, LessonRow, PendingSchedule, UserRow } from "./types";

export async function claimUpdate(db: D1Database, updateId: number, nowMs: number): Promise<boolean> {
  const result = await db.prepare("INSERT INTO telegram_updates (update_id, received_at_ms) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(updateId, nowMs).run();
  return (result.meta.changes ?? 0) === 1;
}

export function getUser(db: D1Database, userId: number): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE telegram_user_id = ?").bind(userId).first<UserRow>();
}

export async function createOrRefreshUser(
  db: D1Database,
  userId: number,
  chatId: number,
  firstName: string,
  nowMs: number,
): Promise<UserRow> {
  await db.prepare(`
    INSERT INTO users (telegram_user_id, chat_id, first_name, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      chat_id = excluded.chat_id,
      first_name = excluded.first_name,
      delivery_blocked = 0,
      updated_at_ms = excluded.updated_at_ms
  `).bind(userId, chatId, firstName, nowMs, nowMs).run();
  const user = await getUser(db, userId);
  if (!user) throw new Error("Failed to load user after upsert");
  return user;
}

export function getLesson(db: D1Database, lesson: number): Promise<LessonRow | null> {
  return db.prepare("SELECT * FROM lessons WHERE lesson_number = ?").bind(lesson).first<LessonRow>();
}

export function getDaily(db: D1Database, userId: number, date: string): Promise<DailyRow | null> {
  return db.prepare("SELECT * FROM daily_progress WHERE user_id = ? AND course_date = ?").bind(userId, date).first<DailyRow>();
}

export async function ensureDaily(db: D1Database, userId: number, date: string, lesson: number, nowMs: number): Promise<DailyRow> {
  await db.prepare(`
    INSERT INTO daily_progress (user_id, course_date, lesson_number, status, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, 'lesson_pending', ?, ?)
    ON CONFLICT(user_id, course_date) DO NOTHING
  `).bind(userId, date, lesson, nowMs, nowMs).run();
  const daily = await getDaily(db, userId, date);
  if (!daily) throw new Error("Failed to load daily progress");
  return daily;
}

export async function updateUser(db: D1Database, userId: number, fields: Record<string, string | number | null>): Promise<void> {
  const allowed = new Set([
    "current_lesson", "selected_lesson", "start_date", "state", "pending_input", "pending_json", "paused", "completed", "delivery_blocked", "updated_at_ms",
    "time_zone", "time_zone_confirmed_at_ms", "pending_time_zone", "pending_time_zone_effective_at_ms", "audio_delivery", "next_lesson_at_ms", "next_night_at_ms",
    "last_ephemeral_message_ids_json", "ephemeral_generation",
  ]);
  const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
  if (entries.length === 0) return;
  const sql = `UPDATE users SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE telegram_user_id = ?`;
  await db.prepare(sql).bind(...entries.map(([, value]) => value), userId).run();
}

export async function claimDailyAudio(db: D1Database, userId: number, date: string, nowMs: number): Promise<"claimed" | "sent" | "busy" | "missing"> {
  const daily = await getDaily(db, userId, date);
  if (!daily?.lesson_sent_at_ms) return "missing";
  if (daily.audio_sent_at_ms && daily.audio_sent_at_ms > 0) return "sent";
  const claim = await db.prepare(`
    UPDATE daily_progress SET audio_sent_at_ms = ?, updated_at_ms = ?
    WHERE user_id = ? AND course_date = ?
      AND (audio_sent_at_ms IS NULL OR (audio_sent_at_ms < 0 AND audio_sent_at_ms > ?))
  `).bind(-nowMs, nowMs, userId, date, -(nowMs - 2 * 60_000)).run();
  if ((claim.meta.changes ?? 0) === 1) return "claimed";
  const refreshed = await getDaily(db, userId, date);
  return refreshed?.audio_sent_at_ms && refreshed.audio_sent_at_ms > 0 ? "sent" : "busy";
}

export async function completeDailyAudio(db: D1Database, userId: number, date: string, claimMs: number, messageId: number, nowMs: number): Promise<void> {
  await db.prepare("UPDATE daily_progress SET audio_sent_at_ms = ?, audio_message_id = ?, updated_at_ms = ? WHERE user_id = ? AND course_date = ? AND audio_sent_at_ms = ?")
    .bind(nowMs, messageId, nowMs, userId, date, -claimMs).run();
}

export async function releaseDailyAudio(db: D1Database, userId: number, date: string, claimMs: number, nowMs: number): Promise<void> {
  await db.prepare("UPDATE daily_progress SET audio_sent_at_ms = NULL, updated_at_ms = ? WHERE user_id = ? AND course_date = ? AND audio_sent_at_ms = ?")
    .bind(nowMs, userId, date, -claimMs).run();
}

export async function configureSchedule(db: D1Database, userId: number, schedule: PendingSchedule, nowMs: number): Promise<void> {
  const slotJson = JSON.stringify(schedule.slots);
  await db.batch([
    db.prepare("UPDATE reminder_jobs SET status = 'cancelled', updated_at_ms = ? WHERE user_id = ? AND course_date = ? AND status IN ('pending', 'sending')").bind(nowMs, userId, schedule.date),
    db.prepare(`
      UPDATE daily_progress SET status = 'reminders_configured', schedule_kind = ?, schedule_value = ?, schedule_slots_json = ?, tomorrow_action = NULL, tomorrow_action_at_ms = NULL, updated_at_ms = ?
      WHERE user_id = ? AND course_date = ? AND lesson_number = ?
    `).bind(schedule.kind, schedule.value, slotJson, nowMs, userId, schedule.date, schedule.lesson),
  ]);
  const statements: D1PreparedStatement[] = [];
  for (const slot of schedule.slots) {
    const id = `${userId}:${schedule.date}:${schedule.lesson}:${slot.ordinal}:${slot.atMs}`;
    statements.push(db.prepare(`
      INSERT INTO reminder_jobs (id, user_id, course_date, lesson_number, ordinal, total, scheduled_at_ms, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = 'pending', lease_until_ms = NULL, updated_at_ms = excluded.updated_at_ms
    `).bind(id, userId, schedule.date, schedule.lesson, slot.ordinal, slot.total, slot.atMs, nowMs, nowMs));
  }
  for (let index = 0; index < statements.length; index += 50) await db.batch(statements.slice(index, index + 50));
}

export async function cancelToday(db: D1Database, userId: number, date: string, status: string, nowMs: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE reminder_jobs SET status = 'cancelled', updated_at_ms = ? WHERE user_id = ? AND course_date = ? AND status IN ('pending', 'sending')").bind(nowMs, userId, date),
    db.prepare("UPDATE daily_progress SET status = ?, updated_at_ms = ? WHERE user_id = ? AND course_date = ?").bind(status, nowMs, userId, date),
  ]);
}

export async function resumeToday(db: D1Database, userId: number, date: string, nowMs: number): Promise<number> {
  const daily = await getDaily(db, userId, date);
  if (!daily?.schedule_slots_json) return 0;
  const slots = JSON.parse(daily.schedule_slots_json) as Array<{ ordinal: number; total: number; atMs: number }>;
  let count = 0;
  const statements: D1PreparedStatement[] = [];
  for (const slot of slots) {
    if (slot.atMs < nowMs + 120_000) continue;
    count += 1;
    statements.push(db.prepare("UPDATE reminder_jobs SET status = 'pending', lease_until_ms = NULL, updated_at_ms = ? WHERE user_id = ? AND course_date = ? AND ordinal = ? AND scheduled_at_ms = ? AND status = 'cancelled'").bind(nowMs, userId, date, slot.ordinal, slot.atMs));
  }
  for (let index = 0; index < statements.length; index += 50) await db.batch(statements.slice(index, index + 50));
  await db.prepare("UPDATE daily_progress SET status = ?, updated_at_ms = ? WHERE user_id = ? AND course_date = ?").bind(count > 0 ? "reminders_configured" : "reminders_stopped_today", nowMs, userId, date).run();
  return count;
}
