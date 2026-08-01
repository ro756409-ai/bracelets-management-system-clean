import { and, asc, eq, inArray } from "drizzle-orm";
import {
  businessEvents,
  businessShippingProviders,
  businesses,
  orderItems,
  orders,
  returnInspections,
  shipmentChargeSnapshots,
  shipmentEvents,
  shipments,
  shippingProviders,
} from "../drizzle/schema";
import {
  divideRounded,
  fromMinorUnits,
  multiplyMoney,
  toMinorUnits,
} from "../shared/accountingMoney";
import {
  createBusinessEventInTransaction,
  payloadHash,
  postFinancialTransactionInTransaction,
  stableJson,
  type Actor,
} from "./accountingV2.service";
import { getDb } from "./db";
import { captureExpectedShippingSnapshotInTransaction } from "./shippingSnapshotV2.service";

export type NormalizedShipmentEvent = string;

type ItemReturn = { orderItemId: number; quantity: number };

export async function recordIntegrationOrderEvent(input: {
  businessId: number;
  orderId: number;
  integrationCode: string;
  providerStatusCode: string;
  occurredAt: Date;
  payload: unknown;
  providerEventId?: string;
  collectedAmount?: string;
  returnedItems?: ItemReturn[];
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const prepared = await db.transaction(async tx => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.id, input.orderId),
          eq(orders.businessId, input.businessId)
        )
      )
      .limit(1)
      .for("update");
    if (!order) throw new Error("Integration order is outside this business");
    const [business] = await tx
      .select({ accountingGoLiveAt: businesses.accountingGoLiveAt })
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .limit(1);
    if (!business?.accountingGoLiveAt)
      return { ignored: true as const, reason: "accounting_not_active" };
    const [existingShipment] = await tx
      .select()
      .from(shipments)
      .where(
        and(
          eq(shipments.businessId, input.businessId),
          eq(shipments.orderId, input.orderId)
        )
      )
      .limit(1);
    if (
      existingShipment &&
      !existingShipment.externalShipmentId?.startsWith("integration:")
    ) {
      return { ignored: true as const, reason: "carrier_is_official" };
    }
    const [link] = await tx
      .select({ link: businessShippingProviders })
      .from(businessShippingProviders)
      .innerJoin(
        shippingProviders,
        eq(shippingProviders.id, businessShippingProviders.providerId)
      )
      .where(
        and(
          eq(businessShippingProviders.businessId, input.businessId),
          eq(businessShippingProviders.isActive, true),
          eq(shippingProviders.code, input.integrationCode)
        )
      )
      .limit(1);
    if (!link)
      throw new Error(
        `Integration ${input.integrationCode} is not configured as an official fallback source`
      );
    let statusMapping: Record<string, string>;
    try {
      statusMapping = JSON.parse(link.link.statusMappingJson);
    } catch {
      throw new Error("Integration status mapping is invalid");
    }
    const normalizedEvent = statusMapping[input.providerStatusCode];
    if (!normalizedEvent)
      return { ignored: true as const, reason: "status_not_mapped" };
    let shipmentId = existingShipment?.id;
    if (!shipmentId) {
      const result: any = await tx.insert(shipments).values({
        businessId: input.businessId,
        orderId: input.orderId,
        businessShippingProviderId: link.link.id,
        externalShipmentId: `integration:${input.integrationCode}:order:${input.orderId}`,
        currentStatus: "integration_created",
      });
      shipmentId = Number(result?.insertId ?? result?.[0]?.insertId);
    }
    if (!shipmentId)
      throw new Error("Could not create integration fallback shipment");
    return { ignored: false as const, shipmentId, normalizedEvent };
  });
  if (prepared.ignored) return prepared;
  return recordShipmentEvent({
    businessId: input.businessId,
    shipmentId: prepared.shipmentId,
    providerStatusCode: input.providerStatusCode,
    normalizedEvent: prepared.normalizedEvent,
    occurredAt: input.occurredAt,
    payload: input.payload,
    providerEventId: input.providerEventId,
    collectedAmount: input.collectedAmount,
    returnedItems: input.returnedItems,
  });
}

function lineRevenue(item: typeof orderItems.$inferSelect): bigint {
  if (item.netAmountSnapshot != null)
    return toMinorUnits(item.netAmountSnapshot);
  if (item.unitPrice == null)
    throw new Error(`Order Item #${item.id} has no revenue snapshot`);
  return multiplyMoney(item.quantity, item.unitPrice);
}

function lineCost(
  item: typeof orderItems.$inferSelect,
  quantity = item.quantity
): bigint {
  if (item.unitCostSnapshot == null)
    throw new Error(`Order Item #${item.id} has no Stock Out cost snapshot`);
  return multiplyMoney(quantity, item.unitCostSnapshot);
}

export async function createConfiguredShipment(input: {
  businessId: number;
  orderId: number;
  businessShippingProviderId: number;
  governorate: string;
  shippingType: string;
  paymentType: string;
  externalShipmentId?: string;
  trackingNumber?: string;
  occurredAt: Date;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.id, input.orderId),
          eq(orders.businessId, input.businessId)
        )
      )
      .limit(1)
      .for("update");
    if (!order) throw new Error("Order is outside this business");
    const [provider] = await tx
      .select()
      .from(businessShippingProviders)
      .where(
        and(
          eq(businessShippingProviders.id, input.businessShippingProviderId),
          eq(businessShippingProviders.businessId, input.businessId),
          eq(businessShippingProviders.isActive, true)
        )
      )
      .limit(1);
    if (!provider)
      throw new Error("Shipping provider is not configured for this business");
    const [existing] = await tx
      .select()
      .from(shipments)
      .where(
        and(
          eq(shipments.businessId, input.businessId),
          eq(shipments.orderId, input.orderId)
        )
      )
      .limit(1);
    if (existing) return { shipmentId: existing.id, duplicate: true };

    const result: any = await tx.insert(shipments).values({
      businessId: input.businessId,
      orderId: input.orderId,
      businessShippingProviderId: input.businessShippingProviderId,
      externalShipmentId: input.externalShipmentId ?? null,
      trackingNumber: input.trackingNumber ?? null,
      currentStatus: "created",
    });
    const shipmentId = Number(result?.insertId ?? result?.[0]?.insertId);
    if (!shipmentId) throw new Error("Could not create shipment");

    const snapshot = await captureExpectedShippingSnapshotInTransaction(tx, {
      ...input,
      shipmentId,
    });
    await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "shipping.shipment_created",
      sourceType: "shipment",
      sourceReference: String(shipmentId),
      idempotencyKey: `shipment:${shipmentId}:created`,
      occurredAt: input.occurredAt,
      payload: {
        shipmentId,
        orderId: input.orderId,
        rateVersionId: snapshot.rateVersionId,
        expectedShippingCost: snapshot.expectedShippingCost,
      },
      actor: input.actor,
    });
    return {
      shipmentId,
      expectedShippingCost: snapshot.expectedShippingCost,
      duplicate: false,
    };
  });
}

export async function recordShipmentEvent(input: {
  businessId: number;
  shipmentId: number;
  providerStatusCode: string;
  normalizedEvent: NormalizedShipmentEvent;
  occurredAt: Date;
  payload: unknown;
  providerEventId?: string;
  isManual?: boolean;
  evidenceUrl?: string;
  actor?: Actor;
  collectedAmount?: string;
  returnedItems?: ItemReturn[];
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [shipment] = await tx
      .select()
      .from(shipments)
      .where(
        and(
          eq(shipments.id, input.shipmentId),
          eq(shipments.businessId, input.businessId)
        )
      )
      .limit(1)
      .for("update");
    if (!shipment) throw new Error("Shipment is outside this business");
    const [order] = await tx
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.id, shipment.orderId),
          eq(orders.businessId, input.businessId)
        )
      )
      .limit(1)
      .for("update");
    if (!order) throw new Error("Shipment order is outside this business");
    const hash = payloadHash(input.payload);
    const [duplicate] = await tx
      .select()
      .from(shipmentEvents)
      .where(
        and(
          eq(shipmentEvents.shipmentId, shipment.id),
          eq(shipmentEvents.payloadHash, hash)
        )
      )
      .limit(1);
    if (duplicate) return { shipmentEventId: duplicate.id, duplicate: true };

    const items = await tx
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.id));
    if (items.length === 0)
      throw new Error("Order Items are required for official shipment events");
    const eventPayload: Record<string, unknown> = {
      shipmentId: shipment.id,
      orderId: order.id,
      normalizedEvent: input.normalizedEvent,
      providerStatusCode: input.providerStatusCode,
    };

    if (input.normalizedEvent === "delivered") {
      if (
        items.some(
          item =>
            item.stockOutQuantity !== item.quantity ||
            item.unitCostSnapshot == null
        )
      ) {
        throw new Error(
          "Delivered is blocked until every Order Item has a complete Stock Out cost snapshot"
        );
      }
      const revenue = items.reduce((sum, item) => sum + lineRevenue(item), 0n);
      const cogs = items.reduce((sum, item) => sum + lineCost(item), 0n);
      eventPayload.revenue = fromMinorUnits(revenue);
      eventPayload.cogs = fromMinorUnits(cogs);
      eventPayload.collectedAmount = input.collectedAmount ?? order.totalAmount;
      eventPayload.items = items.map(item => ({
        orderItemId: item.id,
        quantity: item.quantity,
        revenue: fromMinorUnits(lineRevenue(item)),
        unitCostSnapshot: item.unitCostSnapshot,
        cogs: fromMinorUnits(lineCost(item)),
      }));
    }

    if (
      input.normalizedEvent === "returned" ||
      input.normalizedEvent === "partial_return"
    ) {
      const requested =
        input.normalizedEvent === "returned"
          ? items.map(item => ({
              orderItemId: item.id,
              quantity: item.quantity - item.returnedQuantity,
            }))
          : (input.returnedItems ?? []);
      if (requested.length === 0 || requested.some(row => row.quantity <= 0)) {
        throw new Error(
          "Returned quantities are required and must be positive"
        );
      }
      const itemById = new Map(items.map(item => [item.id, item]));
      let revenueReversal = 0n;
      let pendingInspectionCost = 0n;
      for (const returned of requested) {
        const item = itemById.get(returned.orderItemId);
        if (!item)
          throw new Error(
            `Order Item #${returned.orderItemId} is outside this order`
          );
        if (item.returnedQuantity + returned.quantity > item.quantity)
          throw new Error(`Returned quantity exceeds Order Item #${item.id}`);
        const allocatedBefore = divideRounded(
          lineRevenue(item) * BigInt(item.returnedQuantity),
          BigInt(item.quantity)
        );
        const allocatedAfter = divideRounded(
          lineRevenue(item) * BigInt(item.returnedQuantity + returned.quantity),
          BigInt(item.quantity)
        );
        revenueReversal += allocatedAfter - allocatedBefore;
        pendingInspectionCost += lineCost(item, returned.quantity);
        await tx
          .update(orderItems)
          .set({ returnedQuantity: item.returnedQuantity + returned.quantity })
          .where(eq(orderItems.id, item.id));
      }
      eventPayload.revenueReversal = order.deliveredAt
        ? fromMinorUnits(revenueReversal)
        : "0.0000";
      eventPayload.returnsPendingInspection = fromMinorUnits(
        pendingInspectionCost
      );
      eventPayload.items = requested.map(row => {
        const item = itemById.get(row.orderItemId)!;
        return { ...row, unitCostSnapshot: item.unitCostSnapshot };
      });
      const [existingInspection] = await tx
        .select()
        .from(returnInspections)
        .where(
          and(
            eq(returnInspections.businessId, input.businessId),
            eq(returnInspections.orderId, order.id),
            eq(returnInspections.status, "pending")
          )
        )
        .limit(1);
      if (!existingInspection)
        await tx.insert(returnInspections).values({
          businessId: input.businessId,
          orderId: order.id,
          shipmentId: shipment.id,
          status: "pending",
        });
    }

    const businessEvent = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: `shipment.${input.normalizedEvent}`,
      sourceType: "shipment",
      sourceReference: String(shipment.id),
      idempotencyKey: `shipment:${shipment.id}:event:${input.providerEventId ?? hash}`,
      occurredAt: input.occurredAt,
      payload: eventPayload,
      actor: input.actor,
    });
    if (
      input.normalizedEvent === "delivered" &&
      order.paymentMethod?.toLowerCase() === "cod"
    ) {
      const [provider] = await tx
        .select()
        .from(businessShippingProviders)
        .where(
          and(
            eq(
              businessShippingProviders.id,
              shipment.businessShippingProviderId
            ),
            eq(businessShippingProviders.businessId, input.businessId)
          )
        )
        .limit(1);
      if (!provider?.codSettlementAccountId)
        throw new Error(
          "COD Settlement Account is not configured for this shipping provider"
        );
      const [business] = await tx
        .select({ baseCurrency: businesses.baseCurrency })
        .from(businesses)
        .where(eq(businesses.id, input.businessId))
        .limit(1);
      if (!business) throw new Error("Business not found");
      await postFinancialTransactionInTransaction(tx, {
        businessId: input.businessId,
        transactionType: "cod_receivable",
        targetAccountId: provider.codSettlementAccountId,
        amount: input.collectedAmount ?? order.totalAmount,
        currencyCode: business.baseCurrency,
        description: `COD receivable for Order #${order.orderNumber}`,
        evidenceUrl: `provider-event:${input.providerEventId ?? hash}`,
        occurredAt: input.occurredAt,
        businessEventId: businessEvent.event.id,
        actor: input.actor ?? { id: 0, name: "System" },
      });
    }
    const eventResult: any = await tx.insert(shipmentEvents).values({
      businessId: input.businessId,
      shipmentId: shipment.id,
      businessEventId: businessEvent.event.id,
      providerEventId: input.providerEventId ?? null,
      providerStatusCode: input.providerStatusCode,
      normalizedEvent: input.normalizedEvent,
      occurredAt: input.occurredAt,
      payloadJson: stableJson(input.payload),
      payloadHash: hash,
      isManual: input.isManual ?? false,
      evidenceUrl: input.evidenceUrl ?? null,
      createdBy: input.actor?.id ?? null,
    });
    const shipmentEventId = Number(
      eventResult?.insertId ?? eventResult?.[0]?.insertId
    );

    const chargeSnapshots = await tx
      .select()
      .from(shipmentChargeSnapshots)
      .where(
        and(
          eq(shipmentChargeSnapshots.shipmentId, shipment.id),
          eq(
            shipmentChargeSnapshots.billingEventSnapshot,
            input.normalizedEvent
          ),
          eq(shipmentChargeSnapshots.recognizedAmount, "0.0000")
        )
      );
    for (const charge of chargeSnapshots) {
      await tx
        .update(shipmentChargeSnapshots)
        .set({
          recognizedAmount: charge.expectedAmount,
          recognizedAt: input.occurredAt,
        })
        .where(eq(shipmentChargeSnapshots.id, charge.id));
      await createBusinessEventInTransaction(tx, {
        businessId: input.businessId,
        eventType: "shipping.charge_recognized",
        sourceType: "shipment_charge",
        sourceReference: String(charge.id),
        idempotencyKey: `shipment-charge:${charge.id}:recognized`,
        occurredAt: input.occurredAt,
        payload: {
          shipmentId: shipment.id,
          chargeType: charge.chargeType,
          amount: charge.expectedAmount,
        },
        actor: input.actor,
      });
    }

    const statusPatch: Record<string, unknown> = {
      currentStatus: input.normalizedEvent,
    };
    if (input.normalizedEvent === "pickup")
      statusPatch.dispatchedAt = input.occurredAt;
    if (input.normalizedEvent === "delivered")
      statusPatch.deliveredAt = input.occurredAt;
    if (input.normalizedEvent === "returned")
      statusPatch.returnedAt = input.occurredAt;
    await tx
      .update(shipments)
      .set(statusPatch)
      .where(eq(shipments.id, shipment.id));

    if (input.normalizedEvent === "delivered") {
      await tx
        .update(orders)
        .set({
          status: "delivered",
          deliveredAt: input.occurredAt,
          collectedAmount: input.collectedAmount ?? order.totalAmount,
          collectedAt: input.occurredAt,
          collectionStatus: "collected",
        })
        .where(eq(orders.id, order.id));
    } else if (input.normalizedEvent === "returned") {
      await tx
        .update(orders)
        .set({ status: "returned", collectionStatus: "failed" })
        .where(eq(orders.id, order.id));
    }
    return {
      shipmentEventId,
      businessEventId: businessEvent.event.id,
      recognizedCharges: chargeSnapshots.length,
      duplicate: false,
    };
  });
}
