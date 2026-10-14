import { shippingReadiness } from "@shared/shippingReadiness";

/**
 * What an order needs before an employee can confirm it. Pulled out of
 * EmployeeDashboard.tsx (Today Confirmations) so the rule is unit-testable without
 * mounting the page — a confirmation with no phone or address is silently useless to
 * whoever ships it, so this blocks the action instead of letting it through.
 */
export type ConfirmableOrder = {
  customerName?: string | null;
  customerPhone?: string | null;
  governorate?: string | null;
  customerAddress?: string | null;
  productName?: string | null;
  totalAmount?: string | number | null;
};

const FIELD_LABELS: Record<keyof ConfirmableOrder, string> = {
  customerName: "اسم العميل",
  customerPhone: "رقم الهاتف",
  governorate: "المحافظة",
  customerAddress: "العنوان",
  productName: "المنتج",
  totalAmount: "الإجمالي",
};

/** Returns the Arabic labels of every field missing for confirmation; empty when ready. */
export function getMissingConfirmationFields(order: ConfirmableOrder): string[] {
  const missing: string[] = [];
  if (!order.customerName?.trim()) missing.push(FIELD_LABELS.customerName);
  if (!order.customerPhone?.trim()) missing.push(FIELD_LABELS.customerPhone);
  // العنوان/المحافظة: فارغ ⇒ اسم الحقل؛ موجود لكن غير مكتمل ⇒ سبب «محتاج استكمال بيانات» بنفس قاعدة السيرفر
  // (عنوان 10 أحرف، محافظة معروفة بمطابقة دقيقة/بديل معتمد) — فالموظف يعرف السبب قبل أن يرفضه السيرفر.
  const shipping = shippingReadiness(order);
  if (!order.governorate?.trim()) missing.push(FIELD_LABELS.governorate);
  else for (const i of shipping.issues) if (i.code.startsWith("governorate")) missing.push(i.message);
  if (!order.customerAddress?.trim()) missing.push(FIELD_LABELS.customerAddress);
  else for (const i of shipping.issues) if (i.code === "address_short") missing.push(i.message);
  if (!order.productName?.trim()) missing.push(FIELD_LABELS.productName);
  if (!(Number(order.totalAmount) > 0)) missing.push(FIELD_LABELS.totalAmount);
  return missing;
}

export function canConfirmOrder(order: ConfirmableOrder): boolean {
  return getMissingConfirmationFields(order).length === 0;
}
