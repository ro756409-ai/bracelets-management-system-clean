import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { and, eq, inArray, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { COOKIE_NAME } from "@shared/const";
import { getDb, createEmployee, createProductWithVariants, insertOrderWithItems, confirmOrder, postponeOrder } from "./db";
import { orders, orderItems, inventoryMovements, products, productVariants, employees, tenants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * Security blocker — duplicates.list / duplicates.deleteAll في 620a5ae (والإنتاج) كانوا بلا نطاق تاجر:
 * القائمة بتعرض مكررات كل التجار، و«حذف الكل» بيمسحها. على قاعدة اختبار منفصلة ببيانات مصطنعة بس.
 * بيثبت: نطاق التاجر بس، تاجر B مايتلمسش (لقطة كاملة)، الأدوار غير المصرّح بها مرفوضة، النطاق الفاضي
 * مابيمسحش، والأوردر الماسك مخزون (مؤكد، أو مؤجل لسه ماسك خصم) يرفض الدفعة كلها.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
async function outcome(fn: () => Promise<any>): Promise<{ code: string; value?: any }> {
  try { return { code: "ok", value: await fn() }; } catch (e: any) { return { code: e?.code ?? e?.name ?? "ERR" }; }
}

describe.runIf(CAN)("🔐 duplicates.list/deleteAll — نطاق التاجر (Rollback-Safe)", { timeout: 120_000 }, () => {
  let A: CoreTestFixture; let B: CoreTestFixture;
  const e: Record<string, number> = {};
  const ids = { orders: [] as number[], products: [] as number[], tenantC: 0 };
  let seq = 0; const tag = `${Date.now()}`.slice(-7);
  const db = async () => (await getDb())!;
  const snapBusiness = async (businessId: number) => {
    const d = await db();
    const os = await d.select().from(orders).where(eq(orders.businessId, businessId)).orderBy(orders.id);
    const oids = os.map((o: any) => o.id);
    return JSON.stringify({
      os,
      items: oids.length ? await d.select().from(orderItems).where(inArray(orderItems.orderId, oids)).orderBy(orderItems.id) : [],
      moves: await d.select().from(inventoryMovements).where(eq(inventoryMovements.businessId, businessId)).orderBy(inventoryMovements.id),
      stock: await d.select({ id: productVariants.id, s: productVariants.currentStock }).from(productVariants).innerJoin(products, eq(products.id, productVariants.productId)).where(eq(products.businessId, businessId)).orderBy(productVariants.id),
    });
  };
  const exists = async (id: number) => (await (await db()).select({ id: orders.id }).from(orders).where(eq(orders.id, id))).length === 1;
  const markDup = async (oids: number[]) => (await db()).update(orders).set({ isDuplicate: true, duplicateMarkedAt: new Date() }).where(inArray(orders.id, oids));
  const unmarkBiz = async (businessId: number) => (await db()).update(orders).set({ isDuplicate: false }).where(eq(orders.businessId, businessId));
  async function product(businessId: number) {
    const k = ++seq;
    const r = await createProductWithVariants(businessId, { name: `منتج ${k}` }, [{ name: `V${k}`, sku: `DS-${tag}-${k}`, currentStock: 20, price: "100" }] as any);
    ids.products.push(r.productId);
    return { p: r.productId, v: r.variantIds[0] };
  }
  async function order(businessId: number, pr: { p: number; v: number }) {
    const k = ++seq;
    const id = await insertOrderWithItems({
      orderNumber: `DS-${tag}-${k}`, businessId, customerName: `عميل ${k}`, customerPhone: `0101${String(3000000 + k).slice(-7)}`,
      customerAddress: "شارع النيل رقم 5 الدقي الدور 2", governorate: "القاهرة", source: "manual", status: "new",
      productId: pr.p, variantId: pr.v, productName: "x", quantity: 1, totalAmount: "100",
    } as any, [{ productId: pr.p, variantId: pr.v, productName: "x", quantity: 1, unitPrice: 100 }]);
    ids.orders.push(id);
    return id;
  }

  beforeAll(async () => {
    A = await createCoreTestFixture("dups-a"); B = await createCoreTestFixture("dups-b");
    const mk = async (key: string, role: string, tenantId: number, businessId: number | null) => {
      e[key] = insId(await createEmployee({ name: `${key}-dups`, role, isActive: true, tenantId, businessId, username: `${key}_ds_${tag}` } as any));
    };
    await mk("ownerA", "super_admin", A.tenantId, A.businessId); await mk("managerA", "manager", A.tenantId, A.businessId);
    await mk("adminA", "admin", A.tenantId, A.businessId); await mk("agentA", "agent", A.tenantId, A.businessId);
    await mk("ownerB", "super_admin", B.tenantId, B.businessId);
    ids.tenantC = insId(await (await db()).insert(tenants).values({ name: "C empty", slug: `c-empty-${tag}`, status: "active" } as any));
    await mk("ownerC", "super_admin", ids.tenantC, null);
  });
  afterAll(async () => {
    const d = await db();
    if (ids.orders.length) {
      await d.delete(inventoryMovements).where(inArray(inventoryMovements.orderId, ids.orders));
      await d.delete(orderItems).where(inArray(orderItems.orderId, ids.orders));
      await d.delete(orders).where(inArray(orders.id, ids.orders));
    }
    if (ids.products.length) {
      await d.delete(inventoryMovements).where(inArray(inventoryMovements.productId, ids.products));
      await d.delete(productVariants).where(inArray(productVariants.productId, ids.products));
      await d.delete(products).where(inArray(products.id, ids.products));
    }
    await d.delete(employees).where(inArray(employees.id, Object.values(e)));
    if (ids.tenantC) await d.delete(tenants).where(eq(tenants.id, ids.tenantC));
    await B?.cleanup(); await A?.cleanup();
  });

  it("list: أدمن A يشوف مكررات A بس (مفيش أي أوردر لـB)", async () => {
    const PA = await product(A.businessId); const PB = await product(B.businessId);
    const a = await order(A.businessId, PA); const b = await order(B.businessId, PB);
    await markDup([a, b]);
    const list = await (await web(e.adminA)).duplicates.list();
    expect(list.map((o: any) => o.id)).toContain(a);
    expect(list.every((o: any) => o.businessId === A.businessId)).toBe(true);
    await unmarkBiz(A.businessId); await unmarkBiz(B.businessId);
  });

  it("deleteAll: مالك A يمسح مكررات A القابلة للحذف بس؛ غير المكرر في A وكل بيانات B بدون تغيير", async () => {
    const PA = await product(A.businessId); const PB = await product(B.businessId);
    const a1 = await order(A.businessId, PA); const a2 = await order(A.businessId, PA); const aKeep = await order(A.businessId, PA);
    const b1 = await order(B.businessId, PB); const b2 = await order(B.businessId, PB);
    await markDup([a1, a2, b1, b2]);
    const beforeB = await snapBusiness(B.businessId);
    const r = await outcome(async () => (await web(e.ownerA)).duplicates.deleteAll());
    expect([r.code, r.value?.deleted]).toEqual(["ok", 2]);
    expect([await exists(a1), await exists(a2), await exists(aKeep)]).toEqual([false, false, true]);
    expect(await snapBusiness(B.businessId)).toBe(beforeB);
    await unmarkBiz(B.businessId);
  });

  it("الأدوار: مدير/أدمن FORBIDDEN، وجلسة بوابة الموظف UNAUTHORIZED — بدون حذف في A أو B", async () => {
    const PA = await product(A.businessId);
    const a = await order(A.businessId, PA); await markDup([a]);
    const beforeA = await snapBusiness(A.businessId); const beforeB = await snapBusiness(B.businessId);
    expect((await outcome(async () => (await web(e.managerA)).duplicates.deleteAll())).code).toBe("FORBIDDEN");
    expect((await outcome(async () => (await web(e.adminA)).duplicates.deleteAll())).code).toBe("FORBIDDEN");
    expect((await outcome(async () => (await portal(e.agentA)).duplicates.deleteAll())).code).toBe("UNAUTHORIZED");
    expect(await snapBusiness(A.businessId)).toBe(beforeA); expect(await snapBusiness(B.businessId)).toBe(beforeB);
    await unmarkBiz(A.businessId);
  });

  it("نطاق فاضي (مالك تاجر بلا أنشطة): 0 محذوف، ولا تغيير عند A أو B", async () => {
    const PA = await product(A.businessId); const PB = await product(B.businessId);
    const a = await order(A.businessId, PA); const b = await order(B.businessId, PB); await markDup([a, b]);
    const beforeA = await snapBusiness(A.businessId); const beforeB = await snapBusiness(B.businessId);
    const r = await outcome(async () => (await web(e.ownerC)).duplicates.deleteAll());
    expect([r.code, r.value?.deleted]).toEqual(["ok", 0]);
    expect(await snapBusiness(A.businessId)).toBe(beforeA); expect(await snapBusiness(B.businessId)).toBe(beforeB);
    await unmarkBiz(A.businessId); await unmarkBiz(B.businessId);
  });

  it("حماية المخزون: مكرر مؤكد، أو مؤجل لسه ماسك خصم = رفض الدفعة كلها (412) بلا أي حذف", async () => {
    const PA = await product(A.businessId);
    const free = await order(A.businessId, PA);
    const confirmed = await order(A.businessId, PA); await confirmOrder(confirmed, e.ownerA);
    const held = await order(A.businessId, PA); await confirmOrder(held, e.ownerA);
    await postponeOrder(held, new Date(Date.now() + 86_400_000), undefined, e.ownerA);
    for (const set of [[free, confirmed], [free, held]]) {
      await unmarkBiz(A.businessId); await markDup(set);
      const beforeA = await snapBusiness(A.businessId);
      const r = await outcome(async () => (await web(e.ownerA)).duplicates.deleteAll());
      expect(r.code, JSON.stringify(set)).toBe("PRECONDITION_FAILED");
      expect(await snapBusiness(A.businessId)).toBe(beforeA);
      expect(await exists(free)).toBe(true);
    }
    await unmarkBiz(A.businessId);
  });

  it("delete (فردي): مالك B مايقدرش يحذف مكرر A بالمعرّف", async () => {
    const PA = await product(A.businessId);
    const a = await order(A.businessId, PA); await markDup([a]);
    const beforeA = await snapBusiness(A.businessId);
    const r = await outcome(async () => (await web(e.ownerB)).duplicates.delete({ orderId: a }));
    expect(["FORBIDDEN", "NOT_FOUND"]).toContain(r.code);
    expect(await snapBusiness(A.businessId)).toBe(beforeA);
    await unmarkBiz(A.businessId);
  });
});
