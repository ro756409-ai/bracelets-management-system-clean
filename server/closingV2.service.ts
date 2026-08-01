import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import {
  accountingClosingActions,
  accountingClosingAdjustments,
  accountingClosingLines,
  accountingClosings,
  businessEvents,
  businesses,
  carrierSettlementLines,
  carrierSettlements,
  financialTransactionEntries,
  financialAccounts,
  financialTransactions,
  inventoryBalances,
  inventoryTransactions,
  orderItems,
  orders,
  returnInspections,
} from "../drizzle/schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { assertContinuousPeriod, nextClosingStatus, type ClosingStatus } from "../shared/closingWorkflow";
import { stableJson, type Actor } from "./accountingV2.service";
import { getDb } from "./db";

type ClosingPeriodType = "daily" | "weekly" | "monthly" | "custom";

type SnapshotLine = {
  lineType: string;
  amount: string;
  quantity?: number;
  snapshot: Record<string, unknown>;
};

function parsePayload(payloadJson: string): Record<string, unknown> {
  const parsed = JSON.parse(payloadJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Business Event payload must be an object");
  return parsed as Record<string, unknown>;
}

function amount(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`Business Event is missing amount: ${key}`);
  return fromMinorUnits(toMinorUnits(value));
}

function eventLines(eventType: string, payload: Record<string, unknown>): SnapshotLine[] {
  switch (eventType) {
    case "shipment.delivered":
      return [
        { lineType: "revenue", amount: amount(payload, "revenue"), snapshot: payload },
        { lineType: "cogs", amount: amount(payload, "cogs"), snapshot: payload },
        { lineType: "carrier_receivable", amount: amount(payload, "collectedAmount"), snapshot: payload },
      ];
    case "shipment.returned":
    case "shipment.partial_return":
      return [
        { lineType: "revenue_return", amount: amount(payload, "revenueReversal"), snapshot: payload },
        { lineType: "returns_pending_inspection", amount: amount(payload, "returnsPendingInspection"), snapshot: payload },
      ];
    case "shipping.charge_recognized":
      return [{ lineType: "shipping_expense", amount: amount(payload, "amount"), snapshot: payload }];
    case "shipping.cost_adjustment":
      return [{ lineType: "shipping_adjustment", amount: amount(payload, "amount"), snapshot: payload }];
    case "expense.accrued":
      return [{ lineType: "operating_expense", amount: amount(payload, "amount"), snapshot: payload }];
    case "inventory.return_inspected": {
      const items = Array.isArray(payload.items) ? payload.items as Array<Record<string, unknown>> : [];
      const loss = items.filter(item => item.disposition === "scrap" || item.disposition === "missing")
        .reduce((sum, item) => {
          const quantity = Number(item.quantity ?? 0);
          return sum + toMinorUnits(item.unitCostSnapshot as string) * BigInt(quantity);
        }, 0n);
      return loss === 0n ? [] : [{ lineType: "inventory_loss", amount: fromMinorUnits(loss), snapshot: payload }];
    }
    default:
      return [];
  }
}

function add(total: bigint, value: string): bigint {
  return total + toMinorUnits(value);
}

async function action(tx: any, input: {
  closingId: number;
  businessId: number;
  action: string;
  fromStatus?: string;
  toStatus?: string;
  reason?: string;
  actor: Actor;
}) {
  await tx.insert(accountingClosingActions).values({
    closingId: input.closingId,
    businessId: input.businessId,
    action: input.action,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus ?? null,
    reason: input.reason ?? null,
    performedBy: input.actor.id,
    performedByName: input.actor.name,
  });
}

export async function createClosingDraft(input: {
  businessId: number;
  periodType: ClosingPeriodType;
  periodTo: Date;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [business] = await tx.select().from(businesses).where(eq(businesses.id, input.businessId)).limit(1).for("update");
    if (!business) throw new Error("Business not found");
    if (!business.accountingGoLiveAt) throw new Error("Accounting Go-Live Date must be configured first");
    const [latest] = await tx.select().from(accountingClosings).where(eq(
      accountingClosings.businessId, input.businessId,
    )).orderBy(desc(accountingClosings.sequenceNumber)).limit(1).for("update");
    if (latest && latest.status !== "locked") throw new Error("The previous Accounting Closing must be Locked first");
    const periodFrom = latest?.periodTo ?? business.accountingGoLiveAt;
    assertContinuousPeriod(latest?.periodTo ?? null, periodFrom);
    if (input.periodTo <= periodFrom) throw new Error("Closing period end must be after its start");
    const result: any = await tx.insert(accountingClosings).values({
      businessId: input.businessId,
      sequenceNumber: (latest?.sequenceNumber ?? 0) + 1,
      periodType: input.periodType,
      periodFrom,
      periodTo: input.periodTo,
      currencyCode: business.baseCurrency,
      createdBy: input.actor.id,
      createdByName: input.actor.name,
    });
    const closingId = Number(result?.insertId ?? result?.[0]?.insertId);
    if (!closingId) throw new Error("Could not create Accounting Closing");
    await action(tx, { closingId, businessId: input.businessId, action: "create", toStatus: "draft", actor: input.actor });
    return { closingId, sequenceNumber: (latest?.sequenceNumber ?? 0) + 1, periodFrom };
  });
}

async function buildSnapshot(tx: any, closing: typeof accountingClosings.$inferSelect) {
  const events = await tx.select().from(businessEvents).where(and(
    eq(businessEvents.businessId, closing.businessId),
    eq(businessEvents.status, "active"),
    gte(businessEvents.accountingEffectiveAt, closing.periodFrom),
    lt(businessEvents.accountingEffectiveAt, closing.periodTo),
  )).orderBy(asc(businessEvents.id));
  await tx.delete(accountingClosingLines).where(eq(accountingClosingLines.closingId, closing.id));

  const totals = {
    revenue: 0n,
    revenueReturns: 0n,
    cogs: 0n,
    shippingExpense: 0n,
    operatingExpense: 0n,
    inventoryLoss: 0n,
    carrierReceivable: 0n,
    returnsPendingInspection: 0n,
    postClosingAdjustments: 0,
  };
  for (const event of events) {
    const payload = parsePayload(event.payloadJson);
    for (const line of eventLines(event.eventType, payload)) {
      await tx.insert(accountingClosingLines).values({
        closingId: closing.id,
        businessId: closing.businessId,
        lineType: line.lineType,
        sourceType: "business_event",
        sourceId: event.id,
        sourceReference: `${event.id}:${line.lineType}`,
        occurredAt: event.occurredAt,
        amount: line.amount,
        quantity: line.quantity ?? 0,
        snapshotJson: stableJson({
          eventType: event.eventType,
          accountingEffectiveAt: event.accountingEffectiveAt,
          originalClosingId: event.originalClosingId,
          payload: line.snapshot,
        }),
      });
      if (line.lineType === "revenue") totals.revenue = add(totals.revenue, line.amount);
      if (line.lineType === "revenue_return") totals.revenueReturns = add(totals.revenueReturns, line.amount);
      if (line.lineType === "cogs") totals.cogs = add(totals.cogs, line.amount);
      if (line.lineType === "shipping_expense" || line.lineType === "shipping_adjustment") totals.shippingExpense = add(totals.shippingExpense, line.amount);
      if (line.lineType === "operating_expense") totals.operatingExpense = add(totals.operatingExpense, line.amount);
      if (line.lineType === "inventory_loss") totals.inventoryLoss = add(totals.inventoryLoss, line.amount);
      if (line.lineType === "carrier_receivable") totals.carrierReceivable = add(totals.carrierReceivable, line.amount);
      if (line.lineType === "returns_pending_inspection") totals.returnsPendingInspection = add(totals.returnsPendingInspection, line.amount);
    }
    if (event.isPostClosingAdjustment) totals.postClosingAdjustments += 1;
  }
  const netSales = totals.revenue - totals.revenueReturns;
  const grossProfit = netSales - totals.cogs;
  const netProfit = grossProfit - totals.shippingExpense - totals.operatingExpense - totals.inventoryLoss;

  const [cashFlowRow] = await tx.select({
    amount: sql<string>`COALESCE(SUM(CASE WHEN ${financialTransactionEntries.direction} = 'in' THEN ${financialTransactionEntries.amount} ELSE -${financialTransactionEntries.amount} END), 0)`,
  }).from(financialTransactionEntries).innerJoin(
    financialTransactions, eq(financialTransactions.id, financialTransactionEntries.transactionId),
  ).innerJoin(
    financialAccounts, eq(financialAccounts.id, financialTransactionEntries.accountId),
  ).where(and(
    eq(financialTransactionEntries.businessId, closing.businessId),
    eq(financialTransactions.status, "posted"),
    eq(financialAccounts.isCashEquivalent, true),
    gte(financialTransactions.occurredAt, closing.periodFrom),
    lt(financialTransactions.occurredAt, closing.periodTo),
  ));

  const [orderStats] = await tx.select({
    totalOrders: sql<number>`COUNT(*)`,
    confirmed: sql<number>`SUM(CASE WHEN ${orders.confirmedAt} >= ${closing.periodFrom} AND ${orders.confirmedAt} < ${closing.periodTo} THEN 1 ELSE 0 END)`,
    shipped: sql<number>`SUM(CASE WHEN ${orders.shippedAt} >= ${closing.periodFrom} AND ${orders.shippedAt} < ${closing.periodTo} THEN 1 ELSE 0 END)`,
    delivered: sql<number>`SUM(CASE WHEN ${orders.deliveredAt} >= ${closing.periodFrom} AND ${orders.deliveredAt} < ${closing.periodTo} THEN 1 ELSE 0 END)`,
    cancelled: sql<number>`SUM(CASE WHEN ${orders.cancelledAt} >= ${closing.periodFrom} AND ${orders.cancelledAt} < ${closing.periodTo} THEN 1 ELSE 0 END)`,
  }).from(orders).where(and(
    eq(orders.businessId, closing.businessId),
    gte(orders.createdAt, closing.periodFrom),
    lt(orders.createdAt, closing.periodTo),
  ));

  const serializedTotals = {
    grossSales: fromMinorUnits(totals.revenue),
    returns: fromMinorUnits(totals.revenueReturns),
    netSales: fromMinorUnits(netSales),
    cogs: fromMinorUnits(totals.cogs),
    grossProfit: fromMinorUnits(grossProfit),
    shippingExpense: fromMinorUnits(totals.shippingExpense),
    operatingExpense: fromMinorUnits(totals.operatingExpense),
    inventoryLoss: fromMinorUnits(totals.inventoryLoss),
    netProfit: fromMinorUnits(netProfit),
    cashFlow: fromMinorUnits(toMinorUnits(cashFlowRow?.amount ?? "0")),
    carrierReceivable: fromMinorUnits(totals.carrierReceivable),
    returnsPendingInspection: fromMinorUnits(totals.returnsPendingInspection),
    postClosingAdjustments: totals.postClosingAdjustments,
    operational: orderStats ?? { totalOrders: 0, confirmed: 0, shipped: 0, delivered: 0, cancelled: 0 },
  };
  return { totals: serializedTotals, watermark: events.at(-1)?.id ?? 0 };
}

export async function submitClosing(input: { businessId: number; closingId: number; actor: Actor }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [closing] = await tx.select().from(accountingClosings).where(and(
      eq(accountingClosings.id, input.closingId), eq(accountingClosings.businessId, input.businessId),
    )).limit(1).for("update");
    if (!closing) throw new Error("Accounting Closing is outside this business");
    const refreshedStatus = closing.status === "pending_approval"
      ? nextClosingStatus({ status: closing.status, action: "refresh" })
      : closing.status;
    const next = nextClosingStatus({ status: refreshedStatus as ClosingStatus, action: "submit" });
    const snapshot = await buildSnapshot(tx, closing);
    await tx.update(accountingClosings).set({
      status: next,
      snapshotVersion: closing.snapshotVersion + 1,
      snapshotGeneratedAt: new Date(),
      snapshotSourceWatermark: snapshot.watermark,
      isStale: false,
      totalsJson: stableJson(snapshot.totals),
      submittedBy: input.actor.id,
      submittedAt: new Date(),
    }).where(eq(accountingClosings.id, closing.id));
    await action(tx, {
      closingId: closing.id,
      businessId: input.businessId,
      action: closing.status === "pending_approval" ? "refresh_and_submit" : "submit",
      fromStatus: closing.status,
      toStatus: next,
      actor: input.actor,
    });
    return { status: next, snapshotVersion: closing.snapshotVersion + 1, totals: snapshot.totals };
  });
}

async function dataQualityBlockers(tx: any, closing: typeof accountingClosings.$inferSelect): Promise<string[]> {
  const blockers: string[] = [];
  const [latestEvent] = await tx.select({ id: businessEvents.id }).from(businessEvents).where(and(
    eq(businessEvents.businessId, closing.businessId),
    eq(businessEvents.status, "active"),
    gte(businessEvents.accountingEffectiveAt, closing.periodFrom),
    lt(businessEvents.accountingEffectiveAt, closing.periodTo),
  )).orderBy(desc(businessEvents.id)).limit(1);
  if ((latestEvent?.id ?? 0) !== (closing.snapshotSourceWatermark ?? 0)) blockers.push("closing_snapshot_is_stale");

  const [negativeOverride] = await tx.select({ id: inventoryTransactions.id }).from(inventoryTransactions).where(and(
    eq(inventoryTransactions.businessId, closing.businessId),
    eq(inventoryTransactions.transactionType, "stock_out_owner_override"),
    gte(inventoryTransactions.occurredAt, closing.periodFrom),
    lt(inventoryTransactions.occurredAt, closing.periodTo),
  )).limit(1);
  if (negativeOverride) blockers.push("negative_inventory_owner_override_requires_review");

  const [negativeBalance] = await tx.select({ id: inventoryBalances.id }).from(inventoryBalances).where(and(
    eq(inventoryBalances.businessId, closing.businessId),
    lt(inventoryBalances.onHandQuantity, 0),
  )).limit(1);
  if (negativeBalance) blockers.push("negative_inventory_balance");

  const [missingCostSnapshot] = await tx.select({ id: orderItems.id }).from(orderItems).innerJoin(
    orders, eq(orders.id, orderItems.orderId),
  ).where(and(
    eq(orders.businessId, closing.businessId),
    gte(orders.shippedAt, closing.periodFrom),
    lt(orders.shippedAt, closing.periodTo),
    sql`(${orderItems.stockOutQuantity} != ${orderItems.quantity} OR ${orderItems.unitCostSnapshot} IS NULL)`,
  )).limit(1);
  if (missingCostSnapshot) blockers.push("shipped_order_has_incomplete_cost_snapshot");
  const [missingShippingSnapshot] = await tx.select({ id: orders.id }).from(orders)
    .innerJoin(businesses, eq(businesses.id, orders.businessId))
    .where(and(
      eq(orders.businessId, closing.businessId),
      gte(orders.createdAt, closing.periodFrom),
      lt(orders.createdAt, closing.periodTo),
      isNotNull(businesses.accountingGoLiveAt),
      sql`${orders.createdAt} >= ${businesses.accountingGoLiveAt}`,
      isNull(orders.projectedShippingCostSnapshot),
    )).limit(1);
  if (missingShippingSnapshot) blockers.push("order_missing_expected_shipping_snapshot");

  const settlements = await tx.select({ id: carrierSettlements.id }).from(carrierSettlements).where(and(
    eq(carrierSettlements.businessId, closing.businessId),
    gte(carrierSettlements.statementDate, closing.periodFrom),
    lt(carrierSettlements.statementDate, closing.periodTo),
  ));
  if (settlements.length > 0) {
    const [suspense] = await tx.select({ id: carrierSettlementLines.id }).from(carrierSettlementLines).where(and(
      eq(carrierSettlementLines.businessId, closing.businessId),
      inArray(carrierSettlementLines.settlementId, settlements.map((row: { id: number }) => row.id)),
      eq(carrierSettlementLines.matchStatus, "suspense"),
    )).limit(1);
    if (suspense) blockers.push("carrier_settlement_has_suspense_lines");
  }
  return blockers;
}

export async function approveClosing(input: { businessId: number; closingId: number; actor: Actor }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [closing] = await tx.select().from(accountingClosings).where(and(
      eq(accountingClosings.id, input.closingId), eq(accountingClosings.businessId, input.businessId),
    )).limit(1).for("update");
    if (!closing) throw new Error("Accounting Closing is outside this business");
    if (closing.createdBy === input.actor.id) throw new Error("Maker cannot approve their own Accounting Closing");
    const blockers = await dataQualityBlockers(tx, closing);
    if (closing.isStale && !blockers.includes("closing_snapshot_is_stale")) blockers.push("closing_snapshot_is_stale");
    if (blockers.length > 0) return { approved: false, blockers };
    const next = nextClosingStatus({ status: closing.status as ClosingStatus, action: "approve", isStale: closing.isStale });
    await tx.update(accountingClosings).set({ status: next, approvedBy: input.actor.id, approvedAt: new Date() })
      .where(eq(accountingClosings.id, closing.id));
    await action(tx, { closingId: closing.id, businessId: input.businessId, action: "approve", fromStatus: closing.status, toStatus: next, actor: input.actor });
    return { approved: true, status: next, blockers: [] };
  });
}

export async function addClosingAdjustment(input: {
  businessId: number;
  closingId: number;
  adjustmentType: string;
  amount: string;
  reason: string;
  evidenceUrl: string;
  originalOccurredAt?: Date;
  originalClosingId?: number;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [closing] = await tx.select().from(accountingClosings).where(and(
      eq(accountingClosings.id, input.closingId), eq(accountingClosings.businessId, input.businessId),
    )).limit(1).for("update");
    if (!closing) throw new Error("Accounting Closing is outside this business");
    const next = nextClosingStatus({ status: closing.status as ClosingStatus, action: "add_adjustment" });
    const result: any = await tx.insert(accountingClosingAdjustments).values({
      closingId: closing.id,
      businessId: input.businessId,
      adjustmentType: input.adjustmentType,
      amount: fromMinorUnits(toMinorUnits(input.amount)),
      originalOccurredAt: input.originalOccurredAt ?? null,
      originalClosingId: input.originalClosingId ?? null,
      reason: input.reason.trim(),
      evidenceUrl: input.evidenceUrl,
      createdBy: input.actor.id,
      createdByName: input.actor.name,
    });
    await tx.update(accountingClosings).set({ status: next, approvedBy: null, approvedAt: null })
      .where(eq(accountingClosings.id, closing.id));
    await action(tx, { closingId: closing.id, businessId: input.businessId, action: "add_adjustment", fromStatus: closing.status, toStatus: next, reason: input.reason, actor: input.actor });
    return { adjustmentId: Number(result?.insertId ?? result?.[0]?.insertId), status: next };
  });
}

export async function lockClosing(input: { businessId: number; closingId: number; actor: Actor }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [closing] = await tx.select().from(accountingClosings).where(and(
      eq(accountingClosings.id, input.closingId), eq(accountingClosings.businessId, input.businessId),
    )).limit(1).for("update");
    if (!closing) throw new Error("Accounting Closing is outside this business");
    const next = nextClosingStatus({ status: closing.status as ClosingStatus, action: "lock" });
    await tx.update(accountingClosings).set({ status: next, lockedBy: input.actor.id, lockedAt: new Date() })
      .where(eq(accountingClosings.id, closing.id));
    await action(tx, { closingId: closing.id, businessId: input.businessId, action: "lock", fromStatus: closing.status, toStatus: next, actor: input.actor });
    return { status: next };
  });
}

export async function getClosingDetail(businessId: number, closingId: number) {
  const db = await getDb();
  if (!db) return null;
  const [closing] = await db.select().from(accountingClosings).where(and(
    eq(accountingClosings.id, closingId), eq(accountingClosings.businessId, businessId),
  )).limit(1);
  if (!closing) return null;
  const [lines, adjustments, actions] = await Promise.all([
    db.select().from(accountingClosingLines).where(and(eq(accountingClosingLines.closingId, closingId), eq(accountingClosingLines.businessId, businessId))).orderBy(asc(accountingClosingLines.id)),
    db.select().from(accountingClosingAdjustments).where(and(eq(accountingClosingAdjustments.closingId, closingId), eq(accountingClosingAdjustments.businessId, businessId))).orderBy(asc(accountingClosingAdjustments.id)),
    db.select().from(accountingClosingActions).where(and(eq(accountingClosingActions.closingId, closingId), eq(accountingClosingActions.businessId, businessId))).orderBy(asc(accountingClosingActions.id)),
  ]);
  const totals = closing.totalsJson ? JSON.parse(closing.totalsJson) : null;
  const adjustmentTotal = adjustments.reduce((sum, row) => sum + toMinorUnits(row.amount), 0n);
  const adjustedTotals = totals ? {
    ...totals,
    adjustmentTotal: fromMinorUnits(adjustmentTotal),
    adjustedNetProfit: fromMinorUnits(toMinorUnits(totals.netProfit ?? "0") + adjustmentTotal),
  } : null;
  return { ...closing, totals: adjustedTotals, lines, adjustments, actions };
}

export async function listClosings(businessId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(accountingClosings).where(eq(accountingClosings.businessId, businessId))
    .orderBy(desc(accountingClosings.sequenceNumber));
}
