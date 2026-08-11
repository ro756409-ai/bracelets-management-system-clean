/**
 * محتوى الأوردر — **نسخة واحدة حالية**.
 *
 * الأوردر بيعدّي على أربع محطات: الموقع ← متجرك ← تعديل الموظف ← بوسطة ← البوليصة
 * المطبوعة. المحطات دي كلها لازم تقرا نفس النسخة، والنسخة دي هي `order_items`.
 *
 * أعمدة الهيدر في `orders` (productName/quantity/variantId/…) **مرآة** للبنود، موجودة
 * لتوافق الشاشات والتقارير القديمة — مش مصدر مستقل. العطل اللي الملف ده بيقفله كان
 * بالظبط كده: مسار تعديل بيكتب في المرآة من غير الأصل، فالشاشة بتوريك الجديد وبوسطة
 * بتاخد القديم.
 *
 * الملف ده مالوش أي اعتماد على قاعدة البيانات عن قصد: القواعد اللي جواه (إيه اللي يعتبر
 * تغيير في محتوى الصندوق، وإزاي الوصف بيتبني) لازم تكون قابلة للاختبار من غير سيرفر،
 * لأنها بتتنفّذ في مكانين — الحفظ والإرسال.
 */

/**
 * أعمدة الهيدر اللي بتوصف اللي جوه الصندوق فعليًا.
 *
 * `totalAmount` و`shippingFees` مش هنا: دول فلوس مش محتوى. تغييرهم مايغيّرش اللي
 * المندوب بيسلّمه، فما ينفعش يولّد تحذير «بوسطة عندها نسخة قديمة».
 */
export const ORDER_CONTENT_HEADER_FIELDS = [
  "productId",
  "productName",
  "quantity",
  "variantId",
  "size",
  "color",
] as const;

export type OrderContentHeaderField =
  (typeof ORDER_CONTENT_HEADER_FIELDS)[number];

/** القيمة اللي `replaceOrderItemsFromEditor` بتسجّل بيها تعديل السلة كلها. */
export const ORDER_ITEMS_LOG_FIELD = "orderItems";

/** قيم `order_edit_logs.field` اللي معناها إن محتوى الصندوق اتغيّر. */
export const ORDER_CONTENT_LOG_FIELDS: readonly string[] = [
  ...ORDER_CONTENT_HEADER_FIELDS,
  ORDER_ITEMS_LOG_FIELD,
];

/** هل الحقل ده بيوصف محتوى الصندوق؟ */
export function isOrderContentField(field: string): boolean {
  return ORDER_CONTENT_LOG_FIELDS.includes(field);
}

/**
 * هل الأوردر اتعدّل محتواه بعد ما الشحنة اتبعتت لبوسطة؟
 *
 * **بيسأل عن المحتوى بس.** تصحيح رقم تليفون أو ملاحظة داخلية بعد الإرسال مايستاهلش
 * تحذير — ولو ولّد تحذير، التاجر هيتعوّد يتجاهله، وساعتها التحذير الحقيقي مايبقاش
 * ليه لازمة.
 */
export function orderContentChangedAfterShipment(
  logs: { field: string; createdAt: Date | string }[],
  bostaSentAt: Date | string | null | undefined
): boolean {
  if (!bostaSentAt) return false;
  const sentAt = new Date(bostaSentAt).getTime();
  if (Number.isNaN(sentAt)) return false;
  return logs.some(log => {
    if (!isOrderContentField(log.field)) return false;
    const at = new Date(log.createdAt).getTime();
    return !Number.isNaN(at) && at > sentAt;
  });
}

export const SHIPMENT_STALE_WARNING =
  "تم تعديل محتوى الأوردر بعد إرسال الشحنة لبوسطة. بيانات الشحنة في بوسطة قد تكون النسخة القديمة.";

// ==================== وصف الشحنة ====================

export interface ShipmentContentLine {
  productName: string;
  /** اسم الـvariant — نوع الحفر/التخصيص زي ما هو متسجّل في الكتالوج. */
  variantName?: string | null;
  quantity: number;
  size?: string | null;
  color?: string | null;
}

/**
 * بوسطة بترفض الوصف الطويل. الحد هنا محافظ عن قصد — أقل من اللي بوسطة بتقبله —
 * عشان شحنة ما تترفضش بسبب سلة كبيرة.
 */
export const SHIPMENT_DESCRIPTION_LIMIT = 480;

/** فاصل البنود في الوصف. */
const LINE_SEPARATOR = "، ";

/** بند واحد ← نص. */
export function describeShipmentLine(line: ShipmentContentLine): string {
  const variant = (line.variantName ?? "").trim();
  const base = variant ? `${line.productName} - ${variant}` : line.productName;
  // المقاس واللون بيتضافوا لما يكونوا موجودين بس. البند اللي مالوش مقاس مايتكتبش
  // «(مقاس: )» — الفراغ ده بيخلي البوليصة تبان غلط ومحدش بيثق فيها.
  const extras: string[] = [];
  const size = (line.size ?? "").trim();
  const color = (line.color ?? "").trim();
  if (size) extras.push(`مقاس ${size}`);
  if (color) extras.push(`لون ${color}`);
  const detail = extras.length > 0 ? `${base} (${extras.join("، ")})` : base;
  return `${detail} ×${line.quantity}`;
}

/**
 * البنود الحالية ← الوصف وعدد القطع اللي بيتبعتوا لبوسطة.
 *
 * **Deterministic**: نفس البنود بتدي نفس النص بالحرف، فأي اختلاف بين اللي على الشاشة
 * واللي في بوسطة يبقى اختلاف في البنود نفسها مش في التنسيق.
 *
 * القص بيشيل **بنود كاملة** مش نص مقطوع من نص بند: «أسورة - آية الك…» على بوليصة
 * بتوصل لمندوب أسوأ من إن البند ما يظهرش أصلاً ومكتوب إن فيه باقي. وعدد القطع فوق
 * بيفضل هو الإجمالي الحقيقي مهما اتقص الوصف.
 */
export function buildShipmentContents(
  lines: ShipmentContentLine[],
  fallback: { productName?: string | null; quantity?: number | null } = {}
): { description: string; itemsCount: number } {
  const fallbackDescription = (fallback.productName ?? "").trim() || "أساور نحاسية";
  const fallbackCount = fallback.quantity ?? 1;

  if (lines.length === 0) {
    return { description: fallbackDescription, itemsCount: fallbackCount };
  }

  const totalQuantity = lines.reduce((sum, l) => sum + (l.quantity || 0), 0);
  const itemsCount = totalQuantity > 0 ? totalQuantity : fallbackCount;
  const rendered = lines.map(describeShipmentLine);

  const full = rendered.join(LINE_SEPARATOR);
  if (full.length <= SHIPMENT_DESCRIPTION_LIMIT) {
    return { description: full, itemsCount };
  }

  const kept: string[] = [];
  let used = 0;
  for (const text of rendered) {
    const addition = kept.length === 0 ? text.length : LINE_SEPARATOR.length + text.length;
    const remaining = rendered.length - kept.length - 1;
    const suffix = remaining > 0 ? ` +${remaining} صنف` : "";
    if (used + addition + suffix.length > SHIPMENT_DESCRIPTION_LIMIT) break;
    kept.push(text);
    used += addition;
  }

  const dropped = rendered.length - kept.length;
  if (kept.length === 0) {
    // بند واحد أطول من الحد كله — هنا القص من جوه البند هو الاختيار الوحيد.
    return {
      description: `${rendered[0].slice(0, SHIPMENT_DESCRIPTION_LIMIT - 1).trimEnd()}…`,
      itemsCount,
    };
  }
  return {
    description:
      dropped > 0
        ? `${kept.join(LINE_SEPARATOR)} +${dropped} صنف`
        : kept.join(LINE_SEPARATOR),
    itemsCount,
  };
}
