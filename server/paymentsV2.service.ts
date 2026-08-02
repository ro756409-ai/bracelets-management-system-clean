import { and, eq } from "drizzle-orm";
import { businesses, orders } from "../drizzle/schema";
import {
  createBusinessEventInTransaction,
  postFinancialTransactionInTransaction,
  type Actor,
} from "./accountingV2.service";
import { getDb } from "./db";

export async function confirmOrderPayment(input: {
  businessId: number;
  orderId: number;
  targetAccountId: number;
  amount: string;
  paymentReference: string;
  confirmedAt: Date;
  evidenceUrl: string;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.businessId, input.businessId),
    )).limit(1).for("update");
    if (!order) throw new Error("Order is outside this business");
    if (order.paymentMethod?.toLowerCase() === "cod") throw new Error("COD is confirmed by the official Delivered event");
    const [business] = await tx.select().from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
    if (!business) throw new Error("Business not found");
    const event = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "payment.confirmed",
      sourceType: "order",
      sourceReference: String(order.id),
      idempotencyKey: `payment:${input.paymentReference}:confirmed`,
      occurredAt: input.confirmedAt,
      payload: { orderId: order.id, amount: input.amount, paymentReference: input.paymentReference, targetAccountId: input.targetAccountId },
      actor: input.actor,
    });
    if (event.duplicate) return { transactionId: null, duplicate: true };
    const transaction = await postFinancialTransactionInTransaction(tx, {
      businessId: input.businessId,
      transactionType: "order_payment",
      targetAccountId: input.targetAccountId,
      amount: input.amount,
      currencyCode: business.baseCurrency,
      description: `Payment confirmed for Order #${order.orderNumber}`,
      externalCounterparty: order.customerName,
      evidenceUrl: input.evidenceUrl,
      occurredAt: input.confirmedAt,
      businessEventId: event.event.id,
      actor: input.actor,
    });
    await tx.update(orders).set({
      collectedAmount: input.amount,
      collectedAt: input.confirmedAt,
      collectionStatus: Number(input.amount) >= Number(order.totalAmount) ? "collected" : "partial",
    }).where(eq(orders.id, order.id));
    return { transactionId: transaction.id, duplicate: false };
  });
}

export async function refundOrderPayment(input: {
  businessId: number;
  orderId: number;
  sourceAccountId: number;
  amount: string;
  refundReference: string;
  refundedAt: Date;
  reason: string;
  evidenceUrl: string;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [order] = await tx.select().from(orders).where(and(
      eq(orders.id, input.orderId), eq(orders.businessId, input.businessId),
    )).limit(1).for("update");
    if (!order) throw new Error("Order is outside this business");
    const [business] = await tx.select().from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
    if (!business) throw new Error("Business not found");
    const event = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "payment.refunded",
      sourceType: "order",
      sourceReference: String(order.id),
      idempotencyKey: `refund:${input.refundReference}`,
      occurredAt: input.refundedAt,
      payload: { orderId: order.id, amount: input.amount, refundReference: input.refundReference, reason: input.reason },
      actor: input.actor,
    });
    if (event.duplicate) return { transactionId: null, duplicate: true };
    const transaction = await postFinancialTransactionInTransaction(tx, {
      businessId: input.businessId,
      transactionType: "order_refund",
      sourceAccountId: input.sourceAccountId,
      amount: input.amount,
      currencyCode: business.baseCurrency,
      description: `Refund for Order #${order.orderNumber}: ${input.reason}`,
      externalCounterparty: order.customerName,
      evidenceUrl: input.evidenceUrl,
      occurredAt: input.refundedAt,
      businessEventId: event.event.id,
      actor: input.actor,
    });
    return { transactionId: transaction.id, duplicate: false };
  });
}
