import { describe, it, expect } from "vitest";

/**
 * سلوك أدوات الاستيراد الجديدة — على DB حقيقية (`TEST_DATABASE_URL`).
 *
 * `importOrdersAtomic`: الكل-أو-لا-شيء. `getImportDedupOrders`: مقيّد بالنشاط.
 * من غير قاعدة اختبار بتتخطى؛ الحارس النصّي في importExcelSecurity.test.ts بيغطّي البنية.
 */
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  "🔑 D1 · استيراد ذرّي ومقيّد بالنشاط",
  () => {
    it("🔑 صف واحد بيفشل → الدفعة كلها بترجع، مفيش أوردر اتكتب", async () => {
      const { getDb, importOrdersAtomic } = await import("./db");
      const { createCoreTestFixture } = await import("./testFixtures");
      const { orders } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return;
      const fx = await createCoreTestFixture("d1-atomic");

      const good = {
        customerName: "عميل",
        customerPhone: "01000000000",
        customerAddress: "عنوان",
        governorate: "القاهرة",
        productId: fx.productId,
        productName: "Test Product",
        quantity: 1,
        totalAmount: "100.00",
        source: "easyorder",
        status: "new",
      } as any;
      // صف مكسور: customerName = null بيكسر NOT NULL فبيرمي جوه الترانزاكشن.
      const bad = { ...good, customerName: null } as any;

      await expect(
        importOrdersAtomic(fx.businessId, [good, bad, good])
      ).rejects.toBeTruthy();

      const rows = await db
        .select()
        .from(orders)
        .where(eq(orders.businessId, fx.businessId));
      expect(rows).toHaveLength(0); // مفيش نصف استيراد

      await fx.cleanup();
    });

    it("🔑 كل الصفوف سليمة → كلهم بيتكتبوا بأرقام متتالية", async () => {
      const { getDb, importOrdersAtomic } = await import("./db");
      const { createCoreTestFixture } = await import("./testFixtures");
      const { orders } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return;
      const fx = await createCoreTestFixture("d1-atomic-ok");
      const mk = (phone: string) =>
        ({
          customerName: "عميل",
          customerPhone: phone,
          customerAddress: "عنوان",
          governorate: "القاهرة",
          productId: fx.productId,
          productName: "Test Product",
          quantity: 1,
          totalAmount: "100.00",
          source: "easyorder",
          status: "new",
        }) as any;

      const result = await importOrdersAtomic(fx.businessId, [
        mk("01000000001"),
        mk("01000000002"),
      ]);
      expect(result.insertedIds).toHaveLength(2);
      const rows = await db
        .select()
        .from(orders)
        .where(eq(orders.businessId, fx.businessId));
      expect(rows).toHaveLength(2);
      await fx.cleanup();
    });

    it("🔑 getImportDedupOrders بترجّع أوردرات النشاط ده بس", async () => {
      const { getDb, importOrdersAtomic, getImportDedupOrders } = await import("./db");
      const { createCoreTestFixture } = await import("./testFixtures");
      const db = await getDb();
      if (!db) return;
      const a = await createCoreTestFixture("d1-dedup-a");
      const b = await createCoreTestFixture("d1-dedup-b");
      const mk = (phone: string, ext: string) =>
        ({
          customerName: "عميل",
          customerPhone: phone,
          customerAddress: "عنوان",
          governorate: "القاهرة",
          productId: a.productId,
          productName: "Test Product",
          quantity: 1,
          totalAmount: "100.00",
          source: "easyorder",
          status: "new",
          externalOrderId: ext,
        }) as any;
      await importOrdersAtomic(a.businessId, [mk("01000000010", "EXT-A")]);
      const mkB = (phone: string, ext: string) => ({ ...mk(phone, ext), productId: b.productId });
      await importOrdersAtomic(b.businessId, [mkB("01000000011", "EXT-A")]);

      const since = new Date();
      since.setHours(0, 0, 0, 0);
      // نفس externalOrderId "EXT-A" في النشاطين — النطاق لـA لازم يرجّع صف A بس.
      const dedupA = await getImportDedupOrders(a.businessId, ["EXT-A"], since);
      expect(dedupA.every(o => o.customerPhone === "01000000010")).toBe(true);
      expect(dedupA.some(o => o.customerPhone === "01000000011")).toBe(false);

      await a.cleanup();
      await b.cleanup();
    });
  }
);
