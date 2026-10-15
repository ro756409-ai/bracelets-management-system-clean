import { ACCENTS, type AccentId } from "./displayPrefs";
import type { Brand } from "./brandFlag";

/**
 * Matjarak 2.0 — المرحلة 1B-3: طريقة **عرض** ألوان مساحة العمل في نافذة «تخصيص العرض» حسب الهوية المطبَّقة.
 * عرض فقط: القيمة المحفوظة لكل مستخدم لا تتغير أبدًا ("copper" تبقى "copper") ولا يُكتب أي تخزين.
 *  • الهوية الحالية: الأسماء والألوان كما هي حرفيًا («اللون الرئيسي» و«نحاسي»).
 *  • تحت v2: الافتراضي يظهر «عنابي — الافتراضي» بلون Oxblood (نفس قيم --primary في كتلتي v2)، وعنوان المجموعة
 *    «لون مساحة العمل»؛ تركوازي/نيلي/زيتوني بأسمائها وألوانها كما هي.
 */
export const V2_DEFAULT_ACCENT = { label: "عنابي — الافتراضي", light: "#672A39", dark: "#D98B99" } as const;

export function accentPresentation(id: AccentId, mode: "light" | "dark", brand: Brand | null): { label: string; swatch: string } {
  if (brand === "v2" && id === "copper") return { label: V2_DEFAULT_ACCENT.label, swatch: V2_DEFAULT_ACCENT[mode] };
  return { label: ACCENTS[id].label, swatch: ACCENTS[id][mode].primary };
}

export function accentGroupText(brand: Brand | null): { title: string; hint: string } {
  return brand === "v2"
    ? { title: "لون مساحة العمل", hint: "لون البراند (عنابي) ثابت على الشعار وشاشات الدخول. ألوان الحالات (نجاح/تحذير/خطر) لا تتغير." }
    : { title: "اللون الرئيسي", hint: "ألوان الحالات (نجاح/تحذير/خطر) لا تتغير مع اللون الرئيسي." };
}
