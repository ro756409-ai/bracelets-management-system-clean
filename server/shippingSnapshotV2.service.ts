import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import {
  orderItems,
  orders,
  shipmentChargeSnapshots,
  shippingRateCharges,
  shippingRateVersions,
} from "../drizzle/schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { calculateShippingCharge } from "../shared/shippingCharges";

export type ExpectedShippingSelection = {
  businessId: number;
  orderId: number;
  businessShippingProviderId: number;
  governorate: string;
  shippingType: string;
  paymentType: string;
  occurredAt: Date;
  shipmentId?: number;
};

/**
 * Captures the configured expected charges while the order is still operational.
 * Recalculation is allowed only before Stock Out; after that the snapshot is immutable.
 */
export async function captureExpectedShippingSnapshotInTransaction(
  tx: any,
  input: ExpectedShippingSelection
) {
  const [order] = await tx
    .select()
    .from(orders)
    .where(
      and(eq(orders.id, input.orderId), eq(orders.businessId, input.businessId))
    )
    .limit(1)
    .for("update");
  if (!order) throw new Error("Order is outside this business");

  const items = await tx
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, input.orderId))
    .orderBy(asc(orderItems.id));
  if (
    items.some(
      (item: any) => item.stockOutQuantity > 0 || item.costCapturedAt != null
    )
  ) {
    throw new Error("Expected Shipping Snapshot cannot change after Stock Out");
  }

  const [rate] = await tx
    .select()
    .from(shippingRateVersions)
    .where(
      and(
        eq(shippingRateVersions.businessId, input.businessId),
        eq(
          shippingRateVersions.businessShippingProviderId,
          input.businessShippingProviderId
        ),
        eq(shippingRateVersions.governorate, input.governorate),
        eq(shippingRateVersions.shippingType, input.shippingType),
        eq(shippingRateVersions.paymentType, input.paymentType),
        eq(shippingRateVersions.isActive, true),
        lte(shippingRateVersions.effectiveFrom, input.occurredAt),
        or(
          isNull(shippingRateVersions.effectiveTo),
          gt(shippingRateVersions.effectiveTo, input.occurredAt)
        )
      )
    )
    .orderBy(
      desc(shippingRateVersions.priority),
      desc(shippingRateVersions.effectiveFrom)
    )
    .limit(1);
  if (!rate) throw new Error("No effective Shipping Rate matches this order");

  const charges = await tx
    .select()
    .from(shippingRateCharges)
    .where(
      and(
        eq(shippingRateCharges.businessId, input.businessId),
        eq(shippingRateCharges.rateVersionId, rate.id),
        eq(shippingRateCharges.isActive, true)
      )
    )
    .orderBy(asc(shippingRateCharges.id));
  if (charges.length === 0)
    throw new Error("Shipping Rate has no active charges");

  await tx
    .delete(shipmentChargeSnapshots)
    .where(
      and(
        eq(shipmentChargeSnapshots.businessId, input.businessId),
        eq(shipmentChargeSnapshots.orderId, input.orderId),
        eq(shipmentChargeSnapshots.recognizedAmount, "0.0000")
      )
    );

  let expectedTotal = 0n;
  for (const charge of charges) {
    const expectedAmount = calculateShippingCharge(
      {
        calculationType: charge.calculationType,
        value: charge.value,
        percentageBase: charge.percentageBase,
        customFixedBase: charge.customFixedBase,
      },
      order.totalAmount
    );
    expectedTotal += toMinorUnits(expectedAmount);
    await tx.insert(shipmentChargeSnapshots).values({
      businessId: input.businessId,
      orderId: input.orderId,
      shipmentId: input.shipmentId ?? null,
      rateChargeId: charge.id,
      chargeType: charge.chargeType,
      calculationType: charge.calculationType,
      valueSnapshot: charge.value,
      percentageBaseSnapshot: charge.percentageBase,
      customFixedBaseSnapshot: charge.customFixedBase,
      billingEventSnapshot: charge.billingEvent,
      expectedAmount,
      toleranceSnapshot: charge.tolerance,
    });
  }

  const expectedShippingCost = fromMinorUnits(expectedTotal);
  await tx
    .update(orders)
    .set({
      projectedShippingProviderId: input.businessShippingProviderId,
      projectedShippingType: input.shippingType,
      projectedPaymentType: input.paymentType,
      projectedShippingCostSnapshot: expectedShippingCost,
      projectedShippingCapturedAt: input.occurredAt,
    })
    .where(
      and(eq(orders.id, input.orderId), eq(orders.businessId, input.businessId))
    );

  return {
    rateVersionId: rate.id,
    expectedShippingCost,
    chargeCount: charges.length,
  };
}
