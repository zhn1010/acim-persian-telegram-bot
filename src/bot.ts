import { CALLBACK, cleanPersian, escapeHtml, mainMenu, splitText, welcomeText } from "./content";
import { cancelToday, claimDailyAudio, completeDailyAudio, configureSchedule, createOrRefreshUser, ensureDaily, getDaily, getLesson, getUser, releaseDailyAudio, resumeToday, updateUser } from "./db";
import { makeCountSchedule, makeIntervalSchedule } from "./schedule";
import { TelegramClient } from "./telegram";
import { addLocalDays, formatClock, formatPersianDuration, formatTimeInZone, isValidTimeZone, latinDigits, localDate, localMinuteOfDay, nextZonedOccurrence, persianClock, persianNumber, zonedEpoch } from "./time";
import { timeZoneCurrentTime, timeZoneLabel, timeZoneRegionDescription, timeZoneRegionKeyboard } from "./timezones";
import type { AppEnv, CourseOption, InlineKeyboardMarkup, LessonRow, PendingSchedule, TelegramCallbackQuery, TelegramMessage, TelegramUpdate, UserRow } from "./types";

const COUNT_OPTIONS = [2, 3, 4, 5];
const BOT_TELEGRAM_URL = "https://t.me/ACIMDailyCompanionBot";

export async function handleUpdate(update: TelegramUpdate, env: AppEnv, nowMs = Date.now()): Promise<void> {
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.DB);
  if (update.message) {
    await handleMessage(update.message, env, telegram, nowMs);
    await telegram.deleteMessage(update.message.chat.id, update.message.message_id).catch(() => undefined);
  }
  else if (update.callback_query) await handleCallback(update.callback_query, env, telegram, nowMs);
}

async function handleMessage(message: TelegramMessage, env: AppEnv, telegram: TelegramClient, nowMs: number): Promise<void> {
  if (!message.from) return;
  const previousUser = await getUser(env.DB, message.from.id);
  const user = await createOrRefreshUser(env.DB, message.from.id, message.chat.id, message.from.first_name, nowMs);
  if (message.web_app_data) {
    await handleTimeZoneWebAppData(env, telegram, user, message.web_app_data.data, nowMs);
    return;
  }
  if (!message.text) return;
  const text = message.text.trim();
  const command = text.split(/\s+/, 1)[0]?.split("@", 1)[0];

  if (command === "/start") {
    if (previousUser?.delivery_blocked) {
      await updateUser(env.DB, user.telegram_user_id, { paused: 1, state: "paused", updated_at_ms: nowMs });
      await telegram.sendMessage(user.chat_id, `خوش آمدی 🌿\nهنگام غیبت تو دوره جلو نرفته است. درس ذخیره‌شده: ${lessonLabel(user.current_lesson)}\n\nمی‌خواهی از همین درس ادامه بدهی یا شمارهٔ دیگری انتخاب کنی؟`, { inline_keyboard: [[{ text: "ادامه از همین درس", callback_data: CALLBACK.continueCourse }], [{ text: "انتخاب درس دیگر", callback_data: CALLBACK.changeLesson }]] });
      return;
    }
    if (user.state === "onboarding") await showWelcome(telegram, user.chat_id);
    else await showExistingUser(env, telegram, user, nowMs);
    return;
  }
  if (command === "/help" || text === "راهنما") {
    await showHelp(telegram, user.chat_id, user.state === "onboarding");
    return;
  }
  if (command === "/lesson") return startLessonNumberInput(env, telegram, user, nowMs);
  if (command === "/settings") {
    await showSettings(telegram, user, nowMs);
    return;
  }
  if (user.pending_input) {
    await handlePendingInput(env, telegram, user, text, nowMs);
    return;
  }
  await telegram.sendMessage(user.chat_id, "برای ادامه از دکمه‌های زیر استفاده کن.", mainMenu);
}

async function handleCallback(query: TelegramCallbackQuery, env: AppEnv, telegram: TelegramClient, nowMs: number): Promise<void> {
  const chatId = query.message?.chat.id;
  const data = query.data;
  if (!chatId || !data) return;
  const user = await createOrRefreshUser(env.DB, query.from.id, chatId, query.from.first_name, nowMs);

  if (data.startsWith(`${CALLBACK.audioSend}:`)) return sendAudioForCallback(env, telegram, query, user, data, nowMs);
  await telegram.answerCallback(query.id).catch(() => undefined);
  if (data.startsWith(`${CALLBACK.seen}:`)) return acknowledgeReminder(env, telegram, query, user, data, nowMs);
  if (shouldClearCallbackKeyboard(data)) await clearCallbackKeyboard(telegram, query);

  if (data === CALLBACK.timeZoneAuto) return showAutomaticTimeZoneDetector(env, telegram, user);
  if (data === CALLBACK.timeZoneManual || data === CALLBACK.timeZoneSettings) return showTimeZoneChoice(env, telegram, user, nowMs, data === CALLBACK.timeZoneSettings ? "settings" : undefined);
  if (data === CALLBACK.timeZoneConfirmCurrent) return confirmCurrentTimeZone(env, telegram, user, nowMs);
  if (data.startsWith("tz:region:")) return showTimeZoneRegion(telegram, user, data.slice("tz:region:".length), nowMs);
  if (data.startsWith("tz:set:")) return selectTimeZone(env, telegram, user, data.slice("tz:set:".length), nowMs);
  if (data === CALLBACK.audioSettings) return showAudioSettings(telegram, user);
  if (data === CALLBACK.audioOnDemand || data === CALLBACK.audioAutomatic) return setAudioPreference(env, telegram, user, data, nowMs);

  if (data === CALLBACK.backWelcome) return showWelcome(telegram, chatId);
  if (data === CALLBACK.how) return showHelp(telegram, chatId, true);
  if (data === CALLBACK.help) return showHelp(telegram, chatId, user.state === "onboarding");
  if (data === CALLBACK.start) return showLessonChoice(telegram, chatId);
  if (data === CALLBACK.lessonOne) return selectOnboardingLesson(env, telegram, user, 1, nowMs);
  if (data === CALLBACK.lessonCustom || data === CALLBACK.changeLesson) return startLessonNumberInput(env, telegram, user, nowMs, data === CALLBACK.lessonCustom);
  if (data === CALLBACK.confirmLesson) return showTimeZoneChoice(env, telegram, user, nowMs, "onboarding");
  if (data.startsWith("o:when:")) return activateOnboarding(env, telegram, user, data, nowMs);

  if (data === CALLBACK.today) return showToday(env, telegram, user, nowMs);
  if (/^m:text:\d+$/.test(data)) return resendTodayText(env, telegram, user, Number(data.split(":")[2]), nowMs);
  if (data === CALLBACK.courseStatus) return showCourseStatus(env, telegram, user, nowMs);
  if (data === CALLBACK.reminderStatus) return showReminderStatus(env, telegram, user, nowMs);
  if (data === CALLBACK.settings) return showSettings(telegram, user, nowMs);
  if (data === CALLBACK.continueCourse) return continueCourse(env, telegram, user, nowMs);
  if (data === CALLBACK.pauseCourse) return askPauseCourse(telegram, user.chat_id);
  if (data === CALLBACK.pauseCourseConfirm) return pauseCourse(env, telegram, user, nowMs);
  if (data === CALLBACK.lessonTomorrow || data === CALLBACK.lessonNow || data === CALLBACK.lessonTodayAtSix) return applyLessonChange(env, telegram, user, data, nowMs);
  if (data === CALLBACK.restart) return askRestart(telegram, chatId);
  if (data === CALLBACK.restartConfirm) return restartCourse(env, telegram, user, nowMs);

  if (matchesDated(data, CALLBACK.studied)) {
    if (isStaleDated(data, CALLBACK.studied, nowMs, user.time_zone)) return staleButton(telegram, user.chat_id);
    return markStudiedAndShowSchedule(env, telegram, user, nowMs);
  }
  if (matchesDated(data, CALLBACK.reminders)) {
    if (isStaleDated(data, CALLBACK.reminders, nowMs, user.time_zone)) return staleButton(telegram, user.chat_id);
    return showScheduleSelector(env, telegram, user, nowMs);
  }
  if (matchesDated(data, CALLBACK.noReminders)) {
    if (isStaleDated(data, CALLBACK.noReminders, nowMs, user.time_zone)) return staleButton(telegram, user.chat_id);
    return chooseNoReminders(env, telegram, user, nowMs);
  }
  if (matchesDated(data, CALLBACK.defer)) {
    if (isStaleDated(data, CALLBACK.defer, nowMs, user.time_zone)) return staleButton(telegram, user.chat_id);
    return deferToday(env, telegram, user, nowMs);
  }
  if (/^r:c:\d+(?::\d{4}-\d{2}-\d{2})?$/.test(data)) {
    const parts = data.split(":");
    if (parts[3] && parts[3] !== localDate(nowMs, user.time_zone)) return staleButton(telegram, user.chat_id);
    return selectSchedule(env, telegram, user, makeCountSchedule(Number(parts[2]), nowMs, user.current_lesson, user.time_zone), nowMs);
  }
  if (/^r:i:\d+(?::\d{4}-\d{2}-\d{2})?$/.test(data)) {
    const parts = data.split(":");
    if (parts[3] && parts[3] !== localDate(nowMs, user.time_zone)) return staleButton(telegram, user.chat_id);
    return selectSchedule(env, telegram, user, makeIntervalSchedule(Number(parts[2]), nowMs, user.current_lesson, user.time_zone), nowMs);
  }
  if (matchesDated(data, CALLBACK.confirmSchedule) || matchesDated(data, CALLBACK.denseConfirm)) {
    const prefix = data.startsWith(CALLBACK.denseConfirm) ? CALLBACK.denseConfirm : CALLBACK.confirmSchedule;
    if (isStaleDated(data, prefix, nowMs, user.time_zone)) return staleButton(telegram, user.chat_id);
    return confirmPendingSchedule(env, telegram, user, prefix === CALLBACK.denseConfirm, nowMs);
  }
  if (matchesDated(data, CALLBACK.stop)) {
    if (isStaleDated(data, CALLBACK.stop, nowMs, user.time_zone)) return staleButton(telegram, user.chat_id);
    return stopReminders(env, telegram, user, nowMs);
  }
  if (matchesDated(data, CALLBACK.resume)) {
    if (isStaleDated(data, CALLBACK.resume, nowMs, user.time_zone)) return staleButton(telegram, user.chat_id);
    return resumeReminders(env, telegram, user, nowMs);
  }
  if (data.startsWith("n:")) return handleTomorrowChoice(env, telegram, user, data, nowMs);
  await telegram.sendMessage(chatId, "این دکمه دیگر فعال نیست. وضعیت فعلی را از منوی زیر ببین.", mainMenu);
}

async function showWelcome(telegram: TelegramClient, chatId: number): Promise<void> {
  await telegram.sendMessage(chatId, welcomeText, {
    inline_keyboard: [
      [{ text: "شروع کنیم", callback_data: CALLBACK.start }],
      [{ text: "این ربات چطور کار می‌کند؟", callback_data: CALLBACK.how }],
    ],
  });
}

async function showHelp(telegram: TelegramClient, chatId: number, onboarding: boolean): Promise<void> {
  await telegram.sendMessage(chatId, "هر روز ساعت ۶ صبح به وقت محلی خودت متن کامل درس را می‌بینی. اگر فایل صوتی آماده باشد، می‌توانی آن را داخل تلگرام پخش کنی یا ارسال خودکار صوت را فعال کنی. پس از مطالعه می‌توانی فقط برای همان روز یادآوری تنظیم کنی یا بدون یادآوری ادامه بدهی. فردا به‌صورت خودکار درس بعدی ارسال می‌شود؛ فقط پس از درس ۳۶۵ دربارهٔ پایان یا شروع دوبارهٔ دوره از تو می‌پرسم.", onboarding ? {
    inline_keyboard: [[{ text: "شروع کنیم", callback_data: CALLBACK.start }], [{ text: "بازگشت", callback_data: CALLBACK.backWelcome }]],
  } : mainMenu);
}

async function showLessonChoice(telegram: TelegramClient, chatId: number): Promise<void> {
  await telegram.sendMessage(chatId, "الان می‌خواهی از کدام درس شروع کنی؟", {
    inline_keyboard: [
      [{ text: "از ابتدای دوره شروع می‌کنم", callback_data: CALLBACK.lessonOne }],
      [{ text: "شمارهٔ درس دیگری را وارد می‌کنم", callback_data: CALLBACK.lessonCustom }],
    ],
  });
}

async function startLessonNumberInput(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number, onboarding = user.state === "onboarding"): Promise<void> {
  await updateUser(env.DB, user.telegram_user_id, { pending_input: onboarding ? "lesson_number" : "change_lesson_number", updated_at_ms: nowMs });
  await telegram.sendMessage(user.chat_id, "شمارهٔ درس را از ۱ تا ۳۶۵ بفرست.\nمثال: <code>۲۵</code>", {
    inline_keyboard: [[{ text: onboarding ? "بازگشت به انتخاب درس" : "لغو", callback_data: onboarding ? CALLBACK.start : CALLBACK.settings }]],
  });
}

async function selectOnboardingLesson(env: AppEnv, telegram: TelegramClient, user: UserRow, lessonNumber: number, nowMs: number): Promise<void> {
  const lesson = await requireLesson(env, lessonNumber);
  await updateUser(env.DB, user.telegram_user_id, { selected_lesson: lessonNumber, pending_input: null, updated_at_ms: nowMs });
  await telegram.sendMessage(user.chat_id, `درس انتخابی تو:\n<b>درس ${persianNumber(lessonNumber)} از ۳۶۵</b>\n«${escapeHtml(cleanPersian(lesson.title_fa))}»\n\nدرست است؟`, {
    inline_keyboard: [[{ text: "بله، همین درس", callback_data: CALLBACK.confirmLesson }], [{ text: "تغییر شمارهٔ درس", callback_data: CALLBACK.changeLesson }]],
  });
}

async function showStartTiming(env: AppEnv, telegram: TelegramClient, originalUser: UserRow, nowMs: number): Promise<void> {
  const user = (await getUser(env.DB, originalUser.telegram_user_id)) ?? originalUser;
  if (!user.selected_lesson) return showLessonChoice(telegram, user.chat_id);
  const minute = localMinuteOfDay(nowMs, user.time_zone);
  const localClock = persianClock(formatClock(minute));
  const timeContext = `اکنون به وقت ${timeZoneLabel(user.time_zone, nowMs)}: ${localClock}`;
  if (minute < 5 * 60 + 55) {
    const countdown = formatPersianDuration(6 * 60 - minute);
    await telegram.sendMessage(user.chat_id, `چه زمانی شروع کنیم؟\n\n${timeContext}\nساعت ۶ صبح امروز هنوز نرسیده است.`, { inline_keyboard: [[{ text: `امروز ساعت ۶:۰۰ — حدود ${countdown} دیگر`, callback_data: CALLBACK.startToday }], [{ text: "فردا ساعت ۶:۰۰", callback_data: CALLBACK.startTomorrow }]] });
  } else if (minute < 6 * 60) {
    await telegram.sendMessage(user.chat_id, `${timeContext}\nکمتر از ۵ دقیقه تا ساعت ۶ مانده است. برای اینکه اولین درس از دست نرود، می‌توانم آن را همین حالا نشان بدهم یا از فردا منظم شروع کنیم.`, { inline_keyboard: [[{ text: "همین حالا شروع کن", callback_data: CALLBACK.startNow }], [{ text: "فردا ساعت ۶:۰۰", callback_data: CALLBACK.startTomorrow }]] });
  } else if (minute <= 19 * 60 + 57) {
    await telegram.sendMessage(user.chat_id, `${timeContext}\nزمان ارسال ساعت ۶ امروز گذشته است. می‌توانم درس را همین حالا نشان بدهم یا از فردا منظم شروع کنیم.`, { inline_keyboard: [[{ text: "همین حالا شروع کن", callback_data: CALLBACK.startNow }], [{ text: "فردا ساعت ۶:۰۰", callback_data: CALLBACK.startTomorrow }]] });
  } else {
    await telegram.sendMessage(user.chat_id, `${timeContext}\nبازهٔ یادآوری امروز تقریباً تمام شده است. پیشنهاد می‌کنم از فردا ساعت ۶ صبح شروع کنیم.`, { inline_keyboard: [[{ text: "فردا ساعت ۶:۰۰ — پیشنهاد ما", callback_data: CALLBACK.startTomorrow }], [{ text: "فقط متن درس را الان ببینم", callback_data: CALLBACK.textNow }]] });
  }
}

async function activateOnboarding(env: AppEnv, telegram: TelegramClient, originalUser: UserRow, action: string, nowMs: number): Promise<void> {
  const user = (await getUser(env.DB, originalUser.telegram_user_id)) ?? originalUser;
  const lesson = user.selected_lesson;
  if (!lesson) return showLessonChoice(telegram, user.chat_id);
  const today = localDate(nowMs, user.time_zone);
  const tomorrow = addLocalDays(today, 1);
  if (action === CALLBACK.startTomorrow || action === CALLBACK.startToday) {
    const startDate = action === CALLBACK.startTomorrow ? tomorrow : today;
    const nextLessonAt = zonedEpoch(startDate, 6 * 60, user.time_zone);
    await updateUser(env.DB, user.telegram_user_id, { current_lesson: lesson, start_date: startDate, state: "active_before_lesson", pending_input: null, selected_lesson: null, paused: 0, completed: 0, next_lesson_at_ms: nextLessonAt, next_night_at_ms: null, updated_at_ms: nowMs });
    await telegram.sendMessage(user.chat_id, `آماده‌ایم ✅\n\nدرس فعلی: ${lessonLabel(lesson)}\nشروع: ${startDate === today ? "امروز" : "فردا"} ساعت ۶:۰۰ صبح\nمنطقهٔ زمانی: ${timeZoneLabel(user.time_zone, nowMs)}\n\nبعد از دریافت هر درس، برنامهٔ یادآوری همان روز را انتخاب می‌کنی.`, mainMenu);
    return;
  }
  await updateUser(env.DB, user.telegram_user_id, { current_lesson: lesson, start_date: today, state: "active", pending_input: null, selected_lesson: null, paused: 0, completed: 0, updated_at_ms: nowMs });
  await sendLesson(env, telegram, user.telegram_user_id, today, nowMs, action !== CALLBACK.textNow);
  if (action === CALLBACK.textNow) {
    await cancelToday(env.DB, user.telegram_user_id, today, "no_reminders_today", nowMs);
    if (localMinuteOfDay(nowMs, user.time_zone) >= 20 * 60 + 15) await sendNightQuestion(env, telegram, user.telegram_user_id, today, nowMs);
  }
}

async function handlePendingInput(env: AppEnv, telegram: TelegramClient, user: UserRow, input: string, nowMs: number): Promise<void> {
  const pendingInput = user.pending_input;
  if (!pendingInput) return;
  if (pendingInput === "lesson_number") {
    const normalized = latinDigits(input);
    if (!/^\d+$/.test(normalized)) return void (await telegram.sendMessage(user.chat_id, "لطفاً فقط یک شماره از ۱ تا ۳۶۵ بفرست."));
    const lesson = Number(normalized);
    if (lesson < 1 || lesson > 365) return void (await telegram.sendMessage(user.chat_id, "شمارهٔ درس باید بین ۱ و ۳۶۵ باشد."));
    return selectOnboardingLesson(env, telegram, user, lesson, nowMs);
  }
  if (pendingInput === "change_lesson_number") {
    const normalized = latinDigits(input);
    if (!/^\d+$/.test(normalized)) return void (await telegram.sendMessage(user.chat_id, "لطفاً فقط یک شماره از ۱ تا ۳۶۵ بفرست."));
    const lessonNumber = Number(normalized);
    if (lessonNumber < 1 || lessonNumber > 365) return void (await telegram.sendMessage(user.chat_id, "شمارهٔ درس باید بین ۱ و ۳۶۵ باشد."));
    const lesson = await requireLesson(env, lessonNumber);
    await updateUser(env.DB, user.telegram_user_id, { selected_lesson: lessonNumber, pending_input: null, updated_at_ms: nowMs });
    const date = localDate(nowMs, user.time_zone);
    const daily = await getDaily(env.DB, user.telegram_user_id, date);
    const beforeSixAndUnsent = localMinuteOfDay(nowMs, user.time_zone) < 6 * 60 && !daily?.lesson_sent_at_ms;
    const unsent = !daily?.lesson_sent_at_ms;
    const rows: InlineKeyboardMarkup["inline_keyboard"] = beforeSixAndUnsent
      ? [[{ text: "امروز ساعت ۶:۰۰ — پیشنهاد ما", callback_data: CALLBACK.lessonTodayAtSix }], [{ text: "همین حالا نشان بده", callback_data: CALLBACK.lessonNow }], [{ text: "فردا ساعت ۶:۰۰", callback_data: CALLBACK.lessonTomorrow }]]
      : unsent
        ? [[{ text: "همین حالا بفرست — پیشنهاد ما", callback_data: CALLBACK.lessonNow }], [{ text: "از فردا ساعت ۶:۰۰ اعمال کن", callback_data: CALLBACK.lessonTomorrow }]]
        : [[{ text: "از فردا ساعت ۶:۰۰ — پیشنهاد ما", callback_data: CALLBACK.lessonTomorrow }], [{ text: "همین حالا جایگزین درس امروز کن", callback_data: CALLBACK.lessonNow }]];
    rows.push([{ text: "لغو", callback_data: CALLBACK.settings }]);
    await telegram.sendMessage(user.chat_id, `<b>${lessonLabel(lessonNumber)}</b>\n«${escapeHtml(cleanPersian(lesson.title_fa))}»\n\nاز چه زمانی اعمال شود؟`, { inline_keyboard: rows });
    return;
  }
  if (pendingInput.startsWith("custom_")) {
    await updateUser(env.DB, user.telegram_user_id, { pending_input: null, updated_at_ms: nowMs });
    await telegram.sendMessage(user.chat_id, "گزینه‌های یادآوری ساده‌تر شده‌اند. لطفاً یکی از گزینه‌های امروز را انتخاب کن.");
    return showScheduleSelector(env, telegram, user, nowMs);
  }
}

export async function sendLesson(env: AppEnv, telegram: TelegramClient, userId: number, date: string, nowMs: number, offerReminders = true): Promise<void> {
  const user = await getUser(env.DB, userId);
  if (!user || user.paused || user.completed || user.delivery_blocked) return;
  const daily = await ensureDaily(env.DB, userId, date, user.current_lesson, nowMs);
  if (daily.lesson_sent_at_ms && daily.lesson_sent_at_ms > 0) return;
  const claim = await env.DB.prepare(`
    UPDATE daily_progress SET lesson_sent_at_ms = ?, updated_at_ms = ?
    WHERE user_id = ? AND course_date = ?
      AND (lesson_sent_at_ms IS NULL OR (lesson_sent_at_ms < 0 AND lesson_sent_at_ms > ?))
  `).bind(-nowMs, nowMs, userId, date, -(nowMs - 5 * 60_000)).run();
  if ((claim.meta.changes ?? 0) !== 1) return;
  const lesson = await requireLesson(env, daily.lesson_number);
  const audioCaption = `🎧 <b>فایل صوتی ${lessonLabel(lesson.lesson_number)}</b>`;
  try {
    if (user.audio_delivery === "automatic" && lesson.telegram_audio_file_id) {
      if (!(daily.audio_sent_at_ms && daily.audio_sent_at_ms > 0)) {
        const sent = await telegram.sendAudio(user.chat_id, lesson.telegram_audio_file_id, audioCaption, undefined, lesson.telegram_audio_duration ?? undefined);
        await env.DB.prepare("UPDATE daily_progress SET audio_sent_at_ms = ?, audio_message_id = ?, updated_at_ms = ? WHERE user_id = ? AND course_date = ?")
          .bind(nowMs, sent.message_id, nowMs, userId, date).run();
      }
    }
    const audioSent = user.audio_delivery === "automatic" && Boolean(lesson.telegram_audio_file_id);
    await sendLessonText(telegram, user.chat_id, lesson, date, audioSent);
  } catch (error) {
    await env.DB.prepare("UPDATE daily_progress SET lesson_sent_at_ms = NULL, updated_at_ms = ? WHERE user_id = ? AND course_date = ? AND lesson_sent_at_ms = ?").bind(nowMs, userId, date, -nowMs).run();
    throw error;
  }
  await env.DB.prepare("UPDATE daily_progress SET status = ?, lesson_sent_at_ms = ?, updated_at_ms = ? WHERE user_id = ? AND course_date = ? AND lesson_sent_at_ms = ?")
    .bind(offerReminders ? "lesson_delivered" : "no_reminders_today", nowMs, nowMs, userId, date, -nowMs).run();
  const nextDate = addLocalDays(date, 1);
  await updateUser(env.DB, userId, {
    state: "lesson_delivered",
    next_lesson_at_ms: zonedEpoch(nextDate, 6 * 60, user.time_zone),
    next_night_at_ms: lesson.lesson_number === 365 ? zonedEpoch(date, 20 * 60 + 15, user.time_zone) : null,
    updated_at_ms: nowMs,
  });
}

async function sendLessonText(telegram: TelegramClient, chatId: number, lesson: LessonRow, date: string, audioSent = false): Promise<void> {
  const title = cleanPersian(lesson.title_fa);
  const body = removeRepeatedLessonTitle(title, cleanPersian(lesson.full_text_fa));
  const chunks = splitText(body, 3400);
  const messages: Array<{ text: string; keyboard?: InlineKeyboardMarkup }> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const header = index === 0 ? `<b>${lessonLabel(lesson.lesson_number)}</b>\n<b>${escapeHtml(title)}</b>\n\n` : "";
    const label = chunks.length > 1 ? `<i>بخش ${persianNumber(index + 1)} از ${persianNumber(chunks.length)}</i>\n\n` : "";
    const source = index === chunks.length - 1
      ? `\n\n🔗 <a href="${escapeHtml(lesson.text_url_fa)}">مشاهدهٔ این درس در وبسایت</a> | <a href="${escapeHtml(BOT_TELEGRAM_URL)}">همراه دوره‌ای در معجزات</a>`
      : "";
    const actions = lessonActions(lesson, date, audioSent);
    const keyboard = index === chunks.length - 1 && actions.inline_keyboard.length > 0 ? actions : undefined;
    messages.push({ text: `${header}${label}${escapeHtml(chunks[index] ?? "")}${source}`, ...(keyboard ? { keyboard } : {}) });
  }
  await telegram.sendPersistentMessages(chatId, messages);
}

export function removeRepeatedLessonTitle(title: string, fullText: string): string {
  const firstParagraph = /^(.*?)(?:\n\s*\n|$)/s.exec(fullText);
  if (!firstParagraph || normalizeLessonHeading(firstParagraph[1] ?? "") !== normalizeLessonHeading(title)) return fullText;
  return fullText.slice(firstParagraph[0].length).trimStart();
}

function normalizeLessonHeading(value: string): string {
  return value.normalize("NFKC")
    .replaceAll("*", "")
    .replace(/[\u200c\u200e\u200f\u202a-\u202e]/g, " ")
    .replace(/^[«“\"]|[»”\"]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function lessonActions(lesson: LessonRow, date: string, audioSent = false): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  if (lesson.telegram_audio_file_id && !audioSent) rows.push([{ text: "🎧 شنیدن صوت درس", callback_data: `${CALLBACK.audioSend}:${lesson.lesson_number}:${date}` }]);
  rows.push([{ text: "✅ درس امروز را مطالعه کردم", callback_data: dated(CALLBACK.studied, date) }]);
  rows.push([{ text: "⏭ درس امروز را فردا انجام می‌دهم", callback_data: dated(CALLBACK.defer, date) }]);
  rows.push([{ text: "🔢 تغییر شمارهٔ درس", callback_data: CALLBACK.changeLesson }]);
  return { inline_keyboard: rows };
}

async function showScheduleSelector(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number, studyJustRecorded = false): Promise<void> {
  const date = localDate(nowMs, user.time_zone);
  const daily = await getDaily(env.DB, user.telegram_user_id, date);
  if (!daily || !daily.lesson_sent_at_ms) return void (await telegram.sendMessage(user.chat_id, "ابتدا درس امروز باید ارسال شود.", mainMenu));
  if (localMinuteOfDay(nowMs, user.time_zone) > 19 * 60 + 30) {
    await cancelToday(env.DB, user.telegram_user_id, date, "no_reminders_today", nowMs);
    const prefix = studyJustRecorded ? "مطالعهٔ درس امروز ثبت شد ✓\n" : "";
    await telegram.sendMessage(user.chat_id, `${prefix}تا ساعت ۲۰:۰۰ زمان کافی برای یک یادآوری معنادار باقی نمانده است؛ بنابراین امروز یادآوری تازه‌ای تنظیم نمی‌شود.`);
    return;
  }
  const lesson = await requireLesson(env, daily.lesson_number);
  const recommendations = JSON.parse(lesson.schedule_options_json) as CourseOption[];
  const intro = studyJustRecorded
    ? "مطالعهٔ درس امروز ثبت شد ✓\nاگر دوست داری، تا ساعت ۲۰:۰۰ نکتهٔ این درس را به تو یادآوری می‌کنم."
    : "برنامهٔ یادآوری امروز را انتخاب کن:";
  const recommendationText = recommendations.length
    ? `${intro}\n\n<b>پیشنهاد خود درس</b> ⭐\n${recommendations.map((option) => recommendationDescription(option, nowMs, daily.lesson_number, user.time_zone)).join("\n\n")}`
    : `${intro}\nیکی از گزینه‌های زیر را انتخاب کن:`;
  await telegram.sendMessage(user.chat_id, recommendationText, reminderChoiceKeyboard(recommendations, date));
}

async function markStudiedAndShowSchedule(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  const date = localDate(nowMs, user.time_zone);
  const daily = await getDaily(env.DB, user.telegram_user_id, date);
  if (!daily?.lesson_sent_at_ms) return void (await telegram.sendMessage(user.chat_id, "ابتدا درس امروز باید ارسال شود.", mainMenu));
  await env.DB.prepare("UPDATE daily_progress SET studied_at_ms = COALESCE(studied_at_ms, ?), updated_at_ms = ? WHERE user_id = ? AND course_date = ?")
    .bind(nowMs, nowMs, user.telegram_user_id, date).run();
  await showScheduleSelector(env, telegram, user, nowMs, true);
}

export function reminderChoiceKeyboard(recommendations: CourseOption[], date: string): InlineKeyboardMarkup {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = recommendations.length
    ? recommendations.map((option) => [{ text: `⭐ پیشنهاد درس: ${optionLabel(option)}`, callback_data: dated(optionCallback(option), date) }])
    : COUNT_OPTIONS.map((count) => [{ text: `${persianNumber(count)} یادآوری`, callback_data: dated(`r:c:${count}`, date) }]);
  rows.push([{ text: "امروز یادآوری نمی‌خواهم", callback_data: dated(CALLBACK.noReminders, date) }]);
  return { inline_keyboard: rows };
}

async function selectSchedule(env: AppEnv, telegram: TelegramClient, user: UserRow, schedule: PendingSchedule, nowMs: number): Promise<void> {
  const current = await getDaily(env.DB, user.telegram_user_id, schedule.date);
  if (!current || current.lesson_number !== schedule.lesson) return void (await telegram.sendMessage(user.chat_id, "این انتخاب دیگر مربوط به درس امروز نیست.", mainMenu));
  if (schedule.slots.length === 0) {
    await telegram.sendMessage(user.chat_id, "تا پایان بازهٔ امروز زمانی برای این برنامه باقی نمانده است.", { inline_keyboard: [[{ text: "برنامهٔ دیگری انتخاب کن", callback_data: dated(CALLBACK.reminders, schedule.date) }], [{ text: "فقط متن امروز", callback_data: dated(CALLBACK.noReminders, schedule.date) }], [{ text: "همین درس فردا", callback_data: dated(CALLBACK.defer, schedule.date) }]] });
    return;
  }
  if (!schedule.needsDenseConfirmation) return activateSchedule(env, telegram, user, schedule, nowMs);
  await updateUser(env.DB, user.telegram_user_id, { pending_json: JSON.stringify(schedule), updated_at_ms: nowMs });
  const requested = Number(schedule.value);
  const reduced = schedule.kind === "count" && schedule.slots.length < requested
    ? `\nاز ${persianNumber(requested)} نوبت انتخابی، فقط ${persianNumber(schedule.slots.length)} یادآوری با فاصلهٔ قابل استفاده تا ساعت ۲۰:۰۰ جا می‌شود.`
    : "";
  const text = `این برنامه تا ساعت ۲۰:۰۰ فشرده است.${reduced}\n\n${persianNumber(schedule.slots.length)} یادآوری در ساعت‌های زیر ارسال می‌شود:\n${schedule.slots.map((slot) => persianClock(slot.time)).join("، ")}\n\nفعال شود؟`;
  await telegram.sendMessage(user.chat_id, text, { inline_keyboard: [[{ text: "بله، فعال کن", callback_data: dated(CALLBACK.denseConfirm, schedule.date) }], [{ text: "برنامهٔ آرام‌تری می‌خواهم", callback_data: dated(CALLBACK.reminders, schedule.date) }]] });
}

async function confirmPendingSchedule(env: AppEnv, telegram: TelegramClient, originalUser: UserRow, denseConfirmed: boolean, nowMs: number): Promise<void> {
  const user = (await getUser(env.DB, originalUser.telegram_user_id)) ?? originalUser;
  if (!user.pending_json) return void (await telegram.sendMessage(user.chat_id, "برنامه‌ای برای تأیید پیدا نشد.", mainMenu));
  const schedule = JSON.parse(user.pending_json) as PendingSchedule;
  if (schedule.date !== localDate(nowMs, user.time_zone) || schedule.lesson !== user.current_lesson) return void (await telegram.sendMessage(user.chat_id, "این برنامه دیگر مربوط به امروز نیست.", mainMenu));
  if (schedule.needsDenseConfirmation && !denseConfirmed) return selectSchedule(env, telegram, user, schedule, nowMs);
  const refreshed = refreshPendingSchedule(schedule, nowMs);
  if (refreshed.slots.length === 0) return selectSchedule(env, telegram, user, refreshed, nowMs);
  await activateSchedule(env, telegram, user, refreshed, nowMs);
}

async function activateSchedule(env: AppEnv, telegram: TelegramClient, user: UserRow, schedule: PendingSchedule, nowMs: number): Promise<void> {
  await configureSchedule(env.DB, user.telegram_user_id, schedule, nowMs);
  await updateUser(env.DB, user.telegram_user_id, { pending_json: null, state: "reminders_configured", updated_at_ms: nowMs });
  await telegram.sendMessage(user.chat_id, `یادآوری‌های امروز فعال شد ✓\n${persianNumber(schedule.slots.length)} یادآوری از ساعت ${persianClock(schedule.slots[0]?.time ?? "")} تا ${persianClock(schedule.slots.at(-1)?.time ?? "")}\nاولین یادآوری: ${persianClock(schedule.slots[0]?.time ?? "")}`);
}

function refreshPendingSchedule(schedule: PendingSchedule, nowMs: number): PendingSchedule {
  const threshold = nowMs + 120_000;
  const expired = schedule.slots.filter((slot) => slot.atMs < threshold);
  const remaining = schedule.slots.filter((slot) => slot.atMs >= threshold);
  const slots = remaining.map((slot, index) => ({ ...slot, ordinal: index + 1, total: remaining.length }));
  return { ...schedule, missedTimes: [...schedule.missedTimes, ...expired.map((slot) => slot.time)], slots };
}

async function chooseNoReminders(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  const date = localDate(nowMs, user.time_zone);
  await cancelToday(env.DB, user.telegram_user_id, date, "no_reminders_today", nowMs);
  await env.DB.prepare("UPDATE daily_progress SET tomorrow_action = NULL, tomorrow_action_at_ms = NULL, updated_at_ms = ? WHERE user_id = ? AND course_date = ?").bind(nowMs, user.telegram_user_id, date).run();
  const daily = await getDaily(env.DB, user.telegram_user_id, date);
  const next = daily?.lesson_number === 365
    ? "امشب ساعت ۲۰:۱۵ دربارهٔ پایان یا شروع دوبارهٔ دوره از تو می‌پرسم."
    : "فردا ساعت ۶ صبح درس بعدی را می‌بینی.";
  await telegram.sendMessage(user.chat_id, `ثبت شد ✓\nامروز یادآوری نمی‌فرستم. ${next}`);
}

async function deferToday(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  const date = localDate(nowMs, user.time_zone);
  await cancelToday(env.DB, user.telegram_user_id, date, "deferred_to_tomorrow", nowMs);
  await env.DB.prepare("UPDATE daily_progress SET tomorrow_action = 'repeat', tomorrow_action_at_ms = ?, updated_at_ms = ? WHERE user_id = ? AND course_date = ?").bind(nowMs, nowMs, user.telegram_user_id, date).run();
  await updateUser(env.DB, user.telegram_user_id, { next_night_at_ms: null, updated_at_ms: nowMs });
  const daily = await getDaily(env.DB, user.telegram_user_id, date);
  await telegram.sendMessage(user.chat_id, `ثبت شد ✓\nفردا ساعت ۶ صبح، ${lessonLabel(daily?.lesson_number ?? user.current_lesson)} را دوباره می‌بینی.`);
}

async function stopReminders(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  const date = localDate(nowMs, user.time_zone);
  await cancelToday(env.DB, user.telegram_user_id, date, "reminders_stopped_today", nowMs);
  await telegram.sendMessage(user.chat_id, "یادآوری‌های باقی‌ماندهٔ امروز متوقف شد. متن درس امروز همچنان در دسترس است.");
}

async function resumeReminders(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  const date = localDate(nowMs, user.time_zone);
  const count = await resumeToday(env.DB, user.telegram_user_id, date, nowMs);
  await telegram.sendMessage(user.chat_id, count ? `${persianNumber(count)} یادآوریِ آینده دوباره فعال شد.` : "زمانی از برنامهٔ قبلی برای امروز باقی نمانده است.");
}

async function acknowledgeReminder(env: AppEnv, telegram: TelegramClient, query: TelegramCallbackQuery, user: UserRow, data: string, nowMs: number): Promise<void> {
  const jobId = data.slice(`${CALLBACK.seen}:`.length);
  await env.DB.prepare("UPDATE reminder_jobs SET status = 'acknowledged', updated_at_ms = ? WHERE id = ? AND user_id = ? AND status = 'sent'").bind(nowMs, jobId, user.telegram_user_id).run();
  const date = localDate(nowMs, user.time_zone);
  if (query.message) await telegram.editKeyboard(user.chat_id, query.message.message_id, { inline_keyboard: [[{ text: "توقف یادآوری‌های امروز", callback_data: dated(CALLBACK.stop, date) }, { text: "تغییر برنامهٔ امروز", callback_data: dated(CALLBACK.reminders, date) }]] }).catch(() => undefined);
}

export async function sendNightQuestion(env: AppEnv, telegram: TelegramClient, userId: number, date: string, nowMs: number): Promise<void> {
  const user = await getUser(env.DB, userId);
  const daily = await getDaily(env.DB, userId, date);
  if (!user || !daily || (daily.night_question_sent_at_ms && daily.night_question_sent_at_ms > 0) || daily.status === "deferred_to_tomorrow" || user.paused || user.completed) return;
  if (daily.lesson_number !== 365) {
    await updateUser(env.DB, userId, { next_night_at_ms: null, updated_at_ms: nowMs });
    return;
  }
  const claim = await env.DB.prepare(`
    UPDATE daily_progress SET night_question_sent_at_ms = ?, updated_at_ms = ?
    WHERE user_id = ? AND course_date = ?
      AND (night_question_sent_at_ms IS NULL OR (night_question_sent_at_ms < 0 AND night_question_sent_at_ms > ?))
  `).bind(-nowMs, nowMs, userId, date, -(nowMs - 5 * 60_000)).run();
  if ((claim.meta.changes ?? 0) !== 1) return;
  const text = "دورهٔ ۳۶۵ درس را به پایان رساندی 🌿\nدوست داری ادامه چگونه باشد؟";
  const keyboard: InlineKeyboardMarkup = { inline_keyboard: [[{ text: "پایان دوره — پیش‌فرض", callback_data: `n:complete:${date}` }], [{ text: "تکرار درس ۳۶۵ فردا", callback_data: `n:repeat:${date}` }], [{ text: "شروع دوباره از درس ۱", callback_data: `n:restart:${date}` }]] };
  try {
    await telegram.sendMessage(user.chat_id, text, keyboard);
  } catch (error) {
    await env.DB.prepare("UPDATE daily_progress SET night_question_sent_at_ms = NULL, updated_at_ms = ? WHERE user_id = ? AND course_date = ? AND night_question_sent_at_ms = ?").bind(nowMs, userId, date, -nowMs).run();
    throw error;
  }
  await env.DB.prepare("UPDATE daily_progress SET status = 'awaiting_tomorrow_choice', night_question_sent_at_ms = ?, updated_at_ms = ? WHERE user_id = ? AND course_date = ? AND night_question_sent_at_ms = ?").bind(nowMs, nowMs, userId, date, -nowMs).run();
  await updateUser(env.DB, userId, { next_night_at_ms: null, updated_at_ms: nowMs });
}

async function handleTomorrowChoice(env: AppEnv, telegram: TelegramClient, user: UserRow, data: string, nowMs: number): Promise<void> {
  const [, action, date] = data.split(":");
  if (!action || !date) return;
  const daily = await getDaily(env.DB, user.telegram_user_id, date);
  if (!daily) return void (await telegram.sendMessage(user.chat_id, "این انتخاب دیگر فعال نیست.", mainMenu));
  if (localDate(nowMs, user.time_zone) !== date && localMinuteOfDay(nowMs, user.time_zone) >= 6 * 60) return void (await telegram.sendMessage(user.chat_id, "انتخاب دیشب بسته شده و درس امروز قبلاً ارسال شده است.", mainMenu));
  if (action === "pause") {
    await updateUser(env.DB, user.telegram_user_id, { pending_json: JSON.stringify({ nightDate: date }), updated_at_ms: nowMs });
    await telegram.sendMessage(user.chat_id, "با مکث دوره، تا وقتی خودت دوباره ادامه ندهی، متن صبح، یادآوری و پیام پایان دوره ارسال نمی‌شود.", { inline_keyboard: [[{ text: "بله، دوره را متوقف کن", callback_data: `${CALLBACK.pauseConfirm}:${date}` }], [{ text: "بازگشت", callback_data: `${CALLBACK.pauseCancel}:${date}` }]] });
    return;
  }
  if (action === "pause_yes") {
    await cancelToday(env.DB, user.telegram_user_id, localDate(nowMs, user.time_zone), "paused", nowMs);
    await updateUser(env.DB, user.telegram_user_id, { paused: 1, state: "paused", pending_json: null, next_lesson_at_ms: null, next_night_at_ms: null, updated_at_ms: nowMs });
    await env.DB.prepare("UPDATE daily_progress SET tomorrow_action = 'pause', tomorrow_action_at_ms = ?, updated_at_ms = ? WHERE user_id = ? AND course_date = ?").bind(nowMs, nowMs, user.telegram_user_id, date).run();
    await telegram.sendMessage(user.chat_id, "دوره متوقف شد. هر زمان آماده بودی، دکمهٔ «ادامهٔ دوره» را بزن.", { inline_keyboard: [[{ text: "ادامهٔ دوره", callback_data: CALLBACK.continueCourse }, { text: "وضعیت من", callback_data: CALLBACK.courseStatus }]] });
    return;
  }
  if (action === "pause_no") return sendNightQuestionAgain(env, telegram, user, daily);
  const allowed = new Set(["next", "repeat", "complete", "restart", "restart_yes"]);
  if (!allowed.has(action)) return;
  const storedAction = action === "restart_yes" ? "restart" : action;
  await env.DB.prepare("UPDATE daily_progress SET tomorrow_action = ?, tomorrow_action_at_ms = ?, updated_at_ms = ? WHERE user_id = ? AND course_date = ?").bind(storedAction, nowMs, nowMs, user.telegram_user_id, date).run();
  const nextLesson = action === "repeat" ? daily.lesson_number : action === "restart" || action === "restart_yes" ? 1 : Math.min(365, daily.lesson_number + 1);
  const confirmation = action === "complete" ? "ثبت شد ✓\nدوره پایان‌یافته ثبت شد." : action === "repeat" ? `ثبت شد ✓\nفردا ساعت ۶ صبح، ${lessonLabel(daily.lesson_number)} دوباره ارسال می‌شود.` : action === "restart" || action === "restart_yes" ? "ثبت شد ✓\nفردا ساعت ۶ صبح، درس ۱ از ۳۶۵ را می‌بینی." : `ثبت شد ✓\nفردا ساعت ۶ صبح، ${lessonLabel(nextLesson)} را می‌بینی.`;
  await telegram.sendMessage(user.chat_id, confirmation);
}

function tomorrowKeyboard(date: string, selected: string | null): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: selected === "next" ? "درس بعدی فردا ✓" : "درس بعدی فردا — پیش‌فرض", callback_data: `n:next:${date}` }], [{ text: selected === "repeat" ? "تکرار همین درس فردا ✓" : "تکرار همین درس فردا", callback_data: `n:repeat:${date}` }], [{ text: "مکث دوره", callback_data: `n:pause:${date}` }]] };
}

async function sendNightQuestionAgain(env: AppEnv, telegram: TelegramClient, user: UserRow, daily: { course_date: string; lesson_number: number; tomorrow_action: string | null }): Promise<void> {
  if (daily.lesson_number !== 365) return;
  const keyboard = { inline_keyboard: [[{ text: "پایان دوره — پیش‌فرض", callback_data: `n:complete:${daily.course_date}` }], [{ text: "تکرار درس ۳۶۵ فردا", callback_data: `n:repeat:${daily.course_date}` }], [{ text: "شروع دوباره از درس ۱", callback_data: `n:restart:${daily.course_date}` }]] };
  await telegram.sendMessage(user.chat_id, "دوست داری پس از پایان دوره چگونه ادامه بدهی؟", keyboard);
}

async function showToday(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  const daily = await getDaily(env.DB, user.telegram_user_id, localDate(nowMs, user.time_zone));
  if (!daily?.lesson_sent_at_ms) return void (await telegram.sendMessage(user.chat_id, "درس امروز هنوز ارسال نشده است.", mainMenu));
  const lesson = await requireLesson(env, daily.lesson_number);
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [[{ text: "نمایش دوبارهٔ متن کامل", callback_data: `m:text:${daily.lesson_number}` }]];
  if (lesson.telegram_audio_file_id) rows.push([{ text: "🎧 شنیدن صوت در تلگرام", callback_data: `${CALLBACK.audioSend}:${daily.lesson_number}:${daily.course_date}` }]);
  rows.push([{ text: "یادآوری‌های امروز", callback_data: CALLBACK.reminderStatus }], [{ text: "بازگشت به منو", callback_data: CALLBACK.courseStatus }]);
  const studied = daily.studied_at_ms ? "ثبت شده ✓" : "هنوز ثبت نشده";
  await telegram.sendMessage(user.chat_id, `<b>${lessonLabel(daily.lesson_number)}</b>\n${escapeHtml(cleanPersian(lesson.title_fa))}\n\nمطالعه: ${studied}\nوضعیت یادآوری: ${statusLabel(daily.status)}`, { inline_keyboard: rows });
}

async function resendTodayText(env: AppEnv, telegram: TelegramClient, user: UserRow, lessonNumber: number, nowMs: number): Promise<void> {
  const daily = await getDaily(env.DB, user.telegram_user_id, localDate(nowMs, user.time_zone));
  if (!daily || daily.lesson_number !== lessonNumber || !daily.lesson_sent_at_ms) {
    await telegram.sendMessage(user.chat_id, "این متن دیگر مربوط به درس امروز نیست.", mainMenu);
    return;
  }
  const lesson = await requireLesson(env, lessonNumber);
  await sendLessonText(telegram, user.chat_id, lesson, localDate(nowMs, user.time_zone), Boolean(daily.audio_sent_at_ms && daily.audio_sent_at_ms > 0));
}

async function showReminderStatus(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  if (localMinuteOfDay(nowMs, user.time_zone) > 20 * 60) return void (await telegram.sendMessage(user.chat_id, "بازهٔ یادآوری امروز تمام شده است. برنامهٔ یادآوری هر روز بعد از دریافت درس همان روز انتخاب می‌شود.", mainMenu));
  const date = localDate(nowMs, user.time_zone);
  const daily = await getDaily(env.DB, user.telegram_user_id, date);
  if (!daily?.schedule_slots_json || daily.status !== "reminders_configured") return void (await telegram.sendMessage(user.chat_id, "برای امروز یادآوری فعالی نداری.", { inline_keyboard: [[{ text: "تنظیم یادآوری‌های امروز", callback_data: CALLBACK.reminders }], [{ text: "منوی اصلی", callback_data: CALLBACK.courseStatus }]] }));
  const counts = await env.DB.prepare("SELECT SUM(CASE WHEN status IN ('sent','acknowledged') THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, MIN(CASE WHEN status = 'pending' THEN scheduled_at_ms END) AS next_ms FROM reminder_jobs WHERE user_id = ? AND course_date = ?").bind(user.telegram_user_id, date).first<{ sent: number; pending: number; next_ms: number | null }>();
  const next = counts?.next_ms ? persianClock(formatTimeInZone(counts.next_ms, user.time_zone)) : "—";
  await telegram.sendMessage(user.chat_id, `برنامهٔ امروز: ${escapeHtml(scheduleDisplay(daily.schedule_kind, daily.schedule_value))}\nارسال‌شده: ${persianNumber(counts?.sent ?? 0)}\nباقی‌مانده: ${persianNumber(counts?.pending ?? 0)}\nنوبت بعدی: ${next}`, { inline_keyboard: [[{ text: "تغییر برنامه", callback_data: dated(CALLBACK.reminders, date) }, { text: "توقف یادآوری‌های امروز", callback_data: dated(CALLBACK.stop, date) }]] });
}

async function showCourseStatus(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  const refreshed = (await getUser(env.DB, user.telegram_user_id)) ?? user;
  const daily = await getDaily(env.DB, user.telegram_user_id, localDate(nowMs, user.time_zone));
  const tomorrow = daily?.tomorrow_action === "repeat" ? "تکرار همین درس" : daily?.tomorrow_action === "pause" ? "مکث" : daily?.tomorrow_action === "complete" || daily?.lesson_number === 365 ? "پایان دوره" : "درس بعدی";
  const pendingZone = refreshed.pending_time_zone ? `\nتغییر از فردا: ${timeZoneLabel(refreshed.pending_time_zone, nowMs)}` : "";
  await telegram.sendMessage(user.chat_id, `<b>وضعیت دوره</b>\n\nدرس فعلی: ${lessonLabel(refreshed.current_lesson)}\nوضعیت: ${refreshed.paused ? "متوقف" : refreshed.completed ? "پایان‌یافته" : "فعال"}\nفردا: ${tomorrow}\nزمان متن روزانه: ۰۶:۰۰\nمنطقهٔ زمانی: ${timeZoneLabel(refreshed.time_zone, nowMs)}${pendingZone}`, mainMenu);
}

async function showSettings(telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  await telegram.sendMessage(user.chat_id, `تنظیمات\n\nمنطقهٔ زمانی: ${timeZoneLabel(user.time_zone, nowMs)}\nصوت درس: ${user.audio_delivery === "automatic" ? "ارسال خودکار همراه درس صبح" : "ارسال با زدن دکمه"}`, { inline_keyboard: [[{ text: "🌍 منطقهٔ زمانی", callback_data: CALLBACK.timeZoneSettings }], [{ text: "🎧 نحوهٔ دریافت صوت", callback_data: CALLBACK.audioSettings }], [{ text: "تغییر شمارهٔ درس", callback_data: CALLBACK.changeLesson }], [{ text: "مکث دوره", callback_data: CALLBACK.pauseCourse }], [{ text: "شروع دوباره از ابتدای دوره", callback_data: CALLBACK.restart }], [{ text: "دربارهٔ زمان‌بندی", callback_data: CALLBACK.help }], [{ text: "بازگشت", callback_data: CALLBACK.courseStatus }]] });
}

async function askRestart(telegram: TelegramClient, chatId: number): Promise<void> {
  await telegram.sendMessage(chatId, "این کار شمارهٔ درس فعلی را به ابتدای دوره برمی‌گرداند. سابقه حذف نمی‌شود، اما ادامهٔ دوره از درس ۱ از ۳۶۵ خواهد بود.", { inline_keyboard: [[{ text: "بله، از ابتدای دوره شروع کن", callback_data: CALLBACK.restartConfirm }], [{ text: "لغو", callback_data: CALLBACK.settings }]] });
}

async function restartCourse(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  const date = localDate(nowMs, user.time_zone);
  const tomorrow = addLocalDays(date, 1);
  await cancelToday(env.DB, user.telegram_user_id, date, "restarted", nowMs);
  await updateUser(env.DB, user.telegram_user_id, { selected_lesson: 1, start_date: tomorrow, paused: 0, completed: 0, state: "lesson_change_pending", next_lesson_at_ms: zonedEpoch(tomorrow, 6 * 60, user.time_zone), next_night_at_ms: null, updated_at_ms: nowMs });
  await telegram.sendMessage(user.chat_id, "ثبت شد ✓\nفردا ساعت ۶ صبح، درس ۱ از ۳۶۵ را می‌بینی.");
}

async function continueCourse(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  const date = localDate(nowMs, user.time_zone);
  const startDate = addLocalDays(date, localMinuteOfDay(nowMs, user.time_zone) < 6 * 60 ? 0 : 1);
  await updateUser(env.DB, user.telegram_user_id, { paused: 0, selected_lesson: user.current_lesson, state: "lesson_change_pending", start_date: startDate, next_lesson_at_ms: zonedEpoch(startDate, 6 * 60, user.time_zone), updated_at_ms: nowMs });
  await telegram.sendMessage(user.chat_id, `دوره دوباره فعال شد ✅\n${lessonLabel(user.current_lesson)} در نزدیک‌ترین ساعت ۶ صبح ارسال می‌شود.`, mainMenu);
}

async function askPauseCourse(telegram: TelegramClient, chatId: number): Promise<void> {
  await telegram.sendMessage(chatId, "با مکث دوره، تا وقتی خودت دوباره ادامه ندهی، متن صبح، یادآوری و پیام پایان دوره ارسال نمی‌شود.", { inline_keyboard: [[{ text: "بله، دوره را متوقف کن", callback_data: CALLBACK.pauseCourseConfirm }], [{ text: "بازگشت", callback_data: CALLBACK.settings }]] });
}

async function pauseCourse(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  await cancelToday(env.DB, user.telegram_user_id, localDate(nowMs, user.time_zone), "paused", nowMs);
  await updateUser(env.DB, user.telegram_user_id, { paused: 1, state: "paused", pending_json: null, next_lesson_at_ms: null, next_night_at_ms: null, updated_at_ms: nowMs });
  await telegram.sendMessage(user.chat_id, "دوره متوقف شد. هر زمان آماده بودی، دکمهٔ «ادامهٔ دوره» را بزن.", { inline_keyboard: [[{ text: "ادامهٔ دوره", callback_data: CALLBACK.continueCourse }, { text: "وضعیت من", callback_data: CALLBACK.courseStatus }]] });
}

async function applyLessonChange(env: AppEnv, telegram: TelegramClient, originalUser: UserRow, action: string, nowMs: number): Promise<void> {
  const user = (await getUser(env.DB, originalUser.telegram_user_id)) ?? originalUser;
  if (!user.selected_lesson) return void (await telegram.sendMessage(user.chat_id, "شمارهٔ درس جدید پیدا نشد.", mainMenu));
  const date = localDate(nowMs, user.time_zone);
  if (action === CALLBACK.lessonTodayAtSix && localMinuteOfDay(nowMs, user.time_zone) < 6 * 60) {
    await env.DB.prepare(`
      UPDATE daily_progress SET lesson_number = ?, status = 'lesson_pending', studied_at_ms = NULL,
        audio_sent_at_ms = NULL, audio_message_id = NULL, schedule_kind = NULL, schedule_value = NULL,
        schedule_slots_json = NULL, tomorrow_action = NULL, tomorrow_action_at_ms = NULL, updated_at_ms = ?
      WHERE user_id = ? AND course_date = ? AND lesson_sent_at_ms IS NULL
    `).bind(user.selected_lesson, nowMs, user.telegram_user_id, date).run();
    await updateUser(env.DB, user.telegram_user_id, { state: "lesson_change_pending", start_date: date, paused: 0, completed: 0, next_lesson_at_ms: zonedEpoch(date, 6 * 60, user.time_zone), next_night_at_ms: null, updated_at_ms: nowMs });
    await telegram.sendMessage(user.chat_id, `ثبت شد ✓\n${lessonLabel(user.selected_lesson)} امروز ساعت ۶:۰۰ ارسال می‌شود.`);
    return;
  }
  if (action === CALLBACK.lessonTomorrow) {
    const tomorrow = addLocalDays(date, 1);
    await updateUser(env.DB, user.telegram_user_id, { state: "lesson_change_pending", start_date: tomorrow, paused: 0, completed: 0, next_lesson_at_ms: zonedEpoch(tomorrow, 6 * 60, user.time_zone), next_night_at_ms: null, updated_at_ms: nowMs });
    await telegram.sendMessage(user.chat_id, `ثبت شد ✓\nفردا ساعت ۶ صبح، ${lessonLabel(user.selected_lesson)} را می‌بینی.`);
    return;
  }
  await cancelToday(env.DB, user.telegram_user_id, date, "replacing_lesson", nowMs);
  await env.DB.prepare(`UPDATE daily_progress SET lesson_number = ?, status = 'lesson_pending', lesson_sent_at_ms = NULL, night_question_sent_at_ms = NULL, studied_at_ms = NULL, audio_sent_at_ms = NULL, audio_message_id = NULL, tomorrow_action = NULL, tomorrow_action_at_ms = NULL, schedule_kind = NULL, schedule_value = NULL, schedule_slots_json = NULL, updated_at_ms = ? WHERE user_id = ? AND course_date = ?`).bind(user.selected_lesson, nowMs, user.telegram_user_id, date).run();
  await updateUser(env.DB, user.telegram_user_id, { current_lesson: user.selected_lesson, selected_lesson: null, paused: 0, completed: 0, state: "active", updated_at_ms: nowMs });
  await sendLesson(env, telegram, user.telegram_user_id, date, nowMs, localMinuteOfDay(nowMs, user.time_zone) < 19 * 60 + 58);
  if (localMinuteOfDay(nowMs, user.time_zone) >= 20 * 60 + 15) await sendNightQuestion(env, telegram, user.telegram_user_id, date, nowMs);
}

async function showExistingUser(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  const daily = await getDaily(env.DB, user.telegram_user_id, localDate(nowMs, user.time_zone));
  await telegram.sendMessage(user.chat_id, `دورهٔ تو از قبل فعال است.\nدرس فعلی: ${lessonLabel(user.current_lesson)}\nوضعیت امروز: ${daily ? statusLabel(daily.status) : user.paused ? "دوره متوقف است" : "در انتظار درس"}.`, mainMenu);
  if (!user.time_zone_confirmed_at_ms) {
    await telegram.sendMessage(user.chat_id, `زمان‌بندی فعلی بر اساس ${timeZoneLabel(user.time_zone, nowMs)} است. آیا این درست است؟\nاکنون در این منطقه ساعت ${timeZoneCurrentTime(user.time_zone, nowMs)} است.`, { inline_keyboard: [[{ text: "بله، درست است", callback_data: CALLBACK.timeZoneConfirmCurrent }], [{ text: "🌍 تغییر منطقهٔ زمانی", callback_data: CALLBACK.timeZoneSettings }]] });
  }
}

async function showTimeZoneChoice(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number, context?: "onboarding" | "settings"): Promise<void> {
  if (context) await updateUser(env.DB, user.telegram_user_id, { pending_input: `timezone_${context}`, updated_at_ms: nowMs });
  await telegram.sendMessage(user.chat_id, "منطقهٔ زمانی‌ات را مشخص کن تا درس ساعت ۶ صبح، یادآوری‌ها و پیام پایان دوره بر اساس وقت محلی خودت ارسال شوند.\n\nتشخیص خودکار موقعیت مکانی یا GPS را دریافت نمی‌کند.", {
    inline_keyboard: [
      [{ text: "🪄 تشخیص خودکار — پیشنهاد ما", callback_data: CALLBACK.timeZoneAuto }],
      [{ text: `🇮🇷 وقت ایران — اکنون ${timeZoneCurrentTime("Asia/Tehran", nowMs)}`, callback_data: "tz:set:Asia/Tehran" }],
      [{ text: `🇦🇫 وقت افغانستان — اکنون ${timeZoneCurrentTime("Asia/Kabul", nowMs)}`, callback_data: "tz:set:Asia/Kabul" }],
      [{ text: "خلیج فارس و آسیای جنوبی", callback_data: "tz:region:nearby" }],
      [{ text: "اروپا و ترکیه", callback_data: "tz:region:europe" }],
      [{ text: "آمریکا و کانادا", callback_data: "tz:region:north_america" }],
      [{ text: "استرالیا و نیوزیلند", callback_data: "tz:region:oceania" }],
      [{ text: "منطقهٔ من در فهرست نیست", callback_data: CALLBACK.timeZoneAuto }],
    ],
  });
}

async function showAutomaticTimeZoneDetector(env: AppEnv, telegram: TelegramClient, user: UserRow): Promise<void> {
  const baseUrl = env.APP_BASE_URL?.replace(/\/$/, "") ?? "";
  if (!baseUrl.startsWith("https://")) {
    await telegram.sendMessage(user.chat_id, "تشخیص خودکار فعلاً در دسترس نیست. لطفاً انتخاب دستی را انجام بده.", { inline_keyboard: [[{ text: "انتخاب دستی", callback_data: CALLBACK.timeZoneManual }]] });
    return;
  }
  await telegram.sendMessage(user.chat_id, "دکمهٔ زیر را بزن. یک صفحهٔ کوچک داخل تلگرام باز می‌شود و پس از تأیید، به همین گفت‌وگو برمی‌گردی.", {
    keyboard: [[{ text: "🪄 باز کردن تشخیص خودکار", web_app: { url: `${baseUrl}/timezone` } }]],
    resize_keyboard: true,
    one_time_keyboard: true,
    input_field_placeholder: "تشخیص منطقهٔ زمانی",
  });
}

async function handleTimeZoneWebAppData(env: AppEnv, telegram: TelegramClient, user: UserRow, rawData: string, nowMs: number): Promise<void> {
  let data: { type?: unknown; timeZone?: unknown };
  try {
    if (rawData.length > 512) throw new Error("payload too large");
    data = JSON.parse(rawData) as { type?: unknown; timeZone?: unknown };
  } catch {
    await telegram.sendMessage(user.chat_id, "نتوانستم منطقهٔ زمانی را بخوانم. لطفاً انتخاب دستی را امتحان کن.", { remove_keyboard: true });
    return;
  }
  if (data.type !== "timezone" || typeof data.timeZone !== "string" || !isValidTimeZone(data.timeZone)) {
    await telegram.sendMessage(user.chat_id, "منطقهٔ زمانی دستگاه معتبر نبود. لطفاً انتخاب دستی را امتحان کن.", { remove_keyboard: true });
    return;
  }
  await selectTimeZone(env, telegram, user, data.timeZone, nowMs, true);
}

async function showTimeZoneRegion(telegram: TelegramClient, user: UserRow, region: string, nowMs: number): Promise<void> {
  const keyboard = timeZoneRegionKeyboard(region, nowMs);
  if (!keyboard) {
    await telegram.sendMessage(user.chat_id, "این فهرست در دسترس نیست.", { inline_keyboard: [[{ text: "بازگشت", callback_data: CALLBACK.timeZoneManual }]] });
    return;
  }
  await telegram.sendMessage(user.chat_id, timeZoneRegionDescription(region), keyboard);
}

async function selectTimeZone(env: AppEnv, telegram: TelegramClient, originalUser: UserRow, timeZone: string, nowMs: number, removeKeyboard = false): Promise<void> {
  if (!isValidTimeZone(timeZone)) {
    await telegram.sendMessage(originalUser.chat_id, "این منطقهٔ زمانی معتبر نیست. لطفاً یکی از گزینه‌ها را انتخاب کن.", removeKeyboard ? { remove_keyboard: true } : undefined);
    return;
  }
  const user = (await getUser(env.DB, originalUser.telegram_user_id)) ?? originalUser;
  const onboarding = user.pending_input === "timezone_onboarding" || user.state === "onboarding" || !user.start_date;
  const confirmation = `${timeZoneLabel(timeZone, nowMs)}\nاکنون ساعت ${timeZoneCurrentTime(timeZone, nowMs)} است.`;
  if (onboarding) {
    await updateUser(env.DB, user.telegram_user_id, { time_zone: timeZone, time_zone_confirmed_at_ms: nowMs, pending_time_zone: null, pending_time_zone_effective_at_ms: null, pending_input: null, updated_at_ms: nowMs });
    await telegram.sendMessage(user.chat_id, `منطقهٔ زمانی ثبت شد ✅\n${confirmation}`, removeKeyboard ? { remove_keyboard: true } : undefined);
    const refreshed = (await getUser(env.DB, user.telegram_user_id)) ?? { ...user, time_zone: timeZone, time_zone_confirmed_at_ms: nowMs, pending_input: null };
    await showStartTiming(env, telegram, refreshed, nowMs);
    return;
  }
  if (timeZone === user.time_zone) {
    await updateUser(env.DB, user.telegram_user_id, { time_zone_confirmed_at_ms: nowMs, pending_time_zone: null, pending_time_zone_effective_at_ms: null, pending_input: null, updated_at_ms: nowMs });
    await telegram.sendMessage(user.chat_id, `منطقهٔ زمانی تأیید شد ✅\n${confirmation}`, removeKeyboard ? { remove_keyboard: true } : mainMenu);
    return;
  }
  const oldDate = localDate(nowMs, user.time_zone);
  const effectiveAt = zonedEpoch(addLocalDays(oldDate, 1), 0, user.time_zone);
  const nextLessonAt = user.paused || user.completed ? null : nextZonedOccurrence(effectiveAt, 6 * 60, timeZone);
  await updateUser(env.DB, user.telegram_user_id, {
    pending_time_zone: timeZone,
    pending_time_zone_effective_at_ms: effectiveAt,
    time_zone_confirmed_at_ms: nowMs,
    pending_input: null,
    next_lesson_at_ms: nextLessonAt,
    updated_at_ms: nowMs,
  });
  await telegram.sendMessage(user.chat_id, `تغییر منطقهٔ زمانی ثبت شد ✅\n${confirmation}\n\nبرای اینکه برنامهٔ امروز تکرار یا ناقص نشود، این تغییر از درس فردا اعمال می‌شود.`, removeKeyboard ? { remove_keyboard: true } : mainMenu);
}

async function confirmCurrentTimeZone(env: AppEnv, telegram: TelegramClient, user: UserRow, nowMs: number): Promise<void> {
  await updateUser(env.DB, user.telegram_user_id, { time_zone_confirmed_at_ms: nowMs, updated_at_ms: nowMs });
  await telegram.sendMessage(user.chat_id, `ثبت شد ✅\nهمهٔ زمان‌ها بر اساس ${timeZoneLabel(user.time_zone, nowMs)} محاسبه می‌شوند.`, mainMenu);
}

async function showAudioSettings(telegram: TelegramClient, user: UserRow): Promise<void> {
  const current = user.audio_delivery === "automatic" ? "هر صبح، اگر صوت آن درس آماده باشد، همراه عنوان درس ارسال می‌شود." : "صوت فقط وقتی فرستاده می‌شود که دکمهٔ «شنیدن صوت در تلگرام» را بزنی.";
  await telegram.sendMessage(user.chat_id, `<b>نحوهٔ دریافت صوت درس</b>\n\n${current}\n\nحالت دکمه‌ای حجم اینترنت و شلوغی گفت‌وگو را کمتر می‌کند.`, { inline_keyboard: [[{ text: user.audio_delivery === "on_demand" ? "فقط با زدن دکمه ✓" : "فقط با زدن دکمه — پیشنهاد ما", callback_data: CALLBACK.audioOnDemand }], [{ text: user.audio_delivery === "automatic" ? "ارسال خودکار هر صبح ✓" : "ارسال خودکار هر صبح", callback_data: CALLBACK.audioAutomatic }], [{ text: "بازگشت به تنظیمات", callback_data: CALLBACK.settings }]] });
}

async function setAudioPreference(env: AppEnv, telegram: TelegramClient, user: UserRow, data: string, nowMs: number): Promise<void> {
  const preference = data === CALLBACK.audioAutomatic ? "automatic" : "on_demand";
  await updateUser(env.DB, user.telegram_user_id, { audio_delivery: preference, updated_at_ms: nowMs });
  const text = preference === "automatic"
    ? "ثبت شد ✅\nاز درس بعدی، هرگاه فایل صوتی آماده باشد، صوت همراه پیام صبح ارسال می‌شود."
    : "ثبت شد ✅\nصوت درس فقط با زدن دکمه داخل تلگرام ارسال می‌شود.";
  await telegram.sendMessage(user.chat_id, text, { inline_keyboard: [[{ text: "بازگشت به تنظیمات", callback_data: CALLBACK.settings }]] });
}

async function sendAudioForCallback(env: AppEnv, telegram: TelegramClient, query: TelegramCallbackQuery, user: UserRow, data: string, nowMs: number): Promise<void> {
  const [, , lessonText, date] = data.split(":");
  const lessonNumber = Number(lessonText);
  const today = localDate(nowMs, user.time_zone);
  if (!date || date !== today || !Number.isInteger(lessonNumber)) {
    await telegram.answerCallback(query.id, "این دکمه مربوط به درس امروز نیست.").catch(() => undefined);
    return;
  }
  const daily = await getDaily(env.DB, user.telegram_user_id, date);
  const lesson = await getLesson(env.DB, lessonNumber);
  if (!daily || daily.lesson_number !== lessonNumber || !daily.lesson_sent_at_ms || !lesson?.telegram_audio_file_id) {
    await telegram.answerCallback(query.id, "فایل صوتی این درس هنوز آماده نیست.").catch(() => undefined);
    return;
  }
  const claim = await claimDailyAudio(env.DB, user.telegram_user_id, date, nowMs);
  if (claim === "sent") {
    await telegram.answerCallback(query.id, "صوت این درس قبلاً در همین گفت‌وگو ارسال شده است.").catch(() => undefined);
    if (query.message) await telegram.editKeyboard(user.chat_id, query.message.message_id, lessonActions(lesson, date, true)).catch(() => undefined);
    return;
  }
  if (claim !== "claimed") {
    await telegram.answerCallback(query.id, claim === "busy" ? "صوت در حال ارسال است…" : "درس امروز پیدا نشد.").catch(() => undefined);
    return;
  }
  await telegram.answerCallback(query.id, "در حال ارسال صوت…").catch(() => undefined);
  try {
    const caption = `🎧 <b>فایل صوتی ${lessonLabel(lessonNumber)}</b>`;
    const sent = await telegram.sendAudio(user.chat_id, lesson.telegram_audio_file_id, caption, undefined, lesson.telegram_audio_duration ?? undefined);
    await completeDailyAudio(env.DB, user.telegram_user_id, date, nowMs, sent.message_id, Date.now());
    if (query.message) await telegram.editKeyboard(user.chat_id, query.message.message_id, lessonActions(lesson, date, true)).catch(() => undefined);
  } catch (error) {
    await releaseDailyAudio(env.DB, user.telegram_user_id, date, nowMs, Date.now());
    throw error;
  }
}

function optionLabel(option: CourseOption): string {
  return option.kind === "times_per_day" ? `${persianNumber(option.count)} یادآوری` : intervalButton(option.minutes);
}

function optionCallback(option: CourseOption): string {
  return option.kind === "times_per_day" ? `r:c:${option.count}` : `r:i:${option.minutes}`;
}

function recommendationDescription(option: CourseOption, nowMs: number, lesson: number, timeZone: string): string {
  if (option.kind === "times_per_day") {
    const schedule = makeCountSchedule(option.count, nowMs, lesson, timeZone);
    const reduced = schedule.slots.length < option.count ? `\nتا ساعت ۲۰:۰۰، ${persianNumber(schedule.slots.length)} یادآوری با فاصلهٔ قابل استفاده جا می‌شود.` : "";
    return `${optionLabel(option)}\nساعت‌ها: ${schedule.allTimes.map(persianClock).join("، ")}${reduced}`;
  }
  const schedule = makeIntervalSchedule(option.minutes, nowMs, lesson, timeZone);
  if (schedule.slots.length === 0) return `${optionLabel(option)}\nامروز زمانی باقی نمانده است.`;
  return `${optionLabel(option)}\nاز ${persianClock(schedule.slots[0]?.time ?? "")} تا ${persianClock(schedule.slots.at(-1)?.time ?? "")} — ${persianNumber(schedule.slots.length)} یادآوری`;
}

function intervalButton(minutes: number): string {
  return minutes % 60 === 0 ? `هر ${persianNumber(minutes / 60)} ساعت` : `هر ${persianNumber(minutes)} دقیقه`;
}

function scheduleDisplay(kind: string | null, value: string | null): string {
  if (!kind || !value) return "فعال";
  if (kind === "interval") return intervalButton(Number(value));
  if (kind === "count") return `${persianNumber(value)} بار در روز`;
  return "ساعت‌های دلخواه";
}

function statusLabel(status: string): string {
  return ({ lesson_pending: "در انتظار ارسال", lesson_delivered: "درس ارسال شده؛ برنامه‌ای انتخاب نشده", reminders_configured: "یادآوری‌ها فعال‌اند", no_reminders_today: "بدون یادآوری", deferred_to_tomorrow: "تکرار همین درس فردا", reminders_stopped_today: "یادآوری‌ها متوقف شده‌اند", awaiting_tomorrow_choice: "در انتظار انتخاب فردا", paused: "متوقف" } as Record<string, string>)[status] ?? "وضعیت نامشخص";
}

function lessonLabel(lessonNumber: number): string {
  return `درس ${persianNumber(lessonNumber)} از ۳۶۵`;
}

export function shouldClearCallbackKeyboard(_data: string): boolean {
  return true;
}

async function clearCallbackKeyboard(telegram: TelegramClient, query: TelegramCallbackQuery): Promise<void> {
  if (!query.message) return;
  await telegram.editKeyboard(query.message.chat.id, query.message.message_id, { inline_keyboard: [] }).catch(() => undefined);
}

function dated(prefix: string, date: string): string {
  return `${prefix}:${date}`;
}

function matchesDated(data: string, prefix: string): boolean {
  return data === prefix || data.startsWith(`${prefix}:`);
}

function isStaleDated(data: string, prefix: string, nowMs: number, timeZone: string): boolean {
  if (data === prefix) return false;
  return data.slice(prefix.length + 1) !== localDate(nowMs, timeZone);
}

async function staleButton(telegram: TelegramClient, chatId: number): Promise<void> {
  await telegram.sendMessage(chatId, "این دکمه مربوط به روز دیگری است و برنامهٔ امروز را تغییر نمی‌دهد.", mainMenu);
}

async function requireLesson(env: AppEnv, lessonNumber: number): Promise<LessonRow> {
  const lesson = await getLesson(env.DB, lessonNumber);
  if (!lesson) throw new Error(`Lesson ${lessonNumber} not found`);
  return lesson;
}
