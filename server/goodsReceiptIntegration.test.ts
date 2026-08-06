import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  inventoryBalances, inventoryMovements, inventoryTransactions,
  productVariants, products, purchaseReceipts, warehouses,
} from "../drizzle/schema";
import { getDb, updateProductStock } from "./db";
import {
  approvePurchaseReceipt, createPurchaseReceiptDraft, makeInventoryKey,
  submitPurchaseReceipt, voidPurchaseReceipt,
} from "./inventoryV2.service";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * الجسر بين المخزونين — على قاعدة بيانات حقيقية.
 *
 * اختبارات goodsReceipt.test.ts بتقرا الكود وبتتأكد إنه بيستدعي الحاجات الصح. دي بتشغّل
 * الدورة كاملة وبتقيس الأرقام بعدها، لأن «العدّاد اتزوّد مرة واحدة» مش حاجة تتقاس من
 * قراءة نص.
 *
 * بتشتغل بس مع TEST_DATABASE_URL — من غيرها بتتخطى. الأمر:
 *   TEST_DATABASE_URL=... corepack pnpm vitest run server/goodsReceiptIntegration.test.ts
 */

const ACTOR_MAKER = { id: 9001, name: "مُدخل الاختبار" };
const ACTOR_APPROVER = { id: 9002, name: "معتمد الاختبار" };

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  "إذن الاستلام — الجسر على قاعدة بيانات",
  () => {
    let fx: CoreTestFixture;
    let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
    let variantId: number;
    let secondWarehouseId: number;

    /** رصيد V2 لمفتاح مخزون في مخزن. */
    const v2 = async (warehouseId: number, productId: number, vId?: number | null) => {
      const [row] = await db.select().from(inventoryBalances).where(and(
        eq(inventoryBalances.businessId, fx.businessId),
        eq(inventoryBalances.warehouseId, warehouseId),
        eq(inventoryBalances.inventoryKey, makeInventoryKey(productId, vId ?? null)),
      )).limit(1);
      return row ?? null;
    };

    /** العدّاد التشغيلي. */
    const legacyProduct = async (id: number) => {
      const [row] = await db.select().from(products).where(eq(products.id, id)).limit(1);
      return row!.currentStock;
    };
    const legacyVariant = async (id: number) => {
      const [row] = await db.select().from(productVariants).where(eq(productVariants.id, id)).limit(1);
      return row!.currentStock;
    };

    /** عدد صفوف دفتر الحركات التشغيلي المرتبطة بإذن. */
    const movementsFor = async (reason: string) =>
      db.select().from(inventoryMovements).where(and(
        eq(inventoryMovements.businessId, fx.businessId),
        eq(inventoryMovements.reason, reason),
      ));

    /** يعمل إذن كامل لحد الاعتماد ويرجّع رقمه. */
    const receive = async (input: {
      warehouseId: number;
      receiptType: string;
      items: Array<{ productId: number; variantId?: number; quantity: number; unitCost: string }>;
    }) => {
      const { receiptId } = await createPurchaseReceiptDraft({
        businessId: fx.businessId,
        warehouseId: input.warehouseId,
        receiptType: input.receiptType,
        supplierName: "مورد الاختبار",
        receiptDate: new Date(),
        evidenceUrl: "https://example.test/doc.pdf",
        actor: ACTOR_MAKER,
        items: input.items,
      });
      await submitPurchaseReceipt({ businessId: fx.businessId, receiptId });
      await approvePurchaseReceipt({ businessId: fx.businessId, receiptId, actor: ACTOR_APPROVER });
      return receiptId;
    };

    beforeAll(async () => {
      const maybeDb = await getDb();
      if (!maybeDb) throw new Error("Test database is not available");
      db = maybeDb;
      fx = await createCoreTestFixture("goods-receipt");

      const vResult: any = await db.insert(productVariants).values({
        productId: fx.productId, name: "حفر عميق", price: "150.00",
      });
      variantId = Number(vResult?.insertId ?? vResult?.[0]?.insertId);

      const wResult: any = await db.insert(warehouses).values({
        businessId: fx.businessId, name: "الورشة",
      });
      secondWarehouseId = Number(wResult?.insertId ?? wResult?.[0]?.insertId);

      // الجرد الافتتاحي هو الوحيد اللي بينشئ صفوف الأرصدة، ولازم يكون أول حركة.
      await receive({
        warehouseId: fx.warehouseId,
        receiptType: "opening_inventory",
        items: [
          { productId: fx.productId, quantity: 100, unitCost: "10.0000" },
          { productId: fx.productId, variantId, quantity: 40, unitCost: "12.0000" },
        ],
      });
    });

    afterAll(async () => {
      if (!db || !fx) return;
      await db.delete(inventoryMovements).where(eq(inventoryMovements.businessId, fx.businessId));
      await db.delete(inventoryTransactions).where(eq(inventoryTransactions.businessId, fx.businessId));
      await db.delete(inventoryBalances).where(eq(inventoryBalances.businessId, fx.businessId));
      await db.delete(purchaseReceipts).where(eq(purchaseReceipts.businessId, fx.businessId));
      await db.delete(warehouses).where(eq(warehouses.id, secondWarehouseId));
      await db.delete(productVariants).where(eq(productVariants.id, variantId));
      await fx.cleanup();
    });

    it("🔑 الجرد الافتتاحي زوّد الدفترين — الرصيد المحاسبي والعدّاد التشغيلي", async () => {
      const balance = await v2(fx.warehouseId, fx.productId);
      expect(balance?.onHandQuantity).toBe(100);
      expect(await legacyProduct(fx.productId)).toBe(100);
    });

    it("🔑 بند النوع حرّك عدّاد النوع بس — المنتج الأب مالوش علاقة", async () => {
      expect(await legacyVariant(variantId)).toBe(40);
      // الأب لسه 100 من بنده هو، مااتزودش 40 كمان
      expect(await legacyProduct(fx.productId)).toBe(100);
      expect((await v2(fx.warehouseId, fx.productId, variantId))?.onHandQuantity).toBe(40);
    });

    it("🔑 استلام مشتريات بيزوّد الاتنين مرة واحدة بالظبط", async () => {
      const beforeV2 = (await v2(fx.warehouseId, fx.productId))!.onHandQuantity;
      const beforeLegacy = await legacyProduct(fx.productId);

      const receiptId = await receive({
        warehouseId: fx.warehouseId,
        receiptType: "purchase",
        items: [{ productId: fx.productId, quantity: 50, unitCost: "20.0000" }],
      });

      expect((await v2(fx.warehouseId, fx.productId))!.onHandQuantity).toBe(beforeV2 + 50);
      expect(await legacyProduct(fx.productId)).toBe(beforeLegacy + 50);
      // صف واحد في الدفتر التشغيلي — مش اتنين
      expect(await movementsFor(`purchase_receipt:${receiptId}`)).toHaveLength(1);
    });

    it("🔑 المتوسط المرجّح اتحدّث صح: (100×10 + 50×20) ÷ 150 = 13.3333", async () => {
      const balance = await v2(fx.warehouseId, fx.productId);
      expect(Number(balance!.movingAverageCost)).toBeCloseTo(13.3333, 3);
      expect(Number(balance!.inventoryValue)).toBeCloseTo(2000, 2);
    });

    it("🔑 المسودة لوحدها ماتحركش حاجة", async () => {
      const beforeV2 = (await v2(fx.warehouseId, fx.productId))!.onHandQuantity;
      const beforeLegacy = await legacyProduct(fx.productId);
      await createPurchaseReceiptDraft({
        businessId: fx.businessId, warehouseId: fx.warehouseId, receiptType: "purchase",
        supplierName: "مورد المسودة", receiptDate: new Date(),
        evidenceUrl: "https://example.test/draft.pdf", actor: ACTOR_MAKER,
        items: [{ productId: fx.productId, quantity: 999, unitCost: "5.0000" }],
      });
      expect((await v2(fx.warehouseId, fx.productId))!.onHandQuantity).toBe(beforeV2);
      expect(await legacyProduct(fx.productId)).toBe(beforeLegacy);
    });

    it("🔑 الاعتماد المكرر مابيزوّدش تاني", async () => {
      const { receiptId } = await createPurchaseReceiptDraft({
        businessId: fx.businessId, warehouseId: fx.warehouseId, receiptType: "purchase",
        supplierName: "مورد التكرار", receiptDate: new Date(),
        evidenceUrl: "https://example.test/dup.pdf", actor: ACTOR_MAKER,
        items: [{ productId: fx.productId, quantity: 7, unitCost: "30.0000" }],
      });
      await submitPurchaseReceipt({ businessId: fx.businessId, receiptId });
      await approvePurchaseReceipt({ businessId: fx.businessId, receiptId, actor: ACTOR_APPROVER });

      const afterFirstV2 = (await v2(fx.warehouseId, fx.productId))!.onHandQuantity;
      const afterFirstLegacy = await legacyProduct(fx.productId);

      // التانية بترفض على الحالة (بقت approved) — والمفتاح وراها لو حصل سباق.
      await expect(
        approvePurchaseReceipt({ businessId: fx.businessId, receiptId, actor: ACTOR_APPROVER })
      ).rejects.toThrow();

      expect((await v2(fx.warehouseId, fx.productId))!.onHandQuantity).toBe(afterFirstV2);
      expect(await legacyProduct(fx.productId)).toBe(afterFirstLegacy);
      expect(await movementsFor(`purchase_receipt:${receiptId}`)).toHaveLength(1);
    });

    it("🔑 الإلغاء بيرجّع الاتنين مرة واحدة وبيسيب التاريخ", async () => {
      const receiptId = await receive({
        warehouseId: fx.warehouseId, receiptType: "purchase",
        items: [{ productId: fx.productId, quantity: 25, unitCost: "40.0000" }],
      });
      const afterReceiveV2 = (await v2(fx.warehouseId, fx.productId))!.onHandQuantity;
      const afterReceiveLegacy = await legacyProduct(fx.productId);

      await voidPurchaseReceipt({
        businessId: fx.businessId, receiptId, reason: "فاتورة اتسجّلت غلط", actor: ACTOR_APPROVER,
      });

      expect((await v2(fx.warehouseId, fx.productId))!.onHandQuantity).toBe(afterReceiveV2 - 25);
      expect(await legacyProduct(fx.productId)).toBe(afterReceiveLegacy - 25);

      // الحركة الأصلية لسه موجودة، ومعاها العكسية
      expect(await movementsFor(`purchase_receipt:${receiptId}`)).toHaveLength(1);
      expect(await movementsFor(`purchase_receipt_void:${receiptId}`)).toHaveLength(1);
      const [receipt] = await db.select().from(purchaseReceipts)
        .where(eq(purchaseReceipts.id, receiptId)).limit(1);
      expect(receipt!.status).toBe("voided");
    });

    it("الإلغاء المكرر مرفوض", async () => {
      const receiptId = await receive({
        warehouseId: fx.warehouseId, receiptType: "purchase",
        items: [{ productId: fx.productId, quantity: 5, unitCost: "10.0000" }],
      });
      await voidPurchaseReceipt({ businessId: fx.businessId, receiptId, reason: "أول مرة", actor: ACTOR_APPROVER });
      await expect(
        voidPurchaseReceipt({ businessId: fx.businessId, receiptId, reason: "تاني مرة", actor: ACTOR_APPROVER })
      ).rejects.toThrow(/ملغي بالفعل/);
    });

    it("🔑 مخزنين منفصلين — الاستلام في الورشة مايلمسش رصيد المكتب", async () => {
      // الورشة لسه مالهاش صف رصيد، فالافتتاحي هو اللي بينشئه.
      const officeBefore = (await v2(fx.warehouseId, fx.productId))!.onHandQuantity;
      const legacyBefore = await legacyProduct(fx.productId);

      await receive({
        warehouseId: secondWarehouseId, receiptType: "opening_inventory",
        items: [{ productId: fx.productId, quantity: 15, unitCost: "11.0000" }],
      });

      expect((await v2(secondWarehouseId, fx.productId))!.onHandQuantity).toBe(15);
      expect((await v2(fx.warehouseId, fx.productId))!.onHandQuantity).toBe(officeBefore);
      // العدّاد التشغيلي رقم واحد مالوش بُعد مخزن، فبيجمع الاتنين — وده سلوكه الأصلي
      expect(await legacyProduct(fx.productId)).toBe(legacyBefore + 15);
    });

    it("🔑 الخصم التشغيلي بعد الاستلام لسه شغّال زي ما هو", async () => {
      // ده مسار الأوردر القديم: بيخصم من العدّاد التشغيلي مباشرة. الجسر مالوش دخل بيه
      // ولازم يفضل يشتغل من غير أي تغيير.
      const before = await legacyProduct(fx.productId);
      await updateProductStock(fx.productId, -3);
      expect(await legacyProduct(fx.productId)).toBe(before - 3);
      await updateProductStock(fx.productId, 3);
      expect(await legacyProduct(fx.productId)).toBe(before);
    });

    it("🔑 كل حركة V2 ليها ما يقابلها في الدفتر التشغيلي لأذون الاستلام", async () => {
      const v2Rows = await db.select().from(inventoryTransactions).where(and(
        eq(inventoryTransactions.businessId, fx.businessId),
        eq(inventoryTransactions.sourceType, "purchase_receipt_item"),
      ));
      const legacyRows = await db.select().from(inventoryMovements)
        .where(eq(inventoryMovements.businessId, fx.businessId));
      const fromReceipts = legacyRows.filter(r => (r.reason ?? "").startsWith("purchase_receipt"));
      expect(fromReceipts).toHaveLength(v2Rows.length);
    });
  }
);
