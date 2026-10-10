import { describe, it, expect } from "vitest";
import { availableClockActions, localTimeToIso, formatClock, formatMinutes, DAY_STATUS_LABELS, REQUEST_TYPE_LABELS } from "./attendanceLabels";
import { ATTENDANCE_DAY_STATUSES, CORRECTION_REQUEST_TYPES } from "./attendanceSpec";

describe("تسميات وتحويلات الحضور", () => {
  it("كل حالة وكل نوع طلب له تسمية عربية", () => {
    for (const s of ATTENDANCE_DAY_STATUSES) expect(DAY_STATUS_LABELS[s].label).toBeTruthy();
    for (const t of CORRECTION_REQUEST_TYPES) expect(REQUEST_TYPE_LABELS[t]).toBeTruthy();
  });
  it("الأفعال المتاحة من حالة اليوم", () => {
    expect(availableClockActions(null)).toEqual(["clock_in"]);
    expect(availableClockActions({ status: "open" })).toEqual(["break_start", "clock_out"]);
    expect(availableClockActions({ status: "on_break" })).toEqual(["break_end", "clock_out"]);
  });
  it("الوقت المحلي ⇒ UTC: صيف وشتاء القاهرة، واليوم التالي لليلية، وحدود الشهر", () => {
    expect(localTimeToIso("2026-01-15", "11:00", "Africa/Cairo")).toBe("2026-01-15T09:00:00.000Z");
    expect(localTimeToIso("2026-07-15", "11:00", "Africa/Cairo")).toBe("2026-07-15T08:00:00.000Z");
    expect(localTimeToIso("2026-01-31", "02:00", "Africa/Cairo", true)).toBe("2026-02-01T00:00:00.000Z");
    expect(localTimeToIso("bad", "11:00", "Africa/Cairo")).toBeNull();
  });
  it("العرض بتوقيت اليوم", () => {
    expect(formatClock(Date.parse("2026-01-15T09:05:00Z"), "Africa/Cairo")).toBe("11:05");
    expect(formatClock(null, "Africa/Cairo")).toBe("—");
    expect(formatMinutes(0)).toBe("0");
    expect(formatMinutes(45)).toBe("45د");
    expect(formatMinutes(125)).toBe("2س 5د");
  });
});

import { formatClock12 } from "./attendanceLabels";
describe("الوقت بصيغة 12 ساعة", () => {
  it("12:16 م و12:19 م بتوقيت القاهرة (السيناريو المبلّغ)، والصباح ص، ومنتصف الليل 12:05 ص", () => {
    expect(formatClock12(Date.parse("2026-10-10T12:16:00+03:00"), "Africa/Cairo")).toBe("12:16 م");
    expect(formatClock12(Date.parse("2026-10-10T12:19:00+03:00"), "Africa/Cairo")).toBe("12:19 م");
    expect(formatClock12(Date.parse("2026-10-10T09:05:00+03:00"), "Africa/Cairo")).toBe("9:05 ص");
    expect(formatClock12(Date.parse("2026-10-10T00:05:00+03:00"), "Africa/Cairo")).toBe("12:05 ص");
    expect(formatClock12(Date.parse("2026-01-15T10:00:00Z"), "Africa/Cairo")).toBe("12:00 م");
    expect(formatClock12(null, "Africa/Cairo")).toBe("—");
  });
});
