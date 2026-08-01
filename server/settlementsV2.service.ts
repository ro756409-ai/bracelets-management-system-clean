import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import {
  businessShippingProviders,
  businesses,
  carrierSettlementLines,
  carrierSettlements,
  shipmentChargeSnapshots,
  shipmentEvents,
  shipments,
} from "../drizzle/schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import {
  createBusinessEventInTransaction,
  payloadHash,
  postFinancialTransactionInTransaction,
  stableJson,
  type Actor,
} from "./accountingV2.service";
import { getDb } from "./db";

type SettlementLineInput = {
  externalReference: string;
  grossCollected: string;
  actualCharges: string;
  netAmount: string;
  notes?: string;
};

export async function getShippingFinanceData(businessId: number) {
  const db = await getDb();
  if (!db) return { shipments: [], shipmentEvents: [], chargeSnapshots: [], settlements: [], settlementLines: [] };
  const [shipmentRows, settlementRows] = await Promise.all([
    db.select().from(shipments).where(eq(shipments.businessId, businessId)).orderBy(desc(shipments.id)),
    db.select().from(carrierSettlements).where(eq(carrierSettlements.businessId, businessId)).orderBy(desc(carrierSettlements.id)),
  ]);
  const [eventRows, chargeSnapshots, settlementLines] = await Promise.all([
    shipmentRows.length ? db.select().from(shipmentEvents).where(inArray(shipmentEvents.shipmentId, shipmentRows.map(row => row.id))) : Promise.resolve([]),
    shipmentRows.length ? db.select().from(shipmentChargeSnapshots).where(inArray(shipmentChargeSnapshots.shipmentId, shipmentRows.map(row => row.id))) : Promise.resolve([]),
    settlementRows.length ? db.select().from(carrierSettlementLines).where(inArray(carrierSettlementLines.settlementId, settlementRows.map(row => row.id))) : Promise.resolve([]),
  ]);
  return { shipments: shipmentRows, shipmentEvents: eventRows, chargeSnapshots, settlements: settlementRows, settlementLines };
}

export async function importCarrierSettlement(input: {
  businessId: number;
  businessShippingProviderId: number;
  reference: string;
  statementDate: Date;
  evidenceUrl: string;
  lines: SettlementLineInput[];
  actor: Actor;
}) {
  if (input.lines.length === 0) throw new Error("Settlement statement has no lines");
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [provider] = await tx.select().from(businessShippingProviders).where(and(
      eq(businessShippingProviders.id, input.businessShippingProviderId),
      eq(businessShippingProviders.businessId, input.businessId),
    )).limit(1);
    if (!provider) throw new Error("Shipping provider is outside this business");
    const importHash = payloadHash({
      providerId: input.businessShippingProviderId,
      reference: input.reference,
      statementDate: input.statementDate.toISOString(),
      lines: input.lines,
    });
    const [existing] = await tx.select().from(carrierSettlements).where(and(
      eq(carrierSettlements.businessId, input.businessId),
      eq(carrierSettlements.importHash, importHash),
    )).limit(1);
    if (existing) return { settlementId: existing.id, duplicate: true };

    let grossTotal = 0n;
    let chargesTotal = 0n;
    let netTotal = 0n;
    const matchedLines: Array<SettlementLineInput & { shipmentId: number | null; differenceAmount: string }> = [];
    for (const line of input.lines) {
      const gross = toMinorUnits(line.grossCollected);
      const actual = toMinorUnits(line.actualCharges);
      const net = toMinorUnits(line.netAmount);
      if (gross < 0n || actual < 0n || net < 0n) throw new Error("Settlement amounts cannot be negative");
      if (gross - actual !== net) throw new Error(`Settlement line ${line.externalReference} does not balance`);
      grossTotal += gross;
      chargesTotal += actual;
      netTotal += net;
      const [shipment] = await tx.select().from(shipments).where(and(
        eq(shipments.businessId, input.businessId),
        eq(shipments.businessShippingProviderId, input.businessShippingProviderId),
        or(eq(shipments.trackingNumber, line.externalReference), eq(shipments.externalShipmentId, line.externalReference)),
      )).limit(1);
      let difference = 0n;
      if (shipment) {
        const expectedCharges = await tx.select().from(shipmentChargeSnapshots)
          .where(eq(shipmentChargeSnapshots.shipmentId, shipment.id));
        const expected = expectedCharges.reduce(
          (sum: bigint, charge: typeof shipmentChargeSnapshots.$inferSelect) => sum + toMinorUnits(charge.expectedAmount),
          0n,
        );
        const tolerance = expectedCharges.reduce(
          (sum: bigint, charge: typeof shipmentChargeSnapshots.$inferSelect) => sum + toMinorUnits(charge.toleranceSnapshot),
          0n,
        );
        const rawDifference = actual - expected;
        difference = (rawDifference < 0n ? -rawDifference : rawDifference) <= tolerance ? 0n : rawDifference;
      }
      matchedLines.push({ ...line, shipmentId: shipment?.id ?? null, differenceAmount: fromMinorUnits(difference) });
    }
    const result: any = await tx.insert(carrierSettlements).values({
      businessId: input.businessId,
      businessShippingProviderId: input.businessShippingProviderId,
      reference: input.reference,
      statementDate: input.statementDate,
      importHash,
      grossCollected: fromMinorUnits(grossTotal),
      totalCharges: fromMinorUnits(chargesTotal),
      netTransferred: fromMinorUnits(netTotal),
      status: matchedLines.every(line => line.shipmentId != null) ? "matched" : "draft",
      evidenceUrl: input.evidenceUrl,
      createdBy: input.actor.id,
    });
    const settlementId = Number(result?.insertId ?? result?.[0]?.insertId);
    if (!settlementId) throw new Error("Could not import Carrier Settlement");
    for (const line of matchedLines) {
      await tx.insert(carrierSettlementLines).values({
        settlementId,
        businessId: input.businessId,
        shipmentId: line.shipmentId,
        externalReference: line.externalReference,
        grossCollected: fromMinorUnits(toMinorUnits(line.grossCollected)),
        actualCharges: fromMinorUnits(toMinorUnits(line.actualCharges)),
        netAmount: fromMinorUnits(toMinorUnits(line.netAmount)),
        matchStatus: line.shipmentId == null ? "suspense" : "matched",
        differenceAmount: line.differenceAmount,
        notes: line.notes ?? null,
        rawLineJson: stableJson(line),
      });
    }
    return { settlementId, suspenseLines: matchedLines.filter(line => line.shipmentId == null).length, duplicate: false };
  });
}

export async function approveCarrierSettlement(input: {
  businessId: number;
  settlementId: number;
  targetAccountId: number;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [settlement] = await tx.select().from(carrierSettlements).where(and(
      eq(carrierSettlements.id, input.settlementId),
      eq(carrierSettlements.businessId, input.businessId),
    )).limit(1).for("update");
    if (!settlement) throw new Error("Carrier Settlement is outside this business");
    if (settlement.status !== "matched") throw new Error("Settlement must be fully matched before approval");
    if (settlement.createdBy === input.actor.id) throw new Error("Maker cannot approve their own Settlement");
    const lines = await tx.select().from(carrierSettlementLines).where(and(
      eq(carrierSettlementLines.settlementId, settlement.id),
      eq(carrierSettlementLines.businessId, input.businessId),
    )).orderBy(asc(carrierSettlementLines.id));
    if (lines.some((line: typeof carrierSettlementLines.$inferSelect) => line.matchStatus === "suspense")) {
      throw new Error("Settlement has unmatched suspense lines");
    }
    const [provider] = await tx.select().from(businessShippingProviders).where(and(
      eq(businessShippingProviders.id, settlement.businessShippingProviderId),
      eq(businessShippingProviders.businessId, input.businessId),
    )).limit(1);
    if (!provider?.codSettlementAccountId) throw new Error("COD Settlement Account is not configured");
    const [business] = await tx.select().from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
    if (!business) throw new Error("Business not found");
    const eventResult = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: "shipping.settlement_approved",
      sourceType: "carrier_settlement",
      sourceReference: String(settlement.id),
      idempotencyKey: `carrier-settlement:${settlement.id}:approved`,
      occurredAt: settlement.statementDate,
      payload: {
        settlementId: settlement.id,
        grossCollected: settlement.grossCollected,
        actualCharges: settlement.totalCharges,
        netTransferred: settlement.netTransferred,
      },
      actor: input.actor,
    });
    if (eventResult.duplicate) return { eventId: eventResult.event.id, duplicate: true };

    const transfer = toMinorUnits(settlement.netTransferred) > 0n
      ? await postFinancialTransactionInTransaction(tx, {
        businessId: input.businessId,
        transactionType: "carrier_settlement_transfer",
        sourceAccountId: provider.codSettlementAccountId,
        targetAccountId: input.targetAccountId,
        amount: settlement.netTransferred,
        currencyCode: business.baseCurrency,
        description: `Carrier Settlement ${settlement.reference}`,
        evidenceUrl: settlement.evidenceUrl ?? "settlement-statement",
        occurredAt: settlement.statementDate,
        businessEventId: eventResult.event.id,
        actor: input.actor,
      }) : null;
    const charges = toMinorUnits(settlement.totalCharges) > 0n
      ? await postFinancialTransactionInTransaction(tx, {
        businessId: input.businessId,
        transactionType: "carrier_charges_deducted",
        sourceAccountId: provider.codSettlementAccountId,
        amount: settlement.totalCharges,
        currencyCode: business.baseCurrency,
        description: `Carrier charges for Settlement ${settlement.reference}`,
        evidenceUrl: settlement.evidenceUrl ?? "settlement-statement",
        occurredAt: settlement.statementDate,
        businessEventId: eventResult.event.id,
        actor: input.actor,
      }) : null;

    for (const line of lines) {
      if (line.shipmentId == null) continue;
      const settlementCharges = await tx.select().from(shipmentChargeSnapshots).where(and(
        eq(shipmentChargeSnapshots.shipmentId, line.shipmentId),
        eq(shipmentChargeSnapshots.billingEventSnapshot, "settlement"),
        eq(shipmentChargeSnapshots.recognizedAmount, "0.0000"),
      ));
      for (const charge of settlementCharges) {
        await tx.update(shipmentChargeSnapshots).set({
          recognizedAmount: charge.expectedAmount,
          recognizedAt: settlement.statementDate,
        }).where(eq(shipmentChargeSnapshots.id, charge.id));
        await createBusinessEventInTransaction(tx, {
          businessId: input.businessId,
          eventType: "shipping.charge_recognized",
          sourceType: "shipment_charge",
          sourceReference: String(charge.id),
          idempotencyKey: `shipment-charge:${charge.id}:recognized`,
          occurredAt: settlement.statementDate,
          payload: { shipmentId: line.shipmentId, chargeType: charge.chargeType, amount: charge.expectedAmount },
          actor: input.actor,
        });
      }
      if (toMinorUnits(line.differenceAmount) !== 0n) {
        await createBusinessEventInTransaction(tx, {
          businessId: input.businessId,
          eventType: "shipping.cost_adjustment",
          sourceType: "carrier_settlement_line",
          sourceReference: String(line.id),
          idempotencyKey: `carrier-settlement-line:${line.id}:shipping-adjustment`,
          occurredAt: settlement.statementDate,
          payload: { shipmentId: line.shipmentId, amount: line.differenceAmount, actualCharges: line.actualCharges },
          actor: input.actor,
        });
      }
    }
    await tx.update(carrierSettlements).set({
      status: "approved",
      approvedBy: input.actor.id,
      approvedAt: new Date(),
      targetAccountId: input.targetAccountId,
      transferTransactionId: transfer?.id ?? null,
      chargesTransactionId: charges?.id ?? null,
    }).where(eq(carrierSettlements.id, settlement.id));
    return { eventId: eventResult.event.id, transferTransactionId: transfer?.id, chargesTransactionId: charges?.id, duplicate: false };
  });
}
