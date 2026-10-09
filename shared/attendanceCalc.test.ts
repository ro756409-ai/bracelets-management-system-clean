import { describe, it, expect } from "vitest";
import { addDays, assignmentPriority, pickAssignment, projectDay, rangesOverlap, scheduledWindow, workDateFor, type AssignmentCandidate, type ShiftSnapshot } from "./attendanceCalc";
import { maskFromDays } from "./attendanceSpec";

const ALL = maskFromDays(["sat", "sun", "mon", "tue", "wed", "thu", "fri"]);
const snap = (p: Partial<ShiftSnapshot> = {}): ShiftSnapshot => ({ shiftId: 1, name: "صباحي", startTime: "11:00:00", endTime: "18:00:00", crossesMidnight: false, timezone: "Africa/Cairo", workDaysMask: ALL, graceMinutes: 10, allowedBreakMinutes: 60, overtimeStartsAfterMinutes: 30, earlyClockInLimitMinutes: 60, earlyLeaveToleranceMinutes: 0, ...p });
const night = snap({ name: "ليلي", startTime: "22:00:00", endTime: "06:00:00", crossesMidnight: true });
const H = 3_600_000, M = 60_000;

describe("نافذة الوردية — IANA Africa/Cairo بلا جداول MySQL", () => {
  it("11:00–18:00 بالتوقيت الصيفي (+3) وبعده (+2)", () => {
    const s = scheduledWindow("2026-10-05", snap());
    expect(new Date(s.startMs).toISOString()).toBe("2026-10-05T08:00:00.000Z");
    expect(new Date(s.endMs).toISOString()).toBe("2026-10-05T15:00:00.000Z");
    expect(new Date(scheduledWindow("2026-11-02", snap()).startMs).toISOString()).toBe("2026-11-02T09:00:00.000Z");
  });
  it("الوردية الليلية تنتهي في اليوم التالي — وعبر نهاية الشهر", () => {
    const w = scheduledWindow("2026-01-31", night);
    expect(new Date(w.startMs).toISOString()).toBe("2026-01-31T20:00:00.000Z");
    expect(new Date(w.endMs).toISOString()).toBe("2026-02-01T04:00:00.000Z");
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("التوقيت الصيفي المصري: ليلة التقديم 7 ساعات، ليلة التأخير 9 ساعات، الليالي العادية 8", () => {
    const dur = (d: string) => { const w = scheduledWindow(d, night); return (w.endMs - w.startMs) / H; };
    expect(dur("2026-04-23")).toBe(7);
    expect(dur("2026-10-29")).toBe(9);
    expect(dur("2026-10-28")).toBe(8);
    expect(dur("2026-10-30")).toBe(8);
  });
});

describe("تاريخ العمل = تاريخ بداية الوردية", () => {
  it("حضور 01:30 القاهرة لوردية ليلية = تاريخ الأمس", () => {
    const now = Date.parse("2026-10-05T22:30:00Z"); // 01:30 القاهرة يوم 6
    expect(workDateFor(now, "Africa/Cairo", () => night)).toMatchObject({ workDate: "2026-10-05", scheduled: true });
  });
  it("حضور مبكر في حدود الحد المسموح = نفس اليوم؛ قبله = بلا جدول", () => {
    expect(workDateFor(Date.parse("2026-10-05T07:10:00Z"), "Africa/Cairo", () => snap())).toMatchObject({ workDate: "2026-10-05", scheduled: true }); // 10:10
    expect(workDateFor(Date.parse("2026-10-05T05:00:00Z"), "Africa/Cairo", () => snap())).toMatchObject({ workDate: "2026-10-05", scheduled: false }); // 08:00
  });
  it("منتصف الليل: حضور 00:05 القاهرة بلا وردية ليلية = اليوم الجديد بلا جدول", () => {
    expect(workDateFor(Date.parse("2026-10-05T21:05:00Z"), "Africa/Cairo", () => snap())).toMatchObject({ workDate: "2026-10-06", scheduled: false });
  });
  it("يوم ليس من أيام العمل = بلا جدول", () => {
    const friOff = snap({ workDaysMask: maskFromDays(["sat", "sun", "mon", "tue", "wed", "thu"]) });
    expect(workDateFor(Date.parse("2026-10-09T09:00:00Z"), "Africa/Cairo", () => friOff)).toMatchObject({ workDate: "2026-10-09", scheduled: false, snapshot: null });
  });
});

describe("Projection اليوم من الأحداث", () => {
  const day = "2026-10-05";
  const at = (iso: string) => Date.parse(iso);
  it("حضور متأخر + استراحة زائدة + انصراف بإضافي", () => {
    const p = projectDay([
      { id: 1, eventType: "clock_in", atMs: at("2026-10-05T08:25:00Z") },   // 11:25 (تأخير 25 > السماح 10)
      { id: 2, eventType: "break_start", atMs: at("2026-10-05T11:00:00Z") },
      { id: 3, eventType: "break_end", atMs: at("2026-10-05T12:15:00Z") },  // 75 دقيقة (زائد 15)
      { id: 4, eventType: "clock_out", atMs: at("2026-10-05T15:45:00Z") },  // 18:45 (إضافي 45 > 30)
    ], snap(), day);
    expect(p).toMatchObject({ status: "closed", lateMinutes: 25, breakMinutes: 75, excessBreakMinutes: 15, overtimeMinutes: 45, earlyLeaveMinutes: 0, requiresReview: true });
    expect(p.workedMinutes).toBe(Math.round((at("2026-10-05T15:45:00Z") - at("2026-10-05T08:25:00Z")) / M) - 75);
  });
  it("داخل السماح = بلا تأخير؛ خروج مبكر يُسجَّل للمراجعة بلا خصم", () => {
    const p = projectDay([{ id: 1, eventType: "clock_in", atMs: at("2026-10-05T08:08:00Z") }, { id: 2, eventType: "clock_out", atMs: at("2026-10-05T14:00:00Z") }], snap(), day);
    expect(p).toMatchObject({ lateMinutes: 0, earlyLeaveMinutes: 60, overtimeMinutes: 0, requiresReview: true });
    expect(p.reviewReason).toContain("خروج مبكر");
  });
  it("استراحة مفتوحة = on_break؛ إغلاق اليوم بلا انصراف = incomplete", () => {
    expect(projectDay([{ id: 1, eventType: "clock_in", atMs: at("2026-10-05T08:00:00Z") }, { id: 2, eventType: "break_start", atMs: at("2026-10-05T10:00:00Z") }], snap(), day))
      .toMatchObject({ status: "on_break", openBreakStartedAt: at("2026-10-05T10:00:00Z") });
    expect(projectDay([{ id: 1, eventType: "clock_in", atMs: at("2026-10-05T08:00:00Z") }, { id: 2, eventType: "day_close", atMs: at("2026-10-05T21:00:00Z") }], snap(), day))
      .toMatchObject({ status: "incomplete", requiresReview: true });
  });
  it("التصحيح يستبدل وقت حدث أو يضيف انصرافًا ناقصًا — والنتيجة حتمية", () => {
    const evs = [
      { id: 1, eventType: "clock_in", atMs: at("2026-10-05T09:00:00Z") },
      { id: 2, eventType: "correction", atMs: at("2026-10-05T20:00:00Z"), correctionOfEventId: 1, newValue: { atMs: at("2026-10-05T08:00:00Z") } },
      { id: 3, eventType: "correction", atMs: at("2026-10-05T20:01:00Z"), newValue: { eventType: "clock_out", atMs: at("2026-10-05T15:00:00Z") } },
    ];
    const p = projectDay(evs, snap(), day);
    expect(p).toMatchObject({ status: "closed", lateMinutes: 0, workedMinutes: 420 });
    expect(projectDay([...evs].reverse(), snap(), day)).toEqual(p);
  });
  it("إجازة/مأمورية بالاعتماد = حالة اليوم", () => {
    expect(projectDay([{ id: 1, eventType: "leave", atMs: at("2026-10-05T06:00:00Z") }], snap(), day).status).toBe("leave");
    expect(projectDay([{ id: 1, eventType: "mission", atMs: at("2026-10-05T06:00:00Z") }], snap(), day).status).toBe("mission");
  });
  it("الوردية الليلية عبر التوقيت الصيفي: 9 ساعات عمل فعلية بلا إضافي", () => {
    const w = scheduledWindow("2026-10-29", night);
    const p = projectDay([{ id: 1, eventType: "clock_in", atMs: w.startMs }, { id: 2, eventType: "clock_out", atMs: w.endMs }], night, "2026-10-29");
    expect(p).toMatchObject({ workedMinutes: 540, overtimeMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0 });
  });
});

describe("أولوية التعيين والتداخل", () => {
  const c = (p: Partial<AssignmentCandidate>): AssignmentCandidate => ({ id: 1, targetType: "tenant_default", employeeId: null, role: null, businessId: null, effectiveFrom: "2026-10-01", effectiveTo: null, shiftId: 1, ...p });
  const emp = { id: 7, role: "agent", businessId: 3 };
  it("موظف ← دور+نشاط ← نشاط ← دور على الشركة ← افتراضي", () => {
    const all = [c({ id: 5, shiftId: 5 }), c({ id: 4, targetType: "role", role: "agent", shiftId: 4 }), c({ id: 3, targetType: "business", businessId: 3, shiftId: 3 }), c({ id: 2, targetType: "role", role: "agent", businessId: 3, shiftId: 2 }), c({ id: 1, targetType: "employee", employeeId: 7, shiftId: 1 })];
    expect(pickAssignment(all, emp, "2026-10-05")?.shiftId).toBe(1);
    expect(pickAssignment(all.filter(a => a.id !== 1), emp, "2026-10-05")?.shiftId).toBe(2);
    expect(pickAssignment(all.filter(a => a.id > 2), emp, "2026-10-05")?.shiftId).toBe(3);
    expect(pickAssignment(all.filter(a => a.id > 3), emp, "2026-10-05")?.shiftId).toBe(4);
    expect(pickAssignment(all.filter(a => a.id > 4), emp, "2026-10-05")?.shiftId).toBe(5);
    expect([1, 2, 3, 4, 5].map(id => assignmentPriority(all.find(a => a.id === id)!))).toEqual([1, 2, 3, 4, 5]);
  });
  it("دور+نشاط آخر لا ينطبق، والفترات المنتهية لا تنطبق", () => {
    expect(pickAssignment([c({ targetType: "role", role: "agent", businessId: 99 })], emp, "2026-10-05")).toBeNull();
    expect(pickAssignment([c({ targetType: "employee", employeeId: 7, effectiveTo: "2026-10-04" })], emp, "2026-10-05")).toBeNull();
  });
  it("التقاطع: الفترات المفتوحة والمتلامسة", () => {
    expect(rangesOverlap("2026-10-01", null, "2026-12-01", null)).toBe(true);
    expect(rangesOverlap("2026-10-01", "2026-10-31", "2026-11-01", null)).toBe(false);
    expect(rangesOverlap("2026-10-01", "2026-10-31", "2026-10-31", null)).toBe(true);
  });
});
