import { describe, expect, it } from "vitest";
import { fixedCountTimes, intervalTimes, makeCountSchedule, makeCustomTimesSchedule, makeIntervalSchedule } from "../src/schedule";
import { formatPersianDuration, iranDate, iranMinuteOfDay, localDate, localMinuteOfDay, nextZonedOccurrence, zonedEpoch } from "../src/time";

describe("Iran time", () => {
  it("converts an Iran-local timestamp without hard-coding an offset", () => {
    const epoch = zonedEpoch("2026-11-06", 6 * 60);
    expect(new Date(epoch).toISOString()).toBe("2026-11-06T02:30:00.000Z");
    expect(iranDate(epoch)).toBe("2026-11-06");
    expect(iranMinuteOfDay(epoch)).toBe(360);
  });

  it("formats the countdown to 06:00 in simple Persian", () => {
    expect(formatPersianDuration(231)).toBe("۳ ساعت و ۵۱ دقیقه");
    expect(formatPersianDuration(60)).toBe("۱ ساعت");
    expect(formatPersianDuration(4)).toBe("۴ دقیقه");
  });
});

describe("per-user time zones", () => {
  it("converts the same instant to each user's local date and time", () => {
    const epoch = Date.parse("2026-11-06T14:30:00.000Z");
    expect([localDate(epoch, "Asia/Tehran"), localMinuteOfDay(epoch, "Asia/Tehran")]).toEqual(["2026-11-06", 18 * 60]);
    expect([localDate(epoch, "Europe/Berlin"), localMinuteOfDay(epoch, "Europe/Berlin")]).toEqual(["2026-11-06", 15 * 60 + 30]);
    expect([localDate(epoch, "America/Toronto"), localMinuteOfDay(epoch, "America/Toronto")]).toEqual(["2026-11-06", 9 * 60 + 30]);
  });

  it("automatically follows daylight-saving changes", () => {
    expect(new Date(zonedEpoch("2026-03-28", 6 * 60, "Europe/Berlin")).toISOString()).toBe("2026-03-28T05:00:00.000Z");
    expect(new Date(zonedEpoch("2026-03-30", 6 * 60, "Europe/Berlin")).toISOString()).toBe("2026-03-30T04:00:00.000Z");
  });

  it("calculates reminder slots in the selected local time zone", () => {
    const now = zonedEpoch("2026-11-06", 12 * 60 + 10, "America/Toronto");
    const schedule = makeCountSchedule(6, now, 25, "America/Toronto");
    expect(schedule.missedTimes).toEqual([]);
    expect(new Date(schedule.slots[0]?.atMs ?? 0).toISOString()).toBe("2026-11-06T18:55:00.000Z");
  });

  it("finds the first local 06:00 after a timezone change becomes effective", () => {
    const effectiveAt = zonedEpoch("2026-11-08", 0, "Asia/Tehran");
    const nextInLosAngeles = nextZonedOccurrence(effectiveAt, 6 * 60, "America/Los_Angeles");
    expect(nextInLosAngeles).toBeGreaterThan(effectiveAt);
    expect([localDate(nextInLosAngeles, "America/Los_Angeles"), localMinuteOfDay(nextInLosAngeles, "America/Los_Angeles")]).toEqual(["2026-11-08", 360]);
  });
});

describe("fixed-count schedules", () => {
  it("evenly spaces six repetitions after the start of the reminder window", () => {
    expect(fixedCountTimes(6)).toEqual([600, 720, 840, 960, 1080, 1200]);
  });

  it("does not send an 08:00 reminder immediately after a 07:30 study session", () => {
    const now = zonedEpoch("2026-11-06", 7 * 60 + 30);
    expect(makeCountSchedule(2, now, 25).slots.map((slot) => slot.time)).toEqual(["14:00", "20:00"]);
  });

  it("redistributes the full count over the meaningful time remaining", () => {
    const now = zonedEpoch("2026-11-06", 12 * 60 + 10);
    const schedule = makeCountSchedule(6, now, 25);
    expect(schedule.missedTimes).toEqual([]);
    expect(schedule.slots.map((slot) => [slot.ordinal, slot.total, slot.time])).toEqual([
      [1, 6, "13:55"], [2, 6, "15:05"], [3, 6, "16:20"], [4, 6, "17:35"], [5, 6, "18:45"], [6, 6, "20:00"],
    ]);
  });

  it("requires confirmation when a late fixed-count schedule becomes dense", () => {
    const now = zonedEpoch("2026-11-06", 18 * 60);
    const schedule = makeCountSchedule(6, now, 25);
    expect(schedule.slots).toHaveLength(6);
    expect(schedule.slots[0]?.time).toBe("18:45");
    expect(schedule.slots.at(-1)?.time).toBe("20:00");
    expect(schedule.needsDenseConfirmation).toBe(true);
  });

  it("reduces only when the requested count cannot fit even at five-minute spacing", () => {
    const now = zonedEpoch("2026-11-06", 19 * 60 + 25);
    const schedule = makeCountSchedule(5, now, 25);
    expect(schedule.slots.map((slot) => slot.time)).toEqual(["20:00"]);
    expect(schedule.slots.every((slot) => slot.total === 1)).toBe(true);
    expect(schedule.needsDenseConfirmation).toBe(true);
  });

  it("creates no fixed-count reminder when a meaningful first reminder no longer fits", () => {
    const now = zonedEpoch("2026-11-06", 19 * 60 + 31);
    expect(makeCountSchedule(2, now, 25).slots).toEqual([]);
  });
});

describe("interval schedules", () => {
  it("starts after one complete interval rounded to the next five minutes", () => {
    const now = zonedEpoch("2026-11-06", 11 * 60 + 17);
    expect(intervalTimes(120, now)).toEqual([800, 920, 1040, 1160]);
    const schedule = makeIntervalSchedule(120, now, 25);
    expect(schedule.allTimes).toEqual(["13:20", "15:20", "17:20", "19:20"]);
    expect(schedule.label).toBe("هر ۲ ساعت");
  });

  it("starts at 08:00 when enabled before the reminder window", () => {
    const now = zonedEpoch("2026-11-06", 7 * 60);
    expect(makeIntervalSchedule(60, now, 10).slots).toHaveLength(13);
    expect(makeIntervalSchedule(8, now, 71).slots).toHaveLength(91);
  });

  it("requires an extra confirmation for intervals of 15 minutes or less", () => {
    const now = zonedEpoch("2026-11-06", 9 * 60);
    expect(makeIntervalSchedule(15, now, 74).needsDenseConfirmation).toBe(true);
    expect(makeIntervalSchedule(20, now, 74).needsDenseConfirmation).toBe(false);
  });

  it("supports the allowed five-minute custom interval without losing jobs", () => {
    const now = zonedEpoch("2026-11-06", 7 * 60);
    const schedule = makeIntervalSchedule(5, now, 74);
    expect(schedule.slots).toHaveLength(145);
    expect(schedule.needsDenseConfirmation).toBe(true);
  });
});

describe("custom clock schedules", () => {
  it("sorts, deduplicates, and leaves elapsed times missed", () => {
    const now = zonedEpoch("2026-11-06", 12 * 60);
    const schedule = makeCustomTimesSchedule(["۱۸:۰۰", "09:00", "۱۸:۰۰", "13:30"], now, 1);
    expect(schedule?.allTimes).toEqual(["09:00", "13:30", "18:00"]);
    expect(schedule?.missedTimes).toEqual(["09:00"]);
    expect(schedule?.slots.map((slot) => slot.time)).toEqual(["13:30", "18:00"]);
  });
});
