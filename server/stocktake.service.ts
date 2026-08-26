import { and, desc, eq } from "drizzle-orm";
import {
  inventoryBalances,
  stocktakes,
  stocktakeLines,
  warehouses,
} from "../drizzle/schema";
import { getDb } from "./db";
import { toMinorUnits, fromMinorUnits } from "../shared/accountingMoney";

type Actor = { id: number; name: string };

/**
 * الجرد — P2-C.1: إنشاء جلسة + لقطة، عرض، إدخال العد، إرسال للاعتماد.
 *
 * **مفيش اعتماد ولا حركة مخزون ولا حدث محاسبي في المرحلة دي** — بس جلسة بحالة
 * draft/pending_approval. الاعتماد اللي بيحرّك المخزون ويسجّل الربح/الخسارة في P2-C.2.
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
