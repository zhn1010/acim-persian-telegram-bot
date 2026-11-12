import { formatTimeInZone, genericTimeZoneName, persianClock } from "./time";
import type { InlineKeyboardMarkup } from "./types";

export interface TimeZoneChoice {
  id: string;
  label: string;
  description?: string;
}

export const TIME_ZONE_LABELS: Record<string, string> = {
  "Asia/Tehran": "وقت ایران",
  "Asia/Kabul": "وقت افغانستان",
  "Asia/Dubai": "امارات و عمان",
  "Asia/Riyadh": "عربستان، قطر، کویت، بحرین و عراق",
  "Asia/Karachi": "پاکستان",
  "Asia/Kolkata": "هند",
  "Europe/London": "بریتانیا، ایرلند و پرتغال",
  "Europe/Berlin": "اروپای مرکزی",
  "Europe/Helsinki": "اروپای شرقی",
  "Europe/Istanbul": "ترکیه",
  "Europe/Moscow": "روسیه و بلاروس",
  "America/Halifax": "منطقهٔ آتلانتیک",
  "America/New_York": "منطقهٔ شرقی",
  "America/Chicago": "منطقهٔ مرکزی",
  "America/Denver": "منطقهٔ کوهستانی",
  "America/Los_Angeles": "منطقهٔ غربی",
  "America/Phoenix": "آریزونا؛ بدون ساعت تابستانی",
  "Australia/Perth": "استرالیای غربی",
  "Australia/Adelaide": "استرالیای مرکزی",
  "Australia/Darwin": "داروین؛ بدون ساعت تابستانی",
  "Australia/Sydney": "استرالیای شرقی",
  "Australia/Brisbane": "کوئینزلند؛ بدون ساعت تابستانی",
  "Pacific/Auckland": "نیوزیلند",
};

const REGIONS: Record<string, TimeZoneChoice[]> = {
  nearby: [
    { id: "Asia/Dubai", label: TIME_ZONE_LABELS["Asia/Dubai"] ?? "امارات و عمان" },
    { id: "Asia/Riyadh", label: TIME_ZONE_LABELS["Asia/Riyadh"] ?? "خلیج فارس" },
    { id: "Asia/Karachi", label: TIME_ZONE_LABELS["Asia/Karachi"] ?? "پاکستان" },
    { id: "Asia/Kolkata", label: TIME_ZONE_LABELS["Asia/Kolkata"] ?? "هند" },
  ],
  europe: [
    { id: "Europe/London", label: TIME_ZONE_LABELS["Europe/London"] ?? "بریتانیا" },
    { id: "Europe/Berlin", label: TIME_ZONE_LABELS["Europe/Berlin"] ?? "اروپای مرکزی", description: "آلمان، فرانسه، هلند، ایتالیا، سوئیس و…" },
    { id: "Europe/Helsinki", label: TIME_ZONE_LABELS["Europe/Helsinki"] ?? "اروپای شرقی", description: "فنلاند، یونان، رومانی و…" },
    { id: "Europe/Istanbul", label: TIME_ZONE_LABELS["Europe/Istanbul"] ?? "ترکیه" },
    { id: "Europe/Moscow", label: TIME_ZONE_LABELS["Europe/Moscow"] ?? "روسیه" },
  ],
  north_america: [
    { id: "America/Halifax", label: TIME_ZONE_LABELS["America/Halifax"] ?? "آتلانتیک", description: "هالیفاکس و…" },
    { id: "America/New_York", label: TIME_ZONE_LABELS["America/New_York"] ?? "شرقی", description: "تورنتو، نیویورک و…" },
    { id: "America/Chicago", label: TIME_ZONE_LABELS["America/Chicago"] ?? "مرکزی", description: "شیکاگو، وینیپگ و…" },
    { id: "America/Denver", label: TIME_ZONE_LABELS["America/Denver"] ?? "کوهستانی", description: "دنور، کلگری و…" },
    { id: "America/Los_Angeles", label: TIME_ZONE_LABELS["America/Los_Angeles"] ?? "غربی", description: "ونکوور، لس‌آنجلس و…" },
    { id: "America/Phoenix", label: TIME_ZONE_LABELS["America/Phoenix"] ?? "آریزونا" },
  ],
  oceania: [
    { id: "Australia/Perth", label: TIME_ZONE_LABELS["Australia/Perth"] ?? "استرالیای غربی" },
    { id: "Australia/Adelaide", label: TIME_ZONE_LABELS["Australia/Adelaide"] ?? "استرالیای مرکزی" },
    { id: "Australia/Darwin", label: TIME_ZONE_LABELS["Australia/Darwin"] ?? "داروین" },
    { id: "Australia/Sydney", label: TIME_ZONE_LABELS["Australia/Sydney"] ?? "استرالیای شرقی" },
    { id: "Australia/Brisbane", label: TIME_ZONE_LABELS["Australia/Brisbane"] ?? "کوئینزلند" },
    { id: "Pacific/Auckland", label: TIME_ZONE_LABELS["Pacific/Auckland"] ?? "نیوزیلند" },
  ],
};

export function timeZoneLabel(timeZone: string, nowMs = Date.now()): string {
  return TIME_ZONE_LABELS[timeZone] ?? genericTimeZoneName(timeZone, nowMs);
}

export function timeZoneCurrentTime(timeZone: string, nowMs: number): string {
  return persianClock(formatTimeInZone(nowMs, timeZone));
}

export function timeZoneRegionKeyboard(region: string, nowMs: number): InlineKeyboardMarkup | null {
  const choices = REGIONS[region];
  if (!choices) return null;
  return {
    inline_keyboard: [
      ...choices.map((choice) => [{ text: `${choice.label} — اکنون ${timeZoneCurrentTime(choice.id, nowMs)}`, callback_data: `tz:set:${choice.id}` }]),
      [{ text: "بازگشت", callback_data: "tz:manual" }],
    ],
  };
}

export function timeZoneRegionDescription(region: string): string {
  const choices = REGIONS[region] ?? [];
  const details = choices.filter((choice) => choice.description).map((choice) => `<b>${choice.label}</b>: ${choice.description}`).join("\n");
  return details ? `گروه زمانی محل زندگی‌ات را انتخاب کن. ساعت فعلی کنار هر گزینه آمده است.\n\n${details}` : "گروه زمانی محل زندگی‌ات را انتخاب کن. ساعت فعلی کنار هر گزینه آمده است.";
}
