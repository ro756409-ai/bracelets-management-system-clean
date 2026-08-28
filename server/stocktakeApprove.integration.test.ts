import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  businessEvents,
  businesses,
  inventoryBalances,
  inventoryMovements,
  inventoryTransactions,
  products,
  stocktakeLines,
  stocktakes,
} from "../drizzle/schema";
import { getDb } from "./db";
import { makeInventoryKey } from "./inventoryV2.service";
import {
  approveStocktake,
  createStocktake,
  getStocktake,
  submitStocktake,
  updateStocktakeLine,
} from "./stocktake.service";
import { computeRealizedProfit } from "./accountingV2.service";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * اعتماد الجرد (P2-C.2) — على قاعدة بيانات حقيقية.
 *
 * بتقيس الأرقام بعد الاعتماد فعلًا: delta على الرصيد الحالي، rollback كامل، gain+loss
 * متداخلين، منع الحركة المزدوجة، وانعكاس الخسارة/الربح في realized-profit.
 *
 * بتشتغل بس مع TEST_DATABASE_URL:
 *   TEST_DATABASE_URL=... corepack pnpm vitest run server/stocktakeApprove.integration.test.ts
 */

const MAKER = { id: 7001, name: "عادّ الجرد" };
const APPROVER = { id: 7002, name: "معتمِد الجرد" };

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  "اعتماد الجرد — على قاعدة بيانات",
  () => {
    let fx: CoreTestFixture;
    let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
    let secondProductId: number;

    beforeAll(async () => {
      const database = await getDb();
      if (!database) throw new Error("Test database is not available");
      db = database;
      fx = await createCoreTestFixture("stocktake-approve");
      // منتج تاني عشان اختبارات gain+loss المتداخلة.
      const [row]: any = await db.insert(products).values({
        businessId: fx.businessId,
        name: "Test Product 2",
        sku: `TEST2-${Date.now()}`.slice(0, 50),
        price: "100.00",
      });
      secondProductId = Number(row?.insertId ?? row?.[0]?.insertId);
      // go-live للمحاسبة عشان اختبار الإقفال (لو اتفعّل).
      await db.update(businesses).set({ accountingGoLiveAt: new Date("2020-01-01") }).where(eq(businesses.id, fx.businessId));
    });

    afterAll(async () => {
      if (!fx) return;
      // تنظيف الأثر (business_events/transactions/movements/stocktakes) قبل حذف الأساس.
      await db.delete(inventoryTransactions).where(eq(inventoryTransactions.businessId, fx.businessId));
      await db.delete(inventoryMovements).where(eq(inventoryMovements.businessId, fx.businessId));
      await db.delete(businessEvents).where(eq(businessEvents.businessId, fx.businessId));
      await db.delete(stocktakeLines).where(eq(stocktakeLines.businessId, fx.businessId));
      await db.delete(stocktakes).where(eq(stocktakes.businessId, fx.businessId));
      await db.delete(inventoryBalances).where(eq(inventoryBalances.businessId, fx.businessId));
      await db.delete(products).where(eq(products.id, secondProductId));
      await fx.cleanup();
    });

    /** يزرع رصيد لصنف في مخزن الاختبار. */
    async function seedBalance(productId: number, onHand: number, cost: string) {
      const key = makeInventoryKey(productId, null);
      await db.delete(inventoryBalances).where(and(
        eq(inventoryBalances.businessId, fx.businessId),
        eq(inventoryBalances.warehouseId, fx.warehouseId),
        eq(inventoryBalances.inventoryKey, key),
      ));
      const value = (Number(cost) * onHand).toFixed(4);
      await db.insert(inventoryBalances).values({
        businessId: fx.businessId,
        warehouseId: fx.warehouseId,
        productId,
        variantId: null,
        inventoryKey: key,
        onHandQuantity: onHand,
        inventoryValue: value,
        movingAverageCost: cost,
      });
    }

    async function balanceOf(productId: number) {
      const [row] = await db.select().from(inventoryBalances).where(and(
        eq(inventoryBalances.businessId, fx.businessId),
        eq(inventoryBalances.warehouseId, fx.warehouseId),
        eq(inventoryBalances.inventoryKey, makeInventoryKey(productId, null)),
      )).limit(1);
      return row!;
    }

    /** ينشئ جلسة، يعدّ الأصناف المطلوبة، ويرسلها للاعتماد. بيرجّع stocktakeId. */
    async function buildPendingStocktake(counts: Array<{ productId: number; counted: number }>) {
      const { stocktakeId } = await createStocktake({
        businessId: fx.businessId, warehouseId: fx.warehouseId, actor: MAKER,
      });
      const snap = await getStocktake({ businessId: fx.businessId, stocktakeId });
      for (const { productId, counted } of counts) {
        const line = snap!.lines.find(l => l.productId === productId)!;
        await updateStocktakeLine({
          businessId: fx.businessId, stocktakeId, lineId: line.id, countedQuantity: counted, actor: MAKER,
        });
      }
      await submitStocktake({ businessId: fx.businessId, stocktakeId });
      return stocktakeId;
    }

    it("🔑 gain+loss متداخلين: كل صنف بيتحرّك بالاتجاه الصح", async () => {
      await seedBalance(fx.productId, 100, "10.0000"); // هيتعدّ 95 → عجز 5
      await seedBalance(secondProductId, 50, "20.0000"); // هيتعدّ 58 → زيادة 8
      const id = await buildPendingStocktake([
        { productId: fx.productId, counted: 95 },
        { productId: secondProductId, counted: 58 },
      ]);
      const res = await approveStocktake({ businessId: fx.businessId, stocktakeId: id, actor: APPROVER });
      expect(res.duplicate).toBe(false);
      expect(res.movedLines).toBe(2);

      const b1 = await balanceOf(fx.productId);
      const b2 = await balanceOf(secondProductId);
      expect(b1.onHandQuantity).toBe(95); // 100 - 5
      expect(b2.onHandQuantity).toBe(58); // 50 + 8

      const txns = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.businessEventId, res.eventId));
      const byType = Object.fromEntries(txns.map(t => [t.transactionType, t]));
      expect(byType.stocktake_loss.quantityDelta).toBe(-5);
      expect(byType.stocktake_loss.valueDelta).toBe("-50.0000"); // 5 × 10 بالمتوسط الحالي
      expect(byType.stocktake_gain.quantityDelta).toBe(8);
      expect(byType.stocktake_gain.valueDelta).toBe("160.0000"); // 8 × 20 تكلفة اللقطة
    });

    it("🔑 concurrency: حركة بين العدّ والاعتماد → الفرق delta على الرصيد الحالي", async () => {
      await seedBalance(fx.productId, 100, "10.0000");
      const id = await buildPendingStocktake([{ productId: fx.productId, counted: 95 }]); // عجز 5 مجمّد
      // «شحن» 10 وحدات بين العدّ والاعتماد → الرصيد الحالي 90.
      await db.update(inventoryBalances).set({ onHandQuantity: 90, inventoryValue: "900.0000" }).where(and(
        eq(inventoryBalances.businessId, fx.businessId),
        eq(inventoryBalances.inventoryKey, makeInventoryKey(fx.productId, null)),
      ));
      await approveStocktake({ businessId: fx.businessId, stocktakeId: id, actor: APPROVER });
      const b = await balanceOf(fx.productId);
      // delta (−5) على الرصيد الحالي (90) = 85. مش recompute (اللي كان هيرجّع 95).
      expect(b.onHandQuantity).toBe(85);
    });

    it("🔑 rollback كامل: بند يفشل (عجز يخلّي الرصيد سالب) → صفر تغيير", async () => {
      await seedBalance(fx.productId, 3, "10.0000"); // متاح 3
      await seedBalance(secondProductId, 50, "20.0000");
      // العدّ اتعمل على رصيد قديم أكبر — نزوّد المتاح مؤقتًا عشان العدّ يسجّل عجز كبير.
      await db.update(inventoryBalances).set({ onHandQuantity: 100 }).where(and(
        eq(inventoryBalances.businessId, fx.businessId),
        eq(inventoryBalances.inventoryKey, makeInventoryKey(fx.productId, null)),
      ));
      const id = await buildPendingStocktake([
        { productId: fx.productId, counted: 10 }, // عجز 90
        { productId: secondProductId, counted: 55 }, // زيادة 5 (بند سليم)
      ]);
      // نرجّع المتاح 3 قبل الاعتماد → تطبيق عجز 90 على 3 هيخلّيه سالب → رفض.
      await db.update(inventoryBalances).set({ onHandQuantity: 3, inventoryValue: "30.0000" }).where(and(
        eq(inventoryBalances.businessId, fx.businessId),
        eq(inventoryBalances.inventoryKey, makeInventoryKey(fx.productId, null)),
      ));
      const before2 = await balanceOf(secondProductId);
      await expect(approveStocktake({ businessId: fx.businessId, stocktakeId: id, actor: APPROVER })).rejects.toThrow();
      // مفيش اعتماد جزئي: الصنف السليم مااتغيّرش، ومفيش حدث، والجلسة لسه pending.
      const after2 = await balanceOf(secondProductId);
      expect(after2.onHandQuantity).toBe(before2.onHandQuantity);
      const events = await db.select().from(businessEvents).where(and(
        eq(businessEvents.businessId, fx.businessId),
        eq(businessEvents.idempotencyKey, `stocktake:${id}:approved`),
      ));
      expect(events.length).toBe(0);
      const [hdr] = await db.select().from(stocktakes).where(eq(stocktakes.id, id)).limit(1);
      expect(hdr.status).toBe("pending_approval");
    });

    it("🔑 zero-difference: مفيش حركة ولا transaction", async () => {
      await seedBalance(fx.productId, 40, "10.0000");
      const id = await buildPendingStocktake([]); // مفيش عدّ → كل الفروق صفر
      const res = await approveStocktake({ businessId: fx.businessId, stocktakeId: id, actor: APPROVER });
      expect(res.movedLines).toBe(0);
      const txns = await db.select().from(inventoryTransactions).where(eq(inventoryTransactions.businessEventId, res.eventId));
      expect(txns.length).toBe(0);
      const b = await balanceOf(fx.productId);
      expect(b.onHandQuantity).toBe(40); // مااتغيرش
    });

    it("🔑 double approval (تسلسلي): التاني مايحرّكش المخزون تاني", async () => {
      await seedBalance(fx.productId, 100, "10.0000");
      const id = await buildPendingStocktake([{ productId: fx.productId, counted: 90 }]); // عجز 10
      await approveStocktake({ businessId: fx.businessId, stocktakeId: id, actor: APPROVER });
      const afterFirst = await balanceOf(fx.productId);
      expect(afterFirst.onHandQuantity).toBe(90);
      // إعادة نفس الطلب → مرفوض (مش pending)، والرصيد ثابت.
      await expect(approveStocktake({ businessId: fx.businessId, stocktakeId: id, actor: APPROVER })).rejects.toThrow();
      const afterSecond = await balanceOf(fx.productId);
      expect(afterSecond.onHandQuantity).toBe(90);
      const txns = await db.select().from(inventoryTransactions).where(and(
        eq(inventoryTransactions.businessId, fx.businessId),
        eq(inventoryTransactions.sourceType, "stocktake_line"),
        inArray(inventoryTransactions.sourceId, (await db.select({ id: stocktakeLines.id }).from(stocktakeLines).where(eq(stocktakeLines.stocktakeId, id))).map(r => r.id)),
      ));
      expect(txns.length).toBe(1); // حركة واحدة بس
    });

    it("🔑 concurrent approval: طلبين متوازيين → حركة واحدة فقط", async () => {
      await seedBalance(fx.productId, 100, "10.0000");
      const id = await buildPendingStocktake([{ productId: fx.productId, counted: 88 }]); // عجز 12
      const results = await Promise.allSettled([
        approveStocktake({ businessId: fx.businessId, stocktakeId: id, actor: APPROVER }),
        approveStocktake({ businessId: fx.businessId, stocktakeId: id, actor: APPROVER }),
      ]);
      const fulfilled = results.filter(r => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
      const moved = fulfilled.filter(r => r.value.duplicate === false && r.value.movedLines > 0);
      expect(moved.length).toBe(1); // واحد بس حرّك المخزون
      const b = await balanceOf(fx.productId);
      expect(b.onHandQuantity).toBe(88); // 100 - 12، مرة واحدة
    });

    it("🔑 realized-profit بيعكس الخسارة والربح من نفس الحدث", async () => {
      await seedBalance(fx.productId, 100, "10.0000"); // عجز 5 → خسارة 50
      await seedBalance(secondProductId, 50, "20.0000"); // زيادة 4 → ربح 80
      const id = await buildPendingStocktake([
        { productId: fx.productId, counted: 95 },
        { productId: secondProductId, counted: 54 },
      ]);
      const before = await computeRealizedProfit({ businessIds: [fx.businessId] });
      await approveStocktake({ businessId: fx.businessId, stocktakeId: id, actor: APPROVER });
      const after = await computeRealizedProfit({ businessIds: [fx.businessId] });
      expect(after.scrapLoss - before.scrapLoss).toBeCloseTo(50, 2);
      expect(after.inventoryGain - before.inventoryGain).toBeCloseTo(80, 2);
      // صافي الأثر على الربح = ربح − خسارة = +30.
      expect(after.netProfit - before.netProfit).toBeCloseTo(30, 2);
    });

    it("🔑 P0 دفاع طبقتين: اعتماد بـbusinessId تاني مايلقاش الجلسة (مفلترة بالنشاط)", async () => {
      await seedBalance(fx.productId, 100, "10.0000");
      const id = await buildPendingStocktake([{ productId: fx.productId, counted: 97 }]);
      // حتى لو الراوتر (requireScopedBusinessId) اتخطّى، الخدمة بتفلتر الهيدر بالـbusinessId.
      const otherBusinessId = fx.businessId + 987654;
      await expect(approveStocktake({ businessId: otherBusinessId, stocktakeId: id, actor: APPROVER })).rejects.toThrow();
      const [hdr] = await db.select().from(stocktakes).where(eq(stocktakes.id, id)).limit(1);
      expect(hdr.status).toBe("pending_approval"); // مااتعتمدتش من نشاط تاني
    });

    it("🔑 maker-checker: منشئ الجلسة مايعتمدهاش بنفسه (بدون allowSelfApproval)", async () => {
      await seedBalance(fx.productId, 100, "10.0000");
      const id = await buildPendingStocktake([{ productId: fx.productId, counted: 99 }]);
      await expect(approveStocktake({ businessId: fx.businessId, stocktakeId: id, actor: MAKER })).rejects.toThrow();
      // بـallowSelfApproval (المالك) بينجح.
      const res = await approveStocktake({ businessId: fx.businessId, stocktakeId: id, actor: MAKER, allowSelfApproval: true });
      expect(res.duplicate).toBe(false);
    });
  }
);
