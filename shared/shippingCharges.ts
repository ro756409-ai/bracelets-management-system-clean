import { fromMinorUnits, percentageOf, toMinorUnits } from "./accountingMoney";

export type ShippingCalculationType = "fixed" | "percentage";
export type PercentageBase = "collected_amount" | "custom_fixed_base";

export type ShippingChargeRule = {
  calculationType: ShippingCalculationType;
  value: string;
  percentageBase?: PercentageBase | null;
  customFixedBase?: string | null;
};

export function calculateShippingCharge(rule: ShippingChargeRule, collectedAmount: string): string {
  if (rule.calculationType === "fixed") return fromMinorUnits(toMinorUnits(rule.value));
  const base = rule.percentageBase === "custom_fixed_base"
    ? rule.customFixedBase
    : collectedAmount;
  if (base == null) throw new Error("Percentage charge requires a calculation base");
  return fromMinorUnits(percentageOf(base, rule.value));
}

export function shippingAdjustment(expected: string, actual: string): string {
  return fromMinorUnits(toMinorUnits(actual) - toMinorUnits(expected));
}
