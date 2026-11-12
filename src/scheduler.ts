import { CALLBACK, cleanPersian, escapeHtml, splitText } from "./content";
import { cancelToday, getDaily, getLesson, getUser, updateUser } from "./db";
import { sendLesson, sendNightQuestion } from "./bot";
import { TelegramClient, TelegramError } from "./telegram";
import { addLocalDays, formatTimeInZone, localDate, localMinuteOfDay, persianClock, persianNumber, zonedEpoch } from "./time";
import type { AppEnv, InlineKeyboardMarkup, UserRow } from "./types";

interface DueJob {
  id: string;
  user_id: number;
  course_date: string;
  lesson_number: number;
  ordinal: number;
  total: number;
  scheduled_at_ms: number;
  attempts: number;
}

export async function runScheduler(env: AppEnv, nowMs: number): Promise<void> {
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.DB);
  await applyPendingTimeZones(env.DB, nowMs);
  await backfillDeliveryTimes(env.DB, nowMs);
  await processDueReminders(env, telegram, nowMs);
  await deliverMorningLessons(env, telegram, nowMs);
  await deliverNightQuestions(env, telegram, nowMs);
  await cleanupOldUpdates(env.DB, nowMs);
}

async function applyPendingTimeZones(db: D1Database, nowMs: number): Promise<void> {
  const users = await db.prepare(`
    SELECT telegram_user_id, pending_time_zone FROM users
    WHERE pending_time_zone IS NOT NULL AND pending_time_zone_effective_at_ms <= ?
    LIMIT 100
  `).bind(nowMs).all<{ telegram_user_id: number; pending_time_zone: string }>();
  for (const user of users.results) {
    await updateUser(db, user.telegram_user_id, {
      time_zone: user.pending_time_zone,
      pending_time_zone: null,
      pending_time_zone_effective_at_ms: null,
      updated_at_ms: nowMs,
    });
  }
}

async function backfillDeliveryTimes(db: D1Database, nowMs: number): Promise<void> {
  const users = await db.prepare(`
    SELECT * FROM users
    WHERE paused = 0 AND completed = 0 AND delivery_blocked = 0
      AND state != 'onboarding' AND start_date IS NOT NULL
      AND next_lesson_at_ms IS NULL
    LIMIT 100
  `).all<UserRow>();
  for (const user of users.results) {
    const date = localDate(nowMs, user.time_zone);
    const minute = localMinuteOfDay(nowMs, user.time_zone);
    const daily = await getDaily(db, user.telegram_user_id, date);
    let nextLessonAt: number;
    let nextNightAt: number | null = null;
    if (user.start_date && user.start_date > date) {
      nextLessonAt = zonedEpoch(user.start_date, 6 * 60, user.time_zone);
    } else if (!daily?.lesson_sent_at_ms) {
      nextLessonAt = minute < 6 * 60 ? zonedEpoch(date, 6 * 60, user.time_zone) : nowMs;
    } else {
      nextLessonAt = zonedEpoch(addLocalDays(date, 1), 6 * 60, user.time_zone);
      if (daily.lesson_number === 365 && !daily.night_question_sent_at_ms && daily.status !== "deferred_to_tomorrow") {
        const scheduledNight = zonedEpoch(date, 20 * 60 + 15, user.time_zone);
        nextNightAt = scheduledNight > nowMs ? scheduledNight : nowMs;
      }
    }
    await updateUser(db, user.telegram_user_id, { next_lesson_at_ms: nextLessonAt, next_night_at_ms: nextNightAt, updated_at_ms: nowMs });
  }
}

async function deliverMorningLessons(env: AppEnv, telegram: TelegramClient, nowMs: number): Promise<void> {
  const result = await env.DB.prepare(`
    SELECT * FROM users
    WHERE paused = 0 AND completed = 0 AND delivery_blocked = 0
      AND state != 'onboarding' AND start_date IS NOT NULL
      AND next_lesson_at_ms IS NOT NULL AND next_lesson_at_ms <= ?
    ORDER BY next_lesson_at_ms
    LIMIT 100
  `).bind(nowMs).all<UserRow>();
  for (const user of result.results) {
    const date = localDate(nowMs, user.time_zone);
    try {
      if (user.start_date && user.start_date > date) {
        await updateUser(env.DB, user.telegram_user_id, { next_lesson_at_ms: zonedEpoch(user.start_date, 6 * 60, user.time_zone), updated_at_ms: nowMs });
        continue;
      }
      const shouldSend = await applyPreviousChoice(env, user, nowMs);
      if (shouldSend) await sendLesson(env, telegram, user.telegram_user_id, date, nowMs, true);
      else await updateUser(env.DB, user.telegram_user_id, { next_lesson_at_ms: null, next_night_at_ms: null, updated_at_ms: nowMs });
    } catch (error) {
      await handleDeliveryError(env, user, error, date, nowMs);
    }
  }
}

async function applyPreviousChoice(env: AppEnv, user: UserRow, nowMs: number): Promise<boolean> {
  if (user.state === "lesson_change_pending" && user.selected_lesson) {
    await updateUser(env.DB, user.telegram_user_id, { current_lesson: user.selected_lesson, selected_lesson: null, state: "active", updated_at_ms: nowMs });
    return true;
  }
  const previous = await env.DB.prepare(`
    SELECT lesson_number, tomorrow_action FROM daily_progress
    WHERE user_id = ? AND lesson_sent_at_ms IS NOT NULL AND lesson_sent_at_ms > 0
    ORDER BY lesson_sent_at_ms DESC LIMIT 1
  `).bind(user.telegram_user_id).first<{ lesson_number: number; tomorrow_action: string | null }>();
  if (!previous) return true;
  const action = previous.tomorrow_action ?? (previous.lesson_number === 365 ? "complete" : "next");
  if (action === "pause") {
    await updateUser(env.DB, user.telegram_user_id, { paused: 1, state: "paused", next_lesson_at_ms: null, next_night_at_ms: null, updated_at_ms: nowMs });
    return false;
  }
  if (action === "complete") {
    await updateUser(env.DB, user.telegram_user_id, { completed: 1, state: "completed", next_lesson_at_ms: null, next_night_at_ms: null, updated_at_ms: nowMs });
    return false;
  }
  const lesson = action === "repeat" ? previous.lesson_number : action === "restart" ? 1 : Math.min(365, previous.lesson_number + 1);
  await updateUser(env.DB, user.telegram_user_id, { current_lesson: lesson, state: "active", updated_at_ms: nowMs });
  return true;
}

async function deliverNightQuestions(env: AppEnv, telegram: TelegramClient, nowMs: number): Promise<void> {
  const users = await env.DB.prepare(`
    SELECT * FROM users
    WHERE paused = 0 AND completed = 0 AND delivery_blocked = 0
      AND next_night_at_ms IS NOT NULL AND next_night_at_ms <= ?
    ORDER BY next_night_at_ms
    LIMIT 100
  `).bind(nowMs).all<UserRow>();
  for (const user of users.results) {
    const date = localDate(nowMs, user.time_zone);
    try {
      await sendNightQuestion(env, telegram, user.telegram_user_id, date, nowMs);
      const refreshed = await getDaily(env.DB, user.telegram_user_id, date);
      if (!refreshed || refreshed.night_question_sent_at_ms || refreshed.status === "deferred_to_tomorrow") {
        await updateUser(env.DB, user.telegram_user_id, { next_night_at_ms: null, updated_at_ms: nowMs });
      }
    } catch (error) {
      await handleDeliveryError(env, user, error, date, nowMs);
    }
  }
}

async function processDueReminders(env: AppEnv, telegram: TelegramClient, nowMs: number): Promise<void> {
  await env.DB.prepare("UPDATE reminder_jobs SET status = 'missed', updated_at_ms = ? WHERE status IN ('pending','sending') AND scheduled_at_ms < ?").bind(nowMs, nowMs - 15 * 60_000).run();
  await env.DB.prepare("UPDATE reminder_jobs SET status = 'pending', lease_until_ms = NULL, updated_at_ms = ? WHERE status = 'sending' AND lease_until_ms < ?").bind(nowMs, nowMs).run();
  const due = await env.DB.prepare("SELECT id, user_id, course_date, lesson_number, ordinal, total, scheduled_at_ms, attempts FROM reminder_jobs WHERE status = 'pending' AND scheduled_at_ms <= ? ORDER BY scheduled_at_ms LIMIT 50").bind(nowMs).all<DueJob>();
  for (const job of due.results) {
    const claimed = await env.DB.prepare("UPDATE reminder_jobs SET status = 'sending', lease_until_ms = ?, attempts = attempts + 1, updated_at_ms = ? WHERE id = ? AND status = 'pending'").bind(nowMs + 2 * 60_000, nowMs, job.id).run();
    if ((claimed.meta.changes ?? 0) !== 1) continue;
    try {
      await sendReminder(env, telegram, job, nowMs);
    } catch (error) {
      const user = await getUser(env.DB, job.user_id);
      if (user) await handleDeliveryError(env, user, error, job.course_date, nowMs);
      const nextStatus = job.attempts >= 2 ? "cancelled" : "pending";
      await env.DB.prepare("UPDATE reminder_jobs SET status = ?, lease_until_ms = NULL, updated_at_ms = ? WHERE id = ? AND status = 'sending'").bind(nextStatus, nowMs, job.id).run();
    }
  }
}

async function sendReminder(env: AppEnv, telegram: TelegramClient, job: DueJob, nowMs: number): Promise<void> {
  const user = await getUser(env.DB, job.user_id);
  const lesson = await getLesson(env.DB, job.lesson_number);
  const daily = await getDaily(env.DB, job.user_id, job.course_date);
  if (!user || !lesson || !daily || daily.status !== "reminders_configured" || localDate(nowMs, user.time_zone) !== job.course_date) {
    await env.DB.prepare("UPDATE reminder_jobs SET status = 'cancelled', updated_at_ms = ? WHERE id = ?").bind(nowMs, job.id).run();
    return;
  }
  const next = await env.DB.prepare("SELECT scheduled_at_ms FROM reminder_jobs WHERE user_id = ? AND course_date = ? AND status = 'pending' AND scheduled_at_ms > ? ORDER BY scheduled_at_ms LIMIT 1").bind(job.user_id, job.course_date, job.scheduled_at_ms).first<{ scheduled_at_ms: number }>();
  const nextLine = next ? `نوبت بعدی: ${persianClock(formatTimeInZone(next.scheduled_at_ms, user.time_zone))}` : "این آخرین یادآوری امروز است.";
  const program = daily.schedule_kind === "interval" ? `\nبرنامه: ${scheduleValueLabel(daily.schedule_value)}` : "";
  const header = `🔔 <b>یادآوری ${persianNumber(job.ordinal)} از ${persianNumber(job.total)}</b>${program}\nدرس ${persianNumber(job.lesson_number)} از ۳۶۵\n\n`;
  const chunks = splitText(cleanPersian(lesson.reminder_fa), 3200);
  const messages: Array<{ text: string; keyboard?: InlineKeyboardMarkup }> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const text = `${index === 0 ? header : ""}${escapeHtml(chunks[index] ?? "")}${index === chunks.length - 1 ? `\n\n${nextLine}` : ""}`;
    const keyboard = index === chunks.length - 1 ? { inline_keyboard: [[{ text: "دیدم ✓", callback_data: `${CALLBACK.seen}:${job.id}` }], [{ text: "توقف یادآوری‌های امروز", callback_data: `${CALLBACK.stop}:${job.course_date}` }, { text: "تغییر برنامهٔ امروز", callback_data: `${CALLBACK.reminders}:${job.course_date}` }]] } : undefined;
    messages.push({ text, ...(keyboard ? { keyboard } : {}) });
  }
  const sent = await telegram.sendEphemeralMessages(user.chat_id, messages);
  const lastMessageId = sent.at(-1)?.message_id ?? null;
  await env.DB.prepare("UPDATE reminder_jobs SET status = 'sent', sent_at_ms = ?, telegram_message_id = ?, lease_until_ms = NULL, updated_at_ms = ? WHERE id = ? AND status = 'sending'").bind(nowMs, lastMessageId, nowMs, job.id).run();
}

async function handleDeliveryError(env: AppEnv, user: UserRow, error: unknown, date: string, nowMs: number): Promise<void> {
  console.error("delivery_failed", { userId: user.telegram_user_id, date, error: error instanceof Error ? error.message : String(error) });
  if (error instanceof TelegramError && error.code === 403) {
    await updateUser(env.DB, user.telegram_user_id, { delivery_blocked: 1, state: "delivery_blocked", next_lesson_at_ms: null, next_night_at_ms: null, updated_at_ms: nowMs });
    await cancelToday(env.DB, user.telegram_user_id, date, "delivery_blocked", nowMs);
  }
}

async function cleanupOldUpdates(db: D1Database, nowMs: number): Promise<void> {
  await db.prepare("DELETE FROM telegram_updates WHERE received_at_ms < ?").bind(nowMs - 7 * 24 * 60 * 60_000).run();
}

function scheduleValueLabel(value: string | null): string {
  if (!value) return "فاصلهٔ زمانی";
  const minutes = Number(value);
  return minutes % 60 === 0 ? `هر ${persianNumber(minutes / 60)} ساعت` : `هر ${persianNumber(minutes)} دقیقه`;
}
