export const DEFAULT_TIME_ZONE = "Asia/Tehran";
export const IRAN_TIME_ZONE = DEFAULT_TIME_ZONE;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(epochMs: number, timeZone = DEFAULT_TIME_ZONE): ZonedParts {
  const values: Partial<Record<keyof ZonedParts, number>> = {};
  for (const part of partsFormatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type === "year" || part.type === "month" || part.type === "day" || part.type === "hour" || part.type === "minute" || part.type === "second") {
      values[part.type] = Number(part.value);
    }
  }
  if ([values.year, values.month, values.day, values.hour, values.minute, values.second].some((value) => value === undefined)) {
    throw new Error(`Could not format timestamp in ${timeZone}`);
  }
  return values as ZonedParts;
}

export function localDate(epochMs: number, timeZone = DEFAULT_TIME_ZONE): string {
  const p = zonedParts(epochMs, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function localMinuteOfDay(epochMs: number, timeZone = DEFAULT_TIME_ZONE): number {
  const p = zonedParts(epochMs, timeZone);
  return p.hour * 60 + p.minute;
}

export function zonedEpoch(date: string, minuteOfDay: number, timeZone = DEFAULT_TIME_ZONE): number {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day || minuteOfDay < 0 || minuteOfDay >= 24 * 60) throw new Error(`Invalid local date/time: ${date} ${minuteOfDay}`);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = targetUtc;
  for (let index = 0; index < 4; index += 1) {
    const local = zonedParts(guess, timeZone);
    const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    const correction = targetUtc - represented;
    guess += correction;
    if (correction === 0) break;
  }
  return guess;
}

export function addLocalDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`Invalid date: ${date}`);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function nextZonedOccurrence(afterMs: number, minuteOfDay: number, timeZone: string): number {
  let date = localDate(afterMs, timeZone);
  let candidate = zonedEpoch(date, minuteOfDay, timeZone);
  if (candidate <= afterMs) {
    date = addLocalDays(date, 1);
    candidate = zonedEpoch(date, minuteOfDay, timeZone);
  }
  return candidate;
}

export function formatTimeInZone(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(epochMs))
    .replace(/^24:/, "00:");
}

export function genericTimeZoneName(timeZone: string, epochMs = Date.now()): string {
  const parts = new Intl.DateTimeFormat("fa-IR", { timeZone, timeZoneName: "longGeneric" }).formatToParts(new Date(epochMs));
  return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone.replaceAll("_", " ");
}

export function iranParts(epochMs: number): ZonedParts {
  return zonedParts(epochMs, IRAN_TIME_ZONE);
}

export function iranDate(epochMs: number): string {
  return localDate(epochMs, IRAN_TIME_ZONE);
}

export function iranMinuteOfDay(epochMs: number): number {
  return localMinuteOfDay(epochMs, IRAN_TIME_ZONE);
}

export const addIranDays = addLocalDays;

export function formatClock(minuteOfDay: number): string {
  return `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`;
}

export function parseClock(value: string): number | null {
  const normalized = latinDigits(value.trim()).replace("٫", ":");
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(normalized);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 ? hour * 60 + minute : null;
}

export function latinDigits(value: string): string {
  return value.replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))).replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

export function persianNumber(value: number | string): string {
  return String(value).replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)] ?? digit);
}

export function persianClock(clock: string): string {
  return persianNumber(clock);
}

export function formatPersianDuration(totalMinutes: number): string {
  const safeMinutes = Math.max(0, Math.floor(totalMinutes));
  const hours = Math.floor(safeMinutes / 60);
  const minutes = safeMinutes % 60;
  if (hours && minutes) return `${persianNumber(hours)} ساعت و ${persianNumber(minutes)} دقیقه`;
  if (hours) return `${persianNumber(hours)} ساعت`;
  return `${persianNumber(minutes)} دقیقه`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
