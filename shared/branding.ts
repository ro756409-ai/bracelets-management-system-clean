/**
 * هوية النشاط (اسم البراند + اللوجو) — **بلا أي عمود جديد ولا Migration**.
 *
 * الاسم هو `businesses.name` نفسه. اللوجو بيتخزّن كمرجع ملف في
 * `business_configuration_values` تحت `namespace="branding"` و`configKey="logoUrl"` —
 * نفس الجدول اللي بيشيل قالب الإدخال (`order_entry`) وموجود في Production.
 * الصورة نفسها في تخزين الملفات (S3/قرص) — **مش Base64 في القاعدة**.
 *
 * المرجع المخزّن مسار مُتحقّق (`/api/branding/files/<اسم>`) بيحمل رقم الـtenant في
 * الاسم، فأي محاولة ربط لوجو tenant تاني بتترفض قبل الكتابة.
 */

export const BRANDING_NAMESPACE = "branding";
export const BRANDING_LOGO_KEY = "logoUrl";

/** اسم ملف اللوجو: t<tenant>-logo-<uuid>.<ext> — البادئة هي عزل التينانت وقت التنزيل. */
export const LOGO_FILENAME_PATTERN = /^t(\d+)-logo-[a-f0-9-]+\.(png|jpg|webp)$/;
export const LOGO_URL_PREFIX = "/api/branding/files/";

/** الحرف الأول من اسم البراند — لما مفيش لوجو. */
export function brandInitial(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "؟";
  // أول حرف فعلي (بيتخطّى «ال» التعريف مش مطلوب — الحرف الأول كما هو، زي ما المالك كتبه).
  return Array.from(trimmed)[0].toUpperCase();
}

/** يستخرج tenant من مرجع لوجو صالح، أو null لو المرجع مش بتاعنا. */
export function logoUrlTenant(url: string | null | undefined): number | null {
  if (!url || !url.startsWith(LOGO_URL_PREFIX)) return null;
  const m = LOGO_FILENAME_PATTERN.exec(url.slice(LOGO_URL_PREFIX.length));
  return m ? Number(m[1]) : null;
}

/** المرجع صالح **ومملوك للتينانت ده** — الشرط الوحيد اللي بيسمح بالحفظ. */
export function isOwnedLogoUrl(url: string, tenantId: number): boolean {
  return logoUrlTenant(url) === tenantId;
}

/** القيمة المخزّنة (JSON) → مرجع لوجو أو null. مابترميش أبدًا. */
export function parseLogoUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    /* نص خام */
  }
  return typeof value === "string" && value.startsWith(LOGO_URL_PREFIX) ? value : null;
}
