import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { drizzle } from "drizzle-orm/mysql2";
import { __setDbForTests, createEmployee } from "./db";
import { createCoreTestFixture } from "./testFixtures";
import { confirmPhrase, runHandMigration } from "./handMigration.service";
import { ATTENDANCE_MIGRATION } from "./attendanceMigration";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { monthBounds, monthlyAttendanceSummary } from "./attendanceSummary.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";

/** ملخص الحضور الشهري (المرحلة 5): التصنيف، الأوفرتايم المعتمد منفصل، أيام المراجعة، حدود الشهر النصية، وعزل الشركات. */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe("🕘 حدود الشهر (نصية)", () => {
  it("فبراير الكبيس وأشهر 30/31", () => {
    expect(monthBounds("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthBounds("2026-09")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(monthBounds("2026-10").to).toBe("2026-10-31");
    expect(() => monthBounds("2026-13")).toThrow();
  });
});

describe.runIf(CAN)("🕘 ملخص الحضور الشهري على قاعدة حقيقية", () => {
  let tmp: TempSchema; let TA = 0, TB = 0, E1 = 0, E2 = 0, EB = 0, MGR = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const day = (tenant: number, emp: number, date: string, status: string, o: { late?: number; ot?: number; review?: boolean; approved?: number | null } = {}) =>
    q(`INSERT INTO attendance_days (tenantId, employeeId, workDate, timezone, status, workedMinutes, breakMinutes, excessBreakMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes, requiresReview, approvedByEmployeeId, approvedAt, version)
       VALUES (?, ?, ?, 'Africa/Cairo', ?, 480, 0, 0, ?, 0, ?, ?, ?, IF(? IS NULL, NULL, NOW(3)), 1)`, [tenant, emp, date, status, o.late ?? 0, o.ot ?? 0, o.review ? 1 : 0, o.approved ?? null, o.approved ?? null]);

  beforeAll(async () => {
    tmp = await createTempSchema("att_sum");
    // 0042 تعتمد على 0041 (نفس ترتيب اختبارات الحضور الحالية)
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [ATTENDANCE_MIGRATION, "drizzle/0042_attendance.sql", "0042"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    const A = await createCoreTestFixture("as-a"), B = await createCoreTestFixture("as-b");
    TA = A.tenantId; TB = B.tenantId;
    const mk = async (k: string, f: typeof A) => Number(((await createEmployee({ name: k, role: "agent", isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)) as any)?.insertId ?? (await q("SELECT id FROM employees WHERE username = ?", [`${k}_${tmp.name}`.slice(0, 50)]))[0].id);
    E1 = await mk("as_e1", A); E2 = await mk("as_e2", A); EB = await mk("as_eb", B); MGR = await mk("as_mgr", A);
    await day(TA, E1, "2026-09-30", "closed", { late: 99 }); // خارج أكتوبر
    await day(TA, E1, "2026-10-01", "closed", { late: 15, ot: 60, approved: MGR });
    await day(TA, E1, "2026-10-02", "closed", { ot: 30 }); // أوفرتايم غير معتمد
    await day(TA, E1, "2026-10-03", "absent");
    await day(TA, E1, "2026-10-04", "leave");
    await day(TA, E1, "2026-10-05", "day_off");
    await day(TA, E1, "2026-10-06", "incomplete");
    await day(TA, E1, "2026-10-31", "mission", { review: true });
    await day(TA, E1, "2026-11-01", "closed");
    await day(TA, E2, "2026-10-01", "closed");
    await day(TB, EB, "2026-10-01", "absent"); // شركة أخرى
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("تصنيف الأيام وحدود الشهر والأوفرتايم المعتمد فقط وأيام المراجعة — والشركة من المدخل لا من الصف", async () => {
    const s = await monthlyAttendanceSummary({ tenantId: TA, period: "2026-10" });
    expect(s).toEqual([
      { employeeId: E1, presentDays: 4, absentDays: 1, leaveDays: 1, offDays: 1, lateMinutes: 15, recordedOvertimeMinutes: 90, approvedOvertimeMinutes: 60, reviewDays: 2 },
      { employeeId: E2, presentDays: 1, absentDays: 0, leaveDays: 0, offDays: 0, lateMinutes: 0, recordedOvertimeMinutes: 0, approvedOvertimeMinutes: 0, reviewDays: 0 },
    ].sort((a, b) => a.employeeId - b.employeeId));
    expect(await monthlyAttendanceSummary({ tenantId: TA, period: "2026-10", employeeIds: [E2] })).toHaveLength(1);
    expect(await monthlyAttendanceSummary({ tenantId: TA, period: "2026-10", employeeIds: [] })).toEqual([]);
    // الشركة من المدخل: موظف شركة أخرى لا يظهر حتى لو طُلب بمعرّفه
    expect(await monthlyAttendanceSummary({ tenantId: TA, period: "2026-10", employeeIds: [EB] })).toEqual([]);
    expect(await monthlyAttendanceSummary({ tenantId: TB, period: "2026-10" })).toEqual([expect.objectContaining({ employeeId: EB, absentDays: 1, presentDays: 0 })]);
  });
});
