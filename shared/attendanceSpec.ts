import type { TableSpec } from "./schemaSpec";

/**
 * مواصفة 0042 (الحضور والانصراف) كبيانات + الثوابت المشتركة بين الخدمة والواجهة.
 *
 * workDaysMask — Mapping ثابت (نفس تعليق الـDDL):
 *   bit0=السبت، bit1=الأحد، bit2=الاثنين، bit3=الثلاثاء، bit4=الأربعاء، bit5=الخميس، bit6=الجمعة.
 * لا Default في الخدمة ولا الواجهة: العميل يرسل الأيام صراحةً ويوم واحد على الأقل.
 */
export const ATTENDANCE_TABLES = ["attendance_shifts", "attendance_assignments", "attendance_days", "attendance_correction_requests", "attendance_events"] as const;
export type AttendanceTable = (typeof ATTENDANCE_TABLES)[number];

/** أيام الأسبوع بترتيب البتات. `Date.getUTCDay()`: 0=الأحد … 6=السبت. */
export const WEEKDAYS = [
  { bit: 0, key: "sat", label: "السبت", jsDay: 6 },
  { bit: 1, key: "sun", label: "الأحد", jsDay: 0 },
  { bit: 2, key: "mon", label: "الاثنين", jsDay: 1 },
  { bit: 3, key: "tue", label: "الثلاثاء", jsDay: 2 },
  { bit: 4, key: "wed", label: "الأربعاء", jsDay: 3 },
  { bit: 5, key: "thu", label: "الخميس", jsDay: 4 },
  { bit: 6, key: "fri", label: "الجمعة", jsDay: 5 },
] as const;
export type WeekdayKey = (typeof WEEKDAYS)[number]["key"];

export function maskFromDays(days: readonly WeekdayKey[]): number {
  return days.reduce((m, k) => m | (1 << WEEKDAYS.find(d => d.key === k)!.bit), 0);
}
export function daysFromMask(mask: number): WeekdayKey[] {
  return WEEKDAYS.filter(d => (mask & (1 << d.bit)) !== 0).map(d => d.key);
}
/** هل يوم الأسبوع (من getUTCDay لتاريخ `YYYY-MM-DD`) يوم عمل في القناع؟ */
export function isWorkDay(mask: number, isoDate: string): boolean {
  const js = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  const d = WEEKDAYS.find(w => w.jsDay === js)!;
  return (mask & (1 << d.bit)) !== 0;
}

export const ATTENDANCE_EVENT_TYPES = ["clock_in", "break_start", "break_end", "clock_out", "absence", "leave", "mission", "correction", "day_close", "day_reopen"] as const;
export type AttendanceEventType = (typeof ATTENDANCE_EVENT_TYPES)[number];
export const ATTENDANCE_DAY_STATUSES = ["open", "on_break", "closed", "absent", "leave", "mission", "holiday", "day_off", "incomplete"] as const;
export type AttendanceDayStatus = (typeof ATTENDANCE_DAY_STATUSES)[number];
export const CORRECTION_REQUEST_TYPES = ["missing_clock_in", "missing_clock_out", "wrong_time", "break_fix", "absence_to_leave", "absence_to_mission", "early_leave_reason", "other"] as const;
export type CorrectionRequestType = (typeof CORRECTION_REQUEST_TYPES)[number];
export const ASSIGNMENT_TARGETS = ["employee", "role", "business", "tenant_default"] as const;
export type AssignmentTarget = (typeof ASSIGNMENT_TARGETS)[number];

/** اقتراحات أولية في نموذج إنشاء الوردية فقط (قرارات المالك) — ليست Defaults في الخدمة. */
export const SHIFT_FORM_SUGGESTIONS = { graceMinutes: 10, allowedBreakMinutes: 60, overtimeStartsAfterMinutes: 30, earlyClockInLimitMinutes: 60, earlyLeaveToleranceMinutes: 0 } as const;

const ts = (name: string, nullable = false) => ({ name, type: "timestamp(3)", nullable });
const int = (name: string, nullable = false) => ({ name, type: "int", nullable });

export const ATTENDANCE_SPEC: Record<AttendanceTable, TableSpec> = {
  attendance_shifts: {
    columns: [
      int("id"), int("tenantId"), int("businessId", true),
      { name: "name", type: "varchar(80)", nullable: false },
      { name: "startTime", type: "time", nullable: false }, { name: "endTime", type: "time", nullable: false },
      { name: "crossesMidnight", type: "tinyint(1)", nullable: false },
      { name: "workDaysMask", type: "tinyint unsigned", nullable: false },
      { name: "graceMinutes", type: "smallint unsigned", nullable: false },
      { name: "allowedBreakMinutes", type: "smallint unsigned", nullable: false },
      { name: "overtimeStartsAfterMinutes", type: "smallint unsigned", nullable: false },
      { name: "earlyClockInLimitMinutes", type: "smallint unsigned", nullable: false },
      { name: "earlyLeaveToleranceMinutes", type: "smallint unsigned", nullable: false },
      { name: "timezone", type: "varchar(64)", nullable: false },
      { name: "effectiveFrom", type: "date", nullable: false }, { name: "effectiveTo", type: "date", nullable: true },
      { name: "isActive", type: "tinyint(1)", nullable: false },
      { name: "version", type: "int unsigned", nullable: false },
      int("createdByEmployeeId"), ts("createdAt"), ts("updatedAt"),
    ],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "ash_tenant_id_unique", columns: ["tenantId", "id"] }],
    indexes: [{ name: "ash_tenant_active_from", columns: ["tenantId", "isActive", "effectiveFrom"] }],
    foreignKeys: [
      { name: "fk_ash_tenant", columns: ["tenantId"], refTable: "tenants", refColumns: ["id"] },
      { name: "fk_ash_tenant_business", columns: ["tenantId", "businessId"], refTable: "businesses", refColumns: ["tenantId", "id"] },
      { name: "fk_ash_tenant_creator", columns: ["tenantId", "createdByEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
    ],
    checks: ["chk_ash_times", "chk_ash_days", "chk_ash_limits", "chk_ash_range", "chk_ash_name"],
  },
  attendance_assignments: {
    columns: [
      int("id"), int("tenantId"), int("shiftId"),
      { name: "targetType", type: "enum", nullable: false },
      int("employeeId", true), { name: "role", type: "varchar(50)", nullable: true }, int("businessId", true),
      { name: "effectiveFrom", type: "date", nullable: false }, { name: "effectiveTo", type: "date", nullable: true },
      int("assignedByEmployeeId"), ts("assignedAt"), int("endedByEmployeeId", true), ts("endedAt", true),
    ],
    uniques: [{ name: "PRIMARY", columns: ["id"] }, { name: "aas_tenant_id_unique", columns: ["tenantId", "id"] }],
    indexes: [
      { name: "aas_tenant_employee_from", columns: ["tenantId", "employeeId", "effectiveFrom"] },
      { name: "aas_tenant_target_from", columns: ["tenantId", "targetType", "role", "businessId", "effectiveFrom"] },
    ],
    foreignKeys: [
      { name: "fk_aas_tenant", columns: ["tenantId"], refTable: "tenants", refColumns: ["id"] },
      { name: "fk_aas_tenant_shift", columns: ["tenantId", "shiftId"], refTable: "attendance_shifts", refColumns: ["tenantId", "id"] },
      { name: "fk_aas_tenant_employee", columns: ["tenantId", "employeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
      { name: "fk_aas_tenant_business", columns: ["tenantId", "businessId"], refTable: "businesses", refColumns: ["tenantId", "id"] },
      { name: "fk_aas_tenant_assigner", columns: ["tenantId", "assignedByEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
      { name: "fk_aas_tenant_ender", columns: ["tenantId", "endedByEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
    ],
    checks: ["chk_aas_target", "chk_aas_range", "chk_aas_end"],
  },
  attendance_days: {
    columns: [
      int("id"), int("tenantId"), int("employeeId"), int("businessId", true),
      { name: "workDate", type: "date", nullable: false }, { name: "timezone", type: "varchar(64)", nullable: false },
      int("shiftId", true), { name: "shiftSnapshotJson", type: "json", nullable: true },
      ts("scheduledStartAt", true), ts("scheduledEndAt", true),
      { name: "status", type: "enum", nullable: false },
      ts("firstInAt", true), ts("lastOutAt", true), ts("openBreakStartedAt", true),
      { name: "workedMinutes", type: "int unsigned", nullable: false }, { name: "breakMinutes", type: "int unsigned", nullable: false },
      { name: "excessBreakMinutes", type: "int unsigned", nullable: false }, { name: "lateMinutes", type: "int unsigned", nullable: false },
      { name: "earlyLeaveMinutes", type: "int unsigned", nullable: false }, { name: "overtimeMinutes", type: "int unsigned", nullable: false },
      { name: "requiresReview", type: "tinyint(1)", nullable: false }, { name: "reviewReason", type: "varchar(160)", nullable: true },
      int("approvedByEmployeeId", true), ts("approvedAt", true),
      { name: "version", type: "int unsigned", nullable: false }, ts("createdAt"), ts("updatedAt"),
    ],
    uniques: [
      { name: "PRIMARY", columns: ["id"] },
      { name: "ad_tenant_employee_date_unique", columns: ["tenantId", "employeeId", "workDate"] },
      { name: "ad_tenant_id_unique", columns: ["tenantId", "id"] },
      { name: "ad_tenant_employee_id_unique", columns: ["tenantId", "employeeId", "id"] },
    ],
    indexes: [
      { name: "ad_tenant_date_status", columns: ["tenantId", "workDate", "status"] },
      { name: "ad_tenant_business_date", columns: ["tenantId", "businessId", "workDate"] },
    ],
    foreignKeys: [
      { name: "fk_ad_tenant", columns: ["tenantId"], refTable: "tenants", refColumns: ["id"] },
      { name: "fk_ad_tenant_employee", columns: ["tenantId", "employeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
      { name: "fk_ad_tenant_business", columns: ["tenantId", "businessId"], refTable: "businesses", refColumns: ["tenantId", "id"] },
      { name: "fk_ad_tenant_shift", columns: ["tenantId", "shiftId"], refTable: "attendance_shifts", refColumns: ["tenantId", "id"] },
      { name: "fk_ad_tenant_approver", columns: ["tenantId", "approvedByEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
    ],
    checks: ["chk_ad_times", "chk_ad_break", "chk_ad_approval", "chk_ad_snapshot"],
  },
  attendance_correction_requests: {
    columns: [
      int("id"), int("tenantId"), int("employeeId"), int("attendanceDayId", true),
      { name: "workDate", type: "date", nullable: false }, { name: "requestType", type: "enum", nullable: false },
      { name: "targetEventId", type: "bigint", nullable: true }, ts("requestedAt", true),
      { name: "requestedValueJson", type: "json", nullable: true },
      { name: "reason", type: "varchar(500)", nullable: false }, { name: "note", type: "varchar(500)", nullable: true },
      { name: "status", type: "enum", nullable: false },
      int("reviewedByEmployeeId", true), ts("reviewedAt", true), { name: "reviewReason", type: "varchar(500)", nullable: true },
      { name: "idempotencyKey", type: "varchar(191)", nullable: false }, { name: "payloadHash", type: "char(64)", nullable: false },
      { name: "version", type: "int unsigned", nullable: false }, ts("createdAt"), ts("updatedAt"),
    ],
    uniques: [
      { name: "PRIMARY", columns: ["id"] },
      { name: "acr_tenant_idem_unique", columns: ["tenantId", "idempotencyKey"] },
      { name: "acr_tenant_id_unique", columns: ["tenantId", "id"] },
      { name: "acr_tenant_employee_id_unique", columns: ["tenantId", "employeeId", "id"] },
    ],
    indexes: [
      { name: "acr_tenant_status_created", columns: ["tenantId", "status", "createdAt"] },
      { name: "acr_tenant_employee_date", columns: ["tenantId", "employeeId", "workDate"] },
    ],
    foreignKeys: [
      { name: "fk_acr_tenant", columns: ["tenantId"], refTable: "tenants", refColumns: ["id"] },
      { name: "fk_acr_tenant_employee", columns: ["tenantId", "employeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
      { name: "fk_acr_tenant_employee_day", columns: ["tenantId", "employeeId", "attendanceDayId"], refTable: "attendance_days", refColumns: ["tenantId", "employeeId", "id"] },
      { name: "fk_acr_tenant_reviewer", columns: ["tenantId", "reviewedByEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
      { name: "fk_acr_tenant_employee_target_event", columns: ["tenantId", "employeeId", "targetEventId"], refTable: "attendance_events", refColumns: ["tenantId", "employeeId", "id"] },
    ],
    checks: ["chk_acr_reason", "chk_acr_review", "chk_acr_reject", "chk_acr_no_self", "chk_acr_hash"],
  },
  attendance_events: {
    columns: [
      { name: "id", type: "bigint", nullable: false }, int("tenantId"), int("attendanceDayId"), int("employeeId"),
      { name: "eventType", type: "enum", nullable: false }, ts("occurredAt"), ts("effectiveAt", true),
      { name: "actorType", type: "enum", nullable: false }, int("actorEmployeeId", true),
      { name: "source", type: "enum", nullable: false },
      { name: "idempotencyKey", type: "varchar(191)", nullable: false }, { name: "payloadHash", type: "char(64)", nullable: false },
      { name: "correctionOfEventId", type: "bigint", nullable: true }, int("correctionRequestId", true),
      { name: "reason", type: "varchar(200)", nullable: true },
      { name: "oldValueJson", type: "json", nullable: true }, { name: "newValueJson", type: "json", nullable: true },
      { name: "clientInfoJson", type: "json", nullable: true }, ts("createdAt"),
    ],
    uniques: [
      { name: "PRIMARY", columns: ["id"] },
      { name: "ae_tenant_idem_unique", columns: ["tenantId", "idempotencyKey"] },
      { name: "ae_tenant_id_unique", columns: ["tenantId", "id"] },
      { name: "ae_tenant_employee_id_unique", columns: ["tenantId", "employeeId", "id"] },
    ],
    indexes: [
      { name: "ae_tenant_employee_occurred", columns: ["tenantId", "employeeId", "occurredAt"] },
      { name: "ae_day_occurred", columns: ["attendanceDayId", "occurredAt"] },
    ],
    foreignKeys: [
      { name: "fk_ae_tenant", columns: ["tenantId"], refTable: "tenants", refColumns: ["id"] },
      { name: "fk_ae_tenant_employee", columns: ["tenantId", "employeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
      { name: "fk_ae_tenant_employee_day", columns: ["tenantId", "employeeId", "attendanceDayId"], refTable: "attendance_days", refColumns: ["tenantId", "employeeId", "id"] },
      { name: "fk_ae_tenant_actor", columns: ["tenantId", "actorEmployeeId"], refTable: "employees", refColumns: ["tenantId", "id"] },
      { name: "fk_ae_tenant_employee_correction_of", columns: ["tenantId", "employeeId", "correctionOfEventId"], refTable: "attendance_events", refColumns: ["tenantId", "employeeId", "id"] },
      { name: "fk_ae_tenant_employee_request", columns: ["tenantId", "employeeId", "correctionRequestId"], refTable: "attendance_correction_requests", refColumns: ["tenantId", "employeeId", "id"] },
    ],
    checks: ["chk_ae_actor", "chk_ae_correction", "chk_ae_hash"],
  },
};
