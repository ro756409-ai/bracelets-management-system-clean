import { brandFromEnv, type Brand } from "./brandFlag";

/**
 * locale العرض العربي — **مصدر واحد** لكل تنسيق أرقام/مبالغ/تواريخ في الواجهة (بدل كتابة "ar-EG" في كل ملف).
 *
 *  • v2 (VITE_BRAND=v2): `ar-EG-u-nu-latn` ⇒ أرقام غربية 0–9 مع أسماء شهور/أيام و«م/ص» عربي («19 أكتوبر 2026»، «2,010»).
 *  • v1: `ar-EG` كما كان بالظبط (أرقام هندية).
 * ثابت وقت البناء (نفس مصدر الهوية) — **مفيش أي تعديل على Intl أو prototypes**؛ المكتبات الخارجية والسيرفر والاختبارات
 * مابتتأثرش، وكل نداء بيختار الـlocale صراحةً.
 */
export const LATIN_DIGITS_AR_LOCALE = "ar-EG-u-nu-latn";
export const arLocaleFor = (brand: Brand | null | undefined): string => (brand === "v2" ? LATIN_DIGITS_AR_LOCALE : "ar-EG");
export const AR_LOCALE: string = arLocaleFor(brandFromEnv(import.meta.env?.VITE_BRAND));
