import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  businessEvents,
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
} from "../drizzle/schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { applyStockIn, applyStockOut } from "../shared/inventoryCosting";
import { getDb } from "./db";
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
async function mirrorLegacyStock(
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
  evidenceUrl: string;
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
      evidenceUrl: input.evidenceUrl,
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

export async function approvePurchaseReceipt(input: { businessId: number; receiptId: number; actor: Actor }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [receipt] = await tx.select().from(purchaseReceipts).where(and(
      eq(purchaseReceipts.id, input.receiptId), eq(purchaseReceipts.businessId, input.businessId),
    )).limit(1).for("update");
    if (!receipt) throw new Error("Purchase Receipt is outside this business");
    if (receipt.status !== "pending_approval") throw new Error("Only a pending Purchase Receipt can be approved");
    if (receipt.createdBy === input.actor.id) throw new Error("Maker cannot approve their own Purchase Receipt");
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
