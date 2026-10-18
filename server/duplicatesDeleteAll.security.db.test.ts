import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { COOKIE_NAME } from "@shared/const";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee, createProductWithVariants, createOrderWithItems, confirmOrder, postponeOrder } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * Security blocker — duplicates.deleteAll (كان يمسح مكررات كل التجار في 620a5ae/الإنتاج).
 * قاعدة مؤقتة منفصلة ببيانات مصطنعة بس (DDL من قاعدة الاختبار، بلا بيانات)، وبتتمسح بعد الاختبار.
 * بيثبت على نسخة v2: نطاق التاجر بس، تاجر B مايتلمسش (لقطة كاملة: أوردرات+بنود+حركات+أرصدة)، الأدوار غير
 * المصرّح بها مرفوضة، النطاق الفاضي مابيمسحش حاجة، والأوردر الماسك مخزون (بالحالة أو بالحركات) يرفض الدفعة كلها.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
async function outcome(fn: () => Promise<any>): Promise<{ code: string; value?: any; message?: string }> {
  try { return { code: "ok", value: await fn() }; } catch (e: any) { return { code: e?.code ?? e?.name ?? "ERR", message: String(e?.message ?? "") }; }
}

describe.runIf(CAN)("🔐 duplicates.deleteAll — نطاق التاجر، الأدوار، النطاق الفاضي، وحماية المخزون (قاعدة مصطنعة منفصلة)", { timeout: 120_000 }, () => {
  let tmp: TempSchema; let A: CoreTestFixture; let B: CoreTestFixture;
  const e: Record<string, number> = {};
  let seq = 0; let tenantC = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  /** كل اللي ممكن الحذف يلمسه لتاجر: الأوردرات، البنود، الحركات، أرصدة التركيبات. */
  const snapBusiness = async (businessId: number) => JSON.stringify({
    orders: await q("SELECT * FROM orders WHERE businessId = ? ORDER BY id", [businessId]),
    items: await q("SELECT i.* FROM order_items i JOIN orders o ON o.id = i.orderId WHERE o.businessId = ? ORDER BY i.id", [businessId]),
    moves: await q("SELECT * FROM inventory_movements WHERE businessId = ? ORDER BY id", [businessId]),
    stock: await q("SELECT v.id, v.currentStock FROM product_variants v JOIN products p ON p.id = v.productId WHERE p.businessId = ? ORDER BY v.id", [businessId]),
  });
  const exists = async (id: number) => (await q("SELECT COUNT(*) n FROM orders WHERE id = ?", [id]))[0].n === 1;
  async function product(businessId: number) {
    const k = ++seq;
    const r = await createProductWithVariants(businessId, { name: `منتج ${k}` }, [
      { sku: `D1-${k}-${tmp.name}`.slice(0, 50), color: "ذهبي", currentStock: 20 } as any,
    ]);
    return { p: r.productId, a: r.variantIds[0] };
  }
  async function order(businessId: number, prod: { p: number; a: number }) {
    const k = ++seq;
    return (await createOrderWithItems({
      businessId, orderNumber: `D${tmp.name.slice(-6)}${k}`.slice(0, 20), customerName: `عميل ${businessId}-${k}`,
      customerPhone: `0101${String(2000000 + k).slice(-7)}`, customerAddress: "شارع النيل رقم 5 الدقي", governorate: "القاهرة",
      productName: "x", productId: prod.p, variantId: prod.a, quantity: 1, totalAmount: "100.00", status: "new", source: "manual",
    } as any, [{ productId: prod.p, variantId: prod.a, productName: "x", quantity: 1, unitPrice: 100 }]))!;
  }
  const markDup = (ids: number[]) => q(`UPDATE orders SET isDuplicate = 1, duplicateMarkedAt = NOW() WHERE id IN (${ids.map(() => "?").join(",")})`, ids);

  beforeAll(async () => {
    tmp = await createTempSchema("dupdel");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("dup-a");
    B = await createCoreTestFixture("dup-b");
    const mk = async (key: string, role: string, tenantId: number, businessId: number | null) => {
      e[key] = insId(await createEmployee({ name: `${key}-dup`, role, isActive: true, tenantId, businessId,
        username: `${key}_${tmp.name}`.slice(0, 50), passwordHash: `hash-${key}` } as any));
    };
    await mk("ownerA", "super_admin", A.tenantId, A.businessId); await mk("managerA", "manager", A.tenantId, A.businessId);
    await mk("adminA", "admin", A.tenantId, A.businessId); await mk("agentA", "agent", A.tenantId, A.businessId);
    await mk("ownerB", "super_admin", B.tenantId, B.businessId);
    // تاجر C بلا أي نشاط: مالك نطاقه فاضي
    tenantC = insId(await q("INSERT INTO tenants (name, slug, status) VALUES ('C empty', ?, 'active')", [`c-${tmp.name}`.slice(0, 60)]));
    await mk("ownerC", "super_admin", tenantC, null);
  }, 180_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("مالك A يمسح مكررات A القابلة للحذف بس؛ أوردرات A غير المكررة وكل بيانات B (حتى مكرراتها) بدون أي تغيير", async () => {
    const PA = await product(A.businessId); const PB = await product(B.businessId);
    const a1 = await order(A.businessId, PA); const a2 = await order(A.businessId, PA); const aKeep = await order(A.businessId, PA);
    const b1 = await order(B.businessId, PB); const b2 = await order(B.businessId, PB);
    await markDup([a1, a2, b1, b2]);
    const beforeB = await snapBusiness(B.businessId);
    const r = await outcome(async () => (await web(e.ownerA)).duplicates.deleteAll());
    expect(r.code).toBe("ok");
    expect(r.value.deleted).toBe(2);
    expect([await exists(a1), await exists(a2), await exists(aKeep)]).toEqual([false, false, true]);
    expect(await q("SELECT COUNT(*) n FROM order_items WHERE orderId IN (?, ?)", [a1, a2])).toEqual([{ n: 0 }]);
    expect(await snapBusiness(B.businessId)).toBe(beforeB);
    expect([await exists(b1), await exists(b2)]).toEqual([true, true]);
    await q("UPDATE orders SET isDuplicate = 0 WHERE id IN (?, ?)", [b1, b2]);
  });

  it("الأدوار غير المصرّح بها: مدير/أدمن (ويب) FORBIDDEN، وجلسة بوابة الموظف UNAUTHORIZED — بدون أي حذف في A أو B", async () => {
    const PA = await product(A.businessId);
    const a = await order(A.businessId, PA); await markDup([a]);
    const beforeA = await snapBusiness(A.businessId); const beforeB = await snapBusiness(B.businessId);
    expect((await outcome(async () => (await web(e.managerA)).duplicates.deleteAll())).code).toBe("FORBIDDEN");
    expect((await outcome(async () => (await web(e.adminA)).duplicates.deleteAll())).code).toBe("FORBIDDEN");
    expect((await outcome(async () => (await portal(e.agentA)).duplicates.deleteAll())).code).toBe("UNAUTHORIZED");
    expect(await snapBusiness(A.businessId)).toBe(beforeA);
    expect(await snapBusiness(B.businessId)).toBe(beforeB);
    await q("UPDATE orders SET isDuplicate = 0 WHERE id = ?", [a]);
  });

  it("نطاق فاضي (مالك تاجر بلا أنشطة): مايمسحش أي حاجة عند أي تاجر", async () => {
    const PA = await product(A.businessId); const PB = await product(B.businessId);
    const a = await order(A.businessId, PA); const b = await order(B.businessId, PB);
    await markDup([a, b]);
    const beforeA = await snapBusiness(A.businessId); const beforeB = await snapBusiness(B.businessId);
    const r = await outcome(async () => (await web(e.ownerC)).duplicates.deleteAll());
    // scopeBusinessIds → denyWhenEmpty → [-1] (NO_BUSINESS): مفيش صف يطابق، فالرد «0 محذوف» بلا أي كتابة
    expect([r.code, r.value?.deleted]).toEqual(["ok", 0]);
    expect(await snapBusiness(A.businessId)).toBe(beforeA);
    expect(await snapBusiness(B.businessId)).toBe(beforeB);
    expect([await exists(a), await exists(b)]).toEqual([true, true]);
    await q("UPDATE orders SET isDuplicate = 0 WHERE id IN (?, ?)", [a, b]);
  });

  it("حماية المخزون: مكرر مؤكد، أو مؤجل لسه ماسك خصم (الحالة مش «مؤكد» لكن الحركات بتثبت) = رفض الدفعة كلها، ولا حاجة تتمسح", async () => {
    const PA = await product(A.businessId);
    const free = await order(A.businessId, PA);
    const confirmed = await order(A.businessId, PA); await confirmOrder(confirmed, e.ownerA);
    const held = await order(A.businessId, PA); await confirmOrder(held, e.ownerA);
    await postponeOrder(held, new Date(Date.now() + 86_400_000), undefined, e.ownerA);
    expect((await q("SELECT status FROM orders WHERE id = ?", [held]))[0].status).toBe("postponed");
    for (const set of [[free, confirmed], [free, held]]) {
      await q("UPDATE orders SET isDuplicate = 0 WHERE businessId = ?", [A.businessId]);
      await markDup(set);
      const beforeA = await snapBusiness(A.businessId);
      const r = await outcome(async () => (await web(e.ownerA)).duplicates.deleteAll());
      expect(r.code, JSON.stringify(set)).toBe("BAD_REQUEST");
      expect(await snapBusiness(A.businessId)).toBe(beforeA);
      expect(await exists(free)).toBe(true);
    }
    // والمفرد كمان
    await q("UPDATE orders SET isDuplicate = 0 WHERE businessId = ?", [A.businessId]);
    await markDup([held]);
    const before = await snapBusiness(A.businessId);
    expect((await outcome(async () => (await web(e.ownerA)).duplicates.delete({ orderId: held }))).code).toBe("BAD_REQUEST");
    expect(await snapBusiness(A.businessId)).toBe(before);
  });

  it("مالك B مايقدرش يحذف مكرر A بالمعرّف (duplicates.delete) — رفض بلا تغيير", async () => {
    const PA = await product(A.businessId);
    const a = await order(A.businessId, PA); await markDup([a]);
    const beforeA = await snapBusiness(A.businessId);
    const r = await outcome(async () => (await web(e.ownerB)).duplicates.delete({ orderId: a }));
    expect(["FORBIDDEN", "NOT_FOUND"]).toContain(r.code);
    expect(await snapBusiness(A.businessId)).toBe(beforeA);
  });
});
