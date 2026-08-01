export const ACCOUNTING_SCALE = 4;
const SCALE_FACTOR = 10n ** BigInt(ACCOUNTING_SCALE);

export type MoneyValue = string | number | bigint;

export function toMinorUnits(value: MoneyValue): bigint {
  if (typeof value === "bigint") return value;
  const raw = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error(`Invalid money value: ${raw}`);
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");
  const padded = (fraction + "0".repeat(ACCOUNTING_SCALE + 1)).slice(0, ACCOUNTING_SCALE + 1);
  let result = BigInt(whole) * SCALE_FACTOR + BigInt(padded.slice(0, ACCOUNTING_SCALE));
  if (Number(padded[ACCOUNTING_SCALE] ?? "0") >= 5) result += 1n;
  return negative ? -result : result;
}

export function fromMinorUnits(value: bigint, scale = ACCOUNTING_SCALE): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / SCALE_FACTOR;
  const fraction = (absolute % SCALE_FACTOR).toString().padStart(ACCOUNTING_SCALE, "0");
  const shown = scale === ACCOUNTING_SCALE
    ? fraction
    : scale < ACCOUNTING_SCALE
      ? roundFraction(whole, fraction, scale)
      : fraction.padEnd(scale, "0");
  if (scale < ACCOUNTING_SCALE && shown.includes(".")) {
    const [roundedWhole, roundedFraction] = shown.split(".");
    return `${negative ? "-" : ""}${roundedWhole}.${roundedFraction}`;
  }
  return `${negative ? "-" : ""}${whole}${scale > 0 ? `.${shown}` : ""}`;
}

function roundFraction(whole: bigint, fraction: string, scale: number): string {
  if (scale < 0) throw new Error("Scale cannot be negative");
  const kept = fraction.slice(0, scale);
  const shouldRound = Number(fraction[scale] ?? "0") >= 5;
  if (!shouldRound) return scale > 0 ? `${whole}.${kept}` : whole.toString();
  const factor = 10n ** BigInt(scale);
  const combined = whole * factor + BigInt(kept || "0") + 1n;
  const roundedWhole = combined / factor;
  const roundedFraction = (combined % factor).toString().padStart(scale, "0");
  return scale > 0 ? `${roundedWhole}.${roundedFraction}` : roundedWhole.toString();
}

export function multiplyMoney(quantity: MoneyValue, unitAmount: MoneyValue): bigint {
  const q = toMinorUnits(quantity);
  const amount = toMinorUnits(unitAmount);
  return divideRounded(q * amount, SCALE_FACTOR);
}

export function percentageOf(base: MoneyValue, percent: MoneyValue): bigint {
  return divideRounded(toMinorUnits(base) * toMinorUnits(percent), 100n * SCALE_FACTOR);
}

export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Division by zero");
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export function allocateEvenly(total: MoneyValue, parts: number): bigint[] {
  if (!Number.isInteger(parts) || parts <= 0) throw new Error("Parts must be a positive integer");
  const amount = toMinorUnits(total);
  const base = amount / BigInt(parts);
  const result = Array.from({ length: parts }, () => base);
  result[parts - 1] += amount - base * BigInt(parts);
  return result;
}

export function allocateProportionally(total: MoneyValue, weights: bigint[]): bigint[] {
  if (weights.length === 0) return [];
  if (weights.some(weight => weight < 0n)) throw new Error("Allocation weights cannot be negative");
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight === 0n) return allocateEvenly(total, weights.length);
  const amount = toMinorUnits(total);
  let allocated = 0n;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return amount - allocated;
    const share = divideRounded(amount * weight, totalWeight);
    allocated += share;
    return share;
  });
}
