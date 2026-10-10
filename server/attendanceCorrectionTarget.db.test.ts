import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { ATTENDANCE_MIGRATION } from "./attendanceMigration";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { COOKIE_NAME } from "@shared/const";

/**
 * «وقت مسجّل خطأ» (wrong_time) — targetEventId إلزامي ويُختار من أحداث **يوم الموظف نفسه** القابلة للتصحيح:
 * سيناريو Staging (2026-10-10: حضور 12:16 م، انصراف 12:19 م، الصحيح 12:30 م) من الطلب حتى الاعتماد والإسقاط،
 * ومنع حدث موظف آخر/Tenant آخر/يوم آخر/حدث ملغى، وstrict بلا هوية من العميل.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const at = (d: string, hm: string) => new Date(`${d}T${hm}:00+03:00`).toISOString();
let seq = 0;
const op = () => `tgt${Date.now().toString(36)}${++seq}`;
const D = "2026-10-10";

describe.runIf(CAN)("🎯 تصحيح الوقت — الحدث المستهدف", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const emp: Record<string, number> = {};
  const saved = process.env.ATTENDANCE_ENABLED;
  const eventsOf = async (employeeId: number, workDate: string) =>
    ((await tmp.raw.query("SELECT e.id, e.eventType FROM attendance_events e JOIN attendance_days d ON d.id = e.attendanceDayId WHERE e.employeeId = ? AND d.workDate = ? ORDER BY e.id", [employeeId, workDate])) as any)[0] as Array<{ id: number; eventType: string }>;
  const punch = async (ownerId: number, employeeId: number, workDate: string, punchType: string, hm: string) =>
    (await web(ownerId)).attendance.adminCorrect({ employeeId, workDate, punchType: punchType as any, at: at(workDate, hm), reason: "بيانات اختبار", operationId: op() });
  const request = async (id: number, targetEventId: number | null | undefined, workDate = D) =>
    (await portal(id)).employeePortal.attendanceRequestCorrection({ workDate, requestType: "wrong_time", ...(targetEventId !== undefined ? { targetEventId } : {}), requestedValue: { at: at(workDate, "12:30") }, reason: "سجّلت الانصراف مبكرًا بالخطأ", operationId: op() });

  beforeAll(async () => {
    tmp = await createTempSchema("att_tgt");
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [ATTENDANCE_MIGRATION, "drizzle/0042_attendance.sql", "0042"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    process.env.ATTENDANCE_ENABLED = "true";
    A = await createCoreTestFixture("tg-a"); B = await createCoreTestFixture("tg-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { emp[k] = insId(await createEmployee({ name: `${k}-tg`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("agent", "agent", A); await mk("agent2", "agent", A); await mk("owner", "super_admin", A); await mk("agentB", "agent", B); await mk("ownerB", "super_admin", B);
    await punch(emp.owner, emp.agent, D, "clock_in", "12:16");
    await punch(emp.owner, emp.agent, D, "clock_out", "12:19");
    await punch(emp.owner, emp.agent, "2026-10-08", "clock_in", "11:00");
    await punch(emp.owner, emp.agent2, D, "clock_in", "11:30");
    await punch(emp.ownerB, emp.agentB, D, "clock_in", "10:00");
  }, 240_000);
  afterAll(async () => {
    if (saved == null) delete process.env.ATTENDANCE_ENABLED; else process.env.ATTENDANCE_ENABLED = saved;
    __setDbForTests(null); await tmp?.drop();
  }, 120_000);

  it("أحداث يومي: للموظف نفسه ولليوم المحدد فقط، بوقتها", async () => {
    const r = await (await portal(emp.agent)).employeePortal.attendanceMyDayEvents({ workDate: D });
    expect(r.enabled && r.events.map(e => [e.eventType, new Date(e.atMs).toISOString()])).toEqual([["clock_in", at(D, "12:16")], ["clock_out", at(D, "12:19")]]);
    expect(r.enabled && r.timezone).toBe("Africa/Cairo");
    const other = await (await portal(emp.agent)).employeePortal.attendanceMyDayEvents({ workDate: "2026-10-09" });
    expect(other.enabled && other.events).toEqual([]);
    const a2 = await (await portal(emp.agent2)).employeePortal.attendanceMyDayEvents({ workDate: D });
    expect(a2.enabled && a2.events.map(e => e.eventType)).toEqual(["clock_in"]);
  });

  it("strict: لا employeeId/tenantId من العميل", async () => {
    const p = await portal(emp.agent);
    expect(await code(() => p.employeePortal.attendanceMyDayEvents({ workDate: D, employeeId: emp.agent2 } as any))).toBe("BAD_REQUEST");
  });

  it("بلا targetEventId ⇒ رفض واضح (هذا كان العيب: الواجهة لا ترسله)", async () => {
    expect(await code(() => request(emp.agent, undefined))).toBe("BAD_REQUEST");
  });

  it("منع: حدث موظف آخر، حدث Tenant آخر، حدث يوم آخر، حدث ملغى", async () => {
    const [a2In] = await eventsOf(emp.agent2, D);
    const [bIn] = await eventsOf(emp.agentB, D);
    const [otherDayIn] = await eventsOf(emp.agent, "2026-10-08");
    expect(await code(() => request(emp.agent, a2In.id))).toBe("FORBIDDEN");
    expect(await code(() => request(emp.agent, bIn.id))).toBe("FORBIDDEN");
    expect(await code(() => request(emp.agent, otherDayIn.id))).toBe("BAD_REQUEST");
    // إلغاء حدث (تصحيح إداري void) ثم محاولة استهدافه
    await punch(emp.owner, emp.agent, "2026-10-07", "clock_in", "09:00");
    const [toVoid] = await eventsOf(emp.agent, "2026-10-07");
    await (await web(emp.owner)).attendance.adminCorrect({ employeeId: emp.agent, workDate: "2026-10-07", punchType: "clock_in", correctionOfEventId: toVoid.id, voidEvent: true, reason: "إلغاء للاختبار", operationId: op() });
    expect(await code(() => request(emp.agent, toVoid.id, "2026-10-07"))).toBe("BAD_REQUEST");
    const after = await (await portal(emp.agent)).employeePortal.attendanceMyDayEvents({ workDate: "2026-10-07" });
    expect(after.enabled && after.events.some(e => e.id === toVoid.id)).toBe(false);
  });

  it("سيناريو Staging: انصراف 12:19 ⇒ 12:30 — طلب بالحدث الحقيقي، اعتماد، والإسقاط يعكس الوقت الجديد", async () => {
    const [, clockOut] = await eventsOf(emp.agent, D);
    const r = await request(emp.agent, clockOut.id);
    expect(r.replay).toBe(false);
    const [[row]] = (await tmp.raw.query("SELECT targetEventId, requestType FROM attendance_correction_requests WHERE id = ?", [r.id])) as any;
    expect(Number(row.targetEventId)).toBe(clockOut.id);
    expect((await (await web(emp.owner)).attendance.review({ requestId: r.id, decision: "approve" })).status).toBe("approved");
    const [[day]] = (await tmp.raw.query("SELECT UNIX_TIMESTAMP(lastOutAt) * 1000 AS lastOut FROM attendance_days WHERE employeeId = ? AND workDate = ?", [emp.agent, D])) as any;
    expect(new Date(Number(day.lastOut)).toISOString()).toBe(at(D, "12:30"));
    const ev = await (await portal(emp.agent)).employeePortal.attendanceMyDayEvents({ workDate: D });
    expect(ev.enabled && ev.events.find(e => e.id === clockOut.id)).toMatchObject({ corrected: true, atMs: Date.parse(at(D, "12:30")) });
  });
});
