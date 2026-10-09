import { mysqlTable, int, bigint, varchar, char, smallint, tinyint, time, date, json, mysqlEnum, boolean } from "drizzle-orm/mysql-core";

/**
 * الحضور والانصراف (0042) — تعريفات Drizzle **للخدمة فقط** (ليست ضمن drizzle.config؛ لا push ولا generate).
 * المصدر الوحيد للإنشاء `drizzle/0042_attendance.sql` عبر `scripts/migrate-0042-attendance`. المفاتيح الأجنبية
 * المركّبة والثلاثية وقيود CHECK في الـDDL. الطوابع الزمنية تُكتب وتُقرأ في الخدمة بالـepoch
 * (FROM_UNIXTIME / UNIX_TIMESTAMP) داخل معاملات `time_zone='+00:00'` — لا اعتماد على timezone الاتصال.
 */
export const attendanceShifts = mysqlTable("attendance_shifts", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  businessId: int("businessId"),
  name: varchar("name", { length: 80 }).notNull(),
  startTime: time("startTime").notNull(),
  endTime: time("endTime").notNull(),
  crossesMidnight: boolean("crossesMidnight").notNull(),
  workDaysMask: tinyint("workDaysMask", { unsigned: true }).notNull(),
  graceMinutes: smallint("graceMinutes", { unsigned: true }).notNull(),
  allowedBreakMinutes: smallint("allowedBreakMinutes", { unsigned: true }).notNull(),
  overtimeStartsAfterMinutes: smallint("overtimeStartsAfterMinutes", { unsigned: true }).notNull(),
  earlyClockInLimitMinutes: smallint("earlyClockInLimitMinutes", { unsigned: true }).notNull(),
  earlyLeaveToleranceMinutes: smallint("earlyLeaveToleranceMinutes", { unsigned: true }).notNull(),
  timezone: varchar("timezone", { length: 64 }).notNull(),
  effectiveFrom: date("effectiveFrom", { mode: "string" }).notNull(),
  effectiveTo: date("effectiveTo", { mode: "string" }),
  isActive: boolean("isActive").notNull(),
  version: int("version", { unsigned: true }).notNull(),
  createdByEmployeeId: int("createdByEmployeeId").notNull(),
});

export const attendanceAssignments = mysqlTable("attendance_assignments", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  shiftId: int("shiftId").notNull(),
  targetType: mysqlEnum("targetType", ["employee", "role", "business", "tenant_default"]).notNull(),
  employeeId: int("employeeId"),
  role: varchar("role", { length: 50 }),
  businessId: int("businessId"),
  effectiveFrom: date("effectiveFrom", { mode: "string" }).notNull(),
  effectiveTo: date("effectiveTo", { mode: "string" }),
  assignedByEmployeeId: int("assignedByEmployeeId").notNull(),
  endedByEmployeeId: int("endedByEmployeeId"),
});

export const attendanceDays = mysqlTable("attendance_days", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  employeeId: int("employeeId").notNull(),
  businessId: int("businessId"),
  workDate: date("workDate", { mode: "string" }).notNull(),
  timezone: varchar("timezone", { length: 64 }).notNull(),
  shiftId: int("shiftId"),
  shiftSnapshotJson: json("shiftSnapshotJson"),
  status: mysqlEnum("status", ["open", "on_break", "closed", "absent", "leave", "mission", "holiday", "day_off", "incomplete"]).notNull(),
  workedMinutes: int("workedMinutes", { unsigned: true }).notNull(),
  breakMinutes: int("breakMinutes", { unsigned: true }).notNull(),
  excessBreakMinutes: int("excessBreakMinutes", { unsigned: true }).notNull(),
  lateMinutes: int("lateMinutes", { unsigned: true }).notNull(),
  earlyLeaveMinutes: int("earlyLeaveMinutes", { unsigned: true }).notNull(),
  overtimeMinutes: int("overtimeMinutes", { unsigned: true }).notNull(),
  requiresReview: boolean("requiresReview").notNull(),
  reviewReason: varchar("reviewReason", { length: 160 }),
  approvedByEmployeeId: int("approvedByEmployeeId"),
  version: int("version", { unsigned: true }).notNull(),
});

export const attendanceCorrectionRequests = mysqlTable("attendance_correction_requests", {
  id: int("id").autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  employeeId: int("employeeId").notNull(),
  attendanceDayId: int("attendanceDayId"),
  workDate: date("workDate", { mode: "string" }).notNull(),
  requestType: mysqlEnum("requestType", ["missing_clock_in", "missing_clock_out", "wrong_time", "break_fix", "absence_to_leave", "absence_to_mission", "early_leave_reason", "other"]).notNull(),
  targetEventId: bigint("targetEventId", { mode: "number" }),
  requestedValueJson: json("requestedValueJson"),
  reason: varchar("reason", { length: 500 }).notNull(),
  note: varchar("note", { length: 500 }),
  status: mysqlEnum("status", ["pending", "approved", "rejected", "canceled"]).notNull(),
  reviewedByEmployeeId: int("reviewedByEmployeeId"),
  reviewReason: varchar("reviewReason", { length: 500 }),
  idempotencyKey: varchar("idempotencyKey", { length: 191 }).notNull(),
  payloadHash: char("payloadHash", { length: 64 }).notNull(),
  version: int("version", { unsigned: true }).notNull(),
});

export const attendanceEvents = mysqlTable("attendance_events", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  tenantId: int("tenantId").notNull(),
  attendanceDayId: int("attendanceDayId").notNull(),
  employeeId: int("employeeId").notNull(),
  eventType: mysqlEnum("eventType", ["clock_in", "break_start", "break_end", "clock_out", "absence", "leave", "mission", "correction", "day_close", "day_reopen"]).notNull(),
  actorType: mysqlEnum("actorType", ["self", "admin", "system"]).notNull(),
  actorEmployeeId: int("actorEmployeeId"),
  source: mysqlEnum("source", ["web", "mobile_web", "admin", "system"]).notNull(),
  idempotencyKey: varchar("idempotencyKey", { length: 191 }).notNull(),
  payloadHash: char("payloadHash", { length: 64 }).notNull(),
  correctionOfEventId: bigint("correctionOfEventId", { mode: "number" }),
  correctionRequestId: int("correctionRequestId"),
  reason: varchar("reason", { length: 200 }),
  oldValueJson: json("oldValueJson"),
  newValueJson: json("newValueJson"),
  clientInfoJson: json("clientInfoJson"),
});

/** الطوابع (timestamp(3)) عمدًا غير معرّفة هنا: الخدمة تتعامل معها بـFROM_UNIXTIME/UNIX_TIMESTAMP فقط. */
export const ATTENDANCE_TIMESTAMP_COLUMNS = ["scheduledStartAt", "scheduledEndAt", "firstInAt", "lastOutAt", "openBreakStartedAt", "approvedAt", "occurredAt", "effectiveAt", "requestedAt", "reviewedAt", "assignedAt", "endedAt", "createdAt", "updatedAt"] as const;
