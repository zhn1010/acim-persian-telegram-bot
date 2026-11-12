import type { PendingSchedule, ReminderSlot } from "./types";
import { DEFAULT_TIME_ZONE, formatClock, localDate, localMinuteOfDay, parseClock, persianNumber, zonedEpoch } from "./time";

const START = 8 * 60;
const END = 20 * 60;
const SAFETY_MINUTES = 2;
const FIRST_REMINDER_DELAY = 30;
const MINIMUM_DENSE_GAP = 5;

export function fixedCountTimes(count: number): number[] {
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("Count must be from 1 to 20");
  return distributeCountAfter(START, count);
}

export function intervalTimes(interval: number, nowMs: number, timeZone = DEFAULT_TIME_ZONE): number[] {
  if (!Number.isInteger(interval) || interval < 5 || interval > 240) throw new Error("Interval must be from 5 to 240 minutes");
  const nowMinute = localMinuteOfDay(nowMs, timeZone);
  const first = nowMinute < START ? START : Math.ceil((nowMinute + interval) / 5) * 5;
  if (first > END) return [];
  const result: number[] = [];
  for (let minute = first; minute <= END; minute += interval) result.push(minute);
  return result;
}

export function makeCountSchedule(count: number, nowMs: number, lesson: number, timeZone = DEFAULT_TIME_ZONE): PendingSchedule {
  const date = localDate(nowMs, timeZone);
  const nowMinute = localMinuteOfDay(nowMs, timeZone);
  const allMinutes = redistributedCountTimes(count, nowMinute);
  const slots: ReminderSlot[] = allMinutes.map((minute, index) => ({
    ordinal: index + 1,
    total: allMinutes.length,
    atMs: zonedEpoch(date, minute, timeZone),
    time: formatClock(minute),
  }));
  const smallestGap = allMinutes.length > 1
    ? Math.min(...allMinutes.slice(1).map((minute, index) => minute - (allMinutes[index] ?? minute)))
    : Number.POSITIVE_INFINITY;
  return {
    date,
    lesson,
    kind: "count",
    value: String(count),
    label: `${persianNumber(count)} بار در روز`,
    allTimes: allMinutes.map(formatClock),
    missedTimes: [],
    slots,
    needsDenseConfirmation: allMinutes.length < count || smallestGap < 30,
  };
}

function redistributedCountTimes(count: number, nowMinute: number): number[] {
  const safeStart = Math.max(START, Math.ceil((nowMinute + FIRST_REMINDER_DELAY) / 5) * 5);
  return distributeCountAfter(safeStart, count);
}

function distributeCountAfter(start: number, count: number): number[] {
  if (start >= END) return [];
  if (count === 1) return [Math.round(((start + END) / 2) / 5) * 5];
  const capacity = Math.floor((END - start) / MINIMUM_DENSE_GAP);
  const actualCount = Math.min(count, capacity);
  if (actualCount === 0) return [];
  if (actualCount === 1) return [END];
  const span = END - start;
  return Array.from({ length: actualCount }, (_, index) => {
    if (index === actualCount - 1) return END;
    return Math.round((start + ((index + 1) * span) / actualCount) / 5) * 5;
  });
}

export function makeIntervalSchedule(interval: number, nowMs: number, lesson: number, timeZone = DEFAULT_TIME_ZONE): PendingSchedule {
  const date = localDate(nowMs, timeZone);
  const minutes = intervalTimes(interval, nowMs, timeZone);
  const slots = minutes.map((minute, index) => ({
    ordinal: index + 1,
    total: minutes.length,
    atMs: zonedEpoch(date, minute, timeZone),
    time: formatClock(minute),
  }));
  return {
    date,
    lesson,
    kind: "interval",
    value: String(interval),
    label: interval % 60 === 0 ? `هر ${persianNumber(interval / 60)} ساعت` : `هر ${persianNumber(interval)} دقیقه`,
    allTimes: minutes.map(formatClock),
    missedTimes: [],
    slots,
    needsDenseConfirmation: interval <= 15 || slots.length > 50,
  };
}

export function makeCustomTimesSchedule(values: string[], nowMs: number, lesson: number, timeZone = DEFAULT_TIME_ZONE): PendingSchedule | null {
  const parsed = values.map(parseClock);
  if (parsed.some((value) => value === null)) return null;
  const minutes = [...new Set(parsed as number[])].sort((a, b) => a - b);
  if (minutes.some((minute) => minute < START || minute > END)) return null;
  const date = localDate(nowMs, timeZone);
  const threshold = nowMs + SAFETY_MINUTES * 60_000;
  const slots: ReminderSlot[] = [];
  const missedTimes: string[] = [];
  minutes.forEach((minute, index) => {
    const atMs = zonedEpoch(date, minute, timeZone);
    if (atMs >= threshold) slots.push({ ordinal: index + 1, total: minutes.length, atMs, time: formatClock(minute) });
    else missedTimes.push(formatClock(minute));
  });
  return {
    date,
    lesson,
    kind: "custom_times",
    value: minutes.map(formatClock).join(","),
    label: "ساعت‌های دلخواه",
    allTimes: minutes.map(formatClock),
    missedTimes,
    slots,
    needsDenseConfirmation: slots.length > 50,
  };
}

export function splitClockInput(value: string): string[] {
  return value.split(/[،,؛;\s]+/).map((item) => item.trim()).filter(Boolean);
}
