import { businessDateKey, zonedDateTimeToUtc } from "./businessTime";
import { isWorkDay, type AttendanceDayStatus } from "./attendanceSpec";

/**
 * حسابات الحضور النقية (بلا قاعدة بيانات) — المصدر الوحيد للحساب في الخدمة وفي reconcile:
 *  • نافذة الوردية بتوقيت الوردية (IANA عبر Intl) → UTC، والوردية الليلية تنتهي في اليوم التالي، والتوقيت
 *    الصيفي المصري محسوب تلقائيًا (لا اعتماد على جداول المناطق في MySQL).
 *  • تاريخ العمل = تاريخ **بداية** الوردية بتوقيتها.
 *  • اليوم (Projection) يُعاد حسابه كاملًا من الأحداث في كل مرة — الأحداث هي المصدر التاريخي.
 */
export type ShiftSnapshot = {
  shiftId: number;
  name: string;
  startTime: string; // HH:MM[:SS]
  endTime: string;
  crossesMidnight: boolean;
  timezone: string;
  workDaysMask: number;
  graceMinutes: number;
  allowedBreakMinutes: number;
  overtimeStartsAfterMinutes: number;
  earlyClockInLimitMinutes: number;
  earlyLeaveToleranceMinutes: number;
};

const MIN = 60_000;
const parseTime = (t: string) => { const [h, m, s] = t.split(":").map(Number); return { hour: h, minute: m ?? 0, second: s ?? 0 }; };
export function addDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const ymd = (iso: string) => { const [year, month, day] = iso.split("-").map(Number); return { year, month, day }; };

export function scheduledWindow(workDate: string, snap: ShiftSnapshot): { startMs: number; endMs: number } {
  const start = zonedDateTimeToUtc({ ...ymd(workDate), ...parseTime(snap.startTime) }, snap.timezone).getTime();
  const endDate = snap.crossesMidnight ? addDays(workDate, 1) : workDate;
  const end = zonedDateTimeToUtc({ ...ymd(endDate), ...parseTime(snap.endTime) }, snap.timezone).getTime();
  return { startMs: start, endMs: end };
}

/**
 * تاريخ العمل للحضور الآن: الوردية التي نافذتها [البداية − حد الحضور المبكر، النهاية] تحتوي اللحظة — نجرب
 * وردية الأمس (لليلية بعد منتصف الليل) ثم اليوم. لا شيء ⇒ تاريخ اليوم المحلي بلا جدول (يحتاج مراجعة).
 */
export function workDateFor(nowMs: number, timeZone: string, snapFor: (workDate: string) => ShiftSnapshot | null): { workDate: string; snapshot: ShiftSnapshot | null; scheduled: boolean } {
  const today = businessDateKey(new Date(nowMs), timeZone);
  for (const candidate of [addDays(today, -1), today]) {
    const snap = snapFor(candidate);
    if (!snap || !isWorkDay(snap.workDaysMask, candidate)) continue;
    const w = scheduledWindow(candidate, snap);
    if (nowMs >= w.startMs - snap.earlyClockInLimitMinutes * MIN && nowMs <= w.endMs) return { workDate: candidate, snapshot: snap, scheduled: true };
  }
  const snap = snapFor(today);
  return { workDate: today, snapshot: snap && isWorkDay(snap.workDaysMask, today) ? snap : null, scheduled: false };
}

export type ProjectionEvent = {
  id: number;
  eventType: string;
  atMs: number; // effectiveAt ?? occurredAt
  correctionOfEventId?: number | null;
  newValue?: { eventType?: string; atMs?: number; void?: boolean } | null;
};

export type DayProjection = {
  status: AttendanceDayStatus;
  firstInAt: number | null;
  lastOutAt: number | null;
  openBreakStartedAt: number | null;
  workedMinutes: number;
  breakMinutes: number;
  excessBreakMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  requiresReview: boolean;
  reviewReason: string | null;
};

const mins = (ms: number) => Math.max(0, Math.round(ms / MIN));

/** يطبّق التصحيحات على الأحداث الأساسية ثم يحسب اليوم. نقي وحتمي (نفس المدخل = نفس الناتج). */
export function projectDay(events: ProjectionEvent[], snap: ShiftSnapshot | null, workDate: string): DayProjection {
  const base = new Map<number, { eventType: string; atMs: number }>();
  const added: { eventType: string; atMs: number }[] = [];
  const ordered = [...events].sort((a, b) => a.atMs - b.atMs || a.id - b.id);
  for (const e of ordered) if (e.eventType !== "correction") base.set(e.id, { eventType: e.eventType, atMs: e.atMs });
  for (const e of ordered) {
    if (e.eventType !== "correction" || !e.newValue) continue;
    if (e.correctionOfEventId != null && base.has(e.correctionOfEventId)) {
      if (e.newValue.void) base.delete(e.correctionOfEventId);
      else base.set(e.correctionOfEventId, { eventType: e.newValue.eventType ?? base.get(e.correctionOfEventId)!.eventType, atMs: e.newValue.atMs ?? base.get(e.correctionOfEventId)!.atMs });
    } else if (e.newValue.eventType && e.newValue.atMs != null) added.push({ eventType: e.newValue.eventType, atMs: e.newValue.atMs });
  }
  const timeline = [...base.values(), ...added].sort((a, b) => a.atMs - b.atMs);
  const reasons: string[] = [];
  let status: AttendanceDayStatus = "open";
  let firstIn: number | null = null, lastOut: number | null = null, breakStart: number | null = null, breakMs = 0;
  let marker: AttendanceDayStatus | null = null, closed = false;
  for (const e of timeline) {
    switch (e.eventType) {
      case "clock_in": if (firstIn == null) firstIn = e.atMs; break;
      case "break_start": if (breakStart == null) breakStart = e.atMs; break;
      case "break_end": if (breakStart != null) { breakMs += Math.max(0, e.atMs - breakStart); breakStart = null; } break;
      case "clock_out": if (breakStart != null) { breakMs += Math.max(0, e.atMs - breakStart); breakStart = null; } lastOut = e.atMs; break;
      case "leave": marker = "leave"; break;
      case "mission": marker = "mission"; break;
      case "absence": marker = "absent"; break;
      case "day_close": closed = true; break;
      case "day_reopen": closed = false; break;
    }
  }
  if (marker) status = marker;
  else if (lastOut != null) status = "closed";
  else if (breakStart != null) status = "on_break";
  else if (firstIn == null) status = closed ? "absent" : "open";
  else status = closed ? "incomplete" : "open";

  const worked = firstIn != null && lastOut != null && lastOut >= firstIn ? mins(lastOut - firstIn - breakMs) : 0;
  const breakMinutes = mins(breakMs);
  let late = 0, early = 0, overtime = 0, excess = 0;
  if (snap) {
    const w = scheduledWindow(workDate, snap);
    if (firstIn != null && firstIn > w.startMs + snap.graceMinutes * MIN) late = mins(firstIn - w.startMs);
    if (lastOut != null && lastOut < w.endMs - snap.earlyLeaveToleranceMinutes * MIN) early = mins(w.endMs - lastOut);
    if (lastOut != null && lastOut > w.endMs + snap.overtimeStartsAfterMinutes * MIN) overtime = mins(lastOut - w.endMs);
    excess = Math.max(0, breakMinutes - snap.allowedBreakMinutes);
  } else if (firstIn != null) reasons.push("حضور بلا وردية مجدولة");
  if (early > 0) reasons.push("خروج مبكر — يحتاج سببًا ومراجعة");
  if (overtime > 0) reasons.push("وقت إضافي — يحتاج اعتمادًا");
  if (excess > 0) reasons.push("استراحة زائدة (تُسجَّل بلا خصم)");
  if (status === "incomplete") reasons.push("يوم بلا انصراف");
  return {
    status, firstInAt: firstIn, lastOutAt: lastOut, openBreakStartedAt: status === "on_break" ? breakStart : null,
    workedMinutes: worked, breakMinutes, excessBreakMinutes: excess, lateMinutes: late, earlyLeaveMinutes: early, overtimeMinutes: overtime,
    requiresReview: reasons.length > 0, reviewReason: reasons.length ? reasons.join(" · ").slice(0, 160) : null,
  };
}

/** أنواع التسجيل التي يمكن تصحيح وقتها (wrong_time) — ليست التصحيحات ولا الغياب/الإجازة/الإقفال. */
export const CORRECTABLE_EVENT_TYPES = ["clock_in", "break_start", "break_end", "clock_out"] as const;
export type CorrectableEvent = { id: number; eventType: (typeof CORRECTABLE_EVENT_TYPES)[number]; atMs: number; corrected: boolean };

/**
 * أحداث اليوم القابلة لتصحيح الوقت بوقتها **الحالي** — بنفس دلالة projectDay: التصحيح بـcorrectionOfEventId يغيّر
 * الوقت/النوع أو يلغي الحدث (void ⇒ يُستبعد). الأحداث المضافة بتصحيح بلا هدف ليست أحداثًا أصلية فلا تُستهدف.
 */
export function correctableEvents(events: ProjectionEvent[]): CorrectableEvent[] {
  const ordered = [...events].sort((a, b) => a.atMs - b.atMs || a.id - b.id);
  const base = new Map<number, { eventType: string; atMs: number; corrected: boolean }>();
  for (const e of ordered) if (e.eventType !== "correction") base.set(e.id, { eventType: e.eventType, atMs: e.atMs, corrected: false });
  for (const e of [...events].sort((a, b) => a.id - b.id)) {
    if (e.eventType !== "correction" || !e.newValue || e.correctionOfEventId == null || !base.has(e.correctionOfEventId)) continue;
    const cur = base.get(e.correctionOfEventId)!;
    if (e.newValue.void) base.delete(e.correctionOfEventId);
    else base.set(e.correctionOfEventId, { eventType: e.newValue.eventType ?? cur.eventType, atMs: e.newValue.atMs ?? cur.atMs, corrected: true });
  }
  return [...base.entries()]
    .filter(([, v]) => (CORRECTABLE_EVENT_TYPES as readonly string[]).includes(v.eventType))
    .map(([id, v]) => ({ id, eventType: v.eventType as CorrectableEvent["eventType"], atMs: v.atMs, corrected: v.corrected }))
    .sort((a, b) => a.atMs - b.atMs || a.id - b.id);
}

/** أولوية التعيين (قرار المالك، مكتوبة ومختبرة): موظف ← دور+نشاط ← نشاط ← دور على الشركة ← افتراضي الشركة. */
export type AssignmentCandidate = { id: number; targetType: "employee" | "role" | "business" | "tenant_default"; employeeId: number | null; role: string | null; businessId: number | null; effectiveFrom: string; effectiveTo: string | null; shiftId: number };
export function assignmentPriority(a: AssignmentCandidate): number {
  if (a.targetType === "employee") return 1;
  if (a.targetType === "role" && a.businessId != null) return 2;
  if (a.targetType === "business") return 3;
  if (a.targetType === "role") return 4;
  return 5;
}
/** كل التعيينات المنطبقة على الموظف في يوم العمل، بترتيب الاختيار نفسه (الأول = ما يطبّقه الحضور). */
export function applicableAssignments(cands: AssignmentCandidate[], emp: { id: number; role: string | null; businessId: number | null }, workDate: string): AssignmentCandidate[] {
  const applies = (a: AssignmentCandidate) =>
    a.effectiveFrom <= workDate && (a.effectiveTo == null || a.effectiveTo >= workDate) && (
      (a.targetType === "employee" && a.employeeId === emp.id) ||
      (a.targetType === "role" && a.role === emp.role && (a.businessId == null || a.businessId === emp.businessId)) ||
      (a.targetType === "business" && a.businessId === emp.businessId) ||
      a.targetType === "tenant_default");
  return cands.filter(applies).sort((x, y) => assignmentPriority(x) - assignmentPriority(y) || (y.effectiveFrom < x.effectiveFrom ? -1 : y.effectiveFrom > x.effectiveFrom ? 1 : 0) || y.id - x.id);
}
export function pickAssignment(cands: AssignmentCandidate[], emp: { id: number; role: string | null; businessId: number | null }, workDate: string): AssignmentCandidate | null {
  return applicableAssignments(cands, emp, workDate)[0] ?? null;
}
/**
 * تعارض تعيينات: أكثر من تعيين منطبق في **نفس أعلى أولوية** — الحضور يختار واحدًا منها بالأحدث بداية ثم الأعلى
 * رقمًا (pickAssignment)، فالتعارض يُعرض للمراجعة ولا يغيّر الاختيار. [] = لا تعارض.
 */
export function tiedTopAssignments(cands: AssignmentCandidate[], emp: { id: number; role: string | null; businessId: number | null }, workDate: string): AssignmentCandidate[] {
  const all = applicableAssignments(cands, emp, workDate);
  if (all.length < 2) return [];
  const top = assignmentPriority(all[0]);
  const tied = all.filter(a => assignmentPriority(a) === top);
  return tied.length > 1 ? tied : [];
}

/** هل فترتا تاريخ (شاملة، to=null مفتوحة) تتقاطعان؟ */
export function rangesOverlap(aFrom: string, aTo: string | null, bFrom: string, bTo: string | null): boolean {
  return (aTo == null || bFrom <= aTo) && (bTo == null || aFrom <= bTo);
}

/** CSV الحضور للتصدير — الأوقات بتوقيت اليوم (IANA)، الدقائق كما هي. */
export function attendanceCsv(days: { employeeName: string; workDate: string; status: string; firstInMs: number | null; lastOutMs: number | null; timezone: string; workedMinutes: number; breakMinutes: number; lateMinutes: number; earlyLeaveMinutes: number; overtimeMinutes: number; excessBreakMinutes: number; requiresReview: number | boolean; reviewReason: string | null }[]): string {
  const fmt = (ms: number | null, tz: string) => (ms == null ? "" : new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Number(ms))));
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["الموظف", "التاريخ", "الحالة", "الحضور", "الانصراف", "دقائق العمل", "الاستراحة", "التأخير", "الخروج المبكر", "الإضافي", "استراحة زائدة", "يحتاج مراجعة", "السبب"];
  const lines = days.map(d => [d.employeeName, d.workDate, d.status, fmt(d.firstInMs, d.timezone), fmt(d.lastOutMs, d.timezone), d.workedMinutes, d.breakMinutes, d.lateMinutes, d.earlyLeaveMinutes, d.overtimeMinutes, d.excessBreakMinutes, Number(d.requiresReview) ? "نعم" : "لا", d.reviewReason ?? ""].map(esc).join(","));
  return "﻿" + [head.join(","), ...lines].join("\n");
}
