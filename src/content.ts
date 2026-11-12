import type { InlineKeyboardMarkup } from "./types";

export const CALLBACK = {
  start: "o:start",
  how: "o:how",
  backWelcome: "o:welcome",
  lessonOne: "o:l:1",
  lessonCustom: "o:l:custom",
  confirmLesson: "o:l:confirm",
  changeLesson: "o:l:change",
  startNow: "o:when:now",
  startTomorrow: "o:when:tomorrow",
  startToday: "o:when:today",
  textNow: "o:when:text",
  reminders: "r:open",
  studied: "r:studied",
  noReminders: "r:none",
  defer: "r:defer",
  confirmSchedule: "r:confirm",
  denseConfirm: "r:dense",
  stop: "r:stop",
  resume: "r:resume",
  seen: "r:seen",
  today: "m:today",
  reminderStatus: "m:reminders",
  courseStatus: "m:status",
  settings: "m:settings",
  help: "m:help",
  tomorrowNext: "n:next",
  tomorrowRepeat: "n:repeat",
  tomorrowPause: "n:pause",
  pauseConfirm: "n:pause_yes",
  pauseCancel: "n:pause_no",
  continueCourse: "m:continue",
  restart: "m:restart",
  restartConfirm: "m:restart:yes",
  pauseCourse: "m:pause",
  pauseCourseConfirm: "m:pause:yes",
  lessonTomorrow: "m:lesson:tomorrow",
  lessonNow: "m:lesson:now",
  lessonTodayAtSix: "m:lesson:today_six",
  customCount: "r:count:x",
  customInterval: "r:int:x",
  customTimes: "r:times:x",
  audioSend: "a:send",
  audioSettings: "a:settings",
  audioOnDemand: "a:pref:on_demand",
  audioAutomatic: "a:pref:automatic",
  timeZoneSettings: "tz:settings",
  timeZoneAuto: "tz:auto",
  timeZoneManual: "tz:manual",
  timeZoneConfirmCurrent: "tz:confirm_current",
} as const;

export const welcomeText = `سلام 🌿
این ربات هر روز یک درس از «دوره‌ای در معجزات» را به فارسی همراهت می‌آورد.

• متن درس: ساعت ۶ صبح
• یادآوری‌های اختیاری: بین ساعت ۸ صبح تا ۸ شب
• پس از درس ۳۶۵: انتخاب نحوهٔ ادامه در ساعت ۸:۱۵ شب

همهٔ زمان‌ها بر اساس وقت محلی خودت تنظیم می‌شود.`;

export const mainMenu: InlineKeyboardMarkup = {
  inline_keyboard: [
    [{ text: "📖 درس امروز", callback_data: CALLBACK.today }, { text: "🔔 یادآوری‌های امروز", callback_data: CALLBACK.reminderStatus }],
    [{ text: "🔢 تغییر شمارهٔ درس", callback_data: CALLBACK.changeLesson }, { text: "⚙️ تنظیمات", callback_data: CALLBACK.settings }],
    [{ text: "📊 وضعیت دوره", callback_data: CALLBACK.courseStatus }, { text: "❓ راهنما", callback_data: CALLBACK.help }],
  ],
};

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function cleanPersian(value: string): string {
  return value.replaceAll("*", "").trim();
}

export function splitText(value: string, maxLength = 3600): string[] {
  if (value.length <= maxLength) return [value];
  const paragraphs = value.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= maxLength) {
      current = paragraph;
      continue;
    }
    const sentences = paragraph.split(/(?<=[.!؟])\s+/);
    current = "";
    for (const sentence of sentences) {
      if (sentence.length > maxLength) {
        if (current) chunks.push(current);
        const pieces = splitLongText(sentence, maxLength);
        chunks.push(...pieces.slice(0, -1));
        current = pieces.at(-1) ?? "";
        continue;
      }
      const sentenceCandidate = current ? `${current} ${sentence}` : sentence;
      if (sentenceCandidate.length <= maxLength) current = sentenceCandidate;
      else {
        if (current) chunks.push(current);
        current = sentence;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLongText(value: string, maxLength: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > maxLength) {
      if (current) chunks.push(current);
      for (let offset = 0; offset < word.length; offset += maxLength) chunks.push(word.slice(offset, offset + maxLength));
      current = "";
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxLength) current = candidate;
    else {
      if (current) chunks.push(current);
      current = word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
