/**
 * BUG-01 (Release 1) — هل الجلسة تكتب تكلفة المخزون (`inventory_costing.manage`)؟
 *
 * نموذج تعديل التركيبة بيحمّل التكلفة المحفوظة ويرجّعها مع أي تعديل؛ لو المدير مسحوب منه
 * إدارة التكلفة، السيرفر بيرفض الطلب كله حتى لو التعديل على السعر أو الاسم بس. فالواجهة ماتبعتش
 * أي حقل تكلفة من غير الصلاحية. الإخفاء هنا مش أمان — الحارس الحقيقي على السيرفر.
 *
 * قبل ما الصلاحيات تتحمّل بنجاح (تحميل أو خطأ) = نفس السلوك القديم (التكلفة بتتبعت والسيرفر
 * يحكم) — عشان المالك والمحاسب مايخسروش تعديل تكلفة بسبب تأخير في التحميل.
 */
export function canWriteCost(perms: { isSuccess: boolean; has: (permission: string) => boolean }): boolean {
  if (!perms.isSuccess) return true;
  return perms.has("inventory_costing.manage");
}

/** قيمة التكلفة اللي تتبعت في الطلب: بلا صلاحية = لا شيء (المفتاح يتشال من الـJSON). */
export function costForSubmit(canWrite: boolean, cost: number | undefined): number | undefined {
  return canWrite ? cost : undefined;
}
