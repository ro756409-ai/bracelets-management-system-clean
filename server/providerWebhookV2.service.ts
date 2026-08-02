import { and, eq } from "drizzle-orm";
import {
  businessShippingProviders,
  rawProviderWebhooks,
  shipments,
  shippingProviders,
} from "../drizzle/schema";
import { payloadHash, stableJson } from "./accountingV2.service";
import { getDb } from "./db";
import { recordShipmentEvent } from "./shippingV2.service";

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export async function processProviderWebhook(input: {
  providerCode: string;
  externalShipmentId?: string;
  trackingNumber?: string;
  providerEventId?: string;
  providerStatusCode: string;
  occurredAt: Date;
  payload: unknown;
}) {
  if (!input.externalShipmentId?.trim() && !input.trackingNumber?.trim()) {
    throw new Error("Provider webhook requires an external shipment id or tracking number");
  }
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const hash = payloadHash(input.payload);
  const [existingRaw] = await db.select().from(rawProviderWebhooks).where(and(
    eq(rawProviderWebhooks.providerCode, input.providerCode),
    eq(rawProviderWebhooks.payloadHash, hash),
  )).limit(1);
  if (existingRaw) return { rawWebhookId: existingRaw.id, duplicate: true, status: existingRaw.processingStatus };

  const providerLinks = await db.select({
    provider: businessShippingProviders,
    providerCode: shippingProviders.code,
  }).from(businessShippingProviders).innerJoin(
    shippingProviders, eq(shippingProviders.id, businessShippingProviders.providerId),
  ).where(and(
    eq(shippingProviders.code, input.providerCode),
    eq(businessShippingProviders.isActive, true),
  ));
  const linkIds = new Set(providerLinks.map(row => row.provider.id));
  const candidates = await db.select().from(shipments).where(and(
    ...(input.externalShipmentId ? [eq(shipments.externalShipmentId, input.externalShipmentId)] : []),
    ...(input.trackingNumber && !input.externalShipmentId ? [eq(shipments.trackingNumber, input.trackingNumber)] : []),
  ));
  const matches = candidates.filter(shipment => linkIds.has(shipment.businessShippingProviderId));
  const match = matches.length === 1 ? matches[0] : null;
  const link = match ? providerLinks.find(row => row.provider.id === match.businessShippingProviderId)?.provider : null;
  const retentionDays = link?.rawWebhookRetentionDays ?? 365;
  const rawResult: any = await db.insert(rawProviderWebhooks).values({
    businessId: match?.businessId ?? null,
    businessShippingProviderId: link?.id ?? null,
    providerCode: input.providerCode,
    externalReference: input.externalShipmentId ?? input.trackingNumber ?? null,
    payloadJson: stableJson(input.payload),
    payloadHash: hash,
    processingStatus: match && link ? "received" : "unmatched",
    retainUntil: addDays(new Date(), retentionDays),
  });
  const rawWebhookId = Number(rawResult?.insertId ?? rawResult?.[0]?.insertId);
  if (!match || !link) return { rawWebhookId, duplicate: false, status: "unmatched" as const };

  let statusMapping: Record<string, string>;
  try {
    statusMapping = JSON.parse(link.statusMappingJson);
  } catch {
    await db.update(rawProviderWebhooks).set({ processingStatus: "failed", processingError: "Invalid provider status mapping" })
      .where(eq(rawProviderWebhooks.id, rawWebhookId));
    throw new Error("Invalid provider status mapping configuration");
  }
  const normalizedEvent = statusMapping[input.providerStatusCode];
  if (!normalizedEvent) {
    await db.update(rawProviderWebhooks).set({ processingStatus: "unmatched", processingError: "Provider status is not mapped" })
      .where(eq(rawProviderWebhooks.id, rawWebhookId));
    return { rawWebhookId, duplicate: false, status: "unmatched" as const };
  }
  try {
    const processed = await recordShipmentEvent({
      businessId: match.businessId,
      shipmentId: match.id,
      providerStatusCode: input.providerStatusCode,
      normalizedEvent,
      occurredAt: input.occurredAt,
      payload: input.payload,
      providerEventId: input.providerEventId,
    });
    await db.update(rawProviderWebhooks).set({ processingStatus: "processed" })
      .where(eq(rawProviderWebhooks.id, rawWebhookId));
    return { rawWebhookId, duplicate: false, status: "processed" as const, processed };
  } catch (error) {
    await db.update(rawProviderWebhooks).set({
      processingStatus: "failed",
      processingError: error instanceof Error ? error.message : "Unknown processing error",
    }).where(eq(rawProviderWebhooks.id, rawWebhookId));
    throw error;
  }
}
