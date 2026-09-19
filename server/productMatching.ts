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
  currentStock?: number | null;
}

export interface MatchableVariant {
  id: number;
  productId: number;
  name: string | null;
  sku: string | null;
  price: string | null;
  isActive?: boolean;
  color?: string | null;
  size?: string | null;
  currentStock?: number | null;
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

/** أرقام عربية-هندية → ASCII (٠-٩ و ۰-۹). */
export function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, d => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/**
 * تطبيع اللون للمطابقة: تطبيع عربي (أ→ا، ة→ه...) + حروف صغيرة. فـ«أسود» و«اسود» و«Black»
 * (بعد lowercase) بتتقارن بثبات؛ الألوان الإنجليزية بتفضل زي ما هي بعد التصغير.
 */
export function normalizeColor(text: string | null | undefined): string {
  if (!text) return "";
  return normalizeArabic(text);
}

/**
 * تطبيع المقاس: بيستخرج أرقام المقاس ويتجاهل الكلمات (مقاس/من/إلى/لـ/سنين/سنة/عام). فـ
 * «مقاس 6» و«6» و«من 6 سنين» كلها → "6". النطاق بيتحوّل لـ**الحد الأعلى** (اللي بيطابق مقاس
 * المخزون المفرد): «من 5 إلى 6 سنين» → "6"، «من 6 إلى 8» → "8"، «من 10 إلى 12 سنة» → "12".
 * لو مفيش أرقام، بيرجّع النص المطبّع.
 */
export function normalizeSize(text: string | null | undefined): string {
  if (!text) return "";
  const digits = normalizeDigits(String(text));
  const nums = digits.match(/\d+/g);
  if (nums && nums.length > 0) {
    return String(Math.max(...nums.map(n => parseInt(n, 10))));
  }
  return normalizeArabic(digits);
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

/**
 * مجموعات أسماء المنتجات المكافئة (aliases). كل مجموعة = أسماء بتشير لنفس المنتج، بتُطابَق
 * **فقط مع منتجات الكتالوج الممرَّر (المعزول بالنشاط)**. مش mapping لمنتج بعينه — مجرد توسيع
 * للمكافئات النصية، فمستحيل تسحب منتج نشاط تاني. الإضافة هنا آمنة طالما المجموعة أسماء ملابس
 * أطفال (ماينفعش تطابق منتج أساور لأنه مش في كتالوج Afandy Kids أصلًا).
 */
export const PRODUCT_NAME_ALIASES: string[][] = [
  // ملابس أطفال (Afandy Kids) — أسماء مكافئة لنفس المنتج.
  [
    "بدلة كورن للأطفال",
    "بدلة كورن للاطفال",
    "بدله كورن للاطفال",
    "بدلة كورن",
    "بدله كورن",
    "كورن اطفالي",
    "طقم اطفال",
    "طقم أطفال",
    "طقم كورن",
    "ملابس اطفالي",
    "ملابس أطفالي",
    "ملابس اطفال",
    "ملابس أطفال",
    "لبس اطفالي",
    "لبس اطفال",
  ],
];

/**
 * يحلّ المنتج عبر الأسماء البديلة: لو الاسم المستلَم يطابق (تطبيعًا) عضوًا في مجموعة، بنجمّع
 * كل منتجات الكتالوج اللي تطابق أي عضو في نفس المجموعة. منتج واحد فريد → مطابقة؛ أكتر من
 * منتج مختلف → غموض (بلا تخمين)؛ صفر → لا شيء.
 */
export function resolveProductByAlias(
  name: string,
  products: MatchableProduct[]
): { hit: MatchableProduct | null; ambiguous?: boolean } {
  const n = normalizeArabic(name);
  if (!n) return { hit: null };
  for (const group of PRODUCT_NAME_ALIASES) {
    const normGroup = group.map(normalizeArabic);
    const nameInGroup = normGroup.some(g => n === g || n.includes(g) || g.includes(n));
    if (!nameInGroup) continue;
    const matched = products.filter(p => {
      const pn = normalizeArabic(p.name);
      return normGroup.some(g => pn === g || pn.includes(g) || g.includes(pn));
    });
    const uniqueIds = Array.from(new Set(matched.map(p => p.id)));
    if (uniqueIds.length === 1) return { hit: matched.find(p => p.id === uniqueIds[0])! };
    if (uniqueIds.length > 1) return { hit: null, ambiguous: true };
  }
  return { hit: null };
}

// ============================================================
// Import matcher (Excel / EasyOrder file) — variant-aware, STRICT (never guesses).
// ============================================================

export interface ImportMatchInput {
  /** SKU as printed in the file (variant SKU preferred, product SKU accepted). */
  sku?: string | null;
  /** Product name as printed (may embed color/size — extract those into color/size first). */
  name?: string | null;
  color?: string | null;
  size?: string | null;
  /** Raw variant/option text (e.g. bracelet engraving "نوع الحفر: آية الكرسي") — fallback. */
  variantText?: string | null;
}

export type ImportMatchResult =
  | {
      matched: true;
      method: "variant_sku" | "product_sku_variant" | "name_color_size" | "product_only" | "color_size_unique";
      productId: number;
      productName: string;
      variantId?: number;
      variantName?: string;
      color?: string | null;
      size?: string | null;
      sku?: string | null;
      unitPrice: string | null;
    }
  | {
      matched: false;
      reason: string;
      /** ما استُلم فعلًا — لعرضه في تقرير الفشل بدقة. */
      received: { name?: string | null; color?: string | null; size?: string | null; sku?: string | null };
    };

/**
 * يطابق صنفًا قادمًا من ملف استيراد بمنتج + تركيبة، **بلا تخمين** يخصم من تركيبة خاطئة:
 *   1) Variant SKU (الأدق).
 *   2) Product SKU → ثم تحديد التركيبة داخله باللون+المقاس (لو للمنتج تركيبات).
 *   3) اسم المنتج (بعد التطبيع) → ثم تحديد التركيبة باللون+المقاس.
 * منتج له تركيبات لكن اللون/المقاس مش متطابق = فشل صريح (مش product-only)، فمفيش خصم غلط.
 * منتج بسيط (بلا تركيبات) = مطابقة على مستوى المنتج.
 */
export function matchImportItem(
  input: ImportMatchInput,
  catalog: MatchCatalog
): ImportMatchResult {
  const activeVariants = catalog.variants.filter(v => v.isActive !== false);
  const variantsOf = (pid: number) => activeVariants.filter(v => v.productId === pid);
  const received = {
    name: input.name ?? null,
    color: input.color ?? null,
    size: input.size ?? null,
    sku: input.sku ?? null,
  };
  const wantColor = normalizeColor(input.color);
  const wantSize = normalizeSize(input.size);

  // ── 1) Variant SKU مباشر ──
  const sku = input.sku?.trim();
  if (sku) {
    const s = normSku(sku);
    const vHits = activeVariants.filter(v => v.sku && normSku(v.sku) === s);
    if (vHits.length === 1) {
      const p = catalog.products.find(pp => pp.id === vHits[0].productId);
      if (p)
        return {
          matched: true, method: "variant_sku", productId: p.id, productName: p.name,
          variantId: vHits[0].id, variantName: vHits[0].name ?? undefined,
          color: vHits[0].color ?? null, size: vHits[0].size ?? null, sku: vHits[0].sku,
          unitPrice: vHits[0].price ?? p.price,
        };
    }
    if (vHits.length > 1)
      return { matched: false, reason: `رمز التركيبة (SKU) "${sku}" مرتبط بأكثر من تركيبة`, received };
  }

  // ── حدّد المنتج: Product SKU ثم الاسم المطبّع ──
  let product = null as MatchableProduct | null;
  let productMethod: "product_sku_variant" | "name_color_size" = "name_color_size";
  if (sku) {
    const s = normSku(sku);
    const pHits = catalog.products.filter(p => p.sku && normSku(p.sku) === s);
    if (pHits.length === 1) { product = pHits[0]; productMethod = "product_sku_variant"; }
    else if (pHits.length > 1)
      return { matched: false, reason: `رمز المنتج (SKU) "${sku}" مرتبط بأكثر من منتج`, received };
  }
  if (!product && input.name?.trim()) {
    const { hit, ambiguousWith } = matchByName(input.name, catalog.products, p => p.name);
    if (hit) product = hit;
    else if (ambiguousWith && ambiguousWith.length > 1)
      return { matched: false, reason: `اسم المنتج "${input.name}" يطابق أكثر من منتج`, received };
  }
  // (fallback آمن) أسماء بديلة: لو الاسم المستلَم عضو في مجموعة أسماء مكافئة، نطابق أي عضو
  // في المجموعة مع **منتجات النشاط الحالي فقط** (catalog معزول). لو أدّت لأكثر من منتج
  // مختلف → غموض بلا تخمين. مستحيل توصل لمنتج نشاط تاني لأن الكتالوج مقيّد بالنشاط.
  if (!product && input.name?.trim()) {
    const aliasRes = resolveProductByAlias(input.name, catalog.products);
    if (aliasRes.hit) product = aliasRes.hit;
    else if (aliasRes.ambiguous)
      return { matched: false, reason: `اسم المنتج "${input.name}" (اسم بديل) يطابق أكثر من منتج`, received };
  }
  // (fallback حتمي — بلا تخمين) لو الاسم/الـSKU مش حاسمين، بس في **تركيبة واحدة فريدة**
  // في النشاط (الكتالوج معزول) تطابق اللون+المقاس بالظبط → نستخدمها. مش تخمين: التركيبة
  // فريدة على مستوى النشاط. أكتر من تركيبة → غموض → مانكملش (فشل صريح تحت). للأساور مافيش
  // تركيبات لون/مقاس فمابيتفعّلش، ومستحيل يوصل لمنتج نشاط تاني (الكتالوج مقيّد بالنشاط).
  if (!product && wantColor && wantSize) {
    const csMatches = activeVariants.filter(
      v => normalizeColor(v.color) === wantColor && normalizeSize(v.size) === wantSize
    );
    if (csMatches.length === 1) {
      const v = csMatches[0];
      const p = catalog.products.find(pp => pp.id === v.productId);
      if (p)
        return {
          matched: true, method: "color_size_unique", productId: p.id, productName: p.name,
          variantId: v.id, variantName: v.name ?? undefined,
          color: v.color ?? null, size: v.size ?? null, sku: v.sku,
          unitPrice: v.price ?? p.price,
        };
    }
  }
  if (!product) {
    // سبب واضح + قائمة منتجات النشاط (معزولة) عشان الموظف يشوف الأسماء الفعلية ويطابق يدويًا.
    const available = catalog.products.map(p => p.name).slice(0, 12).join("، ") || "لا توجد منتجات في هذا النشاط";
    return {
      matched: false,
      reason:
        `لا يوجد منتج مطابق للاسم "${input.name ?? ""}"${sku ? ` أو الرمز "${sku}"` : ""}` +
        ` — منتجات نشاطك المتاحة: ${available}`,
      received,
    };
  }

  // ── حدّد التركيبة داخل المنتج ──
  const vs = variantsOf(product.id);
  if (vs.length === 0) {
    // منتج بسيط بلا تركيبات — مطابقة على مستوى المنتج.
    return {
      matched: true, method: "product_only", productId: product.id, productName: product.name,
      color: null, size: null, sku: product.sku, unitPrice: product.price,
    };
  }
  // المنتج له تركيبات → نحدّد واحدة (بلا تخمين):
  // (أ) باللون+المقاس لو موجودين (ملابس).
  if (wantColor || wantSize) {
    const byCS = vs.filter(v =>
      (!wantColor || normalizeColor(v.color) === wantColor) &&
      (!wantSize || normalizeSize(v.size) === wantSize)
    );
    if (byCS.length === 1) {
      const v = byCS[0];
      return {
        matched: true, method: productMethod, productId: product.id, productName: product.name,
        variantId: v.id, variantName: v.name ?? undefined,
        color: v.color ?? null, size: v.size ?? null, sku: v.sku,
        unitPrice: v.price ?? product.price,
      };
    }
    if (byCS.length > 1)
      return {
        matched: false,
        reason: `أكثر من تركيبة تطابق اللون "${input.color ?? ""}" والمقاس "${input.size ?? ""}" في "${product.name}"`,
        received,
      };
    return {
      matched: false,
      reason: `مفيش تركيبة باللون "${input.color ?? ""}" والمقاس "${input.size ?? ""}" في المنتج "${product.name}"`,
      received,
    };
  }
  // (ب) باسم التركيبة (fallback للأساور: نوع الحفر) — من variantText ثم الاسم بعد التنظيف.
  const nameCandidates: string[] = [];
  if (input.variantText) nameCandidates.push(extractVariantLabel(input.variantText));
  if (input.name) { nameCandidates.push(stripBraceletPrefix(input.name)); nameCandidates.push(input.name); }
  for (const c of nameCandidates) {
    if (!c?.trim()) continue;
    const { hit, ambiguousWith } = matchByName(c, vs, v => v.name);
    if (hit)
      return {
        matched: true, method: productMethod, productId: product.id, productName: product.name,
        variantId: hit.id, variantName: hit.name ?? undefined,
        color: hit.color ?? null, size: hit.size ?? null, sku: hit.sku,
        unitPrice: hit.price ?? product.price,
      };
    if (ambiguousWith && ambiguousWith.length > 1)
      return {
        matched: false,
        reason: `"${c}" يطابق أكثر من نوع في "${product.name}"`,
        received,
      };
  }
  // مفيش لون/مقاس ولا اسم تركيبة يحسم — فشل صريح (مايتخصمش من الأب).
  return {
    matched: false,
    reason: `المنتج "${product.name}" له تركيبات (ألوان/مقاسات/أنواع) لكن الصف مافيهوش ما يحدّد التركيبة`,
    received,
  };
}
