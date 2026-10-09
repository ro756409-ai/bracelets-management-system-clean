import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, getDb, createEmployee } from "./db";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { businessDateKey } from "../shared/businessTime";
import { tenantRolePermissions } from "../drizzle/schema";
import { COOKIE_NAME } from "@shared/const";

/**
 * تقرير الأداء من سجل الأحداث عبر المسارات الحقيقية: الصلاحيات (view_all / view_self / export، والمدير بالمنح)،
 * عزل Tenant A/B، «أدائي» بهوية البوابة حتى مع جلسة مالك مفتوحة، والعلم معطل بلا وصول للجدول.
 */
const SQL = fs.readFileSync("drizzle/0041_order_activity_events.sql", "utf-8");
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const portal = async (id: number, ownerCookieOf?: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id), ...(ownerCookieOf ? { [COOKIE_NAME]: sign(ownerCookieOf) } : {}) } }, res } as any));
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const today = businessDateKey(new Date(), "Africa/Cairo");
const RANGE = { dateFrom: today, dateTo: today };
const op = () => `op${Math.random().toString(36).slice(2, 14)}`;

describe.runIf(CAN)("📈 تقرير الأداء من سجل الأحداث", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const emp: Record<string, number> = {};
  const saved = process.env.ORDER_EVENTS_ENABLED;

  async function order(f: CoreTestFixture, assignee: number) {
    const d = (await getDb())!;
    const { orders, orderItems } = await import("../drizzle/schema");
    const id = insId(await d.insert(orders).values({ businessId: f.businessId, orderNumber: `P-${Math.random().toString(36).slice(2, 10)}`, customerName: "c", customerPhone: "01000000000", customerAddress: "شارع تجريبي 12", governorate: "القاهرة", productName: "p", quantity: 1, totalAmount: "100.00", source: "manual", status: "new", productId: f.productId, assignedEmployeeId: assignee } as any));
    await d.insert(orderItems).values({ orderId: id, productId: f.productId, productName: "p", quantity: 1, unitPrice: "100.00" } as any);
    return id;
  }

  beforeAll(async () => {
    tmp = await createTempSchema("perf");
    expect((await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: SQL, deployEnv: "test", confirm: confirmPhrase("0041", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("perf-a"); B = await createCoreTestFixture("perf-b");
    await tmp.raw.query("UPDATE products SET currentStock = 100 WHERE id IN (?, ?)", [A.productId, B.productId]);
    const mk = async (key: string, role: string, f: CoreTestFixture) => { emp[key] = insId(await createEmployee({ name: `${key}-perf`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${key}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("agent1", "agent", A); await mk("agent2", "agent", A); await mk("owner", "super_admin", A); await mk("mgr", "manager", A); await mk("agentB", "agent", B);
    process.env.ORDER_EVENTS_ENABLED = "true";
    const a1 = await portal(emp.agent1), a2 = await portal(emp.agent2), ab = await portal(emp.agentB);
    for (let i = 0; i < 3; i++) {
      const o = await order(A, emp.agent1);
      await a1.employeePortal.markNoAnswer({ orderId: o, callAttempts: 2, operationId: op() });
      if (i < 2) await a1.employeePortal.confirm({ orderId: o, operationId: op() });
    }
    const o2 = await order(A, emp.agent2);
    await a2.employeePortal.cancel({ orderId: o2, cancelReason: "سعر", operationId: op() });
    const ob = await order(B, emp.agentB);
    await ab.employeePortal.confirm({ orderId: ob, operationId: op() });
  }, 240_000);

  afterAll(async () => {
    if (saved == null) delete process.env.ORDER_EVENTS_ENABLED; else process.env.ORDER_EVENTS_ENABLED = saved;
    __setDbForTests(null);
    await tmp?.drop();
  }, 120_000);

  it("المالك (view_all): الفريق داخل شركته فقط، والأرقام من الأحداث", async () => {
    const r = await (await web(emp.owner)).performance.team(RANGE);
    if (!r.enabled) throw new Error("expected enabled");
    const one = r.rows.find(x => x.employeeId === emp.agent1)!;
    expect(one).toMatchObject({ decisionEligibleOrders: 3, confirmedOrders: 2, confirmationRate: 66.7, noAnswerOrders: 3, noAnswerAttempts: 6, rank: null, rankable: false });
    expect(r.rows.find(x => x.employeeId === emp.agent2)).toMatchObject({ cancelledOrders: 1, confirmationRate: 0 });
    expect(r.rows.some(x => x.employeeId === emp.agentB)).toBe(false);
    expect(r.minSample).toBe(20);
  });

  it("تزوير businessIds لشركة أخرى = لا بيانات منها، وtenantId في المدخل يُرفض", async () => {
    const owner = await web(emp.owner);
    const r = await owner.performance.team({ ...RANGE, businessIds: [B.businessId] });
    expect(r.enabled && r.rows.length).toBe(0);
    expect(await code(() => owner.performance.team({ ...RANGE, tenantId: B.tenantId } as any))).toBe("BAD_REQUEST");
  });

  it("الموظف: view_all مرفوض، و«أدائي» يعرض نفسه فقط", async () => {
    const a1 = await portal(emp.agent1);
    expect(await code(() => a1.performance.team(RANGE))).toBe("FORBIDDEN");
    const mine = await a1.employeePortal.myPerformance(RANGE);
    if (!mine.enabled) throw new Error("expected enabled");
    expect(mine.rows.map(r => r.employeeId)).toEqual([emp.agent1]);
    expect(mine.rows[0].rank).toBeNull();
  });

  it("«أدائي» بهوية البوابة حتى مع جلسة مالك مفتوحة في نفس المتصفح", async () => {
    const both = await portal(emp.agent2, emp.owner);
    const mine = await both.employeePortal.myPerformance(RANGE);
    if (!mine.enabled) throw new Error("expected enabled");
    expect(mine.rows.map(r => r.employeeId)).toEqual([emp.agent2]);
  });

  it("المدير: مقارنة الفريق والتصدير بالمنح فقط، والسحب فوري", async () => {
    const m = await web(emp.mgr);
    expect(await code(() => m.performance.team(RANGE))).toBe("FORBIDDEN");
    expect(await code(() => m.performance.exportCsv(RANGE))).toBe("FORBIDDEN");
    const d = (await getDb())!;
    await d.insert(tenantRolePermissions).values({ tenantId: A.tenantId, role: "manager", permission: "employee_performance.view_all", isAllowed: true, updatedBy: emp.owner });
    expect(await code(() => m.performance.team(RANGE))).toBe("ok");
    await tmp.raw.query("UPDATE tenant_role_permissions SET isAllowed = 0 WHERE tenantId = ? AND role = 'manager' AND permission = 'employee_performance.view_all'", [A.tenantId]);
    expect(await code(() => m.performance.team(RANGE))).toBe("FORBIDDEN");
  });

  it("التصدير CSV للمالك بنفس النطاق", async () => {
    const r = await (await web(emp.owner)).performance.exportCsv(RANGE);
    expect(r.enabled).toBe(true);
    expect(r.csv).toContain("agent1-perf");
    expect(r.csv).not.toContain("agentB-perf");
  });

  it("العلم معطل: enabled=false بلا وصول للجدول", async () => {
    process.env.ORDER_EVENTS_ENABLED = "false";
    try {
      await tmp.raw.query("RENAME TABLE order_activity_events TO oae_hidden");
      expect(await (await web(emp.owner)).performance.team(RANGE)).toEqual({ enabled: false });
      expect(await (await portal(emp.agent1)).employeePortal.myPerformance(RANGE)).toEqual({ enabled: false });
      expect(await (await web(emp.owner)).performance.status()).toEqual({ enabled: false });
      process.env.ORDER_EVENTS_ENABLED = "true";
      expect(await code(async () => (await web(emp.owner)).performance.team(RANGE))).toBe("PRECONDITION_FAILED");
    } finally {
      await tmp.raw.query("RENAME TABLE oae_hidden TO order_activity_events");
      process.env.ORDER_EVENTS_ENABLED = "true";
    }
  });
});
