import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb, createEmployee } from "./db";
import { employees, orders } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * ملكية أوردرات موظف الإدخال عبر حقل ثابت `orders.createdByEmployeeId` (بديل lastUpdatedBy
 * المتغيّر). بيتحدّد مرة عند الإنشاء من الجلسة، مابيتغيّرش، والأوردرات القديمة NULL مايقدرش
 * موظف الإدخال يعدّلها/يحذفها. يتطلّب Migration 0036 مطبّقة على matjarak_test لاختبارات DB.
 */
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");
const migration = fs.readFileSync("drizzle/0036_orders_created_by_employee.sql", "utf-8");

describe("🔑 حراس المصدر — createdByEmployeeId", () => {
  it("🔑 العمود الثابت متعرّف في schema", () => {
    expect(schema).toContain('createdByEmployeeId: int("createdByEmployeeId")');
  });
  it("🔑 Migration 0036: عمود + index، بلا FK وبلا backfill", () => {
    expect(migration).toContain("ADD COLUMN `createdByEmployeeId` int");
    expect(migration).toContain("CREATE INDEX `orders_created_by_employee_idx`");
    expect(migration).not.toContain("FOREIGN KEY");
    expect(migration).not.toContain("REFERENCES");
    // مفيش backfill تخميني ولا استخدام lastUpdatedBy كمُنشئ
    expect(migration).not.toContain("UPDATE `orders`");
    expect(migration).not.toContain("lastUpdatedBy");
  });
  it("🔑 addOrder بيحدّد المُنشئ من الجلسة مرة واحدة", () => {
    const start = routers.indexOf('addOrder: requireEmployeePermission("orders.create")');
    const block = routers.slice(start, routers.indexOf("myOrders:", start));
    expect(block).toContain("createdByEmployeeId: ctx.employee.id");
  });
  it("🔑 الملكية في myOrders/update/delete بالمُنشئ الثابت مش lastUpdatedBy", () => {
    // 3 مواضع بتفلتر بـcreatedByEmployeeId (myOrders + delete + update)
    const count = (routers.match(/eq\(orders\.createdByEmployeeId, ctx\.employee\.id\)/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
    // فحص الملكية مابيعتمدش على lastUpdatedBy
    expect(routers).not.toContain("eq(orders.lastUpdatedBy, ctx.employee.id)");
  });
  it("🔑 updateOrder.set مابيغيّرش المُنشئ (ثابت)", () => {
    const i = routers.indexOf('updateOrder: requireEmployeePermission("orders.create")');
    const block = routers.slice(i, routers.indexOf("products: employeePortalProcedure", i));
    const setBlock = block.slice(block.indexOf(".set({"), block.indexOf("})", block.indexOf(".set({")));
    expect(setBlock).not.toContain("createdByEmployeeId");
  });
});

// ── سلوكي (matjarak_test + Migration 0036 مطبّقة + JWT_SECRET) ──
const CAN_E2E = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
describe.runIf(CAN_E2E)("🔑 ملكية المُنشئ end-to-end", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const ids = { empIds: [] as number[], orderIds: [] as number[] };
  let a1 = 0, a2 = 0, b1 = 0;
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  const ctxFor = (employeeId: number): any => ({
    user: null, employee: null, tenantId: null,
    req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId }, process.env.JWT_SECRET as string) } },
    res: { clearCookie: () => {}, cookie: () => {} },
  });
  const caller = (employeeId: number) => appRouter.createCaller(ctxFor(employeeId));
  const code = async (fn: () => Promise<any>) => { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } };
  async function addOrderVia(empId: number, biz: CoreTestFixture) {
    const r = await caller(empId).facebookEntry.addOrder({
      customerName: "c", customerPhone: "01234567890", governorate: "القاهرة",
      customerAddress: "a", selectedProducts: [{ productId: biz.productId, productName: "Test Product", quantity: 1 }],
      totalAmount: 100,
    } as any);
    const d = await getDb();
    const [row] = await d!.select().from(orders).where(inArray(orders.orderNumber, [r.orderNumber]));
    ids.orderIds.push(row.id);
    return row;
  }

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("own-a");
    B = await createCoreTestFixture("own-b");
    a1 = insId(await createEmployee({ name: "A1", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `a1_${tag}` } as any));
    a2 = insId(await createEmployee({ name: "A2", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `a2_${tag}` } as any));
    b1 = insId(await createEmployee({ name: "B1", role: "data_entry", isActive: true, tenantId: B.tenantId, businessId: B.businessId, username: `b1_${tag}` } as any));
    ids.empIds.push(a1, a2, b1);
  });
  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (ids.orderIds.length) await d.delete(orders).where(inArray(orders.id, ids.orderIds));
    if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔑 الإنشاء بيثبّت createdByEmployeeId من الجلسة", async () => {
    const row = await addOrderVia(a1, A);
    expect(row.createdByEmployeeId).toBe(a1);
  });

  it("🔑 عزل داخل نفس النشاط: A2 مايعدّلش/يحذفش أوردر A1، ومايظهرش في myOrders بتاعته", async () => {
    const row = await addOrderVia(a1, A);
    expect(await code(() => caller(a2).facebookEntry.deleteOrder({ orderId: row.id } as any))).toBe("NOT_FOUND");
    expect(await code(() => caller(a2).facebookEntry.updateOrder({
      orderId: row.id, customerName: "x", customerPhone: "01234567890",
      governorate: "القاهرة", customerAddress: "z",
      selectedProducts: [{ productId: A.productId, productName: "p", quantity: 1 }], totalAmount: 1,
    } as any))).toBe("NOT_FOUND");
    const a2Orders = await caller(a2).facebookEntry.myOrders({} as any);
    expect(a2Orders.some((o: any) => o.id === row.id)).toBe(false);
    const a1Orders = await caller(a1).facebookEntry.myOrders({} as any);
    expect(a1Orders.some((o: any) => o.id === row.id)).toBe(true);
  });

  it("🔑 عزل بين نشاطين: B1 مايوصلش أوردر A1", async () => {
    const row = await addOrderVia(a1, A);
    expect(await code(() => caller(b1).facebookEntry.deleteOrder({ orderId: row.id } as any))).not.toBe("ok");
    expect(await code(() => caller(b1).facebookEntry.updateOrder({
      orderId: row.id, customerName: "x", customerPhone: "01234567890",
      governorate: "القاهرة", customerAddress: "z",
      selectedProducts: [{ productId: B.productId, productName: "p", quantity: 1 }], totalAmount: 1,
    } as any))).not.toBe("ok");
  });

  it("🔑 أوردر قديم createdByEmployeeId=NULL: موظف الإدخال مايعدّلش/يحذفش/يشوفه", async () => {
    const d = await getDb();
    const legacyId = insId(await d!.insert(orders).values({
      businessId: A.businessId, orderNumber: `LEG-${tag}`, source: "facebook",
      customerName: "old", customerPhone: "01234567890", customerAddress: "a",
      governorate: "القاهرة", productName: "p", quantity: 1, totalAmount: "5.00",
      createdByEmployeeId: null,
    } as any));
    ids.orderIds.push(legacyId);
    expect(await code(() => caller(a1).facebookEntry.deleteOrder({ orderId: legacyId } as any))).toBe("NOT_FOUND");
    expect(await code(() => caller(a1).facebookEntry.updateOrder({
      orderId: legacyId, customerName: "x", customerPhone: "01234567890",
      governorate: "القاهرة", customerAddress: "z",
      selectedProducts: [{ productId: A.productId, productName: "p", quantity: 1 }], totalAmount: 1,
    } as any))).toBe("NOT_FOUND");
    const a1Orders = await caller(a1).facebookEntry.myOrders({} as any);
    expect(a1Orders.some((o: any) => o.id === legacyId)).toBe(false);
  });

  it("🔑 المُنشئ ثابت: تعديل الأوردر مايغيّرش createdByEmployeeId", async () => {
    const row = await addOrderVia(a1, A);
    await caller(a1).facebookEntry.updateOrder({
      orderId: row.id, customerName: "محدّث", customerPhone: "01234567899",
      governorate: "الجيزة", customerAddress: "عنوان جديد",
      selectedProducts: [{ productId: A.productId, productName: "Test Product", quantity: 2 }], totalAmount: 200,
    } as any);
    const d = await getDb();
    const [after] = await d!.select().from(orders).where(eq(orders.id, row.id));
    expect(after.createdByEmployeeId).toBe(a1); // ماتغيّرش
    expect(after.customerName).toBe("محدّث");   // باقي الحقول اتعدّلت
  });
});
