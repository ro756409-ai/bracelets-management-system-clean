import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { eq, inArray, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { getDb, createEmployee } from "./db";
import { businessGroups, businesses, employees, inventoryMovements, orders, products } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { COOKIE_NAME } from "@shared/const";

/**
 * P0 — استعلامات لوحة المدير (/manager-dashboard): كل استعلام بنطاق الجلسة (tenant الموظف + نشاطه)،
 * والمدير بلا نشاط = صفر، مش «كل الـtenants». قبل الإصلاح: productsList/lowStockProducts/
 * inventoryMovements/cancellationReasons/dailyChart كانوا بيمرّروا `emp.businessId ?? undefined`،
 * و`getDailyOrdersChart` مالوش أي شرط tenant؛ assignOrder بيقبل موظف أي tenant؛ والمدير/الأدمن
 * كان معفيًا من فحص نطاق الأوردر في confirm/cancel/postpone (assertEmployeeOwnsOrder).
 */

const routers = fs.readFileSync("server/routers.ts", "utf-8");
const portalSection = routers.slice(routers.indexOf("  employeePortal: router({"), routers.indexOf("  duplicates: router({"));

describe("🔒 P0 لوحة المدير — حراس نصّية", () => {
  it("مفيش أي قارئ في البوابة بياخد `emp.businessId ?? undefined` كفلتر", () => {
    // قرّاء db (get*) مايستقبلوش نشاط الموظف الخام — النطاق بس. (createOrder/createEmployee بيستخدموه
    // كقيمة افتراضية للكتابة وبيترفض/يتحلّ لو null — مش فلتر قراءة.)
    const code = portalSection.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/get[A-Za-z]+\([^;]*?emp\.businessId \?\? undefined/);
  });
  it("الرسم اليومي والإلغاءات والمنتجات والحركات بنطاق الجلسة", () => {
    for (const call of ["getDailyOrdersChart(input.days, undefined, await scopeBusinessIds(empScope(ctx), {}))",
      "getAllProducts(undefined, await scopeBusinessIds(empScope(ctx), {}))",
      "getLowStockProducts(undefined, await scopeBusinessIds(empScope(ctx), {}))"]) expect(portalSection, call).toContain(call);
  });
  it("assertEmployeeOwnsOrder يفحص النطاق قبل استثناء الدور، وassignOrder يفحص المستلم", () => {
    const fn = routers.slice(routers.indexOf("async function assertEmployeeOwnsOrder("), routers.indexOf("function requireTenantId("));
    expect(fn.indexOf('requireOwned(empScope({ employee: emp }), "order", orderId)')).toBeGreaterThan(-1);
    expect(fn.indexOf("requireOwned(")).toBeLessThan(fn.indexOf("isAdminTierRole("));
    const assign = portalSection.slice(portalSection.indexOf("assignOrder: managerPortalProcedure"), portalSection.indexOf("bulkAssignOrders:"));
    expect(assign).toContain('requireOwned(empScope(ctx), "employee", input.employeeId)');
  });
  it("groupsWithBusinesses: نطاق مجهول = لا شيء، والتصفية في الاستعلام", () => {
    const g = routers.slice(routers.indexOf("groupsWithBusinesses: authenticatedProcedure"), routers.indexOf("businessIdsByGroup:"));
    expect(g).toContain("if (allowed == null) return [];");
    expect(g).toContain("getBusinessGroupsWithBusinesses(denyWhenEmpty(allowed))");
  });
});

const CAN_E2E = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN_E2E)("🔒 P0 لوحة المدير — Tenant A / Tenant B (DB)", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  let A2 = 0, productA2 = 0, groupA = 0, groupB = 0;
  const tag = `mp${Date.now().toString(36)}`;
  const emp: Record<string, number> = {};
  const orderIds: number[] = [];
  const ord: Record<string, number> = {};
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
  const res = { cookie: () => {}, clearCookie: () => {} } as any;
  const portal = async (id: number) =>
    appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
  const web = async (id: number) =>
    appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
  async function code(fn: () => Promise<any>): Promise<string> {
    try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; }
  }
  const db = async () => (await getDb())!;
  const chartTotal = (rows: any[]) => rows.reduce((s, r) => s + (Number(r.total) || 0), 0);
  // نفس التاريخ لكل الـtenants: كل الأوردرات بتتعمل دلوقتي
  async function mkOrder(key: string, businessId: number, status = "new", extra: Record<string, unknown> = {}) {
    const id = insId(await (await db()).insert(orders).values({
      businessId,
      orderNumber: `M-${tag}-${Math.random().toString(36).slice(2, 6)}`.slice(0, 20),
      customerName: "cust", customerPhone: "01000000000", customerAddress: "addr",
      governorate: "القاهرة", productName: "prod", quantity: 1, totalAmount: "100.00",
      source: "manual", status, ...extra,
    } as any));
    orderIds.push(id); ord[key] = id; return id;
  }

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("mgr-a");
    B = await createCoreTestFixture("mgr-b");
    A2 = insId(await d.insert(businesses).values({ tenantId: A.tenantId, name: `A2 ${tag}`, slug: `a2-${tag}`, baseCurrency: "EGP", timezone: "Africa/Cairo" }));
    productA2 = insId(await d.insert(products).values({ businessId: A2, name: `prod A2 ${tag}`, sku: `A2-${tag}`, price: "100.00" }));
    groupA = insId(await d.insert(businessGroups).values({ tenantId: A.tenantId, name: `group A ${tag}`, slug: `ga-${tag}` } as any));
    groupB = insId(await d.insert(businessGroups).values({ tenantId: B.tenantId, name: `group B ${tag}`, slug: `gb-${tag}` } as any));
    await d.update(businesses).set({ groupId: groupA }).where(inArray(businesses.id, [A.businessId, A2]));
    await d.update(businesses).set({ groupId: groupB }).where(eq(businesses.id, B.businessId));
    const mk = async (key: string, role: string, tenantId: number, businessId: number | null) => {
      emp[key] = insId(await createEmployee({ name: `${key}-${tag}`, role, isActive: true, tenantId, businessId, username: `${key}_${tag}`.slice(0, 50) } as any));
    };
    await mk("mgrA", "manager", A.tenantId, A.businessId);
    await mk("mgrNone", "manager", A.tenantId, null);
    await mk("superA", "super_admin", A.tenantId, A.businessId);
    await mk("agentA", "agent", A.tenantId, A.businessId);
    await mk("mgrB", "manager", B.tenantId, B.businessId);
    await mk("agentB", "agent", B.tenantId, B.businessId);
    // A1: 3 أوردرات (واحد ملغي)، A2: 2، B: 4 (واحد ملغي) — كلها نفس اليوم
    await mkOrder("a1", A.businessId); await mkOrder("a2", A.businessId);
    await mkOrder("a3", A.businessId, "cancelled", { cancelReason: `reason-A ${tag}`, cancelledAt: new Date() });
    await mkOrder("x1", A2); await mkOrder("x2", A2);
    await mkOrder("b1", B.businessId); await mkOrder("b2", B.businessId); await mkOrder("b3", B.businessId);
    await mkOrder("b4", B.businessId, "cancelled", { cancelReason: `reason-B ${tag}`, cancelledAt: new Date() });
    await d.insert(inventoryMovements).values([
      { businessId: A.businessId, productId: A.productId, type: "in", quantity: 3, reason: `mv-A ${tag}` },
      { businessId: B.businessId, productId: B.productId, type: "in", quantity: 4, reason: `mv-B ${tag}` },
    ] as any);
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (orderIds.length) await d.delete(orders).where(inArray(orders.id, orderIds));
    await d.delete(orders).where(sql`${orders.orderNumber} LIKE ${`%${tag}%`}`);
    await d.delete(inventoryMovements).where(sql`${inventoryMovements.reason} LIKE ${`%${tag}%`}`);
    const ids = Object.values(emp);
    if (ids.length) await d.delete(employees).where(inArray(employees.id, ids));
    if (productA2) await d.delete(products).where(eq(products.id, productA2));
    if (A2) await d.delete(businesses).where(eq(businesses.id, A2));
    await d.update(businesses).set({ groupId: null }).where(inArray(businesses.id, [A.businessId, B.businessId]));
    await d.delete(businessGroups).where(inArray(businessGroups.id, [groupA, groupB].filter(Boolean)));
    await B?.cleanup(); await A?.cleanup();
  });

  it("الرسم اليومي: مدير A يشوف A1 بس (3)، مدير B يشوف B بس (4) — نفس التاريخ", async () => {
    expect(chartTotal(await (await portal(emp.mgrA)).employeePortal.dailyChart({ days: 30 }))).toBe(3);
    expect(chartTotal(await (await portal(emp.mgrB)).employeePortal.dailyChart({ days: 30 }))).toBe(4);
  });

  it("مدير بلا نشاط: صفر في كل البطاقات والعدادات والمجاميع (مش كل الـtenants)", async () => {
    const none = await portal(emp.mgrNone);
    expect(await none.employeePortal.dailyChart({ days: 30 })).toEqual([]);
    expect(await none.employeePortal.cancellationReasons({})).toEqual([]);
    expect(await none.employeePortal.productsList()).toEqual([]);
    expect(await none.employeePortal.lowStockProducts()).toEqual([]);
    expect(await none.employeePortal.inventoryMovements({})).toEqual([]);
    expect(await none.employeePortal.employeePerformance({})).toEqual([]);
    expect((await none.employeePortal.allOrders({})).orders).toEqual([]);
    const stats = await none.employeePortal.dashboardStats({});
    expect(stats?.statusStats ?? []).toEqual([]);
    expect(stats?.totalRevenue ?? 0).toBe(0);
  });

  it("البطاقات والعدادات والمجاميع معزولة لمدير A", async () => {
    const mgrA = await portal(emp.mgrA);
    const stats = await mgrA.employeePortal.dashboardStats({});
    expect(stats!.statusStats.reduce((s: number, x: any) => s + Number(x.count), 0)).toBe(3);
    const reasons = (await mgrA.employeePortal.cancellationReasons({})).map(r => r.reason);
    expect(reasons).toContain(`reason-A ${tag}`);
    expect(reasons).not.toContain(`reason-B ${tag}`);
    const all = (await mgrA.employeePortal.allOrders({ limit: 100 })).orders.map((o: any) => o.id);
    expect(all.sort()).toEqual([ord.a1, ord.a2, ord.a3].sort());
  });

  it("المنتجات والمخزون المنخفض والحركات معزولة", async () => {
    const mgrA = await portal(emp.mgrA);
    const pIds = (await mgrA.employeePortal.productsList()).map((p: any) => p.id);
    expect(pIds).toContain(A.productId);
    expect(pIds).not.toContain(B.productId);
    expect(pIds).not.toContain(productA2);
    const low = (await mgrA.employeePortal.lowStockProducts()).map((p: any) => p.id);
    expect(low).toContain(A.productId);
    expect(low).not.toContain(B.productId);
    const mv = (await mgrA.employeePortal.inventoryMovements({ limit: 200 })).map((m: any) => m.reason);
    expect(mv).toContain(`mv-A ${tag}`);
    expect(mv).not.toContain(`mv-B ${tag}`);
    expect(await code(() => mgrA.employeePortal.inventoryMovements({ productId: B.productId }))).toBe("FORBIDDEN");
  });

  it("تزوير businessId/businessIds يرجّع صفر بيانات من B", async () => {
    const mgrA = await portal(emp.mgrA);
    expect((await mgrA.employeePortal.allOrders({ businessId: B.businessId })).orders).toEqual([]);
    expect((await mgrA.employeePortal.allOrders({ businessIds: [B.businessId] })).orders).toEqual([]);
    const stats = await mgrA.employeePortal.dashboardStats({ businessIds: [B.businessId] });
    expect(stats!.statusStats).toEqual([]);
  });

  it("المالك: كل أنشطة شركته (A1+A2 = 5) ولا شيء من B، والتزوير لـB = صفر", async () => {
    const owner = await web(emp.superA);
    expect(chartTotal(await owner.reports.dailyChart({ days: 30 }))).toBe(5);
    expect(chartTotal(await owner.reports.dailyChart({ days: 30, businessIds: [B.businessId] }))).toBe(0);
    const groups = await owner.businesses.groupsWithBusinesses();
    const ids = groups.flatMap((g: any) => g.businesses.map((b: any) => b.id));
    expect(ids.sort()).toEqual([A.businessId, A2].sort());
    expect(groups.some((g: any) => g.id === groupB)).toBe(false);
  });

  it("الإسناد: مدير A مايقدرش يسند أوردر لموظف B — بلا تغيير", async () => {
    const mgrA = await portal(emp.mgrA);
    expect(await code(() => mgrA.employeePortal.assignOrder({ orderId: ord.a1, employeeId: emp.agentB }))).toBe("FORBIDDEN");
    expect(await code(() => mgrA.employeePortal.bulkAssignOrders({ orderIds: [ord.a1], employeeId: emp.agentB }))).toBe("FORBIDDEN");
    const [o] = await (await db()).select().from(orders).where(eq(orders.id, ord.a1));
    expect(o.assignedEmployeeId ?? null).toBeNull();
    await mgrA.employeePortal.assignOrder({ orderId: ord.a1, employeeId: emp.agentA });
  });

  it("المدير والمالك مايقدروش يأكّدوا/يلغوا/يأجّلوا أوردر B بمعرّفه — بلا تغيير", async () => {
    for (const who of [emp.mgrA, emp.superA]) {
      const c = await portal(who);
      expect(await code(() => c.employeePortal.cancel({ orderId: ord.b1, cancelReason: "x" }))).toBe("FORBIDDEN");
      expect(await code(() => c.employeePortal.confirm({ orderId: ord.b1 }))).toBe("FORBIDDEN");
      expect(await code(() => c.employeePortal.postpone({ orderId: ord.b1, postponedTo: new Date() }))).toBe("FORBIDDEN");
    }
    const [b1] = await (await db()).select().from(orders).where(eq(orders.id, ord.b1));
    expect(b1.status).toBe("new");
  });

  it("إنشاء أوردر بمنتج من B يُرفض بلا أي أوردر جديد", async () => {
    const mgrA = await portal(emp.mgrA);
    const count = async () => Number((await (await db()).select({ n: sql<number>`COUNT(*)` }).from(orders).where(eq(orders.businessId, A.businessId)))[0].n);
    const before = await count();
    expect(await code(() => mgrA.employeePortal.createOrder({
      customerName: "عميل", customerPhone: "01000000000", customerAddress: "عنوان تجريبي", governorate: "القاهرة",
      productId: B.productId, productName: "x", quantity: 1, totalAmount: "100", source: "manual",
    }))).toBe("FORBIDDEN");
    expect(await count()).toBe(before);
  });

  it("الاستعلامات لا تغيّر أي بيانات", async () => {
    const d = await db();
    const snap = async () => JSON.stringify([
      await d.select().from(orders).where(inArray(orders.id, orderIds)).orderBy(orders.id),
      await d.select().from(products).where(inArray(products.id, [A.productId, B.productId, productA2])).orderBy(products.id),
    ]);
    const before = await snap();
    const mgrA = await portal(emp.mgrA);
    await mgrA.employeePortal.dailyChart({ days: 30 });
    await mgrA.employeePortal.dashboardStats({});
    await mgrA.employeePortal.lowStockProducts();
    await mgrA.employeePortal.cancellationReasons({});
    expect(await snap()).toBe(before);
  });
});
