import type { ParseResultV2, PriceSource } from "@shared/orderParse";
import type { Catalog, CatalogProduct, CatalogVariant, PickedItem } from "@/components/orders/VariantOrderPicker";

/**
 * قواعد سطر القالب المبسّط (`bracelets_legacy`) — نقية وقابلة للاختبار بلا React.
 *
 * السعر له مصدر (`priceSource`): من الرسالة (message)، موزَّع من إجمالي الرسالة
 * (allocated)، من الكتالوج (catalog)، أو يدوي (manual). **تغيير النوع أو الكمية لا يستبدل
 * سعرًا له مصدر** — سعر الكتالوج بيتحط بس لما السطر بلا سعر أصلًا. ده اللي كان بيرجّع
 * «160» من الكتالوج مكان السعر المكتوب في الرسالة.
 */

const num = (s: string | number | null | undefined) => {
  const n = Number(s ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** السطر ده سعره محسوم من مصدر ما (مايتلمسش عند تغيير النوع/الكمية)؟ */
export function hasSettledPrice(line: Pick<PickedItem, "unitPrice" | "priceSource">): boolean {
  return line.priceSource === "manual" || line.priceSource === "message" || line.priceSource === "allocated";
}

/** اختيار/تغيير النوع لسطر — الهوية من الكتالوج، والسعر يبقى لو له مصدر. */
export function applyTypeToLine(line: PickedItem, variant: CatalogVariant, product: CatalogProduct): PickedItem {
  const keep = hasSettledPrice(line) || (line.unitPrice > 0 && line.priceSource !== "catalog");
  const catalogPrice = num(variant.price ?? product.price);
  return {
    ...line,
    productId: product.id,
    productName: product.name,
    variantId: variant.id,
    sku: variant.sku ?? null,
    color: null,
    size: null,
    optionLabel: variant.name ?? null,
    availableStock: variant.currentStock ?? 0,
    unitPrice: keep ? line.unitPrice : catalogPrice,
    priceSource: keep ? line.priceSource ?? "manual" : "catalog",
    needsPick: false,
    needsVariantReview: false,
    pickReason: null,
    // النوع اتحدد يدويًا → مفيش غموض باقٍ في السطر. `aiAssisted` بيفضل زي ما هو (أصل السطر)،
    // والسيرفر بيسجّل في audit إن الموظف قبل الاقتراح أو صحّحه.
    confidence: "confident",
  };
}

/** تعديل السعر يدويًا → manual (ولا يُستبدل بعدها). */
export function setManualPrice(line: PickedItem, price: number): PickedItem {
  return { ...line, unitPrice: Math.max(0, num(price)), priceSource: "manual" };
}

/** تعديل الكمية — السعر كما هو. */
export function setLineQuantity(line: PickedItem, quantity: number): PickedItem {
  return { ...line, quantity: Math.max(1, Math.floor(num(quantity)) || 1) };
}

/** سطور ParseResultV2 → سطور القالب المبسّط (المطابقة جات من السيرفر على كتالوج النشاط). */
export function linesFromParse(v2: ParseResultV2, catalog: Catalog): PickedItem[] {
  return v2.lines.map(l => {
    const v = l.match?.variantId != null ? catalog.variants.find(x => x.id === l.match!.variantId) : undefined;
    const p = l.match ? catalog.products.find(x => x.id === l.match!.productId) : undefined;
    // المطابقة لازم تكون موجودة في كتالوج الجلسة نفسه — وإلا السطر يفضل غير محلول.
    const resolved = !!(l.match && p);
    return {
      productId: resolved ? p!.id : 0,
      productName: resolved ? p!.name : l.segmentText,
      variantId: resolved ? (v?.id ?? undefined) : undefined,
      sku: v?.sku ?? null,
      color: null,
      size: null,
      optionLabel: v?.name ?? l.match?.variantName ?? null,
      quantity: l.quantity,
      unitPrice: l.unitPrice ?? 0,
      availableStock: v?.currentStock ?? p?.currentStock ?? 0,
      needsPick: !resolved,
      pickReason: l.reason,
      priceSource: (l.priceSource ?? undefined) as PriceSource | undefined,
      confidence: resolved ? l.confidence : "unresolved",
      segmentText: l.segmentText,
      aiAssisted: l.aiAssisted,
    } as PickedItem;
  });
}

/** إجمالي السطر بالقرش الصحيح — للعرض ولمقارنة المجموع. */
export function lineTotal(line: Pick<PickedItem, "unitPrice" | "quantity">): number {
  return Math.round(num(line.unitPrice) * 100) * Math.max(1, Math.floor(num(line.quantity)) || 1) / 100;
}
