import { and, between, eq, inArray } from "drizzle-orm";
import { attendanceDays } from "../drizzle/attendance.schema";
import { getDb } from "./db";

/**
 * ملخص الحضور الشهري لكل موظف (المرحلة 5) — مدخل دورة المرتب V3، قراءة فقط ولكل شركة:
 *  • حضور = closed/open/on_break/mission/incomplete؛ غياب = absent؛ إجازة = leave؛ عطلات/راحة = holiday/day_off (لا تُحسب).
 *  • الأوفرتايم المسجّل منفصل عن **المعتمد** (يوم معتمد approvedByEmployeeId) — الدورة تستخدم المعتمد فقط.
 *  • أيام تحتاج مراجعة (requiresReview أو incomplete) تُعدّ وتمنع اعتماد الدورة حتى تُراجع — لا حساب على بيانات ناقصة.
 *  • التاريخ نصي (workDate) بحدود الشهر — لا يتأثر بتوقيت Node.
 */
export type MonthlyAttendance = {
  employeeId: number; presentDays: number; absentDays: number; leaveDays: number; offDays: number;
  lateMinutes: number; recordedOvertimeMinutes: number; approvedOvertimeMinutes: number; reviewDays: number;
};

const PRESENT = new Set(["closed", "open", "on_break", "mission", "incomplete"]);
const OFF = new Set(["holiday", "day_off"]);

export function monthBounds(period: string): { from: string; to: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error("الفترة بصيغة YYYY-MM");
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, "0")}` };
}

export async function monthlyAttendanceSummary(input: { tenantId: number; period: string; employeeIds?: number[] }): Promise<MonthlyAttendance[]> {
  const { from, to } = monthBounds(input.period);
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const conds = [eq(attendanceDays.tenantId, input.tenantId), between(attendanceDays.workDate, from, to)];
  if (input.employeeIds) { if (input.employeeIds.length === 0) return []; conds.push(inArray(attendanceDays.employeeId, input.employeeIds)); }
  const rows = await db.select({
    employeeId: attendanceDays.employeeId, status: attendanceDays.status, lateMinutes: attendanceDays.lateMinutes, overtimeMinutes: attendanceDays.overtimeMinutes,
    requiresReview: attendanceDays.requiresReview, approvedBy: attendanceDays.approvedByEmployeeId,
  }).from(attendanceDays).where(and(...conds));
  const by = new Map<number, MonthlyAttendance>();
  for (const r of rows) {
    const s = by.get(r.employeeId) ?? { employeeId: r.employeeId, presentDays: 0, absentDays: 0, leaveDays: 0, offDays: 0, lateMinutes: 0, recordedOvertimeMinutes: 0, approvedOvertimeMinutes: 0, reviewDays: 0 };
    if (PRESENT.has(r.status)) s.presentDays++;
    else if (r.status === "absent") s.absentDays++;
    else if (r.status === "leave") s.leaveDays++;
    else if (OFF.has(r.status)) s.offDays++;
    s.lateMinutes += Number(r.lateMinutes);
    s.recordedOvertimeMinutes += Number(r.overtimeMinutes);
    if (r.approvedBy != null) s.approvedOvertimeMinutes += Number(r.overtimeMinutes);
    if (r.requiresReview || r.status === "incomplete") s.reviewDays++;
    by.set(r.employeeId, s);
  }
  return [...by.values()].sort((a, b) => a.employeeId - b.employeeId);
}
