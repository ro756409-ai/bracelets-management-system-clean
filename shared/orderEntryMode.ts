/**
 * قالب شاشة إدخال الأوردر — إعداد **لكل نشاط**، بيتقرا من السيرفر بهوية الجلسة.
 *
 * الإعداد بيتخزّن في `business_configuration_values` تحت `namespace="order_entry"` و
 * `configKey="mode"` (مفيش عمود جديد ولا Migration). الافتراضي `catalog_variants` وهو
 * سلوك كل الأنشطة النهاردة — فالنشر بلا تغيير لحد ما المالك يختار قالبًا تانيًا.
 *
 * الملف في `shared/` عشان الواجهة والسيرفر يستخدموا نفس الأسماء، ومفيش أي اعتماد على
 * قاعدة بيانات.
 */

export const ORDER_ENTRY_NAMESPACE = "order_entry";
export const ORDER_ENTRY_CONFIG_KEY = "mode";

export const ORDER_ENTRY_MODES = ["catalog_variants", "bracelets_legacy"] as const;
export type OrderEntryMode = (typeof ORDER_ENTRY_MODES)[number];

export const DEFAULT_ORDER_ENTRY_MODE: OrderEntryMode = "catalog_variants";

export const ORDER_ENTRY_MODE_LABEL: Record<OrderEntryMode, string> = {
  catalog_variants: "الكتالوج الكامل (ألوان ومقاسات وسلة)",
  bracelets_legacy: "إدخال مبسّط (نوع النقش والكمية)",
};

export function isOrderEntryMode(v: unknown): v is OrderEntryMode {
  return typeof v === "string" && (ORDER_ENTRY_MODES as readonly string[]).includes(v);
}

/**
 * يحوّل القيمة المخزّنة لقالب صالح — أي حاجة غير معروفة (null، JSON بايظ، قيمة
 * قديمة) → الافتراضي. **مابيرميش أبدًا**: خطأ في الإعداد مايوقعش الصفحة.
 */
export function parseOrderEntryMode(raw: unknown): OrderEntryMode {
  if (isOrderEntryMode(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (isOrderEntryMode(parsed)) return parsed;
    } catch {
      /* نص مش JSON — بيتجاهل */
    }
  }
  return DEFAULT_ORDER_ENTRY_MODE;
}
