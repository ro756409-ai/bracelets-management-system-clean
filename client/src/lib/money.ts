/**
 * تنسيق المبالغ.
 *
 * كل صفحة كانت بتكتب `Number(x).toLocaleString('ar-EG') + ' ج.م'` بنفسها، ونتيجتها كانت
 * تختلف في التفاصيل: بعضها بيعرض كسور وبعضها لأ، وبعضها بيطبع "NaN ج.م" لما القيمة
 * تكون null. الأربع صفحات دي كلها أرقام، فلازم يقروا من دالة واحدة.
 */

const EGP = "ج.م";

/** رقم عربي بفاصلة آلاف ومنزلتين عشريتين، أو شرطة لو القيمة مش رقم. */
export function formatAmount(value: unknown): string {
  const n = Number(value);
  if (value == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** نفس الحاجة مع العملة. */
export function formatMoney(value: unknown): string {
  const formatted = formatAmount(value);
  return formatted === "—" ? formatted : `${formatted} ${EGP}`;
}

/**
 * صيغة مختصرة للمؤشرات الكبيرة: ٤٥٠ أ بدل ٤٥٠٠٠٠٫٠٠.
 * بطاقات لوحة الحسابات بتعرض ملايين، والرقم الكامل بيكسر عرض الكارت.
 */
export function formatMoneyCompact(value: unknown): string {
  const n = Number(value);
  if (value == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toLocaleString("ar-EG", { maximumFractionDigits: 1 })} م`;
  if (abs >= 10_000) return `${(n / 1000).toLocaleString("ar-EG", { maximumFractionDigits: 1 })} أ`;
  return n.toLocaleString("ar-EG", { maximumFractionDigits: 0 });
}

export { EGP };
