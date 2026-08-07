import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  businessConfigurationValues,
  businessShippingProviders,
  financialAccounts,
  shippingProviders,
  shippingRateCharges,
  shippingRateVersions,
} from "../drizzle/schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import type { Actor } from "./accountingV2.service";
import { getDb } from "./db";

type ChargeInput = {
  chargeType: string;
  calculationType: "fixed" | "percentage";
  value: string;
  percentageBase?: "collected_amount" | "custom_fixed_base";
  customFixedBase?: string;
  billingEvent: string;
  tolerance?: string;
};

async function assertConfiguredValues(tx: any, businessId: number, requested: Array<{ namespace: string; key: string }>) {
  const namespaces = [...new Set(requested.map(item => item.namespace))];
  const rows = await tx.select().from(businessConfigurationValues).where(and(
    eq(businessConfigurationValues.businessId, businessId),
    eq(businessConfigurationValues.isActive, true),
    inArray(businessConfigurationValues.namespace, namespaces),
  ));
  const configured = new Set(rows.map((row: typeof businessConfigurationValues.$inferSelect) => `${row.namespace}:${row.configKey}`));
  const missing = requested.filter(item => !configured.has(`${item.namespace}:${item.key}`));
  if (missing.length > 0) throw new Error(`Missing active Business Configuration: ${missing.map(item => `${item.namespace}.${item.key}`).join(", ")}`);
}

export async function configureBusinessShippingProvider(input: {
  businessId: number;
  providerCode: string;
  providerName: string;
  displayName: string;
  codSettlementAccountId?: number;
  statusMapping: Record<string, string>;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    await tx.insert(shippingProviders).values({ code: input.providerCode, name: input.providerName })
      .onDuplicateKeyUpdate({ set: { isActive: true } });
    const [provider] = await tx.select().from(shippingProviders).where(eq(shippingProviders.code, input.providerCode)).limit(1);
    if (!provider) throw new Error("Could not configure Shipping Provider");
    if (input.codSettlementAccountId != null) {
      const [account] = await tx.select().from(financialAccounts).where(and(
        eq(financialAccounts.id, input.codSettlementAccountId),
        eq(financialAccounts.businessId, input.businessId),
      )).limit(1);
      if (!account) throw new Error("COD Settlement Account is outside this business");
    }
    await tx.insert(businessShippingProviders).values({
      businessId: input.businessId,
      providerId: provider.id,
      displayName: input.displayName,
      codSettlementAccountId: input.codSettlementAccountId ?? null,
      statusMappingJson: JSON.stringify(input.statusMapping),
    }).onDuplicateKeyUpdate({ set: {
      displayName: input.displayName,
      codSettlementAccountId: input.codSettlementAccountId ?? null,
      statusMappingJson: JSON.stringify(input.statusMapping),
      isActive: true,
    }});
    const [configured] = await tx.select().from(businessShippingProviders).where(and(
      eq(businessShippingProviders.businessId, input.businessId),
      eq(businessShippingProviders.providerId, provider.id),
    )).limit(1);
    return configured;
  });
}

export async function createShippingRateVersion(input: {
  businessId: number;
  businessShippingProviderId: number;
  governorate: string;
  shippingType: string;
  paymentType: string;
  priority: number;
  effectiveFrom: Date;
  charges: ChargeInput[];
  actor: Actor;
}) {
  if (input.charges.length === 0) throw new Error("Shipping Rate requires at least one charge");
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const [provider] = await tx.select().from(businessShippingProviders).where(and(
      eq(businessShippingProviders.id, input.businessShippingProviderId),
      eq(businessShippingProviders.businessId, input.businessId),
      eq(businessShippingProviders.isActive, true),
    )).limit(1);
    if (!provider) throw new Error("Shipping Provider is outside this business");
    await assertConfiguredValues(tx, input.businessId, [
      { namespace: "governorate", key: input.governorate },
      { namespace: "shipping_type", key: input.shippingType },
      { namespace: "payment_type", key: input.paymentType },
      ...input.charges.flatMap(charge => [
        { namespace: "shipping_charge_type", key: charge.chargeType },
        { namespace: "shipping_billing_event", key: charge.billingEvent },
      ]),
    ]);
    for (const charge of input.charges) {
      if (toMinorUnits(charge.value) < 0n) throw new Error("Shipping Charge value cannot be negative");
      if (charge.calculationType === "percentage" && !charge.percentageBase) {
        throw new Error("Percentage Charge requires Percentage Base");
      }
      if (charge.percentageBase === "custom_fixed_base" && charge.customFixedBase == null) {
        throw new Error("Custom Fixed Base amount is required");
      }
    }
    const previous = await tx.select().from(shippingRateVersions).where(and(
      eq(shippingRateVersions.businessId, input.businessId),
      eq(shippingRateVersions.businessShippingProviderId, input.businessShippingProviderId),
      eq(shippingRateVersions.governorate, input.governorate),
      eq(shippingRateVersions.shippingType, input.shippingType),
      eq(shippingRateVersions.paymentType, input.paymentType),
      eq(shippingRateVersions.priority, input.priority),
      eq(shippingRateVersions.isActive, true),
    )).orderBy(desc(shippingRateVersions.effectiveFrom)).limit(1).for("update");
    if (previous[0] && previous[0].effectiveFrom >= input.effectiveFrom) {
      throw new Error("New Shipping Rate version must start after the current version");
    }
    if (previous[0]) await tx.update(shippingRateVersions).set({ effectiveTo: input.effectiveFrom })
      .where(eq(shippingRateVersions.id, previous[0].id));
    const result: any = await tx.insert(shippingRateVersions).values({
      businessId: input.businessId,
      businessShippingProviderId: input.businessShippingProviderId,
      governorate: input.governorate,
      shippingType: input.shippingType,
      paymentType: input.paymentType,
      priority: input.priority,
      effectiveFrom: input.effectiveFrom,
      createdBy: input.actor.id,
    });
    const rateVersionId = Number(result?.insertId ?? result?.[0]?.insertId);
    if (!rateVersionId) throw new Error("Could not create Shipping Rate version");
    for (const charge of input.charges) await tx.insert(shippingRateCharges).values({
      businessId: input.businessId,
      rateVersionId,
      chargeType: charge.chargeType,
      calculationType: charge.calculationType,
      value: fromMinorUnits(toMinorUnits(charge.value)),
      percentageBase: charge.percentageBase ?? null,
      customFixedBase: charge.customFixedBase == null ? null : fromMinorUnits(toMinorUnits(charge.customFixedBase)),
      billingEvent: charge.billingEvent,
      tolerance: fromMinorUnits(toMinorUnits(charge.tolerance ?? "0")),
    });
    return { rateVersionId };
  });
}

export async function listShippingConfiguration(businessId: number) {
  const db = await getDb();
  if (!db) return { providers: [], rates: [], charges: [] };
  const providers = await db.select().from(businessShippingProviders)
    .where(eq(businessShippingProviders.businessId, businessId)).orderBy(asc(businessShippingProviders.displayName));
  const rates = await db.select().from(shippingRateVersions)
    .where(eq(shippingRateVersions.businessId, businessId)).orderBy(desc(shippingRateVersions.effectiveFrom));
  const charges = rates.length > 0 ? await db.select().from(shippingRateCharges)
    .where(and(eq(shippingRateCharges.businessId, businessId), inArray(shippingRateCharges.rateVersionId, rates.map(rate => rate.id)))) : [];
  return { providers, rates, charges };
}

/**
 * إيقاف شركة شحن — مش حذف.
 *
 * التسويات القديمة بتشاور على الصف ده (`carrier_settlements.businessShippingProviderId`)،
 * فحذفه بيخلي تحصيلات الشهور اللي فاتت تعرض شركة مفقودة. الإيقاف بيشيلها من قوايم
 * الاختيار وبيسيب التاريخ سليم — نفس منطق أرشفة تصنيف المصروف.
 */
export async function deactivateBusinessShippingProvider(input: {
  businessId: number;
  businessShippingProviderId: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db
    .select()
    .from(businessShippingProviders)
    .where(
      and(
        eq(businessShippingProviders.id, input.businessShippingProviderId),
        eq(businessShippingProviders.businessId, input.businessId)
      )
    )
    .limit(1);
  if (!row) throw new Error("شركة الشحن مش تابعة للنشاط ده");
  await db
    .update(businessShippingProviders)
    .set({ isActive: false })
    .where(eq(businessShippingProviders.id, row.id));
  return { id: row.id };
}
