/**
 * حساب صافي المرتب البسيط — نموذج التاجر:
 *
 *   صافي المرتب = المرتب الأساسي + إجمالي البونص − إجمالي السُلف
 *
 * دالة نقية عشان الواجهة والسيرفر والاختبار كلهم يحسبوا بنفس القاعدة بالظبط — مفيش
 * تعريف تاني للصافي يقدر يختلف بينهم. مش بتلمس عمولة ولا أوفرتايم ولا خصومات: دي
 * الشاشة البسيطة اللي التاجر بيطلبها، والدورة الكاملة لسه موجودة لوحدها لمن يحتاجها.
 */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function computeNetSalary(input: {
  baseSalary: number;
  bonuses: number;
  advances: number;
}): number {
  return round2(input.baseSalary + input.bonuses - input.advances);
}
