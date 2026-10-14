/**
 * Matjarak 2.0 — مفتاح الهوية الجديدة (المرحلة 1A).
 *
 * مصدره الوحيد متغير وقت البناء `VITE_BRAND`: القيمة "v2" تضع `data-brand="v2"` على `<html>` فتطبّق tokens الهوية
 * الجديدة في index.css؛ أي قيمة أخرى أو غيابه = الهوية الحالية كما هي. لا يقرأ ولا يكتب أي تفضيلات أو بيانات —
 * الإلغاء = إزالة المتغير وإعادة البناء.
 */
export type Brand = "v2";

export function brandFromEnv(value: unknown): Brand | null {
  return typeof value === "string" && value.trim().toLowerCase() === "v2" ? "v2" : null;
}

export function applyBrandFlag(root: HTMLElement, value: unknown): Brand | null {
  const brand = brandFromEnv(value);
  if (brand) root.setAttribute("data-brand", brand);
  else root.removeAttribute("data-brand");
  return brand;
}
