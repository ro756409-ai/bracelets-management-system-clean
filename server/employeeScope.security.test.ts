import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  getAllEmployees, getActiveEmployees,
  getEmployeePerformance, getCancellationReasons,
  createEmployee,
} from "./db";
import { employees, orders } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * المرحلة A — عزل مصادر الموظفين بين التينانتات. البلاغ: جدول «جرد الموظفين» في حساب جديد
 * عرض أسماء موظفي تينانتات أخرى (دنيا/سهام/هاجر/مدير حقوقي). السبب: `employees.allInventory`
 * كان بينادي `getActiveEmployees()` بلا نطاق = كل التينانتات. الإصلاح: كل مصادر الموظفين
 * (allInventory + نسخ managerPortal) تمرّر businessIds من الجلسة، وطبقة الأداء/الإلغاء
 * fail-closed (فاضي → صفر، مش الكل).
 */
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const db = fs.readFileSync("server/db.ts", "utf-8");

describe("🔑 حراس المصدر — مصادر الموظفين معزولة (fail-closed)", () => {
  it("🔑 employees.allInventory بيمرّر scopeBusinessIds (مش getActiveEmployees() عارية)", () => {
    const block = routers.slice(
      routers.indexOf("allInventory: adminProcedure"),
      routers.indexOf("allInventory: adminProcedure") + 700
    );
    expect(block).toContain("scopeBusinessIds(ctx, {})");
    expect(block).toContain("getActiveEmployees(undefined, businessIds)");
    // مفيش استدعاء عارٍ تاني جوّه الـendpoint
    expect(block).not.toContain("getActiveEmployees()");
  });

  it("🔑 managerPortal (employeePerformance/employeesList/activeEmployeesList) fail-closed", () => {
    // النسخ الثلاثة بقت تستخدم scopeBusinessIds(empScope(ctx), {}) مش emp.businessId ?? undefined
    expect(routers).toContain("getEmployeePerformance(input.dateFrom, input.dateTo, undefined, businessIds)");
    expect(routers).not.toContain("getAllEmployees(emp.businessId ?? undefined)");
    expect(routers).not.toContain("getActiveEmployees(emp.businessId ?? undefined)");
    // عدّاد: كل نسخ managerPortal للموظفين بتمرّر empScope
    const count = (routers.match(/scopeBusinessIds\(empScope\(ctx\), \{\}\)/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("🔑 getEmployeePerformance/getCancellationReasons بقت fail-closed (scopedBusinessFilter)", () => {
    const perf = db.slice(db.indexOf("export async function getEmployeePerformance"), db.indexOf("export async function getCancellationReasons"));
    expect(perf).toContain("scopedBusinessFilter(orders.businessId, businessIds)");
    const canc = db.slice(db.indexOf("export async function getCancellationReasons"), db.indexOf("export async function getCancellationReasons") + 1200);
    expect(canc).toContain("scopedBusinessFilter(orders.businessId, businessIds)");
  });
});

// ── سلوكي فعلي cross-tenant (matjarak_test) ──
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("🔑 عزل الموظفين A ≠ B فعلي", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const cleanup = { empIds: [] as number[], orderIds: [] as number[] };
  let empA = 0, empB = 0;

  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

  async function makeOrder(d: any, businessId: number, assignedEmployeeId: number | null, opts: any = {}) {
    const dbi = await getDb(); if (!dbi) return;
    const id = insId(await dbi.insert(orders).values({
      businessId,
      orderNumber: `T-${tag}-${Math.random().toString(36).slice(2, 8)}`,
      customerName: "cust", customerPhone: "01000000000", customerAddress: "addr",
      governorate: "القاهرة", productName: "prod", quantity: 1, totalAmount: "100.00",
      assignedEmployeeId: assignedEmployeeId ?? undefined,
      ...opts,
    } as any));
    cleanup.orderIds.push(id);
  }

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("emp-a");
    B = await createCoreTestFixture("emp-b");
    empA = insId(await createEmployee({ name: "empA", role: "agent", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `empA_${tag}` } as any));
    empB = insId(await createEmployee({ name: "empB", role: "agent", isActive: true, tenantId: B.tenantId, businessId: B.businessId, username: `empB_${tag}` } as any));
    cleanup.empIds.push(empA, empB);
    // أداء: أوردر مؤكّد موزّع لكل نشاط
    await makeOrder(d, A.businessId, empA, { status: "confirmed" });
    await makeOrder(d, B.businessId, empB, { status: "confirmed" });
    // إلغاء: أوردر ملغى بسبب لكل نشاط
    await makeOrder(d, A.businessId, empA, { status: "cancelled", cancelReason: "reasonA", cancelledAt: new Date() });
    await makeOrder(d, B.businessId, empB, { status: "cancelled", cancelReason: "reasonB", cancelledAt: new Date() });
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (cleanup.orderIds.length) await d.delete(orders).where(inArray(orders.id, cleanup.orderIds));
    if (cleanup.empIds.length) await d.delete(employees).where(inArray(employees.id, cleanup.empIds));
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔑 getEmployeePerformance([A]) → موظف A فقط، مش B؛ [] → صفر", async () => {
    const a = await getEmployeePerformance(undefined, undefined, undefined, [A.businessId]);
    expect(a.some(p => p.employeeId === empA)).toBe(true);
    expect(a.some(p => p.employeeId === empB)).toBe(false);
    // fail-closed: نطاق فاضي = صفر، مش كل التينانتات
    expect((await getEmployeePerformance(undefined, undefined, undefined, [])).length).toBe(0);
  });

  it("🔑 getCancellationReasons([A]) → أسباب A فقط؛ [] → صفر (fail-closed)", async () => {
    const a = await getCancellationReasons(undefined, undefined, undefined, [A.businessId]);
    expect(a.some(r => r.reason === "reasonA")).toBe(true);
    expect(a.some(r => r.reason === "reasonB")).toBe(false);
    expect((await getCancellationReasons(undefined, undefined, undefined, [])).length).toBe(0);
  });

  it("🔑 قوائم الموظفين: [A] → موظف A فقط؛ [] → صفر", async () => {
    const all = await getAllEmployees(undefined, [A.businessId]);
    expect(all.some(e => e.id === empA)).toBe(true);
    expect(all.some(e => e.id === empB)).toBe(false);
    expect((await getAllEmployees(undefined, [])).length).toBe(0);
    expect((await getActiveEmployees(undefined, [])).length).toBe(0);
  });
});
