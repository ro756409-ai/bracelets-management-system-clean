import { GOVERNORATES, normalizeAr } from "./egyptGovernorates";

/**
 * اكتمال بيانات الشحن — قاعدة واحدة للسيرفر والواجهة.
 *
 * الأوردر بعنوان ناقص **يُحفظ** (لا يُرفض عند الإنشاء)، لكنه «محتاج استكمال بيانات»: لا يُؤكَّد، ولا يُرسل لبوسطة،
 * ولا يدخل شيت الشحن حتى يكتمل. ده **تنبيه مستقل** مشتق من الحقول نفسها — مش حالة أوردر جديدة ومش علم مخزّن
 * (فمايتقادمش: تصحيح العنوان يزيله فورًا).
 *
 *  • العنوان: 10 أحرف على الأقل بعد trim.
 *  • المحافظة: معروفة بمطابقة **دقيقة** لاسم من الـ27 (بعد التطبيع العربي: الهمزات/التاء المربوطة/الياء/المسافات)
 *    أو اسم بديل **معتمد** صراحةً في `GOVERNORATE_ALIASES` — بلا أي مطابقة جزئية ولا «أقرب نتيجة» ولا أول كلمة.
 *    «محافظة X» مقبولة (البادئة تُحذف ثم مطابقة دقيقة).
 */
export const MIN_SHIPPING_ADDRESS_LENGTH = 10;

/**
 * أسماء بديلة معتمدة → الاسم الرسمي. مصدرها الخرائط المعتمدة الموجودة في الكود (بوسطة/EasyOrder/الاستيراد) —
 * اختلافات كتابة فقط. مستبعد عمدًا: أسماء مناطق ليست محافظات («الساحل الشمالي» يمتد على أكثر من محافظة،
 * «العاشر من رمضان» مدينة) — لا تُخمَّن محافظتها.
 */
export const GOVERNORATE_ALIASES: Readonly<Record<string, string>> = {
  "قاهرة": "القاهرة", "cairo": "القاهرة",
  "جيزة": "الجيزة", "giza": "الجيزة",
  "اسكندرية": "الإسكندرية", "alexandria": "الإسكندرية",
  "قليوبية": "القليوبية",
  "شرقية": "الشرقية",
  "دقهلية": "الدقهلية",
  "غربية": "الغربية",
  "منوفية": "المنوفية",
  "بحيرة": "البحيرة",
  "كفرالشيخ": "كفر الشيخ",
  "بور سعيد": "بورسعيد",
  "اسماعيلية": "الإسماعيلية",
  "سويس": "السويس",
  "فيوم": "الفيوم",
  "منيا": "المنيا",
  "الاسيوط": "أسيوط",
  "اقصر": "الأقصر",
  "مرسي مطروح": "مطروح",
};

const CANONICAL_BY_KEY: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const g of GOVERNORATES) m.set(normalizeAr(g), g);
  for (const [alias, g] of Object.entries(GOVERNORATE_ALIASES)) m.set(normalizeAr(alias), g);
  return m;
})();

/** الاسم الرسمي للمحافظة من قيمة حقل المحافظة — مطابقة دقيقة أو بديل معتمد فقط، وإلا null. */
export function canonicalGovernorate(value: string | null | undefined): string | null {
  let key = normalizeAr(String(value ?? ""));
  if (!key) return null;
  key = key.replace(/^محافظه\s+/, "");
  return CANONICAL_BY_KEY.get(key) ?? null;
}

export type ShippingIssueCode = "address_missing" | "address_short" | "governorate_missing" | "governorate_unknown";
export type ShippingIssue = { code: ShippingIssueCode; message: string };
export type ShippingReadiness = { ready: boolean; issues: ShippingIssue[]; governorate: string | null };

export function shippingReadiness(order: { customerAddress?: string | null; governorate?: string | null }): ShippingReadiness {
  const issues: ShippingIssue[] = [];
  const address = String(order.customerAddress ?? "").trim();
  if (!address) issues.push({ code: "address_missing", message: "العنوان مفقود" });
  else if ([...address].length < MIN_SHIPPING_ADDRESS_LENGTH)
    issues.push({ code: "address_short", message: `العنوان قصير — ${MIN_SHIPPING_ADDRESS_LENGTH} أحرف على الأقل (الحالي ${[...address].length})` });
  const rawGov = String(order.governorate ?? "").trim();
  const governorate = canonicalGovernorate(rawGov);
  if (!rawGov || rawGov === "غير محدد") issues.push({ code: "governorate_missing", message: "المحافظة غير محددة" });
  else if (!governorate) issues.push({ code: "governorate_unknown", message: `المحافظة «${rawGov}» غير معروفة — اختر محافظة من القائمة` });
  return { ready: issues.length === 0, issues, governorate };
}

/** نص واحد بالأسباب، للرسائل. */
export function shippingIssuesText(r: ShippingReadiness): string {
  return r.issues.map(i => i.message).join(" — ");
}

/** عنوان التنبيه المستقل في الواجهة (ليس حالة أوردر). */
export const NEEDS_COMPLETION_LABEL = "محتاج استكمال بيانات";

/** بادئة سبب المراجعة عند اختلاف عنوان EasyOrder القادم عن العنوان المصحَّح يدويًا (يُكتب في `reviewReason`). */
export const MANUAL_ADDRESS_CONFLICT_PREFIX = "عنوان Easy Order مختلف عن العنوان المصحَّح يدويًا";

/** يشيل سبب تعارض العنوان من `reviewReason` (بعد ما الموظف عدّل العنوان/المحافظة بنفسه). null = لا تغيير. */
export function withoutAddressConflictReason(reviewReason: string | null | undefined): { needsReview?: boolean; reviewReason: string | null } | null {
  const reasons = String(reviewReason ?? "").split(" | ").map(r => r.trim()).filter(Boolean);
  const remaining = reasons.filter(r => !r.startsWith(MANUAL_ADDRESS_CONFLICT_PREFIX));
  if (remaining.length === reasons.length) return null;
  return remaining.length ? { reviewReason: remaining.join(" | ") } : { needsReview: false, reviewReason: null };
}
