import { z } from "zod";

/**
 * BUG-41 — البريد في إنشاء/تعديل الموظف اختياري فعلًا: النص الفارغ (أو مسافات) = «لم يُرسل».
 *   • الإنشاء: يُحفظ الموظف بلا بريد.
 *   • التعديل: الخانة الفارغة **لا تمسح** بريدًا محفوظًا (undefined = بلا تغيير في التحديث).
 * البريد غير الصالح ما زال مرفوضًا، والقيمة الصالحة تُحفظ بعد إزالة المسافات الطرفية.
 */
export const optionalEmployeeEmail = z
  .string()
  .optional()
  .transform(v => (v === undefined || v.trim() === "" ? undefined : v.trim()))
  .pipe(z.string().email().optional());
