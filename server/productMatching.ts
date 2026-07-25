/**
 * Shared product/variant matching for incoming external orders (EasyOrder webhook + manual sync).
 *
 * The catalog is a parent-product / variant model (see PROJECT_CONTEXT.md §4b):
 * "أسورة نحاس" is ONE product whose engraving types are variants, while other lines
 * (مسند سيارة, كفر مرتبة ووتر بروف, ...) are standalone products with no variants.
 *
 * Matching order — most reliable signal first, and it NEVER guesses:
 *   1. variant SKU   (exact, case-insensitive)   → product + variant
 *   2. product SKU   (exact, case-insensitive)   → product
 *   3. variant name  (exact, then unique substring, on Arabic-normalized text)
 *   4. product name  (exact, then unique substring, on Arabic-normalized text)
 * Anything that resolves to zero OR to more than one candidate is reported as unmatched /
 * ambiguous so the caller can flag the order for manual review — it is never silently
 * attached to an arbitrary product.
 */

export interface MatchableProduct {
  id: number;
  name: string;
  sku: string | null;
  price: string | null;
  businessId?: number | null;
}

export interface MatchableVariant {
  id: number;
  productId: number;
  name: string | null;
  sku: string | null;
  price: string | null;
  isActive?: boolean;
}

export interface MatchCatalog {
  products: MatchableProduct[];
  variants: MatchableVariant[];
}

export type MatchMethod = "variant_sku" | "product_sku" | "variant_name" | "product_name";

export type MatchResult =
  | {
      matched: true;
      method: MatchMethod;
      productId: number;
      productName: string;
      variantId?: number;
      variantName?: string;
      unitPrice: string | null;
    }
  | {
      matched: false;
      reason: string;
      /** Set when the lookup found several equally-plausible candidates rather than none. */
      ambiguous?: boolean;
      candidates?: string[];
    };

/**
 * Normalizes Arabic text so spelling variants compare equal:
 * alef forms (أإآ→ا), ta marbuta (ة→ه), alef maqsura (ى→ي), tatweel, diacritics,
 * and whitespace. Applied to BOTH sides of every name comparison.
 */
export function normalizeArabic(text: string): string {
  return text
    .replace(/[ً-ْٰ]/g, "") // harakat / diacritics
    .replace(/ـ/g, "")                 // tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normSku(sku: string): string {
  return sku.trim().toLowerCase();
}

/** Exact match, then single-candidate substring containment. Null when zero or 2+ candidates. */
function matchByName<T>(
  target: string,
  candidates: T[],
  getName: (c: T) => string | null | undefined
): { hit: T | null; ambiguousWith?: T[] } {
  const t = normalizeArabic(target);
  if (!t) return { hit: null };

  const named = candidates.filter((c) => {
    const n = getName(c);
    return typeof n === "string" && n.trim().length > 0;
  });

  const exact = named.filter((c) => normalizeArabic(getName(c)!) === t);
  if (exact.length === 1) return { hit: exact[0] };
  if (exact.length > 1) return { hit: null, ambiguousWith: exact };

  const contains = named.filter((c) => {
    const n = normalizeArabic(getName(c)!);
    return t.includes(n) || n.includes(t);
  });
  if (contains.length === 1) return { hit: contains[0] };
  if (contains.length > 1) return { hit: null, ambiguousWith: contains };

  return { hit: null };
}

export interface MatchInput {
  /** SKU reported by the external system, if any. Highest-confidence signal. */
  sku?: string | null;
  /** Product name as reported by the external system. */
  name?: string | null;
  /** Variant/option text, e.g. "نوع الحفر: آية الكرسي" or "اللون: ذهبي". */
  variantText?: string | null;
}

/** Pulls the meaningful value out of "نوع الحفر: X" / "الحفر - X" style option text. */
export function extractVariantLabel(variantText: string): string {
  const patterns = [
    /نوع\s*الحفر\s*[:\-–]\s*(.+)/,
    /الحفر\s*[:\-–]\s*(.+)/,
    /النوع\s*[:\-–]\s*(.+)/,
    /حفر\s*[:\-–]\s*(.+)/,
  ];
  const firstLine = variantText.split("\n")[0].trim();
  for (const p of patterns) {
    const m = firstLine.match(p);
    if (m) return m[1].trim();
  }
  return firstLine;
}

/** Strips generic bracelet wording so "أسورة نحاس آحمر طبي - نوع الحفر: آية الكرسي" → "آية الكرسي". */
export function stripBraceletPrefix(text: string): string {
  return normalizeArabic(text)
    .replace(/اسوره?\s*/g, "")
    .replace(/نحاس\s*/g, "")
    .replace(/احمر\s*/g, "")
    .replace(/طبي\s*/g, "")
    .replace(/نوع\s*الحفر\s*[:\-–]?\s*/g, "")
    .replace(/[\-–—]\s*/g, "")
    .trim();
}

/**
 * Resolves one external line item to a local product (+ variant when applicable).
 * Only active variants are considered.
 */
export function matchExternalItem(input: MatchInput, catalog: MatchCatalog): MatchResult {
  const activeVariants = catalog.variants.filter((v) => v.isActive !== false);
  const productById = new Map(catalog.products.map((p) => [p.id, p]));

  // ---- 1. variant SKU (most reliable) ----
  const sku = input.sku?.trim();
  if (sku) {
    const s = normSku(sku);
    const variantHits = activeVariants.filter((v) => v.sku && normSku(v.sku) === s);
    if (variantHits.length === 1) {
      const v = variantHits[0];
      const parent = productById.get(v.productId);
      if (parent) {
        return {
          matched: true,
          method: "variant_sku",
          productId: parent.id,
          productName: parent.name,
          variantId: v.id,
          variantName: v.name ?? undefined,
          unitPrice: v.price ?? parent.price,
        };
      }
    }
    if (variantHits.length > 1) {
      return {
        matched: false,
        ambiguous: true,
        reason: `رمز المنتج (SKU) "${sku}" مرتبط بأكثر من نوع`,
        candidates: variantHits.map((v) => v.name ?? `#${v.id}`),
      };
    }

    // ---- 2. product SKU ----
    const productHits = catalog.products.filter((p) => p.sku && normSku(p.sku) === s);
    if (productHits.length === 1) {
      const p = productHits[0];
      return {
        matched: true,
        method: "product_sku",
        productId: p.id,
        productName: p.name,
        unitPrice: p.price,
      };
    }
    if (productHits.length > 1) {
      return {
        matched: false,
        ambiguous: true,
        reason: `رمز المنتج (SKU) "${sku}" مرتبط بأكثر من منتج`,
        candidates: productHits.map((p) => p.name),
      };
    }
  }

  // ---- 3. variant name ----
  // Try the explicit option text first, then the product name with generic bracelet
  // wording stripped (legacy EasyOrder titles embed the engraving type in the name).
  const nameCandidates: string[] = [];
  if (input.variantText) nameCandidates.push(extractVariantLabel(input.variantText));
  if (input.name) {
    nameCandidates.push(stripBraceletPrefix(input.name));
    nameCandidates.push(input.name);
  }

  for (const candidate of nameCandidates) {
    if (!candidate?.trim()) continue;
    const { hit, ambiguousWith } = matchByName(candidate, activeVariants, (v) => v.name);
    if (hit) {
      const parent = productById.get(hit.productId);
      if (parent) {
        return {
          matched: true,
          method: "variant_name",
          productId: parent.id,
          productName: parent.name,
          variantId: hit.id,
          variantName: hit.name ?? undefined,
          unitPrice: hit.price ?? parent.price,
        };
      }
    }
    if (ambiguousWith && ambiguousWith.length > 1) {
      return {
        matched: false,
        ambiguous: true,
        reason: `"${candidate}" يطابق أكثر من نوع`,
        candidates: ambiguousWith.map((v) => v.name ?? `#${v.id}`),
      };
    }
  }

  // ---- 4. product name (standalone products) ----
  if (input.name?.trim()) {
    const { hit, ambiguousWith } = matchByName(input.name, catalog.products, (p) => p.name);
    if (hit) {
      return {
        matched: true,
        method: "product_name",
        productId: hit.id,
        productName: hit.name,
        unitPrice: hit.price,
      };
    }
    if (ambiguousWith && ambiguousWith.length > 1) {
      return {
        matched: false,
        ambiguous: true,
        reason: `"${input.name}" يطابق أكثر من منتج`,
        candidates: ambiguousWith.map((p) => p.name),
      };
    }
  }

  const described = [input.sku && `SKU "${input.sku}"`, input.name && `"${input.name}"`]
    .filter(Boolean)
    .join(" / ");
  return {
    matched: false,
    reason: `لا يوجد منتج أو نوع مطابق لـ ${described || "صنف بلا اسم أو SKU"}`,
  };
}
