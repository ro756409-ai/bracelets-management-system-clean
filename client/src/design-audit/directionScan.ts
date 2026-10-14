import fs from "fs";
import path from "path";

/**
 * Matjarak 2.0 — المرحلة 0: حصر ما يمنع الواجهة من العمل بالاتجاهين (عربي RTL / إنجليزي LTR) في المكونات المشتركة.
 *  • physical: أصناف Tailwind مربوطة بجهة فعلية (ml/mr/pl/pr، left/right، text-left/right، rounded-l/r، border-l/r،
 *    space-x-reverse) — مكانها الصحيح المنطقي (ms/me/ps/pe، start/end، text-start/end، rounded-s/e، border-s/e).
 *  • arrows: أيقونات اتجاه (Chevron/Arrow Left/Right) لا تنقلب تلقائيًا مع الاتجاه.
 *  • sides: side="left|right" في Sheet/Drawer.
 *  • hardRtl: dir="rtl" مكتوب داخل المكوّن — يمنع الاتجاه من أن يتبع جذر الصفحة (اللغة) ويثبّت العربي.
 */
export const SHARED_DIRS = ["components/ui", "components/shell", "components/workspace", "components/shared"];
export const SHARED_FILES = ["components/DashboardLayout.tsx", "components/BrandLogo.tsx", "components/BrandMark.tsx"];

const PHYSICAL = /(?<![\w-])-?(?:(?:ml|mr|pl|pr|left|right|rounded-(?:l|r|tl|tr|bl|br)|border-(?:l|r)|scroll-(?:ml|mr|pl|pr))-[\w[\].\/-]+|text-(?:left|right)|rounded-(?:l|r)|border-(?:l|r)|space-x-reverse)(?![\w-])/g;
const ARROWS = /\b(?:Chevron|Arrow)(?:Left|Right)\b/g;
const SIDES = /\bside=["'](?:left|right)["']/g;
const HARD_RTL = /\bdir=(?:"rtl"|\{"rtl"\}|'rtl')/g;

export type DirectionCounts = { physical: number; arrows: number; sides: number; hardRtl: number };

export function scanFile(abs: string): DirectionCounts {
  const src = fs.readFileSync(abs, "utf-8").split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  return { physical: (src.match(PHYSICAL) ?? []).length, arrows: (src.match(ARROWS) ?? []).length, sides: (src.match(SIDES) ?? []).length, hardRtl: (src.match(HARD_RTL) ?? []).length };
}

/** كل ملفات المكونات المشتركة (بلا ملفات الاختبار) → عدّاداتها؛ الملفات النظيفة تُحذف من الناتج. */
export function scanShared(srcRoot: string): Record<string, DirectionCounts> {
  const files = [
    ...SHARED_DIRS.flatMap(d => fs.readdirSync(path.join(srcRoot, d)).filter(f => /\.tsx?$/.test(f) && !/\.test\./.test(f)).map(f => `${d}/${f}`)),
    ...SHARED_FILES,
  ].sort();
  const out: Record<string, DirectionCounts> = {};
  for (const f of files) {
    const c = scanFile(path.join(srcRoot, f));
    if (c.physical || c.arrows || c.sides || c.hardRtl) out[f] = c;
  }
  return out;
}
