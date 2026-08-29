import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  businessEvents,
  businesses,
  inventoryBalances,
  inventoryMovements,
  inventoryReservations,
  inventoryTransactions,
  orderItems,
  orders,
  productVariants,
  products,
  purchaseReceiptItems,
  purchaseReceipts,
  returnInspectionItems,
  returnInspections,
  shipments,
  warehouses,
} from "../drizzle/schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { applyStockIn, applyStockOut } from "../shared/inventoryCosting";
import {
  createWarehouse,
  getBusinessById,
  getDb,
  getWarehousesByBusiness,
} from "./db";
import { createBusinessEventInTransaction, type Actor } from "./accountingV2.service";

export function makeInventoryKey(productId: number, variantId?: number | null): string {
  return `product:${productId}:variant:${variantId ?? "base"}`;
}

/**
 * Keep the operational stock counters in step with an inventory_transactions posting.
 *
 * There are two inventory representations in this codebase and they had drifted apart:
 * `inventory_balances` (per warehouse, valued, weighted-average) is what the accounting
 * screens, the closing and the profit report read, while `products.currentStock` /
 * `product_variants.currentStock` plus the `inventory_movements` log are what the stock
 * screen, the low-stock alert and confirmOrder read. approvePurchaseReceipt only ever wrote
 * the first pair, so receiving a hundred bracelets moved the accountant's number and left
 * the storekeeper's at zero.
 *
 * This is not a second ledger. Both destinations already existed and both are already
 * written by other flows; this is the one place that writes them together, inside the
 * caller's transaction, so an inventory posting can no longer land in one and miss the
 * other. Every caller must be a flow that has already written inventory_transactions.
 *
 * Parent/variant follows the existing rule exactly: a product with variants holds no stock
 * of its own (see getLowStockProducts), so a variant line moves the variant counter and
 * never the parent's.
 */
export async function mirrorLegacyStock(
  tx: any,
  input: {
    businessId: number;
    warehouseId: number;
    productId: number;
    variantId: number | null;
    /** Signed: positive receives, negative reverses. */
    quantityDelta: number;
    reason: string;
    notes?: string | null;
    performedBy: number;
  }
) {
  if (input.quantityDelta === 0) return;
  await tx.insert(inventoryMovements).values({
    businessId: input.businessId,
    warehouseId: input.warehouseId,
    productId: input.productId,
    variantId: input.variantId,
    type: input.quantityDelta > 0 ? "in" : "out",
    quantity: Math.abs(input.quantityDelta),
    reason: input.reason,
    notes: input.notes ?? null,
    performedBy: input.performedBy,
  });
  if (input.variantId != null) {
    await tx
      .update(productVariants)
      .set({ currentStock: sql`${productVariants.currentStock} + ${input.quantityDelta}` })
      .where(eq(productVariants.id, input.variantId));
    return;
  }
  await tx
    .update(products)
    .set({ currentStock: sql`${products.currentStock} + ${input.quantityDelta}` })
    .where(eq(products.id, input.productId));
}

export async function getInventoryControlData(businessId: number) {
  const db = await getDb();
  if (!db) return { balances: [], receipts: [], receiptItems: [], inspections: [], inspectionItems: [], returnOrderItems: [] };
  const [balances, receipts, inspections] = await Promise.all([
    db.select().from(inventoryBalances).where(eq(inventoryBalances.businessId, businessId)).orderBy(asc(inventoryBalances.inventoryKey)),
    db.select().from(purchaseReceipts).where(eq(purchaseReceipts.businessId, businessId)).orderBy(asc(purchaseReceipts.id)),
    db.select().from(returnInspections).where(eq(returnInspections.businessId, businessId)).orderBy(asc(returnInspections.id)),
  ]);
  const [receiptItems, inspectionItems] = await Promise.all([
    receipts.length ? db.select().from(purchaseReceiptItems).where(inArray(purchaseReceiptItems.receiptId, receipts.map(row => row.id))) : Promise.resolve([]),
    inspections.length ? db.select().from(returnInspectionItems).where(inArray(returnInspectionItems.inspectionId, inspections.map(row => row.id))) : Promise.resolve([]),
  ]);
  const returnOrderItems = inspections.length ? await db.select().from(orderItems)
    .where(inArray(orderItems.orderId, [...new Set(inspections.map(row => row.orderId))])) : [];
  return { balances, receipts, receiptItems, inspections, inspectionItems, returnOrderItems };
}

export async function createPurchaseReceiptDraft(input: {
  businessId: number;
  warehouseId: number;
  receiptType: string;
  supplierName: string;
  reference?: string;
  receiptDate: Date;
  /**
   * اختياري على المسودة، إجباري عند الاعتماد (شوف approvePurchaseReceipt).
   *
   * كان إجباري من أول لحظة، فالمحاسب اللي البضاعة قدامه والفاتورة لسه مع السواق مكانش
   * يقدر يحفظ ولا حتى مسودة. المسودة مابتحركش مخزون ولا فلوس، فمفيش حاجة تستاهل ورقة
   * لسه ماوصلتش.
   */
  evidenceUrl?: string;
  reason?: string;
  actor: Actor;
  items: Array<{ productId: number; variantId?: number; quantity: number; unitCost: string }>;
}) {
  if (input.items.length === 0) throw new Error("Stock In requires at least one item");
  if (input.items.some(item => !Number.isInteger(item.quantity) || item.quantity <= 0 || toMinorUnits(item.unitCost) < 0n)) {
    throw new Error("Every Stock In item requires a positive quantity and an explicit non-negative cost");
  }
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    if (input.receiptType === "opening_inventory") {
      const [existing] = await tx.select({ id: inventoryTransactions.id }).from(inventoryTransactions)
        .where(eq(inventoryTransactions.businessId, input.businessId)).limit(1);
      if (existing) throw new Error("Opening Inventory must be the first inventory transaction for the Business");
    }
    const total = input.items.reduce(
      (sum, item) => sum + toMinorUnits(item.unitCost) * BigInt(item.quantity),
      0n,
    );
    const result: any = await tx.insert(purchaseReceipts).values({
      businessId: input.businessId,
      warehouseId: input.warehouseId,
      receiptType: input.receiptType,
      supplierName: input.supplierName,
      reference: input.reference ?? null,
      receiptDate: input.receiptDate,
      totalAmount: fromMinorUnits(total),
      status: "draft",
      evidenceUrl: input.evidenceUrl?.trim() || null,
      reason: input.reason ?? null,
      createdBy: input.actor.id,
    });
    const receiptId = Number(result?.insertId ?? result?.[0]?.insertId);
    if (!receiptId) throw new Error("Could not create Purchase Receipt");
    for (const item of input.items) await tx.insert(purchaseReceiptItems).values({
      receiptId,
      businessId: input.businessId,
      productId: item.productId,
      variantId: item.variantId ?? null,
      quantity: item.quantity,
      unitCost: fromMinorUnits(toMinorUnits(item.unitCost)),
      lineTotal: fromMinorUnits(toMinorUnits(item.unitCost) * BigInt(item.quantity)),
    });
    return { receiptId, totalAmount: fromMinorUnits(total) };
  });
}

export async function submitPurchaseReceipt(input: { businessId: number; receiptId: number }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.update(purchaseReceipts).set({ status: "pending_approval" }).where(and(
    eq(purchaseReceipts.id, input.receiptId),
    eq(purchaseReceipts.businessId, input.businessId),
    eq(purchaseReceipts.status, "draft"),
  ));
  return { success: Number((result as any)?.[0]?.affectedRows ?? (result as any)?.affectedRows ?? 0) === 1 };
}

/**
 * تعديل مسودة استلام — **للمسودة فقط**. المسودة مابتحركش مخزون ولا فلوس، فالتعديل آمن.
 * أي حالة غير `draft` بترفض. مابيغيّرش الحالة ولا بيلمس مخزون — بيحدّث الهيدر والبنود بس.
 */
export async function updatePurchaseReceiptDraft(input: {
  businessId: number;
  receiptId: number;
  warehouseId?: number;
  supplierName?: string;
  reference?: string;
  receiptDate?: Date;
  reason?: string;
  items: Array<{ productId: number; variantId?: number; quantity: number; unitCost: string }>;
  actor: Actor;
}) {
  if (input.items.length === 0) throw new Error("Stock In requires at least one item");
  if (input.items.some(item => !Number.isInteger(item.quantity) || item.quantity <= 0 || toMinorUnits(item.unitCost) < 0n)) {
    throw new Error("Every Stock In item requires a positive quantity and an explicit non-negative cost");
  }
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [receipt] = await tx.select().from(purchaseReceipts).where(and(
      eq(purchaseReceipts.id, input.receiptId), eq(purchaseReceipts.businessId, input.businessId),
    )).limit(1).for("update");
    if (!receipt) throw new Error("Purchase Receipt is outside this business");
    if (receipt.status !== "draft")
      throw new Error("مايتعدّلش إلا المسودة — الإذن المُرسل أو المعتمد للمالك");
    const total = input.items.reduce(
      (sum, item) => sum + toMinorUnits(item.unitCost) * BigInt(item.quantity),
      0n,
    );
    await tx.update(purchaseReceipts).set({
      warehouseId: input.warehouseId ?? receipt.warehouseId,
      supplierName: input.supplierName ?? receipt.supplierName,
      reference: input.reference ?? receipt.reference,
      receiptDate: input.receiptDate ?? receipt.receiptDate,
      reason: input.reason ?? receipt.reason,
      totalAmount: fromMinorUnits(total),
    }).where(and(
      eq(purchaseReceipts.id, receipt.id),
      eq(purchaseReceipts.businessId, input.businessId),
      // حارس تاني: التحديث نفسه مشروط بالمسودة، فسباق حالة مايعدّيش على إذن اتعمد بينهم.
      eq(purchaseReceipts.status, "draft"),
    ));
    // استبدال البنود بالكامل — البنود القديمة تتمسح والجديدة تتكتب داخل نفس الـtransaction.
    await tx.delete(purchaseReceiptItems).where(eq(purchaseReceiptItems.receiptId, receipt.id));
    for (const item of input.items) await tx.insert(purchaseReceiptItems).values({
      receiptId: receipt.id,
      businessId: input.businessId,
      productId: item.productId,
      variantId: item.variantId ?? null,
      quantity: item.quantity,
      unitCost: fromMinorUnits(toMinorUnits(item.unitCost)),
      lineTotal: fromMinorUnits(toMinorUnits(item.unitCost) * BigInt(item.quantity)),
    });
    return { receiptId: receipt.id, totalAmount: fromMinorUnits(total) };
  });
}

/**
 * حذف مسودة استلام — **hard delete للمسودة فقط**. المسودة مالهاش أي أثر مخزون/مالي،
 * فالحذف آمن. أي حالة غير `draft` بترفض. البنود بتتمسح مع الرأس في نفس الـtransaction.
 */
export async function deletePurchaseReceiptDraft(input: {
  businessId: number;
  receiptId: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [receipt] = await tx.select().from(purchaseReceipts).where(and(
      eq(purchaseReceipts.id, input.receiptId), eq(purchaseReceipts.businessId, input.businessId),
    )).limit(1).for("update");
    if (!receipt) throw new Error("Purchase Receipt is outside this business");
    if (receipt.status !== "draft")
      throw new Error("مايتحذفش إلا المسودة — الإذن المُرسل أو المعتمد مايتحذفش (يُلغى من المالك)");
    // البنود الأول (مفيش FK cascade في السكيمة)، بعدين الرأس — كله في transaction واحدة.
    await tx.delete(purchaseReceiptItems).where(eq(purchaseReceiptItems.receiptId, receipt.id));
    await tx.delete(purchaseReceipts).where(and(
      eq(purchaseReceipts.id, receipt.id),
      eq(purchaseReceipts.businessId, input.businessId),
      eq(purchaseReceipts.status, "draft"),
    ));
    return { success: true, receiptId: receipt.id };
  });
}

export async function recordOpeningInTransit(input: {
  businessId: number;
  orderId: number;
  businessShippingProviderId: number;
  externalShipmentId?: string;
  trackingNumber?: string;
  currentStatus: string;
  dispatchedAt: Date;
  actor: Actor;
  items: Array<{ orderItemId: number; quantity: number; unitCostSnapshot: string }>;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.businessId, input.businessId),
    )).limit(1).for("update");
    if (!order) throw new Error("Order is outside this business");
    const itemRows = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id)).for("update");
    if (itemRows.length === 0) throw new Error("Opening In-Transit requires Order Items");
    if (input.items.length !== itemRows.length) throw new Error("Every Order Item requires an Opening In-Transit snapshot");
    const itemById = new Map(itemRows.map(item => [item.id, item]));
    for (const snapshot of input.items) {
      const item = itemById.get(snapshot.orderItemId);
      if (!item) throw new Error(`Order Item #${snapshot.orderItemId} is outside this order`);
      if (snapshot.quantity !== item.quantity) throw new Error(`Opening In-Transit quantity must match Order Item #${item.id}`);
      if (toMinorUnits(snapshot.unitCostSnapshot) < 0n) throw new Error("Opening In-Transit cost cannot be negative");
    }
    const [existingShipment] = await tx.select().from(shipments).where(and(
      eq(shipments.businessId, input.businessId), eq(shipments.orderId, order.id),
    )).limit(1);
    let shipmentId = existingShipment?.id;
    if (!shipmentId) {
      const result: any = await tx.insert(shipments).values({
        businessId: input.businessId,
        orderId: order.id,
        businessShippingProviderId: input.businessShippingProviderId,
        externalShipmentId: input.externalShipmentId ?? null,
        trackingNumber: input.trackingNumber ?? null,
        currentStatus: input.currentStatus,
        dispatchedAt: input.dispatchedAt,
      });
      shipmentId = Number(result?.insertId ?? result?.[0]?.insertId);
    }
    if (!shipmentId) throw new Error("Could not create Opening In-Transit Shipment");
    const eventResult = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "inventory.opening_in_transit",
      sourceType: "order",
      sourceReference: String(order.id),
      idempotencyKey: `order:${order.id}:opening-in-transit`,
      occurredAt: input.dispatchedAt,
      payload: { orderId: order.id, shipmentId, currentStatus: input.currentStatus, items: input.items },
      actor: input.actor,
    });
    if (eventResult.duplicate) return { shipmentId, eventId: eventResult.event.id, duplicate: true };
    for (const snapshot of input.items) await tx.update(orderItems).set({
      stockOutQuantity: snapshot.quantity,
      unitCostSnapshot: fromMinorUnits(toMinorUnits(snapshot.unitCostSnapshot)),
      costCapturedAt: input.dispatchedAt,
    }).where(eq(orderItems.id, snapshot.orderItemId));
    await tx.update(orders).set({ status: "shipped", shippedAt: input.dispatchedAt })
      .where(eq(orders.id, order.id));
    return { shipmentId, eventId: eventResult.event.id, duplicate: false };
  });
}

export async function reserveOrderInventory(input: {
  businessId: number;
  orderId: number;
  warehouseId: number;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.businessId, input.businessId),
    )).limit(1).for("update");
    if (!order) throw new Error("Order is outside this business");
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, input.orderId)).orderBy(asc(orderItems.id));
    if (items.length === 0) throw new Error("Order Items are required before inventory reservation");
    const activeReservations = await tx.select().from(inventoryReservations).where(and(
      eq(inventoryReservations.businessId, input.businessId),
      eq(inventoryReservations.orderId, input.orderId),
      eq(inventoryReservations.status, "active"),
    ));
    if (activeReservations.length > 0) {
      if (activeReservations.length === items.length) return { reservedItems: items.length, duplicate: true };
      throw new Error("Order has an incomplete inventory reservation and requires review");
    }
    const keys = items.map(item => makeInventoryKey(item.productId!, item.variantId));
    if (items.some(item => item.productId == null)) throw new Error("All Order Items must resolve to an inventory product");
    const balances = await tx.select().from(inventoryBalances).where(and(
      eq(inventoryBalances.businessId, input.businessId),
      eq(inventoryBalances.warehouseId, input.warehouseId),
      inArray(inventoryBalances.inventoryKey, keys),
    )).orderBy(asc(inventoryBalances.id)).for("update");
    const balanceByKey = new Map(balances.map(balance => [balance.inventoryKey, balance]));

    for (const item of items) {
      const balance = balanceByKey.get(makeInventoryKey(item.productId!, item.variantId));
      if (!balance) throw new Error(`Opening inventory is missing for Order Item #${item.id}`);
      const available = balance.onHandQuantity - balance.reservedQuantity;
      if (available < item.quantity) throw new Error(`Insufficient available stock for Order Item #${item.id}`);
      await tx.update(inventoryBalances).set({
        reservedQuantity: balance.reservedQuantity + item.quantity,
        version: balance.version + 1,
      }).where(eq(inventoryBalances.id, balance.id));
      await tx.insert(inventoryReservations).values({
        businessId: input.businessId,
        orderId: input.orderId,
        orderItemId: item.id,
        inventoryBalanceId: balance.id,
        quantity: item.quantity,
      });
      await tx.update(orderItems).set({ reservedQuantity: item.quantity }).where(eq(orderItems.id, item.id));
      balanceByKey.set(balance.inventoryKey, {
        ...balance,
        reservedQuantity: balance.reservedQuantity + item.quantity,
        version: balance.version + 1,
      });
    }
    return { reservedItems: items.length, duplicate: false };
  });
}

export async function dispatchOrderInventory(input: {
  businessId: number;
  orderId: number;
  occurredAt: Date;
  actor: Actor;
  ownerNegativeOverrideReason?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.businessId, input.businessId),
    )).limit(1).for("update");
    if (!order) throw new Error("Order is outside this business");
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, input.orderId)).orderBy(asc(orderItems.id));
    if (items.length === 0) throw new Error("Order Items are required before Stock Out");
    const eventPayload = { orderId: input.orderId, items: items.map(item => ({ id: item.id, quantity: item.quantity })) };
    const eventResult = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "inventory.stock_out",
      sourceType: "order",
      sourceReference: String(input.orderId),
      idempotencyKey: `order:${input.orderId}:dispatch`,
      occurredAt: input.occurredAt,
      payload: eventPayload,
      actor: input.actor,
    });
    if (eventResult.duplicate) return { eventId: eventResult.event.id, dispatchedItems: items.length, duplicate: true };
    const reservations = await tx.select().from(inventoryReservations).where(and(
      eq(inventoryReservations.businessId, input.businessId),
      eq(inventoryReservations.orderId, input.orderId),
      eq(inventoryReservations.status, "active"),
    )).orderBy(asc(inventoryReservations.inventoryBalanceId)).for("update");
    if (reservations.length !== items.length) throw new Error("Every Order Item requires an active reservation");
    const balances = await tx.select().from(inventoryBalances).where(inArray(
      inventoryBalances.id, reservations.map(row => row.inventoryBalanceId),
    )).orderBy(asc(inventoryBalances.id)).for("update");
    const balanceById = new Map(balances.map(balance => [balance.id, balance]));
    const itemById = new Map(items.map(item => [item.id, item]));
    const eventId = eventResult.event.id;

    for (const reservation of reservations) {
      const item = itemById.get(reservation.orderItemId);
      const balance = balanceById.get(reservation.inventoryBalanceId);
      if (!item || !balance) throw new Error("Reservation points to missing inventory data");
      const allowNegative = Boolean(input.ownerNegativeOverrideReason);
      const next = applyStockOut({
        quantity: balance.onHandQuantity,
        inventoryValue: balance.inventoryValue,
        movingAverageCost: balance.movingAverageCost,
      }, reservation.quantity, allowNegative);
      const newReserved = balance.reservedQuantity - reservation.quantity;
      if (newReserved < 0) throw new Error("Inventory reservation balance is invalid");
      await tx.update(inventoryBalances).set({
        onHandQuantity: next.quantity,
        reservedQuantity: newReserved,
        inventoryValue: next.inventoryValue,
        movingAverageCost: next.movingAverageCost,
        version: balance.version + 1,
      }).where(eq(inventoryBalances.id, balance.id));
      await tx.update(inventoryReservations).set({ status: "consumed", releasedAt: input.occurredAt })
        .where(eq(inventoryReservations.id, reservation.id));
      await tx.update(orderItems).set({
        reservedQuantity: 0,
        stockOutQuantity: reservation.quantity,
        unitCostSnapshot: next.unitCostSnapshot,
        costCapturedAt: input.occurredAt,
      }).where(eq(orderItems.id, item.id));
      await tx.insert(inventoryTransactions).values({
        businessId: input.businessId,
        businessEventId: eventId,
        inventoryBalanceId: balance.id,
        transactionType: allowNegative ? "stock_out_owner_override" : "stock_out",
        quantityDelta: -reservation.quantity,
        unitCost: next.unitCostSnapshot,
        valueDelta: fromMinorUnits(-toMinorUnits(next.valueOut)),
        quantityAfter: next.quantity,
        valueAfter: next.inventoryValue,
        averageCostAfter: next.movingAverageCost,
        sourceType: "order_item",
        sourceId: item.id,
        occurredAt: input.occurredAt,
        createdBy: input.actor.id,
        createdByName: input.actor.name,
      });
      balanceById.set(balance.id, {
        ...balance,
        onHandQuantity: next.quantity,
        inventoryValue: next.inventoryValue,
        movingAverageCost: next.movingAverageCost,
        version: balance.version + 1,
      });
    }
    await tx.update(orders).set({ status: "shipped", shippedAt: input.occurredAt, lastUpdatedBy: input.actor.id })
      .where(eq(orders.id, input.orderId));
    return { eventId, dispatchedItems: items.length, duplicate: false };
  });
}

export async function approvePurchaseReceipt(input: {
  businessId: number;
  receiptId: number;
  actor: Actor;
  /**
   * يسمح لصاحب الإذن إنه يعتمده بنفسه. للمالك بس، والراوتر هو اللي بيحسبها من الدور.
   *
   * فصل الصلاحيات موجود عشان مايبقاش شخص واحد هو اللي بيسجّل حركة فلوس وهو اللي
   * بيباركها. بس إذن الاستلام **مابيحركش خزنة** — بيزوّد مخزون وبيعمل التزام على
   * الورشة. فالخطر الحقيقي اللي الحاجز بيمنعه هو موظف بينفخ قيمة المخزون، وده حاجز
   * له معنى. أما المالك فبيسرق من نفسه، والحاجز مابيمنعش ده أصلاً — بيمنع بس إنه
   * يشتغل لوحده، وده كل يومه.
   *
   * فبيفضل شغّال على كل حد ما عدا المالك، والاستثناء صريح هنا مش مدسوس في الراوتر.
   */
  allowSelfApproval?: boolean;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [receipt] = await tx.select().from(purchaseReceipts).where(and(
      eq(purchaseReceipts.id, input.receiptId), eq(purchaseReceipts.businessId, input.businessId),
    )).limit(1).for("update");
    if (!receipt) throw new Error("Purchase Receipt is outside this business");
    if (receipt.status !== "pending_approval") throw new Error("Only a pending Purchase Receipt can be approved");
    if (receipt.createdBy === input.actor.id && !input.allowSelfApproval)
      throw new Error("اللي سجّل الإذن مايقدرش يعتمده — لازم حساب تاني");
    // الورقة شرط هنا مش عند المسودة: دي اللحظة اللي المخزون بيتحرك فيها فعلًا، وهي
    // اللي محتاجة يكون وراها مستند.
    if (!receipt.evidenceUrl?.trim())
      throw new Error("الاعتماد يتطلب مستند — ضيف رابط الفاتورة على الإذن الأول");
    const lines = await tx.select().from(purchaseReceiptItems).where(eq(purchaseReceiptItems.receiptId, receipt.id));
    if (lines.length === 0) throw new Error("Purchase Receipt has no items");
    const keys = lines.map(line => makeInventoryKey(line.productId, line.variantId));
    let balances = await tx.select().from(inventoryBalances).where(and(
      eq(inventoryBalances.businessId, input.businessId),
      eq(inventoryBalances.warehouseId, receipt.warehouseId),
      inArray(inventoryBalances.inventoryKey, keys),
    )).orderBy(asc(inventoryBalances.id)).for("update");
    if (receipt.receiptType === "opening_inventory") {
      for (const line of lines) {
        const key = makeInventoryKey(line.productId, line.variantId);
        if (!balances.some((balance: typeof inventoryBalances.$inferSelect) => balance.inventoryKey === key)) {
          await tx.insert(inventoryBalances).values({
            businessId: input.businessId,
            warehouseId: receipt.warehouseId,
            productId: line.productId,
            variantId: line.variantId,
            inventoryKey: key,
          });
        }
      }
      balances = await tx.select().from(inventoryBalances).where(and(
        eq(inventoryBalances.businessId, input.businessId),
        eq(inventoryBalances.warehouseId, receipt.warehouseId),
        inArray(inventoryBalances.inventoryKey, keys),
      )).orderBy(asc(inventoryBalances.id)).for("update");
    }
    const balanceByKey = new Map(balances.map(balance => [balance.inventoryKey, balance]));
    const eventResult = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: receipt.receiptType === "opening_inventory" ? "inventory.opening_recorded" : "inventory.purchase_received",
      sourceType: "purchase_receipt",
      sourceReference: String(receipt.id),
      idempotencyKey: `purchase-receipt:${receipt.id}:approved`,
      occurredAt: receipt.receiptDate,
      payload: { receiptId: receipt.id, lines },
      actor: input.actor,
    });
    if (eventResult.duplicate) return { eventId: eventResult.event.id, duplicate: true };
    const eventId = eventResult.event.id;
    for (const line of lines) {
      const key = makeInventoryKey(line.productId, line.variantId);
      const balance = balanceByKey.get(key);
      if (!balance) throw new Error(`Opening inventory is missing for Purchase Receipt Item #${line.id}`);
      const next = applyStockIn({
        quantity: balance.onHandQuantity,
        inventoryValue: balance.inventoryValue,
        movingAverageCost: balance.movingAverageCost,
      }, line.quantity, line.unitCost);
      await tx.update(inventoryBalances).set({
        onHandQuantity: next.quantity,
        inventoryValue: next.inventoryValue,
        movingAverageCost: next.movingAverageCost,
        version: balance.version + 1,
      }).where(eq(inventoryBalances.id, balance.id));
      await tx.insert(inventoryTransactions).values({
        businessId: input.businessId,
        businessEventId: eventId,
        inventoryBalanceId: balance.id,
        transactionType: receipt.receiptType === "opening_inventory" ? "opening_inventory" : receipt.receiptType,
        quantityDelta: line.quantity,
        unitCost: line.unitCost,
        valueDelta: line.lineTotal,
        quantityAfter: next.quantity,
        valueAfter: next.inventoryValue,
        averageCostAfter: next.movingAverageCost,
        sourceType: "purchase_receipt_item",
        sourceId: line.id,
        occurredAt: receipt.receiptDate,
        createdBy: input.actor.id,
        createdByName: input.actor.name,
      });
      await mirrorLegacyStock(tx, {
        businessId: input.businessId,
        warehouseId: receipt.warehouseId,
        productId: line.productId,
        variantId: line.variantId,
        quantityDelta: line.quantity,
        reason: `purchase_receipt:${receipt.id}`,
        notes: receipt.supplierName,
        performedBy: input.actor.id,
      });
      balanceByKey.set(key, {
        ...balance,
        onHandQuantity: next.quantity,
        inventoryValue: next.inventoryValue,
        movingAverageCost: next.movingAverageCost,
        version: balance.version + 1,
      });
    }
    await tx.update(purchaseReceipts).set({ status: "approved", approvedBy: input.actor.id, approvedAt: new Date() })
      .where(eq(purchaseReceipts.id, receipt.id));
    return { eventId, duplicate: false };
  });
}

/**
 * Cancel a Purchase Receipt without erasing what it did.
 *
 * A draft or a pending receipt never touched stock, so voiding it is a status change and
 * nothing more. An approved one has already moved quantity and value, so the only honest
 * cancellation is an equal and opposite posting: a second business event, a reversing
 * inventory_transactions row per line, and the matching reversal of the operational
 * counters. Nothing is deleted — `purchase-receipt:{id}:approved` and its transactions stay
 * exactly where they are, and the audit reads forwards as receive-then-reverse.
 *
 * The reversal leaves at the CURRENT weighted average rather than at the price the goods
 * came in at. That is what applyStockOut does for every other outbound movement in this
 * system and reversing that choice here would be a second costing method by the back door.
 *
 * Refusing rather than going negative is deliberate: the closing refuses to run against a
 * negative balance, so a void that pushed one below zero would trade a wrong receipt for a
 * blocked month-end.
 */
export async function voidPurchaseReceipt(input: {
  businessId: number;
  receiptId: number;
  reason: string;
  actor: Actor;
}) {
  if (!input.reason.trim()) throw new Error("إلغاء إذن الاستلام يتطلب سببًا موثقًا");
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [receipt] = await tx.select().from(purchaseReceipts).where(and(
      eq(purchaseReceipts.id, input.receiptId), eq(purchaseReceipts.businessId, input.businessId),
    )).limit(1).for("update");
    if (!receipt) throw new Error("إذن الاستلام خارج نطاق هذا النشاط");
    if (receipt.status === "voided") throw new Error("إذن الاستلام ملغي بالفعل");

    if (receipt.status !== "approved") {
      await tx.update(purchaseReceipts).set({ status: "voided", reason: input.reason })
        .where(eq(purchaseReceipts.id, receipt.id));
      return { reversed: false, eventId: null, duplicate: false };
    }

    const lines = await tx.select().from(purchaseReceiptItems).where(eq(purchaseReceiptItems.receiptId, receipt.id));
    const keys = lines.map((line: typeof purchaseReceiptItems.$inferSelect) => makeInventoryKey(line.productId, line.variantId));
    const balances = await tx.select().from(inventoryBalances).where(and(
      eq(inventoryBalances.businessId, input.businessId),
      eq(inventoryBalances.warehouseId, receipt.warehouseId),
      inArray(inventoryBalances.inventoryKey, keys),
    )).orderBy(asc(inventoryBalances.id)).for("update");
    const balanceByKey = new Map(balances.map((balance: typeof inventoryBalances.$inferSelect) => [balance.inventoryKey, balance]));

    const eventResult = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "inventory.purchase_reversed",
      sourceType: "purchase_receipt",
      sourceReference: String(receipt.id),
      idempotencyKey: `purchase-receipt:${receipt.id}:voided`,
      occurredAt: new Date(),
      payload: { receiptId: receipt.id, reason: input.reason, lines },
      actor: input.actor,
    });
    if (eventResult.duplicate) return { reversed: true, eventId: eventResult.event.id, duplicate: true };
    const eventId = eventResult.event.id;

    for (const line of lines) {
      const key = makeInventoryKey(line.productId, line.variantId);
      const balance: any = balanceByKey.get(key);
      if (!balance) throw new Error(`لا يوجد رصيد مخزون لبند إذن الاستلام #${line.id}`);
      if (line.quantity > balance.onHandQuantity) {
        throw new Error(
          `لا يمكن إلغاء الإذن: الكمية المستلمة (${line.quantity}) أكبر من المتاح حاليًا (${balance.onHandQuantity}) — اتصرف في جزء منها بالفعل`
        );
      }
      const next = applyStockOut({
        quantity: balance.onHandQuantity,
        inventoryValue: balance.inventoryValue,
        movingAverageCost: balance.movingAverageCost,
      }, line.quantity);
      await tx.update(inventoryBalances).set({
        onHandQuantity: next.quantity,
        inventoryValue: next.inventoryValue,
        movingAverageCost: next.movingAverageCost,
        version: balance.version + 1,
      }).where(eq(inventoryBalances.id, balance.id));
      await tx.insert(inventoryTransactions).values({
        businessId: input.businessId,
        businessEventId: eventId,
        inventoryBalanceId: balance.id,
        transactionType: "purchase_reversal",
        quantityDelta: -line.quantity,
        unitCost: next.unitCostSnapshot,
        valueDelta: `-${next.valueOut}`,
        quantityAfter: next.quantity,
        valueAfter: next.inventoryValue,
        averageCostAfter: next.movingAverageCost,
        sourceType: "purchase_receipt_item",
        sourceId: line.id,
        occurredAt: new Date(),
        createdBy: input.actor.id,
        createdByName: input.actor.name,
      });
      await mirrorLegacyStock(tx, {
        businessId: input.businessId,
        warehouseId: receipt.warehouseId,
        productId: line.productId,
        variantId: line.variantId,
        quantityDelta: -line.quantity,
        reason: `purchase_receipt_void:${receipt.id}`,
        notes: input.reason,
        performedBy: input.actor.id,
      });
      balanceByKey.set(key, {
        ...balance,
        onHandQuantity: next.quantity,
        inventoryValue: next.inventoryValue,
        movingAverageCost: next.movingAverageCost,
        version: balance.version + 1,
      });
    }
    await tx.update(purchaseReceipts).set({ status: "voided", reason: input.reason })
      .where(eq(purchaseReceipts.id, receipt.id));
    return { reversed: true, eventId, duplicate: false };
  });
}

/**
 * تحويل مخزون بين مخزنين — وده هو مسار الورشة.
 *
 * الورشة مخزن، مش مورد. إرسال خامات لها = تحويل خارج من مخزن المكتب وداخل للورشة،
 * واستلام المشغول = العكس. الكمية والقيمة بيتنقلوا مع بعض فالإجمالي على مستوى النشاط
 * مابيتغيّرش: **مفيش مخزون بيتخلق من العدم ولا بيتمسح**.
 *
 * الوارد بيدخل بنفس تكلفة الصادر (unitCostSnapshot) مش بتكلفة جديدة، عشان التحويل
 * مايبقاش بابًا خلفيًا لإعادة تسعير المخزون. لو الورشة ضافت شغل على الخامة، ده مصروف
 * أو إذن استلام منفصل — مش رقم بيتحط هنا.
 *
 * الرصيد في المخزن المستقبِل ممكن ما يكونش موجود، فبيتعمل بصفر الأول. إنشاء صف رصيد
 * فاضي مش إنشاء مخزون.
 *
 * العدّاد التشغيلي (`products/product_variants.currentStock`) رقم واحد مالوش بُعد مخزن،
 * فالتحويل بيطلع صافيه صفر — وده صحيح. برضه بنكتب الحركتين في `inventory_movements`
 * عشان تاريخ العهدة يفضل كامل: مين خرج منه، ومين دخل عنده، وإمتى.
 */
export async function transferStock(input: {
  businessId: number;
  fromWarehouseId: number;
  toWarehouseId: number;
  /** رقم إذن التحويل/العهدة — بيمنع الترحيل المكرر لنفس الورقة. */
  reference: string;
  reason: string;
  occurredAt: Date;
  actor: Actor;
  lines: Array<{ productId: number; variantId?: number | null; quantity: number }>;
  /**
   * رقم الإذن اللي التحويل ده بيقفله — بيتحط على تحويل الرجوع فبيربطه بإذن الإرسال.
   *
   * ده اللي بيخلّي حالة المرتجع (عند الورشة / رجع) **مشتقّة** بدل ما تبقى عمود حالة
   * محتاج يفضل متزامن مع الحركات. الحركة هي الحقيقة، والحالة قراءة ليها.
   */
  linkedReference?: string;
  /**
   * تكلفة إصلاح القطعة، لو متعرفة وقت الإرسال.
   *
   * **مابتعملش مصروف ولا بتلمس خزنة.** رقم للعلم بيتخزّن مع الحدث، والمصروف بيتسجّل
   * لوحده لما الورشة تتحاسب فعلًا — عشان مانسجّلش مصروف لحاجة لسه ماتدفعتش.
   */
  repairCostPerPiece?: string;
}) {
  if (input.fromWarehouseId === input.toWarehouseId)
    throw new Error("مكان الإرسال ومكان الاستلام لازم يكونوا مختلفين");
  if (!input.reference.trim()) throw new Error("التحويل يتطلب رقم إذن");
  if (input.lines.length === 0) throw new Error("التحويل يتطلب بند واحد على الأقل");
  if (input.lines.some(line => !Number.isInteger(line.quantity) || line.quantity <= 0))
    throw new Error("كمية كل بند لازم تكون رقم صحيح أكبر من صفر");

  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const keys = input.lines.map(line => makeInventoryKey(line.productId, line.variantId));

    const sourceBalances = await tx.select().from(inventoryBalances).where(and(
      eq(inventoryBalances.businessId, input.businessId),
      eq(inventoryBalances.warehouseId, input.fromWarehouseId),
      inArray(inventoryBalances.inventoryKey, keys),
    )).orderBy(asc(inventoryBalances.id)).for("update");
    const sourceByKey = new Map(
      sourceBalances.map((b: typeof inventoryBalances.$inferSelect) => [b.inventoryKey, b])
    );

    // صف رصيد فاضي في المخزن المستقبِل لو مش موجود — مش مخزون، صف بصفر.
    for (const line of input.lines) {
      const key = makeInventoryKey(line.productId, line.variantId);
      const [existing] = await tx.select().from(inventoryBalances).where(and(
        eq(inventoryBalances.businessId, input.businessId),
        eq(inventoryBalances.warehouseId, input.toWarehouseId),
        eq(inventoryBalances.inventoryKey, key),
      )).limit(1);
      if (!existing) await tx.insert(inventoryBalances).values({
        businessId: input.businessId,
        warehouseId: input.toWarehouseId,
        productId: line.productId,
        variantId: line.variantId ?? null,
        inventoryKey: key,
      });
    }
    const targetBalances = await tx.select().from(inventoryBalances).where(and(
      eq(inventoryBalances.businessId, input.businessId),
      eq(inventoryBalances.warehouseId, input.toWarehouseId),
      inArray(inventoryBalances.inventoryKey, keys),
    )).orderBy(asc(inventoryBalances.id)).for("update");
    const targetByKey = new Map(
      targetBalances.map((b: typeof inventoryBalances.$inferSelect) => [b.inventoryKey, b])
    );

    const eventResult = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "inventory.stock_transfer",
      sourceType: "stock_transfer",
      sourceReference: input.reference,
      idempotencyKey: `stock-transfer:${input.businessId}:${input.reference}`,
      occurredAt: input.occurredAt,
      payload: {
        fromWarehouseId: input.fromWarehouseId,
        toWarehouseId: input.toWarehouseId,
        reason: input.reason,
        lines: input.lines,
        linkedReference: input.linkedReference ?? null,
        repairCostPerPiece: input.repairCostPerPiece ?? null,
      },
      actor: input.actor,
    });
    if (eventResult.duplicate) return { eventId: eventResult.event.id, duplicate: true };
    const eventId = eventResult.event.id;

    for (const line of input.lines) {
      const key = makeInventoryKey(line.productId, line.variantId);
      const source: any = sourceByKey.get(key);
      const target: any = targetByKey.get(key);
      if (!source)
        throw new Error(`مفيش رصيد للصنف ده في مكان الإرسال — البند رقم ${line.productId}`);
      if (line.quantity > source.onHandQuantity)
        throw new Error(
          `الكمية المطلوب تحويلها (${line.quantity}) أكبر من المتاح في مكان الإرسال (${source.onHandQuantity})`
        );

      const out = applyStockOut({
        quantity: source.onHandQuantity,
        inventoryValue: source.inventoryValue,
        movingAverageCost: source.movingAverageCost,
      }, line.quantity);
      // الوارد بنفس تكلفة الصادر — القيمة بتتنقل، مابتتخلقش.
      const inn = applyStockIn({
        quantity: target.onHandQuantity,
        inventoryValue: target.inventoryValue,
        movingAverageCost: target.movingAverageCost,
      }, line.quantity, out.unitCostSnapshot);

      await tx.update(inventoryBalances).set({
        onHandQuantity: out.quantity,
        inventoryValue: out.inventoryValue,
        movingAverageCost: out.movingAverageCost,
        version: source.version + 1,
      }).where(eq(inventoryBalances.id, source.id));
      await tx.update(inventoryBalances).set({
        onHandQuantity: inn.quantity,
        inventoryValue: inn.inventoryValue,
        movingAverageCost: inn.movingAverageCost,
        version: target.version + 1,
      }).where(eq(inventoryBalances.id, target.id));

      await tx.insert(inventoryTransactions).values({
        businessId: input.businessId,
        businessEventId: eventId,
        inventoryBalanceId: source.id,
        transactionType: "transfer_out",
        quantityDelta: -line.quantity,
        unitCost: out.unitCostSnapshot,
        valueDelta: `-${out.valueOut}`,
        quantityAfter: out.quantity,
        valueAfter: out.inventoryValue,
        averageCostAfter: out.movingAverageCost,
        sourceType: "stock_transfer",
        sourceId: null,
        occurredAt: input.occurredAt,
        createdBy: input.actor.id,
        createdByName: input.actor.name,
      });
      await tx.insert(inventoryTransactions).values({
        businessId: input.businessId,
        businessEventId: eventId,
        inventoryBalanceId: target.id,
        transactionType: "transfer_in",
        quantityDelta: line.quantity,
        unitCost: out.unitCostSnapshot,
        valueDelta: out.valueOut,
        quantityAfter: inn.quantity,
        valueAfter: inn.inventoryValue,
        averageCostAfter: inn.movingAverageCost,
        sourceType: "stock_transfer",
        sourceId: null,
        occurredAt: input.occurredAt,
        createdBy: input.actor.id,
        createdByName: input.actor.name,
      });

      // الحركتين في الدفتر التشغيلي: صافيهم صفر على العدّاد، وتاريخ العهدة بيفضل كامل.
      await mirrorLegacyStock(tx, {
        businessId: input.businessId,
        warehouseId: input.fromWarehouseId,
        productId: line.productId,
        variantId: line.variantId ?? null,
        quantityDelta: -line.quantity,
        reason: `stock_transfer_out:${input.reference}`,
        notes: input.reason,
        performedBy: input.actor.id,
      });
      await mirrorLegacyStock(tx, {
        businessId: input.businessId,
        warehouseId: input.toWarehouseId,
        productId: line.productId,
        variantId: line.variantId ?? null,
        quantityDelta: line.quantity,
        reason: `stock_transfer_in:${input.reference}`,
        notes: input.reason,
        performedBy: input.actor.id,
      });

      sourceByKey.set(key, { ...source, onHandQuantity: out.quantity, inventoryValue: out.inventoryValue, movingAverageCost: out.movingAverageCost, version: source.version + 1 });
      targetByKey.set(key, { ...target, onHandQuantity: inn.quantity, inventoryValue: inn.inventoryValue, movingAverageCost: inn.movingAverageCost, version: target.version + 1 });
    }
    return { eventId, duplicate: false };
  });
}

/**
 * دفعات المرتجع للورشة وحالتها.
 *
 * مفيش جدول مرتجعات ومفيش عمود حالة. الدفعة هي تحويل **للورشة**، وبترجع لما يتعمل تحويل
 * **من** الورشة بيحمل رقمها في `linkedReference`. فالحالة **مشتقّة من الحركات**، وده
 * أهم من إنها تبقى محفوظة: عمود حالة ينفع يبقى غلط ويقول «رجعت» والمخزون بيقول غير كده،
 * أما الاشتقاق فمستحيل يختلف عن الحركة اللي هو مبني عليها.
 *
 * التاريخ كامل بحكم التصميم — الحدثين الاتنين بيفضلوا في `business_events` ومعاهم حركات
 * المخزون بتاعتهم، ومفيش حاجة بتتمسح ولا بتتعدّل.
 */
export async function listWorkshopReturns(input: {
  businessId: number;
  /** مخزن الورشة — اللي بيتحوّل ليه ومنه. */
  workshopWarehouseId: number;
  limit?: number;
}) {
  const db = await getDb();
  if (!db) return [];

  const events = await db
    .select()
    .from(businessEvents)
    .where(and(
      eq(businessEvents.businessId, input.businessId),
      eq(businessEvents.eventType, "inventory.stock_transfer"),
      eq(businessEvents.status, "active" as any),
    ))
    .orderBy(desc(businessEvents.occurredAt), desc(businessEvents.id))
    .limit(input.limit ?? 200);

  type Payload = {
    fromWarehouseId: number;
    toWarehouseId: number;
    reason?: string;
    lines?: Array<{ productId: number; variantId?: number | null; quantity: number }>;
    linkedReference?: string | null;
    repairCostPerPiece?: string | null;
  };

  const parsed = events.map(e => {
    let payload: Payload | null = null;
    // بيانات حدث قديم أو مشوّهة ماتوقعش الصفحة — الصف بيتتجاهل وبس.
    try { payload = JSON.parse(e.payloadJson) as Payload; } catch { payload = null; }
    return { event: e, payload };
  }).filter((r): r is { event: typeof events[number]; payload: Payload } => r.payload != null);

  // اللي رجع: أي تحويل طالع من الورشة وبيشاور على إذن إرسال
  const closedBy = new Map<string, { at: Date; reference: string }>();
  for (const { event, payload } of parsed) {
    if (payload.fromWarehouseId !== input.workshopWarehouseId) continue;
    if (!payload.linkedReference) continue;
    closedBy.set(payload.linkedReference, {
      at: event.occurredAt,
      reference: event.sourceReference,
    });
  }

  // الدفعات: أي تحويل داخل للورشة
  return parsed
    .filter(({ payload }) => payload.toWarehouseId === input.workshopWarehouseId)
    .map(({ event, payload }) => {
      const closed = closedBy.get(event.sourceReference);
      const quantity = (payload.lines ?? []).reduce((s, l) => s + (l.quantity || 0), 0);
      const perPiece = Number(payload.repairCostPerPiece ?? 0) || 0;
      return {
        reference: event.sourceReference,
        sentAt: event.occurredAt,
        reason: payload.reason ?? "",
        lines: payload.lines ?? [],
        quantity,
        repairCostPerPiece: perPiece,
        repairCostTotal: Number((perPiece * quantity).toFixed(2)),
        status: closed ? ("received" as const) : ("at_workshop" as const),
        receivedAt: closed?.at ?? null,
        receivedReference: closed?.reference ?? null,
      };
    });
}

export async function submitReturnInspection(input: {
  businessId: number;
  inspectionId: number;
  receivedAt: Date;
  notes?: string;
  actor: Actor;
  items: Array<{
    orderItemId: number;
    quantity: number;
    disposition: "restock" | "scrap" | "missing";
    reason?: string;
  }>;
}) {
  if (input.items.length === 0) throw new Error("Return inspection requires at least one item");
  if (input.items.some(item => !Number.isInteger(item.quantity) || item.quantity <= 0)) {
    throw new Error("Return inspection quantities must be positive integers");
  }
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [inspection] = await tx.select().from(returnInspections).where(and(
      eq(returnInspections.id, input.inspectionId),
      eq(returnInspections.businessId, input.businessId),
    )).limit(1).for("update");
    if (!inspection) throw new Error("Return inspection is outside this business");
    if (inspection.status !== "pending") throw new Error("Only a pending return inspection can be submitted");
    const requestedIds = input.items.map(item => item.orderItemId);
    if (new Set(requestedIds).size !== requestedIds.length) throw new Error("Each Order Item may appear only once per inspection");
    const orderItemRows = await tx.select().from(orderItems).where(and(
      eq(orderItems.orderId, inspection.orderId),
      inArray(orderItems.id, requestedIds),
    )).for("update");
    if (orderItemRows.length !== requestedIds.length) throw new Error("Return inspection contains an Order Item outside this order");
    const itemById = new Map(orderItemRows.map(item => [item.id, item]));

    const orderInspections = await tx.select({ id: returnInspections.id }).from(returnInspections).where(and(
      eq(returnInspections.businessId, input.businessId),
      eq(returnInspections.orderId, inspection.orderId),
    ));
    const otherInspectionIds = orderInspections.map(row => row.id).filter(id => id !== inspection.id);
    const existingLines = otherInspectionIds.length > 0
      ? await tx.select().from(returnInspectionItems).where(inArray(returnInspectionItems.inspectionId, otherInspectionIds))
      : [];
    const alreadyInspected = new Map<number, number>();
    for (const line of existingLines) {
      alreadyInspected.set(line.orderItemId, (alreadyInspected.get(line.orderItemId) ?? 0) + line.quantity);
    }

    for (const requested of input.items) {
      const item = itemById.get(requested.orderItemId)!;
      const remaining = item.returnedQuantity - (alreadyInspected.get(item.id) ?? 0);
      if (requested.quantity > remaining) throw new Error(`Inspection quantity exceeds returned quantity for Order Item #${item.id}`);
      if (item.unitCostSnapshot == null) throw new Error(`Order Item #${item.id} has no original cost snapshot`);
      if (requested.disposition !== "restock" && !requested.reason?.trim()) {
        throw new Error("Scrap or missing disposition requires a reason");
      }
      await tx.insert(returnInspectionItems).values({
        inspectionId: inspection.id,
        businessId: input.businessId,
        orderItemId: item.id,
        quantity: requested.quantity,
        unitCostSnapshot: item.unitCostSnapshot,
        disposition: requested.disposition,
        reason: requested.reason?.trim() || null,
      });
    }
    await tx.update(returnInspections).set({
      status: "pending_approval",
      receivedAt: input.receivedAt,
      inspectedBy: input.actor.id,
      notes: input.notes?.trim() || null,
    }).where(eq(returnInspections.id, inspection.id));
    return { inspectionId: inspection.id, inspectedItems: input.items.length };
  });
}

export async function approveReturnInspection(input: {
  businessId: number;
  inspectionId: number;
  warehouseId: number;
  occurredAt: Date;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [inspection] = await tx.select().from(returnInspections).where(and(
      eq(returnInspections.id, input.inspectionId),
      eq(returnInspections.businessId, input.businessId),
    )).limit(1).for("update");
    if (!inspection) throw new Error("Return inspection is outside this business");
    if (inspection.status !== "pending_approval") throw new Error("Only a pending return inspection can be approved");
    if (inspection.inspectedBy === input.actor.id) throw new Error("Maker cannot approve their own return inspection");
    const lines = await tx.select().from(returnInspectionItems).where(and(
      eq(returnInspectionItems.inspectionId, inspection.id),
      eq(returnInspectionItems.businessId, input.businessId),
    )).orderBy(asc(returnInspectionItems.id));
    if (lines.length === 0) throw new Error("Return inspection has no items");
    const itemRows = await tx.select().from(orderItems).where(inArray(
      orderItems.id, lines.map(line => line.orderItemId),
    ));
    const itemById = new Map(itemRows.map(item => [item.id, item]));
    if (itemRows.length !== new Set(lines.map(line => line.orderItemId)).size) throw new Error("Return inspection references missing Order Items");
    const restockLines = lines.filter(line => line.disposition === "restock");
    const restockKeys = restockLines.map(line => {
      const item = itemById.get(line.orderItemId)!;
      if (item.productId == null) throw new Error(`Order Item #${item.id} has no inventory product`);
      return makeInventoryKey(item.productId, item.variantId);
    });
    const balances = restockKeys.length > 0 ? await tx.select().from(inventoryBalances).where(and(
      eq(inventoryBalances.businessId, input.businessId),
      eq(inventoryBalances.warehouseId, input.warehouseId),
      inArray(inventoryBalances.inventoryKey, restockKeys),
    )).orderBy(asc(inventoryBalances.id)).for("update") : [];
    const balanceByKey = new Map(balances.map(balance => [balance.inventoryKey, balance]));
    if (balances.length !== new Set(restockKeys).size) throw new Error("Opening inventory is missing for a returned item");

    const eventResult = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "inventory.return_inspected",
      sourceType: "return_inspection",
      sourceReference: String(inspection.id),
      idempotencyKey: `return-inspection:${inspection.id}:approved`,
      occurredAt: input.occurredAt,
      payload: {
        inspectionId: inspection.id,
        orderId: inspection.orderId,
        items: lines.map(line => ({
          orderItemId: line.orderItemId,
          quantity: line.quantity,
          unitCostSnapshot: line.unitCostSnapshot,
          disposition: line.disposition,
          reason: line.reason,
        })),
      },
      actor: input.actor,
    });
    if (eventResult.duplicate) return { eventId: eventResult.event.id, duplicate: true };

    for (const line of restockLines) {
      const item = itemById.get(line.orderItemId)!;
      const key = makeInventoryKey(item.productId!, item.variantId);
      const balance = balanceByKey.get(key)!;
      const next = applyStockIn({
        quantity: balance.onHandQuantity,
        inventoryValue: balance.inventoryValue,
        movingAverageCost: balance.movingAverageCost,
      }, line.quantity, line.unitCostSnapshot);
      await tx.update(inventoryBalances).set({
        onHandQuantity: next.quantity,
        inventoryValue: next.inventoryValue,
        movingAverageCost: next.movingAverageCost,
        version: balance.version + 1,
      }).where(eq(inventoryBalances.id, balance.id));
      await tx.insert(inventoryTransactions).values({
        businessId: input.businessId,
        businessEventId: eventResult.event.id,
        inventoryBalanceId: balance.id,
        transactionType: "return_restock",
        quantityDelta: line.quantity,
        unitCost: line.unitCostSnapshot,
        valueDelta: fromMinorUnits(toMinorUnits(line.unitCostSnapshot) * BigInt(line.quantity)),
        quantityAfter: next.quantity,
        valueAfter: next.inventoryValue,
        averageCostAfter: next.movingAverageCost,
        sourceType: "return_inspection_item",
        sourceId: line.id,
        occurredAt: input.occurredAt,
        createdBy: input.actor.id,
        createdByName: input.actor.name,
      });
      balanceByKey.set(key, {
        ...balance,
        onHandQuantity: next.quantity,
        inventoryValue: next.inventoryValue,
        movingAverageCost: next.movingAverageCost,
        version: balance.version + 1,
      });
    }
    await tx.update(returnInspections).set({
      status: "approved",
      approvedBy: input.actor.id,
      approvedAt: input.occurredAt,
    }).where(eq(returnInspections.id, inspection.id));
    return { eventId: eventResult.event.id, duplicate: false };
  });
}

// ==================== مرتجعات الورشة — تحديد المخازن تلقائيًا ====================
//
// المكتب = businesses.defaultWarehouseId. الورشة = businesses.workshopWarehouseId.
// الصفحة مابتخلّيش المستخدم يختار مخزنين — بتحلّهم من هنا. الإرسال/الاستلام بيمرّوا على
// نفس `transferStock` (مفيش منطق مخزون مكرر)، ورقم الإذن بيتولّد تلقائيًا.

/** توليد رقم إذن ورشة فريد — المستخدم مابيكتبوش. */
function generateWorkshopReference(): string {
  const rand = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return `WS-${Date.now()}-${rand}`;
}

export type WorkshopSetup = {
  officeWarehouseId: number | null;
  workshopWarehouseId: number | null;
  /** محتاج تحديد مخزن الورشة (أو المكتب) قبل ما الصفحة تشتغل. */
  needsSetup: boolean;
  warehouses: Array<{ id: number; name: string; isActive: boolean }>;
};

/** إعداد الورشة للنشاط: المكتب + الورشة + قايمة المخازن، وهل محتاج تحديد. */
export async function getWorkshopSetup(businessId: number): Promise<WorkshopSetup> {
  const business = await getBusinessById(businessId);
  const list = await getWarehousesByBusiness(businessId);
  const officeWarehouseId = business?.defaultWarehouseId ?? null;
  const workshopWarehouseId = (business as any)?.workshopWarehouseId ?? null;
  const activeIds = new Set(list.filter(w => w.isActive).map(w => w.id));
  // محتاج إعداد لو أي مخزن مش متحدّد، أو بيشاور على مخزن مش موجود/مؤرشف.
  const needsSetup =
    officeWarehouseId == null ||
    workshopWarehouseId == null ||
    !activeIds.has(officeWarehouseId) ||
    !activeIds.has(workshopWarehouseId) ||
    officeWarehouseId === workshopWarehouseId;
  return {
    officeWarehouseId,
    workshopWarehouseId,
    needsSetup,
    warehouses: list.map(w => ({ id: w.id, name: w.name, isActive: w.isActive })),
  };
}

/**
 * تحديد مخزن الورشة — مرة واحدة. يا بياخد مخزن موجود، يا بينشئ واحد جديد باسم.
 * لازم يكون غير مخزن المكتب. (المكتب نفسه بيتحدد من إعدادات النشاط زي ما هو.)
 */
export async function setWorkshopWarehouse(input: {
  businessId: number;
  /** مخزن موجود يتحدد كورشة. */
  warehouseId?: number;
  /** أو اسم مخزن ورشة جديد يتعمل. */
  newWarehouseName?: string;
}): Promise<{ workshopWarehouseId: number }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const business = await getBusinessById(input.businessId);
  const officeWarehouseId = business?.defaultWarehouseId ?? null;

  let workshopWarehouseId: number;
  if (input.newWarehouseName && input.newWarehouseName.trim()) {
    const created = await createWarehouse({
      businessId: input.businessId,
      name: input.newWarehouseName.trim(),
    } as any);
    workshopWarehouseId = (created as any).id ?? (created as any).insertId;
    if (!workshopWarehouseId) throw new Error("تعذّر إنشاء مخزن الورشة");
  } else if (input.warehouseId != null) {
    const list = await getWarehousesByBusiness(input.businessId);
    const target = list.find(w => w.id === input.warehouseId && w.isActive);
    if (!target) throw new Error("المخزن مش تابع للنشاط أو مش نشط");
    workshopWarehouseId = input.warehouseId;
  } else {
    throw new Error("حدّد مخزن ورشة موجود أو اسم لمخزن جديد");
  }

  if (officeWarehouseId != null && workshopWarehouseId === officeWarehouseId)
    throw new Error("مخزن الورشة لازم يكون غير مخزن المكتب");

  await db
    .update(businesses)
    .set({ workshopWarehouseId })
    .where(eq(businesses.id, input.businessId));
  return { workshopWarehouseId };
}

/** يحلّ المكتب + الورشة، ويرمي لو الإعداد ناقص. */
async function resolveWorkshopWarehouses(
  businessId: number
): Promise<{ officeWarehouseId: number; workshopWarehouseId: number }> {
  const setup = await getWorkshopSetup(businessId);
  if (
    setup.officeWarehouseId == null ||
    setup.workshopWarehouseId == null ||
    setup.needsSetup
  )
    throw new Error("لازم تحدّد مخزن الورشة الأول من إعداد الصفحة");
  return {
    officeWarehouseId: setup.officeWarehouseId,
    workshopWarehouseId: setup.workshopWarehouseId,
  };
}

/** إرسال قطع للورشة — تحويل من المكتب للورشة برقم إذن مولّد. */
export async function sendToWorkshop(input: {
  businessId: number;
  reason: string;
  occurredAt: Date;
  repairCostPerPiece?: string;
  lines: Array<{ productId: number; variantId?: number | null; quantity: number }>;
  actor: Actor;
}) {
  const { officeWarehouseId, workshopWarehouseId } =
    await resolveWorkshopWarehouses(input.businessId);
  const reference = generateWorkshopReference();
  const result = await transferStock({
    businessId: input.businessId,
    fromWarehouseId: officeWarehouseId,
    toWarehouseId: workshopWarehouseId,
    reference,
    reason: input.reason,
    occurredAt: input.occurredAt,
    repairCostPerPiece: input.repairCostPerPiece,
    lines: input.lines,
    actor: input.actor,
  });
  return { ...result, reference };
}

/** استلام دفعة من الورشة — تحويل من الورشة للمكتب، مربوط بإذن الإرسال. */
export async function receiveFromWorkshop(input: {
  businessId: number;
  /** رقم إذن الإرسال اللي بيتقفل. */
  sendReference: string;
  reason: string;
  occurredAt: Date;
  repairCostPerPiece?: string;
  lines: Array<{ productId: number; variantId?: number | null; quantity: number }>;
  actor: Actor;
}) {
  const { officeWarehouseId, workshopWarehouseId } =
    await resolveWorkshopWarehouses(input.businessId);
  const reference = `${input.sendReference}-R`;
  const result = await transferStock({
    businessId: input.businessId,
    fromWarehouseId: workshopWarehouseId,
    toWarehouseId: officeWarehouseId,
    reference,
    reason: input.reason || `استلام المشغول — ${input.sendReference}`,
    occurredAt: input.occurredAt,
    linkedReference: input.sendReference,
    repairCostPerPiece: input.repairCostPerPiece,
    lines: input.lines,
    actor: input.actor,
  });
  return { ...result, reference };
}

/** دفعات الورشة — نفس listWorkshopReturns بس بيحلّ مخزن الورشة تلقائيًا. */
export async function listWorkshopBatches(input: {
  businessId: number;
  limit?: number;
}) {
  const { workshopWarehouseId } = await resolveWorkshopWarehouses(input.businessId);
  return listWorkshopReturns({
    businessId: input.businessId,
    workshopWarehouseId,
    limit: input.limit,
  });
}
