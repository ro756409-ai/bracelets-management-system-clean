/**
 * Central duplicate-order classification.
 *
 * A "same phone number" match by itself is treated as a repeat customer,
 * not an automatic duplicate — it never appears alone as a reason to skip
 * or reject an order. Only the stronger, combined signals below are
 * suitable for automated duplicate handling; "samePhone" is informational.
 */
import { normalizeEgyptianPhone } from "../shared/phone";

export type DuplicateSignal =
  | "samePhone"
  | "samePhoneAndProduct"
  | "samePhoneAndAddress"
  | "sameExternalOrderId"
  | "sameTrackingNumber";

export interface DuplicateCandidate {
  customerPhone?: string | null;
  customerAddress?: string | null;
  productId?: number | null;
  productName?: string | null;
  externalOrderId?: string | null;
  bostaTrackingNumber?: string | null;
}

export interface ExistingOrderForDuplicateCheck extends DuplicateCandidate {
  id: number;
}

export interface DuplicateMatch {
  orderId: number;
  signals: DuplicateSignal[];
}

function normalizeAddress(address?: string | null): string {
  return (address ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeProductName(productName?: string | null): string {
  return (productName ?? "").trim().toLowerCase();
}

/**
 * Compares by productId only when both sides actually have one; otherwise
 * falls back to name comparison. This matters because callers often know a
 * new order's product only by name before it's matched against the catalog,
 * while already-stored orders always carry a resolved productId — comparing
 * by id-or-name per side independently would silently never match in that
 * (common) asymmetric case.
 */
function productsMatch(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  if (a.productId && b.productId) return a.productId === b.productId;
  const nameA = normalizeProductName(a.productName);
  const nameB = normalizeProductName(b.productName);
  return nameA.length > 0 && nameA === nameB;
}

/**
 * Compares a candidate order against a list of existing orders and returns,
 * for every existing order that shares at least one signal, exactly which
 * signals matched. Callers decide what to do with each signal (e.g. reject
 * on sameExternalOrderId/sameTrackingNumber, warn-only on samePhone).
 */
export function findPotentialDuplicates(
  candidate: DuplicateCandidate,
  existingOrders: ExistingOrderForDuplicateCheck[]
): DuplicateMatch[] {
  const candidatePhone = normalizeEgyptianPhone(candidate.customerPhone);
  const candidateAddress = normalizeAddress(candidate.customerAddress);
  const candidateExternalId = (candidate.externalOrderId ?? "").trim();
  const candidateTrackingNumber = (candidate.bostaTrackingNumber ?? "").trim();

  const matches: DuplicateMatch[] = [];

  for (const existing of existingOrders) {
    const signals: DuplicateSignal[] = [];

    if (candidateExternalId && candidateExternalId === (existing.externalOrderId ?? "").trim()) {
      signals.push("sameExternalOrderId");
    }

    if (
      candidateTrackingNumber &&
      candidateTrackingNumber === (existing.bostaTrackingNumber ?? "").trim()
    ) {
      signals.push("sameTrackingNumber");
    }

    const existingPhone = normalizeEgyptianPhone(existing.customerPhone);
    const phoneMatches = candidatePhone.length > 0 && candidatePhone === existingPhone;

    if (phoneMatches) {
      signals.push("samePhone");

      if (productsMatch(candidate, existing)) {
        signals.push("samePhoneAndProduct");
      }

      if (candidateAddress.length > 0 && candidateAddress === normalizeAddress(existing.customerAddress)) {
        signals.push("samePhoneAndAddress");
      }
    }

    if (signals.length > 0) {
      matches.push({ orderId: existing.id, signals });
    }
  }

  return matches;
}

/** True if any match carries a signal strong enough to auto-skip/reject (never phone-alone). */
export function hasStrongDuplicateSignal(matches: DuplicateMatch[]): boolean {
  const strongSignals: DuplicateSignal[] = [
    "sameExternalOrderId",
    "sameTrackingNumber",
    "samePhoneAndProduct",
  ];
  return matches.some(m => m.signals.some(s => strongSignals.includes(s)));
}
