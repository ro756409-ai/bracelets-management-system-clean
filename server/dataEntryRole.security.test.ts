import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { inArray } from "drizzle-orm";
import { hasPermission, permissionsForRole } from "./permissions";
import { appRouter } from "./routers";
import { getDb, createEmployee } from "./db";
import { employees, orders } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * إصلاح دور data_entry — إدخال بيانات = شاشة إدخال أوردر يدوي، مش بوابة التأكيدات.
 * data_entry يملك orders.view + orders.create فقط؛ ممنوع تأكيد/تأجيل/إلغاء/توزيع/تقارير؛
 * الأوردر يُحفظ في نشاط الموظف (مش default=1)؛ عزل A≠B؛ بلا نشاط → fail-closed.
 */
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const app = fs.readFileSync("client/src/App.tsx", "utf-8");
const login = fs.readFileSync("client/src/pages/EmployeeLogin.tsx", "utf-8");

// ── مصفوفة الصلاحيات (نقية — نفس اللي requireEmployeePermission بيحكم بيها) ──
describe("🔑 مصفوفة صلاحيات data_entry", () => {
  it("🔑 data_entry: مسموح orders.create/view فقط", () => {
    expect(hasPermission("data_entry", "orders.create")).toBe(true);
    expect(hasPermission("data_entry", "orders.view")).toBe(true);
  });
  it("🔑 data_entry: ممنوع confirm/cancel/update/dashboard.view/import/export", () => {
    for (const p of [
      "orders.confirm", "orders.cancel", "orders.update",
      "dashboard.view", "orders.import", "orders.export",
      "employees.view", "settings.view", "accounting.view",
    ] as const) {
      expect(hasPermission("data_entry", p)).toBe(false);
    }
  });
  it("🔑 لا انحدار: أدوار التأكيد لسه بتأكد", () => {
    expect(hasPermission("order_confirmation", "orders.confirm")).toBe(true);
    expect(hasPermission("agent", "orders.confirm")).toBe(true);
    expect(hasPermission("order_confirmation", "orders.create")).toBe(false); // معناها ما اتوسّعش
    expect(permissionsForRole("data_entry").length).toBe(2);
  });
});

// ── حراس المصدر (redirect + route guards + endpoint gating + businessId من الجلسة) ──
describe("🔑 حراس المصدر — data_entry", () => {
  it("🔑 EmployeeLogin بيوجّه data_entry لشاشة الإدخال", () => {
    expect(login).toContain("data_entry");
    expect(login).toContain('setLocation("/facebook-entry")');
  });
  it("🔑 App فيه حارسي المسار وبيلفّوا الـroutes", () => {
    expect(app).toContain("function EmployeeDashboardGuard");
    expect(app).toContain("function OrderCreateGuard");
    expect(app).toContain("<EmployeeDashboardGuard>");
    expect(app).toContain("<OrderCreateGuard>");
  });
  it("🔑 addOrder/updateOrder/deleteOrder بيتطلبوا orders.create", () => {
    expect(routers).toContain('addOrder: requireEmployeePermission("orders.create")');
    expect(routers).toContain('updateOrder: requireEmployeePermission("orders.create")');
    expect(routers).toContain('deleteOrder: requireEmployeePermission("orders.create")');
  });
  it("🔑 addOrder بياخد businessId من الجلسة (مش input ولا default=1)", () => {
    const start = routers.indexOf('addOrder: requireEmployeePermission("orders.create")');
    const block = routers.slice(start, routers.indexOf("myOrders:", start));
    expect(block).toContain("resolveEmployeeBusinessId(empScope(ctx))");
    expect(block).toContain("businessId,"); // متبعت في الـinsert
  });
});

// ── end-to-end بجلسة موظف حقيقية (كوكي + DB) ──
const CAN_E2E = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
describe.runIf(CAN_E2E)("🔑 data_entry end-to-end", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const ids = { empIds: [] as number[], orderIds: [] as number[] };
  let deA = 0, deB = 0, noBiz = 0;
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

  function ctxFor(employeeId: number): any {
    const token = jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
    return {
      user: null, employee: null, tenantId: null,
      req: { protocol: "https", headers: {}, cookies: { employee_token: token } },
      res: { clearCookie: () => {}, cookie: () => {} },
    };
  }
  const caller = (employeeId: number) => appRouter.createCaller(ctxFor(employeeId));
  async function code(fn: () => Promise<any>): Promise<string> {
    try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; }
  }

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("de-a");
    B = await createCoreTestFixture("de-b");
    deA = insId(await createEmployee({ name: "esraa-A", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `deA_${tag}` } as any));
    deB = insId(await createEmployee({ name: "esraa-B", role: "data_entry", isActive: true, tenantId: B.tenantId, businessId: B.businessId, username: `deB_${tag}` } as any));
    noBiz = insId(await createEmployee({ name: "no-biz", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: null, username: `noBiz_${tag}` } as any));
    ids.empIds.push(deA, deB, noBiz);
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (ids.orderIds.length) await d.delete(orders).where(inArray(orders.id, ids.orderIds));
    if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔑 data_entry ممنوع من confirm/cancel/postpone/updateStatus/stats (FORBIDDEN)", async () => {
    expect(await code(() => caller(deA).employeePortal.confirm({ orderId: 1 } as any))).toBe("FORBIDDEN");
    expect(await code(() => caller(deA).employeePortal.cancel({ orderId: 1, reason: "x" } as any))).toBe("FORBIDDEN");
    expect(await code(() => caller(deA).employeePortal.postpone({ orderId: 1, postponedTo: new Date() } as any))).toBe("FORBIDDEN");
    expect(await code(() => caller(deA).employeePortal.updateStatus({ orderId: 1, status: "confirmed" } as any))).toBe("FORBIDDEN");
    expect(await code(() => caller(deA).employeePortal.stats({} as any))).toBe("FORBIDDEN");
  });

  it("🔑 data_entry بيقدر ينشئ أوردر، والأوردر بيتحفظ في نشاطه (مش business #1)", async () => {
    const res = await caller(deA).facebookEntry.addOrder({
      customerName: "عميل", customerPhone: "01234567890", governorate: "القاهرة",
      customerAddress: "عنوان", selectedProducts: [{ productId: A.productId, productName: "Test Product", quantity: 1 }],
      totalAmount: 100,
    } as any);
    expect(res.success).toBe(true);
    const d = await getDb();
    const [row] = await d!.select().from(orders).where(inArray(orders.orderNumber, [res.orderNumber]));
    ids.orderIds.push(row.id);
    expect(row.businessId).toBe(A.businessId);
    expect(row.businessId).not.toBe(1);
  });

  it("🔑 موظف بلا نشاط → fail-closed (مفيش أوردر يتكتب)", async () => {
    const r = await code(() => caller(noBiz).facebookEntry.addOrder({
      customerName: "x", customerPhone: "01234567890", governorate: "القاهرة",
      customerAddress: "y", selectedProducts: [{ productId: A.productId, productName: "p", quantity: 1 }],
      totalAmount: 10,
    } as any));
    expect(["FORBIDDEN", "BAD_REQUEST"]).toContain(r);
  });

  it("🔑 موظف A مايقدرش يعدّل/يحذف أوردر نشاط B (عزل)", async () => {
    // أوردر في نشاط B عن طريق موظف B
    const resB = await caller(deB).facebookEntry.addOrder({
      customerName: "cB", customerPhone: "01234567891", governorate: "القاهرة",
      customerAddress: "aB", selectedProducts: [{ productId: B.productId, productName: "Test Product", quantity: 1 }],
      totalAmount: 50,
    } as any);
    const d = await getDb();
    const [rowB] = await d!.select().from(orders).where(inArray(orders.orderNumber, [resB.orderNumber]));
    ids.orderIds.push(rowB.id);
    // موظف A يحاول يحذف/يعدّل أوردر B → مرفوض
    expect(await code(() => caller(deA).facebookEntry.deleteOrder({ orderId: rowB.id } as any))).not.toBe("ok");
    expect(await code(() => caller(deA).facebookEntry.updateOrder({
      orderId: rowB.id, customerName: "hack", customerPhone: "01234567890",
      governorate: "القاهرة", customerAddress: "z",
      selectedProducts: [{ productId: A.productId, productName: "p", quantity: 1 }], totalAmount: 1,
    } as any))).not.toBe("ok");
  });

  it("🔑 لا انحدار: agent (بلا orders.create) ممنوع من addOrder", async () => {
    const agent = insId(await createEmployee({ name: "agent", role: "agent", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `agent_${tag}` } as any));
    ids.empIds.push(agent);
    expect(await code(() => caller(agent).facebookEntry.addOrder({
      customerName: "x", customerPhone: "01234567890", governorate: "القاهرة",
      customerAddress: "y", selectedProducts: [{ productId: A.productId, productName: "p", quantity: 1 }],
      totalAmount: 10,
    } as any))).toBe("FORBIDDEN");
  });
});
