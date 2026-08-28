import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  inventoryBalances,
  inventoryTransactions,
  stocktakes,
  stocktakeLines,
  warehouses,
} from "../drizzle/schema";
import { getDb } from "./db";
import { toMinorUnits, fromMinorUnits } from "../shared/accountingMoney";
import { applyStockIn, applyStockOut } from "../shared/inventoryCosting";
import { createBusinessEventInTransaction } from "./accountingV2.service";
import { makeInventoryKey, mirrorLegacyStock } from "./inventoryV2.service";

type Actor = { id: number; name: string };

/**
 * الجرد — إنشاء جلسة + لقطة، عرض، إدخال العد، إرسال للاعتماد (P2-C.1)، والاعتماد (P2-C.2).
 *
 * العدّ والإرسال (draft) مابيحركوش مخزون. **الاعتماد** (`approveStocktake`) هو اللي
 * بيحوّل فروق العدّ لحركات مخزون + حدث محاسبي — عبر نفس محرك التكلفة ومحرك الأحداث
 * الموجودين، مفيش منطق موازي.
 *
 * اللقطة (systemQuantity + unitCostSnapshot) بتتاخد مرة واحدة وقت البدء وبتفضل ثابتة،
 * فحتى لو المخزون اتحرّك بعد كده، الجرد بيقارن بالأرقام اللي كانت وقت العدّ.
 */

/** قيمة الفرق (موقّعة) = الفرق × تكلفة اللقطة — بالحساب الصحيح (bigint، مفيش float). */
function differenceValueOf(differenceQuantity: number, unitCostSnapshot: string): string {
  return fromMinorUnits(toMinorUnits(unitCostSnapshot) * BigInt(differenceQuantity));
}

export async function createStocktake(input: {
  businessId: number;
  warehouseId: number;
  reference?: string;
  notes?: string;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    // المخزن لازم يكون تابع لنفس النشاط — حاجز عزل تاني فوق scoping الراوتر.
    const [warehouse] = await tx.select().from(warehouses).where(and(
      eq(warehouses.id, input.warehouseId),
      eq(warehouses.businessId, input.businessId),
    )).limit(1);
    if (!warehouse) throw new Error("المخزن مش تابع لنشاطك");

    const balances = await tx.select().from(inventoryBalances).where(and(
      eq(inventoryBalances.businessId, input.businessId),
      eq(inventoryBalances.warehouseId, input.warehouseId),
    ));

    const headerResult: any = await tx.insert(stocktakes).values({
      businessId: input.businessId,
      warehouseId: input.warehouseId,
      status: "draft",
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      createdBy: input.actor.id,
      createdByName: input.actor.name,
    });
    const stocktakeId = Number(headerResult?.insertId ?? headerResult?.[0]?.insertId);
    if (!stocktakeId) throw new Error("تعذر إنشاء جلسة الجرد");

    // لقطة كل صنف في المخزن — العدد الفعلي مبدئيًا = الدفتري (الفرق صفر لحد ما يتعدّل).
    for (const balance of balances) {
      await tx.insert(stocktakeLines).values({
        stocktakeId,
        businessId: input.businessId,
        warehouseId: input.warehouseId,
        productId: balance.productId,
        variantId: balance.variantId,
        inventoryKey: balance.inventoryKey,
        systemQuantity: balance.onHandQuantity,
        countedQuantity: balance.onHandQuantity,
        differenceQuantity: 0,
        unitCostSnapshot: balance.movingAverageCost,
        differenceValue: "0",
      });
    }
    return { stocktakeId, lineCount: balances.length };
  });
}

export async function listStocktakes(input: { businessId: number; limit?: number }) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(stocktakes)
    .where(eq(stocktakes.businessId, input.businessId))
    .orderBy(desc(stocktakes.id))
    .limit(input.limit ?? 100);
}

export async function getStocktake(input: { businessId: number; stocktakeId: number }) {
  const db = await getDb();
  if (!db) return null;
  const [header] = await db.select().from(stocktakes).where(and(
    eq(stocktakes.id, input.stocktakeId),
    eq(stocktakes.businessId, input.businessId),
  )).limit(1);
  if (!header) return null;
  const lines = await db.select().from(stocktakeLines).where(and(
    eq(stocktakeLines.stocktakeId, header.id),
    eq(stocktakeLines.businessId, input.businessId),
  )).orderBy(stocktakeLines.id);
  return { ...header, lines };
}

export async function updateStocktakeLine(input: {
  businessId: number;
  stocktakeId: number;
  lineId: number;
  countedQuantity: number;
  actor: Actor;
}) {
  if (!Number.isInteger(input.countedQuantity) || input.countedQuantity < 0) {
    throw new Error("العدد الفعلي لازم يكون رقم صحيح مش سالب");
  }
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [header] = await tx.select().from(stocktakes).where(and(
      eq(stocktakes.id, input.stocktakeId),
      eq(stocktakes.businessId, input.businessId),
    )).limit(1).for("update");
    if (!header) throw new Error("جلسة الجرد مش موجودة");
    if (header.status !== "draft")
      throw new Error("العدّ بيتعدّل في المسودة بس — بعد الإرسال للاعتماد مايتغيّرش");

    const [line] = await tx.select().from(stocktakeLines).where(and(
      eq(stocktakeLines.id, input.lineId),
      eq(stocktakeLines.stocktakeId, header.id),
      eq(stocktakeLines.businessId, input.businessId),
    )).limit(1);
    if (!line) throw new Error("بند الجرد مش موجود");

    const differenceQuantity = input.countedQuantity - line.systemQuantity;
    await tx.update(stocktakeLines).set({
      countedQuantity: input.countedQuantity,
      differenceQuantity,
      differenceValue: differenceValueOf(differenceQuantity, line.unitCostSnapshot),
    }).where(eq(stocktakeLines.id, line.id));
    return { lineId: line.id, differenceQuantity };
  });
}

export async function submitStocktake(input: { businessId: number; stocktakeId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [header] = await tx.select().from(stocktakes).where(and(
      eq(stocktakes.id, input.stocktakeId),
      eq(stocktakes.businessId, input.businessId),
    )).limit(1).for("update");
    if (!header) throw new Error("جلسة الجرد مش موجودة");
    if (header.status !== "draft")
      throw new Error("المسودة بس هي اللي بتتبعت للاعتماد");
    const result: any = await tx.update(stocktakes).set({
      status: "pending_approval",
      submittedAt: new Date(),
    }).where(and(
      eq(stocktakes.id, header.id),
      eq(stocktakes.businessId, input.businessId),
      eq(stocktakes.status, "draft"),
    ));
    return { success: Number(result?.[0]?.affectedRows ?? result?.affectedRows ?? 0) === 1 };
  });
}

/**
 * اعتماد الجرد (P2-C.2) — بيحوّل فروق العدّ لحركات مخزون وحدث محاسبي، كله في transaction واحدة.
 *
 * **Concurrency:** بنطبّق `differenceQuantity` المجمّد وقت العدّ كـ**delta** على الرصيد
 * الحالي وقت الاعتماد. مابنعيدش الحساب مقابل الرصيد الحالي، ومابنعملش set-to-counted —
 * عشان أي حركة مشروعة حصلت بين العدّ والاعتماد (شحن، استلام…) تفضل محفوظة. الفرق هو
 * النقص/الزيادة المكتشَفة، والحركات التانية اتطبّقت على الرصيد أصلاً.
 *
 * **التكلفة (اتّساقًا مع باقي المحرك):** العجز (delta<0) بيمرّ بـ`applyStockOut` فبيتسعّر
 * بالـ`movingAverageCost` الحالي — زي أي صادر تاني (شحن/إلغاء استلام). الزيادة (delta>0)
 * بتمرّ بـ`applyStockIn` بتكلفة اللقطة `unitCostSnapshot`. قيمة الحركة الفعلية (valueDelta)
 * هي اللي بتترحّل للحدث، فخسارة/ربح الـP&L بيساوي بالظبط تغيّر قيمة المخزون.
 *
 * **Idempotency / منع الحركة المزدوجة (3 طبقات):**
 *   1. الحدث بمفتاح ثابت `stocktake:{id}:approved` على `business_events` (UNIQUE) — إعادة
 *      نفس الطلب بعد نجاحه بترجّع `duplicate:true` **قبل** أي حركة (replay-safe).
 *   2. `FOR UPDATE` على الهيدر بيسلسِل الطلبات المتوازية من أول سطر.
 *   3. الـUPDATE النهائي مشروط بـ`status='pending_approval'` مع التأكد إن صف واحد اتغيّر.
 *
 * **Rollback:** أي throw (مثلاً العجز هيخلّي الرصيد سالب) بيلغي العملية كلها — مفيش
 * اعتماد جزئي. الجلسة بعد الاعتماد read-only (الحالة `approved`، وكل مسارات التعديل
 * بترفض أي حالة غير `draft`).
 */
export async function approveStocktake(input: {
  businessId: number;
  stocktakeId: number;
  actor: Actor;
  /** يسمح لمنشئ الجلسة يعتمدها بنفسه — للمالك فقط (الراوتر بيحسبها من الدور). maker-checker. */
  allowSelfApproval?: boolean;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [header] = await tx
      .select()
      .from(stocktakes)
      .where(and(eq(stocktakes.id, input.stocktakeId), eq(stocktakes.businessId, input.businessId)))
      .limit(1)
      .for("update");
    if (!header) throw new Error("جلسة الجرد مش موجودة");
    if (header.status !== "pending_approval")
      throw new Error("الاعتماد للجلسة المرسَلة للاعتماد فقط (pending_approval)");
    if (header.createdBy === input.actor.id && !input.allowSelfApproval)
      throw new Error("اللي عمل الجرد مايقدرش يعتمده — لازم حساب تاني");

    // حاجز عزل تانٍ فوق scoping الراوتر: المخزن لازم يكون تابع لنفس النشاط.
    const [warehouse] = await tx
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.id, header.warehouseId), eq(warehouses.businessId, input.businessId)))
      .limit(1);
    if (!warehouse) throw new Error("المخزن مش تابع لنشاطك");

    const allLines = await tx
      .select()
      .from(stocktakeLines)
      .where(and(eq(stocktakeLines.stocktakeId, header.id), eq(stocktakeLines.businessId, input.businessId)))
      .orderBy(asc(stocktakeLines.id));
    // بس اللي ليها فرق فعلي بتتحرّك — سطور الفرق صفر مالهاش أثر مخزون ولا محاسبي.
    const movingLines = allLines.filter(line => line.differenceQuantity !== 0);

    // ① بنقفل الأرصدة ونحسب الخطة كاملة الأول (فروق delta على الرصيد الحالي)، قبل ما
    //   نعمل أي كتابة. كده الحدث بيتعمل مرة واحدة immutable بالـpayload الكامل الصح.
    const keys = movingLines.map(line => makeInventoryKey(line.productId, line.variantId));
    const balances = keys.length
      ? await tx
          .select()
          .from(inventoryBalances)
          .where(and(
            eq(inventoryBalances.businessId, input.businessId),
            eq(inventoryBalances.warehouseId, header.warehouseId),
            inArray(inventoryBalances.inventoryKey, keys),
          ))
          .orderBy(asc(inventoryBalances.id))
          .for("update")
      : [];
    const balanceByKey = new Map(balances.map(b => [b.inventoryKey, b]));

    type PlanRow = {
      balanceId: number;
      productId: number;
      variantId: number | null;
      inventoryKey: string;
      lineId: number;
      quantityDelta: number; // موقّع: سالب عجز، موجب زيادة
      transactionType: "stocktake_loss" | "stocktake_gain";
      unitCost: string;
      valueDeltaMinor: bigint; // موقّع — هو نفسه اللي بيترحّل P&L
      nextQuantity: number;
      nextValue: string;
      nextAverage: string;
      version: number;
    };
    const plan: PlanRow[] = [];

    for (const line of movingLines) {
      const key = makeInventoryKey(line.productId, line.variantId);
      const balance = balanceByKey.get(key);
      if (!balance) throw new Error(`مفيش رصيد مخزون لبند الجرد #${line.id}`);
      const state = {
        quantity: balance.onHandQuantity,
        inventoryValue: balance.inventoryValue,
        movingAverageCost: balance.movingAverageCost,
      };

      if (line.differenceQuantity > 0) {
        // زيادة → وارد بتكلفة اللقطة.
        const next = applyStockIn(state, line.differenceQuantity, line.unitCostSnapshot);
        plan.push({
          balanceId: balance.id, productId: line.productId, variantId: line.variantId,
          inventoryKey: key, lineId: line.id,
          quantityDelta: line.differenceQuantity,
          transactionType: "stocktake_gain",
          unitCost: fromMinorUnits(toMinorUnits(line.unitCostSnapshot)),
          valueDeltaMinor: toMinorUnits(next.inventoryValue) - toMinorUnits(state.inventoryValue),
          nextQuantity: next.quantity, nextValue: next.inventoryValue, nextAverage: next.movingAverageCost,
          version: balance.version,
        });
      } else {
        // عجز → صادر بالمتوسط الحالي. allowNegative=false → بيرمي لو هيخلّي الرصيد سالب (رفض كامل).
        const next = applyStockOut(state, -line.differenceQuantity);
        plan.push({
          balanceId: balance.id, productId: line.productId, variantId: line.variantId,
          inventoryKey: key, lineId: line.id,
          quantityDelta: line.differenceQuantity, // سالب
          transactionType: "stocktake_loss",
          unitCost: next.unitCostSnapshot,
          valueDeltaMinor: -toMinorUnits(next.valueOut),
          nextQuantity: next.quantity, nextValue: next.inventoryValue, nextAverage: next.movingAverageCost,
          version: balance.version,
        });
      }
    }

    // ② الحدث immutable بمفتاح ثابت. لو الطلب اتعاد بعد نجاحه (أو تسابق) بيرجّع duplicate
    //   من غير أي حركة — replay-safe. الـpayload بيحمل valueDelta الموقّع اللي منه الإقفال
    //   وrealized-profit بيشتقّوا الخسارة/الربح (مفيش تعديل ربح مباشر).
    const occurredAt = header.submittedAt ?? header.createdAt ?? new Date();
    const eventResult = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "inventory.stocktake_approved",
      sourceType: "stocktake",
      sourceReference: String(header.id),
      idempotencyKey: `stocktake:${header.id}:approved`,
      occurredAt,
      payload: {
        stocktakeId: header.id,
        warehouseId: header.warehouseId,
        lines: plan.map(row => ({
          lineId: row.lineId,
          productId: row.productId,
          variantId: row.variantId,
          inventoryKey: row.inventoryKey,
          quantityDelta: row.quantityDelta,
          unitCostSnapshot: row.unitCost,
          valueDelta: fromMinorUnits(row.valueDeltaMinor),
        })),
      },
      actor: input.actor,
    });
    if (eventResult.duplicate)
      return { eventId: eventResult.event.id, duplicate: true, movedLines: 0 };
    const eventId = eventResult.event.id;

    // ③ تنفيذ الخطة — رصيد + inventory_transaction + العدّاد التشغيلي، لكل بند.
    for (const row of plan) {
      await tx.update(inventoryBalances).set({
        onHandQuantity: row.nextQuantity,
        inventoryValue: row.nextValue,
        movingAverageCost: row.nextAverage,
        version: row.version + 1,
      }).where(eq(inventoryBalances.id, row.balanceId));

      await tx.insert(inventoryTransactions).values({
        businessId: input.businessId,
        businessEventId: eventId,
        inventoryBalanceId: row.balanceId,
        transactionType: row.transactionType,
        quantityDelta: row.quantityDelta,
        unitCost: row.unitCost,
        valueDelta: fromMinorUnits(row.valueDeltaMinor),
        quantityAfter: row.nextQuantity,
        valueAfter: row.nextValue,
        averageCostAfter: row.nextAverage,
        sourceType: "stocktake_line",
        sourceId: row.lineId,
        occurredAt,
        createdBy: input.actor.id,
        createdByName: input.actor.name,
      });

      await mirrorLegacyStock(tx, {
        businessId: input.businessId,
        warehouseId: header.warehouseId,
        productId: row.productId,
        variantId: row.variantId,
        quantityDelta: row.quantityDelta,
        reason: `stocktake:${header.id}`,
        notes: header.reference,
        performedBy: input.actor.id,
      });
    }

    const updateResult: any = await tx.update(stocktakes).set({
      status: "approved",
      approvedBy: input.actor.id,
      approvedByName: input.actor.name,
      approvedAt: new Date(),
      businessEventId: eventId,
    }).where(and(
      eq(stocktakes.id, header.id),
      eq(stocktakes.businessId, input.businessId),
      eq(stocktakes.status, "pending_approval"),
    ));
    if (Number(updateResult?.[0]?.affectedRows ?? updateResult?.affectedRows ?? 0) !== 1)
      throw new Error("تعذّر اعتماد الجرد — الحالة اتغيّرت بالتوازي");

    return { eventId, duplicate: false, movedLines: movingLines.length };
  });
}
