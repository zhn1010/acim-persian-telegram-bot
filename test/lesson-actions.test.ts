import { describe, expect, it } from "vitest";
import { lessonActions, reminderChoiceKeyboard, removeRepeatedLessonTitle, shouldClearCallbackKeyboard } from "../src/bot";
import { splitText } from "../src/content";
import type { CourseOption, LessonRow } from "../src/types";

const lesson: LessonRow = {
  lesson_number: 25,
  title_fa: "عنوان درس",
  reminder_fa: "یادآوری",
  full_text_fa: "متن کامل",
  text_url_fa: "https://acim-farsi.org/workbook/lesson/25",
  audio_url_fa: null,
  telegram_audio_file_id: "telegram-file-id",
  telegram_audio_file_unique_id: "telegram-unique-id",
  telegram_audio_duration: 120,
  telegram_audio_uploading_at_ms: null,
  schedule_type: "times_per_day",
  schedule_options_json: "[]",
};

describe("lesson action buttons", () => {
  it("shows the agreed lesson actions in order", () => {
    const rows = lessonActions(lesson, "2026-11-07").inline_keyboard;

    expect(rows.map((row) => row[0]?.text)).toEqual([
      "🎧 شنیدن صوت درس",
      "✅ درس امروز را مطالعه کردم",
      "⏭ درس امروز را فردا انجام می‌دهم",
      "🔢 تغییر شمارهٔ درس",
    ]);
    expect(rows.flat().some((button) => "url" in button)).toBe(false);
  });

  it("removes only the audio action after audio is sent", () => {
    const rows = lessonActions(lesson, "2026-11-07", true).inline_keyboard;

    expect(rows.map((row) => row[0]?.text)).toEqual([
      "✅ درس امروز را مطالعه کردم",
      "⏭ درس امروز را فردا انجام می‌دهم",
      "🔢 تغییر شمارهٔ درس",
    ]);
  });
});

describe("reminder choice buttons", () => {
  it("shows only course recommendations when recommendations exist", () => {
    const recommendations: CourseOption[] = [
      { kind: "times_per_day", count: 6 },
      { kind: "interval", minutes: 120 },
    ];
    const rows = reminderChoiceKeyboard(recommendations, "2026-11-07").inline_keyboard;

    expect(rows.map((row) => row[0]?.text)).toEqual([
      "⭐ پیشنهاد درس: ۶ یادآوری",
      "⭐ پیشنهاد درس: هر ۲ ساعت",
      "امروز یادآوری نمی‌خواهم",
    ]);
  });

  it("falls back to only two through five times when no recommendation exists", () => {
    const rows = reminderChoiceKeyboard([], "2026-11-07").inline_keyboard;

    expect(rows.map((row) => row[0]?.text)).toEqual([
      "۲ یادآوری",
      "۳ یادآوری",
      "۴ یادآوری",
      "۵ یادآوری",
      "امروز یادآوری نمی‌خواهم",
    ]);
  });

  it("uses no Latin digits in visible button labels", () => {
    const recommendations: CourseOption[] = [{ kind: "interval", minutes: 15 }];
    const labels = [
      ...lessonActions(lesson, "2026-11-07").inline_keyboard.flat().map((button) => button.text),
      ...reminderChoiceKeyboard(recommendations, "2026-11-07").inline_keyboard.flat().map((button) => button.text),
      ...reminderChoiceKeyboard([], "2026-11-07").inline_keyboard.flat().map((button) => button.text),
    ];

    expect(labels.every((label) => !/[0-9]/.test(label))).toBe(true);
  });
});

describe("lesson text heading", () => {
  it("removes an exactly repeated first paragraph", () => {
    expect(removeRepeatedLessonTitle("عنوان درس", "عنوان درس\n\nپاراگراف اصلی")).toBe("پاراگراف اصلی");
  });

  it("keeps a distinct review introduction", () => {
    expect(removeRepeatedLessonTitle("مرور (۱ تا ۵)", "مرور امروز ایده‌های زیر را در بر می‌گیرد:\n\nمتن")).toBe("مرور امروز ایده‌های زیر را در بر می‌گیرد:\n\nمتن");
  });

  it("never emits a text chunk above the requested Telegram safety limit", () => {
    const chunks = splitText("واژه ".repeat(2000), 3400);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 3400)).toBe(true);
  });
});

describe("inline keyboard lifecycle", () => {
  it("removes decision keyboards after a click", () => {
    expect(shouldClearCallbackKeyboard("r:open:2026-11-07")).toBe(true);
    expect(shouldClearCallbackKeyboard("r:c:4:2026-11-07")).toBe(true);
    expect(shouldClearCallbackKeyboard("n:next:2026-11-07")).toBe(true);
  });

  it("also removes a used main-menu keyboard before rendering the next screen", () => {
    expect(shouldClearCallbackKeyboard("m:today")).toBe(true);
    expect(shouldClearCallbackKeyboard("m:settings")).toBe(true);
    expect(shouldClearCallbackKeyboard("o:l:change")).toBe(true);
  });
});
