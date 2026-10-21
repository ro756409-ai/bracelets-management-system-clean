import { useMemo } from "react";
import { useOperationalOptions } from "./useOperationalOptions";

/**
 * Standard cancellation reasons, used when the business has not configured its own.
 * Kept short and mutually exclusive — a reason list people scroll is a reason list people
 * stop reading, and the whole point is that the number in the cancelled column means something.
 *
 * (BUG-28) نفس القائمة اللي كانت في لوحة الموظف بالحرف — اتنقلت هنا عشان كل نوافذ الإلغاء تستخدمها.
 * قبل كده: نشاط جديد بلا `cancellation_reason` مضبوطة = قائمة فاضية والسبب إلزامي، فالإلغاء
 * كان مستحيلًا من التفاصيل والأوردرات ومساحة العمل ولوحة المدير.
 */
export const DEFAULT_CANCEL_REASONS = [
  "العميل غيّر رأيه",
  "السعر غالي",
  "طلب بالخطأ",
  "مش متاح للتوصيل في منطقته",
  "المنتج مش متوفر",
  "أوردر مكرر",
  "رقم غلط أو مش موجود",
  "العميل مش بيرد",
] as const;

export type ReasonOption = { value: string; label: string };

/** أسباب النشاط المضبوطة لو موجودة، وإلا القائمة الافتراضية — مش فاضية أبدًا. */
export function withDefaultCancelReasons(configured: ReasonOption[]): ReasonOption[] {
  const usable = configured.filter(o => o.value && o.label);
  return usable.length > 0 ? usable : DEFAULT_CANCEL_REASONS.map(r => ({ value: r, label: r }));
}

/** أسباب الإلغاء لنوافذ الإلغاء — نفس منطق المحافظات (`useGovernorateOptions`): لا قائمة فاضية. */
export function useCancelReasonOptions() {
  const query = useOperationalOptions("cancellation_reason");
  const options = useMemo(() => withDefaultCancelReasons(query.options), [query.options]);
  return { options, isConfigured: query.options.filter(o => o.value && o.label).length > 0 };
}
