import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, getDb, createEmployee } from "./db";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { ATTENDANCE_MIGRATION } from "./attendanceMigration";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { tenantRolePermissions } from "../drizzle/schema";
import { COOKIE_NAME } from "@shared/const";

/** مسارات الحضور: المصفوفة (افتراضي/منح/سحب فوري)، عزل A/B، الجلسة المزدوجة، تزوير الهوية، والعلم. */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const portal = async (id: number, ownerOf?: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id), ...(ownerOf ? { [COOKIE_NAME]: sign(ownerOf) } : {}) } }, res } as any));
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const op = () => `op${Math.random().toString(36).slice(2, 14)}`;
const RANGE = { dateFrom: "2026-01-01", dateTo: "2027-12-31" };
const SHIFT = { name: "مثال", businessId: null, startTime: "11:00", endTime: "18:00", workDays: ["sat", "sun", "mon", "tue", "wed", "thu"] as any, graceMinutes: 10, allowedBreakMinutes: 60, overtimeStartsAfterMinutes: 30, earlyClockInLimitMinutes: 60, earlyLeaveToleranceMinutes: 0, timezone: "Africa/Cairo", effectiveFrom: "2026-01-01", effectiveTo: null };

describe.runIf(CAN)("🛂 مسارات الحضور", () => {
  let tmp: TempSchema, bare: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const emp: Record<string, number> = {};
  const saved = process.env.ATTENDANCE_ENABLED;

  beforeAll(async () => {
    tmp = await createTempSchema("att_r"); bare = await createTempSchema("att_rb");
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [ATTENDANCE_MIGRATION, "drizzle/0042_attendance.sql", "0042"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("ar-a"); B = await createCoreTestFixture("ar-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { emp[k] = insId(await createEmployee({ name: `${k}-ar`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("agent", "agent", A); await mk("agent2", "agent", A); await mk("owner", "super_admin", A); await mk("mgr", "manager", A); await mk("viewer", "viewer", A); await mk("ownerB", "super_admin", B); await mk("agentB", "agent", B);
    process.env.ATTENDANCE_ENABLED = "true";
  }, 240_000);
  afterAll(async () => {
    if (saved == null) delete process.env.ATTENDANCE_ENABLED; else process.env.ATTENDANCE_ENABLED = saved;
    __setDbForTests(null); await tmp?.drop(); await bare?.drop();
  }, 120_000);

  it("الموظف: يسجّل ويرى نفسه، ولا يصل للإدارة؛ viewer بلا شيء", async () => {
    const a = await portal(emp.agent);
    expect((await a.employeePortal.attendanceClock({ action: "clock_in", operationId: op() })).replay).toBe(false);
    const mine = await a.employeePortal.attendanceMine(RANGE);
    expect(mine.enabled && mine.open?.employeeId).toBe(emp.agent);
    expect(await code(() => a.attendance.team(RANGE))).toBe("FORBIDDEN");
    expect(await code(() => a.attendance.createShift(SHIFT))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(emp.viewer)).employeePortal.attendanceClock({ action: "clock_in", operationId: op() }))).toBe("FORBIDDEN");
  });

  it("تزوير الهوية في المدخلات مرفوض (strict)", async () => {
    const a = await portal(emp.agent2);
    expect(await code(() => a.employeePortal.attendanceClock({ action: "clock_in", operationId: op(), employeeId: emp.agent } as any))).toBe("BAD_REQUEST");
    expect(await code(() => a.employeePortal.attendanceClock({ action: "clock_in", operationId: op(), tenantId: B.tenantId } as any))).toBe("BAD_REQUEST");
  });

  it("الجلسة المزدوجة: كوكي مالك مفتوح لا يغيّر هوية الموظف في البوابة", async () => {
    const both = await portal(emp.agent2, emp.owner);
    await both.employeePortal.attendanceClock({ action: "clock_in", operationId: op() });
    const [[row]] = (await tmp.raw.query("SELECT COUNT(*) n FROM attendance_events WHERE employeeId = ? AND actorEmployeeId = ?", [emp.agent2, emp.agent2])) as any;
    expect(Number(row.n)).toBe(1);
    const [[o]] = (await tmp.raw.query("SELECT COUNT(*) n FROM attendance_events WHERE employeeId = ?", [emp.owner])) as any;
    expect(Number(o.n)).toBe(0);
  });

  it("المالك: الورديات والتعيين والفريق والتصدير — داخل شركته فقط", async () => {
    const o = await web(emp.owner);
    const s = await o.attendance.createShift(SHIFT);
    await o.attendance.assign({ shiftId: s.id, targetType: "employee", employeeId: emp.agent, effectiveFrom: "2026-01-01" });
    expect(await code(() => o.attendance.assign({ shiftId: s.id, targetType: "employee", employeeId: emp.agentB, effectiveFrom: "2026-01-01" }))).toBe("FORBIDDEN");
    const t = await o.attendance.team(RANGE);
    expect(t.enabled && t.days.every((d: any) => d.employeeName.endsWith("-ar"))).toBe(true);
    expect(t.enabled && t.days.some((d: any) => d.employeeId === emp.agentB)).toBe(false);
    const csv = await o.attendance.exportCsv(RANGE);
    expect(csv.csv).toContain("agent-ar");
    const ob = await web(emp.ownerB);
    expect(await code(() => ob.attendance.assign({ shiftId: s.id, targetType: "tenant_default", effectiveFrom: "2026-01-01" }))).toBe("NOT_FOUND");
  });

  it("المدير: لا إدارة افتراضيًا، المنح يفتح فورًا، والسحب يمنع فورًا", async () => {
    const m = await web(emp.mgr);
    expect(await code(() => m.attendance.team(RANGE))).toBe("FORBIDDEN");
    expect(await code(() => m.attendance.createShift(SHIFT))).toBe("FORBIDDEN");
    const d = (await getDb())!;
    await d.insert(tenantRolePermissions).values({ tenantId: A.tenantId, role: "manager", permission: "attendance.view_all", isAllowed: true, updatedBy: emp.owner });
    expect(await code(() => m.attendance.team(RANGE))).toBe("ok");
    await tmp.raw.query("UPDATE tenant_role_permissions SET isAllowed = 0 WHERE tenantId = ? AND role = 'manager' AND permission = 'attendance.view_all'", [A.tenantId]);
    expect(await code(() => m.attendance.team(RANGE))).toBe("FORBIDDEN");
  });

  it("المراجعة: الطلب من البوابة، والاعتماد من المالك، ولا مراجعة لشركة أخرى", async () => {
    const a = await portal(emp.agent);
    const r = await a.employeePortal.attendanceRequestCorrection({ workDate: "2026-12-21", requestType: "absence_to_mission", requestedValue: {}, reason: "مأمورية عند عميل", operationId: op() });
    expect(await code(async () => (await web(emp.ownerB)).attendance.review({ requestId: r.id, decision: "approve" }))).toBe("NOT_FOUND");
    expect(await code(async () => (await web(emp.mgr)).attendance.review({ requestId: r.id, decision: "approve" }))).toBe("FORBIDDEN");
    expect((await (await web(emp.owner)).attendance.review({ requestId: r.id, decision: "approve" })).status).toBe("approved");
  });

  it("العلم معطل: القراءة enabled=false والكتابة مرفوضة؛ الجداول غائبة والعلم معطل: النظام يعمل", async () => {
    process.env.ATTENDANCE_ENABLED = "false";
    try {
      expect(await (await web(emp.owner)).attendance.team(RANGE)).toEqual({ enabled: false });
      expect(await (await portal(emp.agent)).employeePortal.attendanceMine(RANGE)).toEqual({ enabled: false });
      expect(await code(async () => (await portal(emp.agent)).employeePortal.attendanceClock({ action: "clock_out", operationId: op() }))).toBe("PRECONDITION_FAILED");
      __setDbForTests(drizzle(bare.url));
      const F = await createCoreTestFixture("ar-bare");
      const owner = insId(await createEmployee({ name: "bare-owner", role: "super_admin", isActive: true, tenantId: F.tenantId, businessId: F.businessId, username: `bo_${bare.name}`.slice(0, 50) } as any));
      expect(await (await web(owner)).attendance.status()).toEqual({ enabled: false });
      expect(await (await web(owner)).attendance.shifts()).toEqual({ enabled: false, rows: [] });
      process.env.ATTENDANCE_ENABLED = "true";
      expect(await code(async () => (await web(owner)).attendance.shifts())).toBe("PRECONDITION_FAILED");
    } finally {
      __setDbForTests(drizzle(tmp.url));
      process.env.ATTENDANCE_ENABLED = "true";
    }
  });
});
