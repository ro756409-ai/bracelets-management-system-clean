import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { isValidIanaTimeZone } from "../shared/businessTime";
import { addDays, correctableEvents, pickAssignment, projectDay, rangesOverlap, scheduledWindow, workDateFor, type AssignmentCandidate, type CorrectableEvent, type DayProjection, type ProjectionEvent, type ShiftSnapshot } from "../shared/attendanceCalc";
import { ATTENDANCE_TABLES, maskFromDays, WEEKDAYS, type CorrectionRequestType, type WeekdayKey } from "../shared/attendanceSpec";
import { getDb } from "./db";
import { canonicalHash } from "./orderEvents.service";
import type { ReadOnlyExecutor } from "./balanceReconciliation.service";

/**
 * الحضور والانصراف (0042) — خلف العلم `ATTENDANCE_ENABLED` (افتراضيًا معطل).
 *
 *  • كل كتابة داخل معاملة تبدأ بـ`SET time_zone = '+00:00'` ثم فحص وجود الجداول الخمسة (غيابها والعلم مفعّل
 *    = PRECONDITION_FAILED). الطوابع تُكتب بـFROM_UNIXTIME وتُقرأ بـUNIX_TIMESTAMP (epoch) — لا اعتماد على
 *    timezone الاتصال ولا جداول المناطق في MySQL؛ الحسابات بـIANA على السيرفر (shared/attendanceCalc).
 *  • الهوية (tenant/الموظف/الفاعل) من الجلسة فقط — يمرّرها الراوتر بعد التحقق؛ لا قيم من العميل.
 *  • الأحداث للإضافة فقط؛ اليوم Projection يُعاد حسابه من الأحداث تحت FOR UPDATE وبـversion.
 *  • Idempotency: نفس المفتاح + نفس الـhash = Replay، hash مختلف = CONFLICT.
 *  • لا كتابة على payroll_* ولا ledger_* ولا أي جدول خارج attendance_*.
 */
export const attendanceEnabled = () => process.env.ATTENDANCE_ENABLED === "true";

export type AttendanceActor = { tenantId: number; employeeId: number; role: string | null; businessId: number | null; name?: string | null };
const OP = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const rows = (r: any): any[] => (Array.isArray(r) ? (Array.isArray(r[0]) ? r[0] : r) : r?.rows ?? []);
const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });
const conflict = (message: string) => new TRPCError({ code: "CONFLICT", message });
const forbidden = (message: string) => new TRPCError({ code: "FORBIDDEN", message });

async function assertAttendanceReady(tx: any): Promise<void> {
  const r = rows(await tx.execute(sql`SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${sql.join(ATTENDANCE_TABLES.map(t => sql`${t}`), sql`, `)})`));
  if (Number(r[0]?.n ?? 0) !== ATTENDANCE_TABLES.length)
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الحضور مفعّل لكن جداوله غير موجودة (0042 غير مطبّقة) — لم يُنفَّذ أي تغيير" });
}

function requireEnabled() {
  if (!attendanceEnabled()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الحضور والانصراف غير مفعّل" });
}

/** معاملة حضور: UTC صريح + فحص الجاهزية. */
export async function runAttendanceTx<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  requireEnabled();
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
  return db.transaction(async tx => {
    await tx.execute(sql`SET time_zone = '+00:00'`);
    await assertAttendanceReady(tx);
    return fn(tx);
  });
}

const one = async (tx: any, q: any) => rows(await tx.execute(q))[0];
const insertId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId);

// ==================== الورديات ====================
export const shiftInput = z.object({
  name: z.string().trim().min(1).max(80),
  businessId: z.number().int().positive().nullable(),
  startTime: z.string().regex(TIME),
  endTime: z.string().regex(TIME),
  workDays: z.array(z.enum(WEEKDAYS.map(d => d.key) as [WeekdayKey, ...WeekdayKey[]])).min(1, "اختر يوم عمل واحدًا على الأقل"),
  graceMinutes: z.number().int().min(0).max(240),
  allowedBreakMinutes: z.number().int().min(0).max(480),
  overtimeStartsAfterMinutes: z.number().int().min(0).max(720),
  earlyClockInLimitMinutes: z.number().int().min(0).max(480),
  earlyLeaveToleranceMinutes: z.number().int().min(0).max(240),
  timezone: z.string().refine(isValidIanaTimeZone, "منطقة زمنية غير صالحة"),
  effectiveFrom: z.string().regex(ISO_DATE),
  effectiveTo: z.string().regex(ISO_DATE).nullable(),
}).strict();
export type ShiftInput = z.infer<typeof shiftInput>;
const hms = (t: string) => (t.length === 5 ? `${t}:00` : t);

export async function createShift(actor: AttendanceActor, input: ShiftInput, allowedBusinessIds: number[]) {
  const v = shiftInput.parse(input);
  if (hms(v.startTime) === hms(v.endTime)) throw bad("بداية الوردية ونهايتها لا يمكن أن تتساويا");
  if (v.effectiveTo && v.effectiveTo < v.effectiveFrom) throw bad("نهاية السريان قبل بدايته");
  if (v.businessId != null && !allowedBusinessIds.includes(v.businessId)) throw forbidden("النشاط خارج نطاقك");
  const crosses = hms(v.endTime) < hms(v.startTime);
  return runAttendanceTx(async tx => {
    const r = await tx.execute(sql`INSERT INTO attendance_shifts (tenantId, businessId, name, startTime, endTime, crossesMidnight, workDaysMask, graceMinutes, allowedBreakMinutes, overtimeStartsAfterMinutes, earlyClockInLimitMinutes, earlyLeaveToleranceMinutes, timezone, effectiveFrom, effectiveTo, createdByEmployeeId)
      VALUES (${actor.tenantId}, ${v.businessId}, ${v.name}, ${hms(v.startTime)}, ${hms(v.endTime)}, ${crosses ? 1 : 0}, ${maskFromDays(v.workDays)}, ${v.graceMinutes}, ${v.allowedBreakMinutes}, ${v.overtimeStartsAfterMinutes}, ${v.earlyClockInLimitMinutes}, ${v.earlyLeaveToleranceMinutes}, ${v.timezone}, ${v.effectiveFrom}, ${v.effectiveTo}, ${actor.employeeId})`);
    return { id: insertId(r), crossesMidnight: crosses };
  });
}

/** تعديل وردية بقفل تفاؤلي — الأيام السابقة لا تتأثر (لقطة الوردية محفوظة فيها). */
export async function updateShift(actor: AttendanceActor, id: number, version: number, input: ShiftInput, allowedBusinessIds: number[]) {
  const v = shiftInput.parse(input);
  if (hms(v.startTime) === hms(v.endTime)) throw bad("بداية الوردية ونهايتها لا يمكن أن تتساويا");
  if (v.businessId != null && !allowedBusinessIds.includes(v.businessId)) throw forbidden("النشاط خارج نطاقك");
  const crosses = hms(v.endTime) < hms(v.startTime);
  return runAttendanceTx(async tx => {
    const cur = await one(tx, sql`SELECT id, version FROM attendance_shifts WHERE id = ${id} AND tenantId = ${actor.tenantId} FOR UPDATE`);
    if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "الوردية غير موجودة" });
    if (Number(cur.version) !== version) throw conflict("الوردية تغيّرت منذ فتحها — أعد التحميل");
    await tx.execute(sql`UPDATE attendance_shifts SET businessId = ${v.businessId}, name = ${v.name}, startTime = ${hms(v.startTime)}, endTime = ${hms(v.endTime)}, crossesMidnight = ${crosses ? 1 : 0}, workDaysMask = ${maskFromDays(v.workDays)},
      graceMinutes = ${v.graceMinutes}, allowedBreakMinutes = ${v.allowedBreakMinutes}, overtimeStartsAfterMinutes = ${v.overtimeStartsAfterMinutes}, earlyClockInLimitMinutes = ${v.earlyClockInLimitMinutes},
      earlyLeaveToleranceMinutes = ${v.earlyLeaveToleranceMinutes}, timezone = ${v.timezone}, effectiveFrom = ${v.effectiveFrom}, effectiveTo = ${v.effectiveTo}, version = version + 1
      WHERE id = ${id} AND tenantId = ${actor.tenantId} AND version = ${version}`);
    return { id, version: version + 1 };
  });
}

export async function setShiftActive(actor: AttendanceActor, id: number, isActive: boolean) {
  return runAttendanceTx(async tx => {
    const cur = await one(tx, sql`SELECT id FROM attendance_shifts WHERE id = ${id} AND tenantId = ${actor.tenantId} FOR UPDATE`);
    if (!cur) throw new TRPCError({ code: "NOT_FOUND", message: "الوردية غير موجودة" });
    await tx.execute(sql`UPDATE attendance_shifts SET isActive = ${isActive ? 1 : 0}, version = version + 1 WHERE id = ${id} AND tenantId = ${actor.tenantId}`);
    return { id, isActive };
  });
}

export async function listShifts(tenantId: number) {
  return runAttendanceTx(async tx => rows(await tx.execute(sql`SELECT id, businessId, name, startTime, endTime, crossesMidnight, workDaysMask, graceMinutes, allowedBreakMinutes, overtimeStartsAfterMinutes, earlyClockInLimitMinutes, earlyLeaveToleranceMinutes, timezone, DATE_FORMAT(effectiveFrom, '%Y-%m-%d') AS effectiveFrom, DATE_FORMAT(effectiveTo, '%Y-%m-%d') AS effectiveTo, isActive, version FROM attendance_shifts WHERE tenantId = ${tenantId} ORDER BY isActive DESC, name`)));
}

// ==================== التعيينات ====================
export const assignmentInput = z.object({
  shiftId: z.number().int().positive(),
  targetType: z.enum(["employee", "role", "business", "tenant_default"]),
  employeeId: z.number().int().positive().nullable().optional(),
  role: z.string().min(1).max(50).nullable().optional(),
  businessId: z.number().int().positive().nullable().optional(),
  effectiveFrom: z.string().regex(ISO_DATE),
  effectiveTo: z.string().regex(ISO_DATE).nullable().optional(),
  replaceExisting: z.boolean().optional(),
}).strict();
export type AssignmentInput = z.infer<typeof assignmentInput>;

/**
 * تعيين وردية بلا تداخل: قفل صف الـtenant FOR UPDATE (يسلسل كل تعديلات التعيين في الشركة) ← البحث عن تعيين
 * نشط لنفس الهدف تتقاطع فترته ← رفض برسالة واضحة، أو (replaceExisting) إنهاء القديم وإدراج الجديد في نفس المعاملة.
 */
export async function assignShift(actor: AttendanceActor, input: AssignmentInput, allowedBusinessIds: number[]) {
  const v = assignmentInput.parse(input);
  const employeeId = v.targetType === "employee" ? v.employeeId ?? null : null;
  const role = v.targetType === "role" ? v.role ?? null : null;
  const businessId = v.targetType === "business" || v.targetType === "role" ? v.businessId ?? null : null;
  if (v.targetType === "employee" && employeeId == null) throw bad("اختر الموظف");
  if (v.targetType === "role" && !role) throw bad("اختر الدور");
  if (v.targetType === "business" && businessId == null) throw bad("اختر النشاط");
  if (businessId != null && !allowedBusinessIds.includes(businessId)) throw forbidden("النشاط خارج نطاقك");
  if (v.effectiveTo && v.effectiveTo < v.effectiveFrom) throw bad("نهاية السريان قبل بدايته");
  return runAttendanceTx(async tx => {
    await tx.execute(sql`SELECT id FROM tenants WHERE id = ${actor.tenantId} FOR UPDATE`);
    const shift = await one(tx, sql`SELECT id, isActive FROM attendance_shifts WHERE id = ${v.shiftId} AND tenantId = ${actor.tenantId}`);
    if (!shift) throw new TRPCError({ code: "NOT_FOUND", message: "الوردية غير موجودة" });
    if (employeeId != null) {
      const e = await one(tx, sql`SELECT id, businessId FROM employees WHERE id = ${employeeId} AND tenantId = ${actor.tenantId}`);
      if (!e || (e.businessId != null && !allowedBusinessIds.includes(Number(e.businessId)))) throw forbidden("الموظف خارج نطاقك");
    }
    const same = rows(await tx.execute(sql`SELECT id, DATE_FORMAT(effectiveFrom, '%Y-%m-%d') AS effectiveFrom, DATE_FORMAT(effectiveTo, '%Y-%m-%d') AS effectiveTo FROM attendance_assignments
      WHERE tenantId = ${actor.tenantId} AND endedAt IS NULL AND targetType = ${v.targetType} AND employeeId <=> ${employeeId} AND role <=> ${role} AND businessId <=> ${businessId} FOR UPDATE`));
    const overlapping = same.filter(a => rangesOverlap(a.effectiveFrom, a.effectiveTo ?? null, v.effectiveFrom, v.effectiveTo ?? null));
    if (overlapping.length && !v.replaceExisting)
      throw conflict(`يوجد تعيين متداخل لنفس الهدف (من ${overlapping[0].effectiveFrom}${overlapping[0].effectiveTo ? ` إلى ${overlapping[0].effectiveTo}` : " مفتوح"}) — أنهِه أو اختر الاستبدال`);
    for (const a of overlapping) {
      if (a.effectiveFrom < v.effectiveFrom) await tx.execute(sql`UPDATE attendance_assignments SET effectiveTo = ${addDays(v.effectiveFrom, -1)} WHERE id = ${a.id}`);
      else await tx.execute(sql`UPDATE attendance_assignments SET endedAt = NOW(3), endedByEmployeeId = ${actor.employeeId} WHERE id = ${a.id}`);
    }
    const r = await tx.execute(sql`INSERT INTO attendance_assignments (tenantId, shiftId, targetType, employeeId, role, businessId, effectiveFrom, effectiveTo, assignedByEmployeeId)
      VALUES (${actor.tenantId}, ${v.shiftId}, ${v.targetType}, ${employeeId}, ${role}, ${businessId}, ${v.effectiveFrom}, ${v.effectiveTo ?? null}, ${actor.employeeId})`);
    return { id: insertId(r), replaced: overlapping.length };
  });
}

export async function endAssignment(actor: AttendanceActor, id: number) {
  return runAttendanceTx(async tx => {
    await tx.execute(sql`SELECT id FROM tenants WHERE id = ${actor.tenantId} FOR UPDATE`);
    const a = await one(tx, sql`SELECT id, endedAt FROM attendance_assignments WHERE id = ${id} AND tenantId = ${actor.tenantId} FOR UPDATE`);
    if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "التعيين غير موجود" });
    if (a.endedAt != null) return { id, ended: true };
    await tx.execute(sql`UPDATE attendance_assignments SET endedAt = NOW(3), endedByEmployeeId = ${actor.employeeId} WHERE id = ${id}`);
    return { id, ended: true };
  });
}

export async function listAssignments(tenantId: number) {
  return runAttendanceTx(async tx => rows(await tx.execute(sql`SELECT a.id, a.shiftId, s.name AS shiftName, a.targetType, a.employeeId, e.name AS employeeName, a.role, a.businessId, DATE_FORMAT(a.effectiveFrom, '%Y-%m-%d') AS effectiveFrom, DATE_FORMAT(a.effectiveTo, '%Y-%m-%d') AS effectiveTo
    FROM attendance_assignments a JOIN attendance_shifts s ON s.id = a.shiftId LEFT JOIN employees e ON e.id = a.employeeId
    WHERE a.tenantId = ${tenantId} AND a.endedAt IS NULL ORDER BY a.effectiveFrom DESC, a.id DESC`)));
}

async function snapshotFor(tx: any, tenantId: number, emp: { id: number; role: string | null; businessId: number | null }, workDate: string): Promise<ShiftSnapshot | null> {
  const cands = rows(await tx.execute(sql`SELECT id, shiftId, targetType, employeeId, role, businessId, DATE_FORMAT(effectiveFrom, '%Y-%m-%d') AS effectiveFrom, DATE_FORMAT(effectiveTo, '%Y-%m-%d') AS effectiveTo
    FROM attendance_assignments WHERE tenantId = ${tenantId} AND endedAt IS NULL`)).map(r => ({ ...r, id: Number(r.id), shiftId: Number(r.shiftId), employeeId: r.employeeId == null ? null : Number(r.employeeId), businessId: r.businessId == null ? null : Number(r.businessId) })) as AssignmentCandidate[];
  const pick = pickAssignment(cands, emp, workDate);
  if (!pick) return null;
  const s = await one(tx, sql`SELECT id, name, startTime, endTime, crossesMidnight, timezone, workDaysMask, graceMinutes, allowedBreakMinutes, overtimeStartsAfterMinutes, earlyClockInLimitMinutes, earlyLeaveToleranceMinutes,
    DATE_FORMAT(effectiveFrom, '%Y-%m-%d') AS effectiveFrom, DATE_FORMAT(effectiveTo, '%Y-%m-%d') AS effectiveTo, isActive
    FROM attendance_shifts WHERE id = ${pick.shiftId} AND tenantId = ${tenantId}`);
  if (!s || !Number(s.isActive) || s.effectiveFrom > workDate || (s.effectiveTo && s.effectiveTo < workDate)) return null;
  return {
    shiftId: Number(s.id), name: s.name, startTime: String(s.startTime), endTime: String(s.endTime), crossesMidnight: Boolean(Number(s.crossesMidnight)), timezone: s.timezone,
    workDaysMask: Number(s.workDaysMask), graceMinutes: Number(s.graceMinutes), allowedBreakMinutes: Number(s.allowedBreakMinutes), overtimeStartsAfterMinutes: Number(s.overtimeStartsAfterMinutes),
    earlyClockInLimitMinutes: Number(s.earlyClockInLimitMinutes), earlyLeaveToleranceMinutes: Number(s.earlyLeaveToleranceMinutes),
  };
}

// ==================== اليوم والأحداث ====================
const DAY_COLS = sql`id, tenantId, employeeId, businessId, DATE_FORMAT(workDate, '%Y-%m-%d') AS workDate, timezone, shiftId, shiftSnapshotJson, status, version,
  UNIX_TIMESTAMP(scheduledStartAt) * 1000 AS scheduledStartMs, UNIX_TIMESTAMP(scheduledEndAt) * 1000 AS scheduledEndMs, UNIX_TIMESTAMP(firstInAt) * 1000 AS firstInMs, UNIX_TIMESTAMP(lastOutAt) * 1000 AS lastOutMs,
  UNIX_TIMESTAMP(openBreakStartedAt) * 1000 AS openBreakStartedMs, workedMinutes, breakMinutes, excessBreakMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes, requiresReview, reviewReason`;
const parseJson = (v: any) => (v == null ? null : typeof v === "string" ? JSON.parse(v) : v);

async function dayEvents(tx: any, dayId: number): Promise<ProjectionEvent[]> {
  return rows(await tx.execute(sql`SELECT id, eventType, correctionOfEventId, newValueJson, UNIX_TIMESTAMP(COALESCE(effectiveAt, occurredAt)) * 1000 AS atMs FROM attendance_events WHERE attendanceDayId = ${dayId} ORDER BY id`))
    .map(r => ({ id: Number(r.id), eventType: r.eventType, atMs: Number(r.atMs), correctionOfEventId: r.correctionOfEventId == null ? null : Number(r.correctionOfEventId), newValue: parseJson(r.newValueJson) }));
}

/** يعيد حساب اليوم من أحداثه ويحفظه بـversion (تحت FOR UPDATE من المتصل). */
async function reproject(tx: any, day: any): Promise<DayProjection> {
  const p = projectDay(await dayEvents(tx, Number(day.id)), parseJson(day.shiftSnapshotJson), day.workDate);
  const ms = (v: number | null) => (v == null ? null : v / 1000);
  const r = await tx.execute(sql`UPDATE attendance_days SET status = ${p.status},
    firstInAt = ${ms(p.firstInAt) == null ? sql`NULL` : sql`FROM_UNIXTIME(${ms(p.firstInAt)})`}, lastOutAt = ${ms(p.lastOutAt) == null ? sql`NULL` : sql`FROM_UNIXTIME(${ms(p.lastOutAt)})`},
    openBreakStartedAt = ${ms(p.openBreakStartedAt) == null ? sql`NULL` : sql`FROM_UNIXTIME(${ms(p.openBreakStartedAt)})`},
    workedMinutes = ${p.workedMinutes}, breakMinutes = ${p.breakMinutes}, excessBreakMinutes = ${p.excessBreakMinutes}, lateMinutes = ${p.lateMinutes},
    earlyLeaveMinutes = ${p.earlyLeaveMinutes}, overtimeMinutes = ${p.overtimeMinutes}, requiresReview = ${p.requiresReview ? 1 : 0}, reviewReason = ${p.reviewReason}, version = version + 1
    WHERE id = ${day.id} AND version = ${day.version}`);
  const affected = Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
  if (affected !== 1) throw conflict("تغيّر اليوم أثناء التنفيذ — أعد المحاولة");
  return p;
}

async function ensureDay(tx: any, actor: { tenantId: number }, emp: { id: number; role: string | null; businessId: number | null }, workDate: string, snap: ShiftSnapshot | null, timeZone: string) {
  const existing = await one(tx, sql`SELECT ${DAY_COLS} FROM attendance_days WHERE tenantId = ${actor.tenantId} AND employeeId = ${emp.id} AND workDate = ${workDate} FOR UPDATE`);
  if (existing) return existing;
  const w = snap ? scheduledWindow(workDate, snap) : null;
  await tx.execute(sql`INSERT INTO attendance_days (tenantId, employeeId, businessId, workDate, timezone, shiftId, shiftSnapshotJson, scheduledStartAt, scheduledEndAt)
    VALUES (${actor.tenantId}, ${emp.id}, ${emp.businessId}, ${workDate}, ${snap?.timezone ?? timeZone}, ${snap?.shiftId ?? null}, ${snap ? JSON.stringify(snap) : null},
      ${w ? sql`FROM_UNIXTIME(${w.startMs / 1000})` : sql`NULL`}, ${w ? sql`FROM_UNIXTIME(${w.endMs / 1000})` : sql`NULL`})`);
  return one(tx, sql`SELECT ${DAY_COLS} FROM attendance_days WHERE tenantId = ${actor.tenantId} AND employeeId = ${emp.id} AND workDate = ${workDate} FOR UPDATE`);
}

async function insertEvent(tx: any, e: { tenantId: number; dayId: number; employeeId: number; eventType: string; actorType: "self" | "admin" | "system"; actorEmployeeId: number | null; source: "web" | "mobile_web" | "admin" | "system"; key: string; hash: string; effectiveAtMs?: number | null; correctionOfEventId?: number | null; correctionRequestId?: number | null; reason?: string | null; newValue?: unknown; oldValue?: unknown; clientInfo?: unknown }) {
  const r = await tx.execute(sql`INSERT INTO attendance_events (tenantId, attendanceDayId, employeeId, eventType, effectiveAt, actorType, actorEmployeeId, source, idempotencyKey, payloadHash, correctionOfEventId, correctionRequestId, reason, oldValueJson, newValueJson, clientInfoJson)
    VALUES (${e.tenantId}, ${e.dayId}, ${e.employeeId}, ${e.eventType}, ${e.effectiveAtMs == null ? sql`NULL` : sql`FROM_UNIXTIME(${e.effectiveAtMs / 1000})`}, ${e.actorType}, ${e.actorEmployeeId}, ${e.source}, ${e.key}, ${e.hash},
      ${e.correctionOfEventId ?? null}, ${e.correctionRequestId ?? null}, ${e.reason ?? null}, ${e.oldValue == null ? null : JSON.stringify(e.oldValue)}, ${e.newValue == null ? null : JSON.stringify(e.newValue)}, ${e.clientInfo == null ? null : JSON.stringify(e.clientInfo)})`);
  return insertId(r);
}

/** Replay/Conflict بمفتاح العملية — قبل أي تغيير. */
async function replayCheck(tx: any, table: "attendance_events" | "attendance_correction_requests", tenantId: number, key: string, hash: string): Promise<boolean> {
  // قراءة **قافلة** (FOR UPDATE): ترى آخر ما التزم فعلًا (لا لقطة REPEATABLE READ القديمة) وتسلسل نفس المفتاح.
  const ex = await one(tx, sql`SELECT payloadHash FROM ${sql.raw(table)} WHERE tenantId = ${tenantId} AND idempotencyKey = ${key} FOR UPDATE`);
  if (!ex) return false;
  if (ex.payloadHash === hash) return true;
  throw conflict("نفس معرّف العملية استُخدم لطلب مختلف — لم يُنفَّذ أي تغيير");
}

export type ClockAction = "clock_in" | "break_start" | "break_end" | "clock_out";

/**
 * تسجيل حضور/استراحة/انصراف للموظف نفسه (الهوية من الجلسة). معاملة واحدة: قفل صف الموظف ← Replay ← وقت
 * السيرفر من الـDB ← اليوم المفتوح FOR UPDATE ← تحقق التسلسل ← الحدث ← إعادة حساب اليوم بـversion.
 */
export async function clock(actor: AttendanceActor, action: ClockAction, operationId: string, source: "web" | "mobile_web" = "web", clientInfo?: Record<string, unknown> | null) {
  OP.parse(operationId);
  return runAttendanceTx(async tx => {
    const emp = await one(tx, sql`SELECT e.id, e.isActive, e.role, e.businessId, COALESCE(b.timezone, 'Africa/Cairo') AS tz FROM employees e LEFT JOIN businesses b ON b.id = e.businessId WHERE e.id = ${actor.employeeId} AND e.tenantId = ${actor.tenantId} FOR UPDATE`);
    if (!emp || !Number(emp.isActive)) throw forbidden("حساب الموظف غير نشط");
    const key = `${action}:${operationId}`;
    const hash = canonicalHash({ action, employeeId: actor.employeeId });
    if (await replayCheck(tx, "attendance_events", actor.tenantId, key, hash)) {
      const day = await one(tx, sql`SELECT ${DAY_COLS} FROM attendance_days WHERE id = (SELECT attendanceDayId FROM attendance_events WHERE tenantId = ${actor.tenantId} AND idempotencyKey = ${key})`);
      return { replay: true, day };
    }
    const nowMs = Number((await one(tx, sql`SELECT UNIX_TIMESTAMP(NOW(3)) * 1000 AS ms`)).ms);
    const e = { id: Number(emp.id), role: emp.role ?? null, businessId: emp.businessId == null ? null : Number(emp.businessId) };
    const open = await one(tx, sql`SELECT ${DAY_COLS} FROM attendance_days WHERE tenantId = ${actor.tenantId} AND employeeId = ${e.id} AND status IN ('open','on_break') ORDER BY workDate DESC LIMIT 1 FOR UPDATE`);
    let day: any;
    if (action === "clock_in") {
      if (open && open.firstInMs != null) throw conflict(`لديك يوم مفتوح (${open.workDate}) — سجّل الانصراف أولًا`);
      // تاريخ العمل بتوقيت نشاط الموظف (IANA): وردية الأمس (الليلية بعد منتصف الليل) أو اليوم. لقطات الورديات
      // تُحمَّل مسبقًا لنطاق يغطي «أمس/اليوم» المحليين أيًا كان فرق التوقيت.
      const tz: string = emp.tz;
      const utcToday = new Date(nowMs).toISOString().slice(0, 10);
      const snaps = new Map<string, ShiftSnapshot | null>();
      for (const d of [-2, -1, 0, 1]) { const iso = addDays(utcToday, d); snaps.set(iso, await snapshotFor(tx, actor.tenantId, e, iso)); }
      const pick = workDateFor(nowMs, tz, d => snaps.get(d) ?? null);
      day = open && !open.firstInMs ? open : await ensureDay(tx, actor, e, pick.workDate, pick.snapshot, tz);
      if (day.status !== "open" || day.firstInMs != null) throw conflict(`تم تسجيل يوم ${day.workDate} بالفعل`);
    } else {
      if (!open || open.firstInMs == null) throw conflict("لا يوجد حضور مفتوح — سجّل الحضور أولًا");
      day = open;
      if (action === "break_start" && day.status !== "open") throw conflict("الاستراحة مفتوحة بالفعل");
      if (action === "break_end" && day.status !== "on_break") throw conflict("لا توجد استراحة مفتوحة");
      if (action === "clock_out" && day.status === "on_break") throw conflict("أنهِ الاستراحة أولًا");
    }
    await insertEvent(tx, { tenantId: actor.tenantId, dayId: Number(day.id), employeeId: e.id, eventType: action, actorType: "self", actorEmployeeId: e.id, source, key, hash, clientInfo: clientInfo ?? null });
    const fresh = await one(tx, sql`SELECT ${DAY_COLS} FROM attendance_days WHERE id = ${day.id} FOR UPDATE`);
    const projection = await reproject(tx, fresh);
    return { replay: false, day: { ...fresh, ...projection, version: Number(fresh.version) + 1 } };
  });
}

// ==================== طلبات التصحيح ====================
const at = z.string().datetime({ offset: true });
/** الحقول المسموحة لكل نوع — لا JSON حر من الواجهة. */
export const REQUESTED_VALUE_SCHEMAS: Record<CorrectionRequestType, z.ZodTypeAny> = {
  missing_clock_in: z.object({ at }).strict(),
  missing_clock_out: z.object({ at }).strict(),
  wrong_time: z.object({ at }).strict(),
  break_fix: z.object({ start: at, end: at }).strict(),
  absence_to_leave: z.object({}).strict(),
  absence_to_mission: z.object({}).strict(),
  early_leave_reason: z.object({}).strict(),
  other: z.object({}).strict(),
};
export const correctionRequestInput = z.object({
  workDate: z.string().regex(ISO_DATE),
  requestType: z.enum(["missing_clock_in", "missing_clock_out", "wrong_time", "break_fix", "absence_to_leave", "absence_to_mission", "early_leave_reason", "other"]),
  targetEventId: z.number().int().positive().nullable().optional(),
  requestedValue: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(3).max(500),
  note: z.string().max(500).nullable().optional(),
  operationId: OP,
}).strict();
export type CorrectionRequestInput = z.infer<typeof correctionRequestInput>;

export async function requestCorrection(actor: AttendanceActor, input: CorrectionRequestInput) {
  const v = correctionRequestInput.parse(input);
  const value = REQUESTED_VALUE_SCHEMAS[v.requestType].safeParse(v.requestedValue);
  if (!value.success) throw bad("قيمة الطلب غير صالحة لهذا النوع");
  if (v.requestType === "wrong_time" && v.targetEventId == null) throw bad("اختر الحدث المطلوب تصحيح وقته من أحداث اليوم");
  return runAttendanceTx(async tx => {
    const key = `req:${v.operationId}`;
    const hash = canonicalHash({ ...v, operationId: undefined, employeeId: actor.employeeId, requestedValue: value.data });
    if (await replayCheck(tx, "attendance_correction_requests", actor.tenantId, key, hash))
      return { replay: true, id: Number((await one(tx, sql`SELECT id FROM attendance_correction_requests WHERE tenantId = ${actor.tenantId} AND idempotencyKey = ${key}`)).id) };
    const day = await one(tx, sql`SELECT id FROM attendance_days WHERE tenantId = ${actor.tenantId} AND employeeId = ${actor.employeeId} AND workDate = ${v.workDate}`);
    if (v.targetEventId != null) {
      // الحدث المستهدف: للموظف نفسه، في نفس الشركة، **في يوم الطلب نفسه**، ومن الأنواع القابلة للتصحيح وغير ملغى.
      // (الاعتماد يطبّق التصحيح على يوم الطلب؛ حدث من يوم آخر كان سيُقبل ثم يُتجاهل بصمت في الإسقاط.)
      const ev = await one(tx, sql`SELECT id, attendanceDayId FROM attendance_events WHERE id = ${v.targetEventId} AND tenantId = ${actor.tenantId} AND employeeId = ${actor.employeeId}`);
      if (!ev) throw forbidden("الحدث المستهدف ليس لك");
      if (!day || Number(ev.attendanceDayId) !== Number(day.id)) throw bad("الحدث المستهدف ليس من أحداث اليوم المحدد");
      if (!correctableEvents(await dayEvents(tx, Number(day.id))).some(e => e.id === Number(v.targetEventId)))
        throw bad("هذا الحدث غير قابل لتصحيح الوقت");
    }
    const firstAt = (value.data as any).at ?? (value.data as any).start ?? null;
    const r = await tx.execute(sql`INSERT INTO attendance_correction_requests (tenantId, employeeId, attendanceDayId, workDate, requestType, targetEventId, requestedAt, requestedValueJson, reason, note, idempotencyKey, payloadHash)
      VALUES (${actor.tenantId}, ${actor.employeeId}, ${day?.id ?? null}, ${v.workDate}, ${v.requestType}, ${v.targetEventId ?? null}, ${firstAt ? sql`FROM_UNIXTIME(${Date.parse(firstAt) / 1000})` : sql`NULL`},
        ${JSON.stringify(value.data)}, ${v.reason}, ${v.note ?? null}, ${key}, ${hash})`);
    return { replay: false, id: insertId(r) };
  });
}

export async function cancelCorrection(actor: AttendanceActor, requestId: number) {
  return runAttendanceTx(async tx => {
    const r = await one(tx, sql`SELECT id, status FROM attendance_correction_requests WHERE id = ${requestId} AND tenantId = ${actor.tenantId} AND employeeId = ${actor.employeeId} FOR UPDATE`);
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "الطلب غير موجود" });
    if (r.status !== "pending") throw conflict("الطلب لم يعد قيد الانتظار");
    await tx.execute(sql`UPDATE attendance_correction_requests SET status = 'canceled', version = version + 1 WHERE id = ${requestId}`);
    return { id: requestId, status: "canceled" };
  });
}

const LEAVE_TYPES = new Set<CorrectionRequestType>(["absence_to_leave", "absence_to_mission"]);

/**
 * مراجعة طلب تصحيح (اعتماد/رفض) — المراجع لا يعتمد طلبه، الرفض بسبب إلزامي، الإجازة/المأمورية تحتاج
 * manage_leaves والباقي approve_corrections. الاعتماد يكتب حدث تصحيح (أو إجازة/مأمورية) ثم يعيد حساب اليوم.
 */
export async function reviewCorrection(actor: AttendanceActor, input: { requestId: number; decision: "approve" | "reject"; reviewReason?: string | null }, perms: { approveCorrections: boolean; manageLeaves: boolean }, allowedBusinessIds: number[],
  /** نطاق القائد (الفرق): صاحب الطلب يجب أن يكون من هؤلاء — يحل محل فحص نشاط الموظف (الموظفة قد تكون في فريق نشاط آخر). */
  scope?: { onlyEmployeeIds: number[] }) {
  return runAttendanceTx(async tx => {
    const req = await one(tx, sql`SELECT r.id, r.employeeId, r.status, r.requestType, r.targetEventId, r.requestedValueJson, DATE_FORMAT(r.workDate, '%Y-%m-%d') AS workDate, e.role, e.businessId, COALESCE(b.timezone, 'Africa/Cairo') AS tz
      FROM attendance_correction_requests r JOIN employees e ON e.id = r.employeeId LEFT JOIN businesses b ON b.id = e.businessId WHERE r.id = ${input.requestId} AND r.tenantId = ${actor.tenantId} FOR UPDATE`);
    if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "الطلب غير موجود" });
    if (scope) { if (!scope.onlyEmployeeIds.includes(Number(req.employeeId))) throw forbidden("الطلب خارج نطاق فريقك"); }
    else if (req.businessId != null && !allowedBusinessIds.includes(Number(req.businessId))) throw forbidden("الطلب خارج نطاقك");
    if (Number(req.employeeId) === actor.employeeId) throw forbidden("لا يمكنك مراجعة طلبك");
    if (LEAVE_TYPES.has(req.requestType) ? !perms.manageLeaves : !perms.approveCorrections) throw forbidden("ليس لديك صلاحية مراجعة هذا النوع");
    if (req.status !== "pending") throw conflict("تمت مراجعة الطلب بالفعل");
    if (input.decision === "reject") {
      const reason = (input.reviewReason ?? "").trim();
      if (reason.length < 3) throw bad("سبب الرفض إلزامي");
      await tx.execute(sql`UPDATE attendance_correction_requests SET status = 'rejected', reviewedByEmployeeId = ${actor.employeeId}, reviewedAt = NOW(3), reviewReason = ${reason}, version = version + 1 WHERE id = ${req.id}`);
      return { id: Number(req.id), status: "rejected" as const };
    }
    const emp = { id: Number(req.employeeId), role: req.role ?? null, businessId: req.businessId == null ? null : Number(req.businessId) };
    const snap = await snapshotFor(tx, actor.tenantId, emp, req.workDate);
    const day = await ensureDay(tx, actor, emp, req.workDate, snap, req.tz);
    const value = parseJson(req.requestedValueJson) ?? {};
    const reason = `اعتماد طلب تصحيح #${req.id}`;
    const base = { tenantId: actor.tenantId, dayId: Number(day.id), employeeId: emp.id, actorType: "admin" as const, actorEmployeeId: actor.employeeId, source: "admin" as const, correctionRequestId: Number(req.id), reason };
    const ev = (suffix: string, extra: Record<string, unknown>) => insertEvent(tx, { ...base, key: `review:${req.id}:${suffix}`, hash: canonicalHash({ requestId: req.id, suffix }), ...(extra as any) });
    switch (req.requestType as CorrectionRequestType) {
      case "absence_to_leave": await ev("leave", { eventType: "leave" }); break;
      case "absence_to_mission": await ev("mission", { eventType: "mission" }); break;
      case "missing_clock_in": await ev("in", { eventType: "correction", newValue: { eventType: "clock_in", atMs: Date.parse(value.at) } }); break;
      case "missing_clock_out": await ev("out", { eventType: "correction", newValue: { eventType: "clock_out", atMs: Date.parse(value.at) } }); break;
      case "wrong_time": await ev("time", { eventType: "correction", correctionOfEventId: Number(req.targetEventId), newValue: { atMs: Date.parse(value.at) } }); break;
      case "break_fix":
        await ev("bs", { eventType: "correction", newValue: { eventType: "break_start", atMs: Date.parse(value.start) } });
        await ev("be", { eventType: "correction", newValue: { eventType: "break_end", atMs: Date.parse(value.end) } });
        break;
      default: await ev("note", { eventType: "correction", newValue: {} });
    }
    const fresh = await one(tx, sql`SELECT ${DAY_COLS} FROM attendance_days WHERE id = ${day.id} FOR UPDATE`);
    await reproject(tx, fresh);
    await tx.execute(sql`UPDATE attendance_correction_requests SET status = 'approved', attendanceDayId = ${day.id}, reviewedByEmployeeId = ${actor.employeeId}, reviewedAt = NOW(3), reviewReason = ${input.reviewReason ?? null}, version = version + 1 WHERE id = ${req.id}`);
    return { id: Number(req.id), status: "approved" as const };
  });
}

/** تصحيح إداري مباشر (attendance.correct) — حدث جديد بسبب إلزامي، لا UPDATE صامت. */
export async function adminCorrect(actor: AttendanceActor, input: { employeeId: number; workDate: string; eventType: ClockAction | "day_close" | "day_reopen"; at?: string | null; correctionOfEventId?: number | null; voidEvent?: boolean; reason: string; operationId: string }, allowedBusinessIds: number[]) {
  OP.parse(input.operationId);
  if (!ISO_DATE.test(input.workDate)) throw bad("تاريخ غير صالح");
  const reason = input.reason.trim();
  if (reason.length < 3) throw bad("سبب التصحيح إلزامي");
  if (input.employeeId === actor.employeeId) throw forbidden("لا يمكنك تصحيح حضورك بنفسك");
  const isMarker = input.eventType === "day_close" || input.eventType === "day_reopen";
  if (!isMarker && !input.voidEvent && !input.at) throw bad("الوقت مطلوب");
  if (input.at && Number.isNaN(Date.parse(input.at))) throw bad("وقت غير صالح");
  return runAttendanceTx(async tx => {
    const emp = await one(tx, sql`SELECT e.id, e.role, e.businessId, COALESCE(b.timezone, 'Africa/Cairo') AS tz FROM employees e LEFT JOIN businesses b ON b.id = e.businessId WHERE e.id = ${input.employeeId} AND e.tenantId = ${actor.tenantId} FOR UPDATE`);
    if (!emp || (emp.businessId != null && !allowedBusinessIds.includes(Number(emp.businessId)))) throw forbidden("الموظف خارج نطاقك");
    const key = `admin:${input.operationId}`;
    const hash = canonicalHash({ ...input, operationId: undefined });
    if (await replayCheck(tx, "attendance_events", actor.tenantId, key, hash)) return { replay: true };
    const e = { id: Number(emp.id), role: emp.role ?? null, businessId: emp.businessId == null ? null : Number(emp.businessId) };
    const snap = await snapshotFor(tx, actor.tenantId, e, input.workDate);
    const day = await ensureDay(tx, actor, e, input.workDate, snap, emp.tz);
    if (input.correctionOfEventId != null) {
      const target = await one(tx, sql`SELECT id FROM attendance_events WHERE id = ${input.correctionOfEventId} AND tenantId = ${actor.tenantId} AND employeeId = ${e.id} AND attendanceDayId = ${day.id}`);
      if (!target) throw forbidden("الحدث المستهدف ليس لهذا اليوم/الموظف");
    }
    await insertEvent(tx, {
      tenantId: actor.tenantId, dayId: Number(day.id), employeeId: e.id, actorType: "admin", actorEmployeeId: actor.employeeId, source: "admin", key, hash, reason,
      // علامة اليوم كما هي؛ تصحيح حدث موجود = correction مرتبط به؛ إضافة بصمة ناقصة = نفس نوع الحدث بفاعل admin
      // ووقت فعلي (effectiveAt) وسبب إلزامي — كلها أحداث جديدة، لا UPDATE صامت.
      ...(isMarker
        ? { eventType: input.eventType }
        : input.correctionOfEventId != null
          ? { eventType: "correction", correctionOfEventId: input.correctionOfEventId, newValue: input.voidEvent ? { void: true } : { atMs: Date.parse(input.at as string) } }
          : { eventType: input.eventType, effectiveAtMs: Date.parse(input.at as string) }),
    } as any);
    const fresh = await one(tx, sql`SELECT ${DAY_COLS} FROM attendance_days WHERE id = ${day.id} FOR UPDATE`);
    return { replay: false, projection: await reproject(tx, fresh) };
  });
}

// ==================== القراءة ====================
export async function myDays(actor: AttendanceActor, fromDate: string, toDate: string) {
  if (!ISO_DATE.test(fromDate) || !ISO_DATE.test(toDate)) throw bad("نطاق غير صالح");
  return runAttendanceTx(async tx => {
    const days = rows(await tx.execute(sql`SELECT ${DAY_COLS} FROM attendance_days WHERE tenantId = ${actor.tenantId} AND employeeId = ${actor.employeeId} AND workDate BETWEEN ${fromDate} AND ${toDate} ORDER BY workDate DESC`));
    const requests = rows(await tx.execute(sql`SELECT id, DATE_FORMAT(workDate, '%Y-%m-%d') AS workDate, requestType, status, reason, reviewReason FROM attendance_correction_requests WHERE tenantId = ${actor.tenantId} AND employeeId = ${actor.employeeId} AND workDate BETWEEN ${fromDate} AND ${toDate} ORDER BY id DESC`));
    const open = await one(tx, sql`SELECT ${DAY_COLS} FROM attendance_days WHERE tenantId = ${actor.tenantId} AND employeeId = ${actor.employeeId} AND status IN ('open','on_break') ORDER BY workDate DESC LIMIT 1`);
    return { days, requests, open: open ?? null };
  });
}

/** أحداث يوم الموظف القابلة لتصحيح الوقت (هوية البوابة فقط) — بوقتها الحالي بعد التصحيحات المعتمدة. */
export async function myCorrectableEvents(actor: AttendanceActor, workDate: string) {
  if (!ISO_DATE.test(workDate)) throw bad("تاريخ غير صالح");
  return runAttendanceTx(async tx => {
    const day = await one(tx, sql`SELECT id, timezone FROM attendance_days WHERE tenantId = ${actor.tenantId} AND employeeId = ${actor.employeeId} AND workDate = ${workDate}`);
    if (!day) return { timezone: null as string | null, events: [] as CorrectableEvent[] };
    return { timezone: String(day.timezone), events: correctableEvents(await dayEvents(tx, Number(day.id))) };
  });
}

export async function teamDays(tenantId: number, businessIds: number[], fromDate: string, toDate: string) {
  if (!ISO_DATE.test(fromDate) || !ISO_DATE.test(toDate)) throw bad("نطاق غير صالح");
  const ids = businessIds.length ? businessIds : [-1];
  return runAttendanceTx(async tx => ({
    days: rows(await tx.execute(sql`SELECT d.id, d.employeeId, e.name AS employeeName, DATE_FORMAT(d.workDate, '%Y-%m-%d') AS workDate, d.status, d.workedMinutes, d.breakMinutes, d.excessBreakMinutes, d.lateMinutes, d.earlyLeaveMinutes, d.overtimeMinutes, d.requiresReview, d.reviewReason,
      UNIX_TIMESTAMP(d.firstInAt) * 1000 AS firstInMs, UNIX_TIMESTAMP(d.lastOutAt) * 1000 AS lastOutMs, d.timezone
      FROM attendance_days d JOIN employees e ON e.id = d.employeeId WHERE d.tenantId = ${tenantId} AND e.businessId IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)}) AND d.workDate BETWEEN ${fromDate} AND ${toDate} ORDER BY d.workDate DESC, e.name`)),
    pending: rows(await tx.execute(sql`SELECT r.id, r.employeeId, e.name AS employeeName, DATE_FORMAT(r.workDate, '%Y-%m-%d') AS workDate, r.requestType, r.reason, r.requestedValueJson, UNIX_TIMESTAMP(r.createdAt) * 1000 AS createdMs
      FROM attendance_correction_requests r JOIN employees e ON e.id = r.employeeId WHERE r.tenantId = ${tenantId} AND e.businessId IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)}) AND r.status = 'pending' ORDER BY r.id`)),
  }));
}

/**
 * أيام وطلبات معلّقة لقائمة موظفين محددة (نطاق القائد) — قراءة فقط. المتصل يقرر أي يوم يخص الفريق بعضوية
 * الموظف لحظة اليوم (anchorMs: أول حضور، وإلا بداية الوردية المجدولة).
 */
export async function daysForEmployees(tenantId: number, employeeIds: number[], fromDate: string, toDate: string) {
  if (!ISO_DATE.test(fromDate) || !ISO_DATE.test(toDate)) throw bad("نطاق غير صالح");
  const ids = employeeIds.length ? employeeIds : [-1];
  const inIds = sql.join(ids.map(i => sql`${i}`), sql`, `);
  return runAttendanceTx(async tx => ({
    days: rows(await tx.execute(sql`SELECT d.id, d.employeeId, e.name AS employeeName, DATE_FORMAT(d.workDate, '%Y-%m-%d') AS workDate, d.status, d.workedMinutes, d.breakMinutes, d.excessBreakMinutes, d.lateMinutes, d.earlyLeaveMinutes, d.overtimeMinutes, d.requiresReview, d.reviewReason,
      UNIX_TIMESTAMP(d.firstInAt) * 1000 AS firstInMs, UNIX_TIMESTAMP(d.lastOutAt) * 1000 AS lastOutMs, UNIX_TIMESTAMP(d.scheduledStartAt) * 1000 AS scheduledStartMs, d.timezone
      FROM attendance_days d JOIN employees e ON e.id = d.employeeId AND e.tenantId = d.tenantId WHERE d.tenantId = ${tenantId} AND d.employeeId IN (${inIds}) AND d.workDate BETWEEN ${fromDate} AND ${toDate} ORDER BY d.workDate DESC, e.name`)),
    pending: rows(await tx.execute(sql`SELECT r.id, r.employeeId, e.name AS employeeName, DATE_FORMAT(r.workDate, '%Y-%m-%d') AS workDate, r.requestType, r.reason, r.requestedValueJson, UNIX_TIMESTAMP(r.createdAt) * 1000 AS createdMs
      FROM attendance_correction_requests r JOIN employees e ON e.id = r.employeeId AND e.tenantId = r.tenantId WHERE r.tenantId = ${tenantId} AND r.employeeId IN (${inIds}) AND r.status = 'pending' ORDER BY r.id`)),
  }));
}

// ==================== Reconcile (قراءة فقط) ====================
export type ReconcileMismatch = { dayId: number; employeeId: number; workDate: string; field: string; stored: unknown; computed: unknown };
const RECON_FIELDS = ["status", "workedMinutes", "breakMinutes", "excessBreakMinutes", "lateMinutes", "earlyLeaveMinutes", "overtimeMinutes"] as const;

/** يعيد حساب كل يوم من أحداثه ويقارنه بالمخزَّن — منفّذ READ ONLY، لا يكتب شيئًا. */
export async function reconcileAttendance(exec: ReadOnlyExecutor, tenantId: number, fromDate?: string, toDate?: string): Promise<{ checked: number; mismatches: ReconcileMismatch[] }> {
  const range = fromDate && toDate ? " AND workDate BETWEEN ? AND ?" : "";
  const days = await exec.query<any>(`SELECT id, employeeId, DATE_FORMAT(workDate, '%Y-%m-%d') AS workDate, shiftSnapshotJson, status, workedMinutes, breakMinutes, excessBreakMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes FROM attendance_days WHERE tenantId = ?${range}`, fromDate && toDate ? [tenantId, fromDate, toDate] : [tenantId]);
  const mismatches: ReconcileMismatch[] = [];
  for (const d of days) {
    const evs = (await exec.query<any>("SELECT id, eventType, correctionOfEventId, newValueJson, UNIX_TIMESTAMP(COALESCE(effectiveAt, occurredAt)) * 1000 AS atMs FROM attendance_events WHERE attendanceDayId = ? ORDER BY id", [d.id]))
      .map(r => ({ id: Number(r.id), eventType: r.eventType, atMs: Number(r.atMs), correctionOfEventId: r.correctionOfEventId == null ? null : Number(r.correctionOfEventId), newValue: parseJson(r.newValueJson) }));
    const p = projectDay(evs, parseJson(d.shiftSnapshotJson), d.workDate);
    for (const f of RECON_FIELDS) {
      const stored = f === "status" ? d[f] : Number(d[f]);
      if (stored !== (p as any)[f]) mismatches.push({ dayId: Number(d.id), employeeId: Number(d.employeeId), workDate: d.workDate, field: f, stored, computed: (p as any)[f] });
    }
  }
  return { checked: days.length, mismatches };
}
