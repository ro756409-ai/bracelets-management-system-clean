import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { eq } from "drizzle-orm";
import { scopeToAllowed, NO_BUSINESS } from "./exportExcel";
import { getDb, createOrder, markOrdersAsPrinted, getOrders } from "./db";
import { orders, orderItems } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * أمان العزل في مسارات export/الطباعة/الشحن (Sprint 2 — security task).
 *
 * الثغرة اللي بنقفلها: القراءة/الكتابة كانت بتحمّل أوردرات **كل التينانتات** وتفلتر بالـIDs
 * الجاية من العميل، والنطاق الفاضي كان بيتحوّل لـ«الكل». دلوقتي كله tenant-scoped من
 * السيرفر، والنطاق الفاضي = صفر (fail-closed) مش الكل.
 *
 * القسم الأول سلوكي فعلي على منطق القصّ (scopeToAllowed). الباقي حراس نصّية على كود
 * المسارات (نفس أسلوب importExcelSecurity.test.ts) — والدفاع الحقيقي على السيرفر.
 */

describe("🔑 scopeToAllowed — fail-closed (نطاق فاضي = صفر، مش الكل)", () => {
  it("🔑 تينانت: تقاطع المطلوب مع المسموح", () => {
    expect(scopeToAllowed([1, 2, 3], [2, 3, 99])).toEqual([2, 3]);
  });
  it("🔑 تينانت بلا فلتر → كل أنشطته (مش كل التينانتات)", () => {
    expect(scopeToAllowed([1, 2], undefined)).toEqual([1, 2]);
  });
  it("🔑 🚨 المطلوب برّه المسموح بالكامل → [NO_BUSINESS] (صفر صفوف)، **مش** الكل", () => {
    expect(scopeToAllowed([1, 2], [99, 100])).toEqual([NO_BUSINESS]);
  });
  it("🔑 🚨 مستخدم بلا أنشطة (allowed=[]) → [NO_BUSINESS]، مش الكل", () => {
    expect(scopeToAllowed([], undefined)).toEqual([NO_BUSINESS]);
    expect(scopeToAllowed([], [5])).toEqual([NO_BUSINESS]);
  });
  it("🔑 مالك المنصة (allowed=null) → يحترم الفلتر أو الكل (undefined)", () => {
    expect(scopeToAllowed(null, undefined)).toBeUndefined();
    expect(scopeToAllowed(null, [7])).toEqual([7]);
  });
  it("🔑 NO_BUSINESS مُعرّف مستحيل (سالب)", () => {
    expect(NO_BUSINESS).toBeLessThan(0);
  });
});

describe("🔑 export routes — عزل التينانت server-side (source guards)", () => {
  const src = fs.readFileSync("server/exportExcel.ts", "utf-8");

  it("🔑 المصدر: allowedBusinessIdsForReq من authInfo.tenantId (مش من العميل)", () => {
    expect(src).toContain("(req as RequestWithAuth).authInfo");
    expect(src).toContain("getBusinessIdsForTenant(auth.tenantId)");
  });
  it("🔑 getFilteredOrders بيقصّ فلتر المجموعة على المسموح (confirmed/shipping/validate)", () => {
    const fn = src.slice(src.indexOf("async function getFilteredOrders"), src.indexOf("// ==================== DATA VALIDATION"));
    expect(fn).toContain("allowedBusinessIdsForReq(req)");
    expect(fn).toContain("scopeToAllowed(allowed, requestedFromGroup)");
    // مش بيبعت businessIds غير مقصوصة للـgetOrders.
    expect(fn).not.toMatch(/businessIds = await getBusinessIdsByGroupId/);
  });
  it("🔑 print-labels: بيجيب المملوك فقط + fail-closed على أي id برّه النطاق", () => {
    const fn = src.slice(src.indexOf("async function exportPrintLabels"), src.indexOf("// ==================== REGISTER ROUTES"));
    expect(fn).toContain("allowedBusinessIdsForReq(req)");
    expect(fn).toContain("getOrders({ businessIds: scopedBusinessIds");
    // رفض كامل لو أي id مطلوب مش مملوك (مش طباعة/تعليم جزئي).
    expect(fn).toContain("owned.length !== ids.length");
    expect(fn).toContain("status(403)");
    // مفيش تحميل كل الأوردرات بدون نطاق.
    expect(fn).not.toContain("getOrders({ limit: 100000 })");
    // التعليم كمطبوع مقيّد بالنطاق (دفاع عميق).
    expect(fn).toContain("markOrdersAsPrinted(ownedIds, allowed)");
  });
});

describe("🔑 markOrdersAsPrinted — دفاع عميق على مستوى الـUPDATE", () => {
  const db = fs.readFileSync("server/db.ts", "utf-8");
  it("🔑 بيقبل allowedBusinessIds وبيفلتر businessId (فاضي → [-1] مش الكل)", () => {
    const fn = db.slice(db.indexOf("export async function markOrdersAsPrinted"), db.indexOf("export async function assignOrderToEmployee"));
    expect(fn).toContain("allowedBusinessIds");
    expect(fn).toContain("inArray(orders.businessId, allowedBusinessIds.length ? allowedBusinessIds : [-1])");
  });
});

describe("🔑 employeePortal.todayShipments — موظف بلا نشاط = fail-closed (مش كل الأوردرات)", () => {
  const routers = fs.readFileSync("server/routers.ts", "utf-8");
  it("🔑 بيستخدم scopeBusinessIds (denyWhenEmpty) مش sessionBusinessIds ?? []", () => {
    const block = routers.slice(
      routers.indexOf("todayShipments: requireEmployeePermission"),
      routers.indexOf("// مسح QR للموظف")
    );
    expect(block).toContain("scopeBusinessIds(empScope(ctx), {})) ?? [NO_BUSINESS]");
    // النمط القديم الخطير (فاضي = الكل) اختفى.
    expect(block).not.toContain("sessionBusinessIds(ctx)) ?? []");
    expect(block).not.toContain("?? [];");
  });
});

// ── اختبار cross-tenant فعلي (بيشتغل مع TEST_DATABASE_URL؛ بيتخطّى بدونه) ──
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  "🔑 cross-tenant فعلي — Tenant A لا يقرأ/يطبع أوردرات Tenant B",
  () => {
    let a: CoreTestFixture;
    let b: CoreTestFixture;
    let bOrderId: number;

    beforeAll(async () => {
      const db = await getDb();
      if (!db) return;
      a = await createCoreTestFixture("exp-sec-a");
      b = await createCoreTestFixture("exp-sec-b");
      // أوردر مؤكّد في نشاط تينانت B.
      bOrderId = (await createOrder({
        businessId: b.businessId,
        orderNumber: `SEC${Date.now() % 100000000}`,
        customerName: "عميل B",
        customerPhone: "01000000077",
        governorate: "القاهرة",
        customerAddress: "عنوان B",
        productId: b.productId,
        productName: "صنف B",
        quantity: 1,
        totalAmount: "100",
        source: "manual",
      } as any)) as number;
      await db.update(orders).set({ status: "confirmed" }).where(eq(orders.id, bOrderId));
    });

    afterAll(async () => {
      const db = await getDb();
      if (!db) return;
      if (bOrderId) {
        await db.delete(orderItems).where(eq(orderItems.orderId, bOrderId));
        await db.delete(orders).where(eq(orders.id, bOrderId));
      }
      await b?.cleanup();
      await a?.cleanup();
    });

    it("🔑 markOrdersAsPrinted بنطاق A مايطبعش أوردر B (حتى لو اتبعت الـid يدويًا)", async () => {
      const db = await getDb();
      await markOrdersAsPrinted([bOrderId], [a.businessId]); // نطاق A، وأوردر B
      const [row] = await db!.select().from(orders).where(eq(orders.id, bOrderId)).limit(1);
      expect(row.status).toBe("confirmed"); // لسه مؤكّد — ما اتطبعش
    });

    it("🔑 markOrdersAsPrinted بنطاق B الصحيح بيطبع أوردر B (السلوك السليم داخل النطاق)", async () => {
      const db = await getDb();
      await markOrdersAsPrinted([bOrderId], [b.businessId]);
      const [row] = await db!.select().from(orders).where(eq(orders.id, bOrderId)).limit(1);
      expect(row.status).toBe("printed");
    });

    it("🔑 getOrders بنطاق A مايرجّعش أوردر B", async () => {
      const { orders: aScoped } = await getOrders({ businessIds: [a.businessId], limit: 100000 });
      expect(aScoped.some((o: any) => o.id === bOrderId)).toBe(false);
    });

    it("🔑 نطاق فاضي [NO_BUSINESS] مايرجّعش أي أوردر (fail-closed)", async () => {
      const { orders: none } = await getOrders({ businessIds: [NO_BUSINESS], limit: 100000 });
      expect(none.length).toBe(0);
    });
  }
);
