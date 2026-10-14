import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { scanFile, scanShared } from "./directionScan";
import { DIRECTION_BASELINE } from "./directionBaseline";

/**
 * Matjarak 2.0 — المرحلة 0: جاهزية الاتجاهين (RTL/LTR) في المكونات المشتركة — قياس + منع التراجع.
 * الواجهة اليوم عربية فقط (`<html lang="ar" dir="rtl">`)؛ الإنجليزية الكاملة هدف أساسي لاحق، فأي اتجاه فيزيائي
 * جديد في المكونات المشتركة يُرفض من الآن، والموجود مسبقًا مسجّل بأرقامه في directionBaseline.ts.
 */
const SRC = path.resolve(__dirname, "..");

describe("↔️ المرحلة 0 — الاتجاهات في المكونات المشتركة", () => {
  it("الماسح يميّز الفيزيائي من المنطقي (عينات ثابتة)", () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dir-scan-")), "x.tsx");
    fs.writeFileSync(tmp, [
      `<div className="ml-2 pr-4 text-left left-0 rounded-l-md border-r space-x-reverse" />`,
      `<div className="ms-2 pe-4 text-start start-0 rounded-s-md border-e" />`,
      `// ml-2 داخل تعليق لا يُحسب`,
      `<ChevronLeft /><ArrowRight /><Sheet side="right" /><div dir="rtl" /><span dir="ltr" />`,
    ].join("\n"));
    expect(scanFile(tmp)).toEqual({ physical: 7, arrows: 2, sides: 1, hardRtl: 1 });
  });

  it("لا اتجاه فيزيائي جديد ولا ملف جديد يحمل اتجاهًا فيزيائيًا (ratchet على مرجع 23be803)", () => {
    const now = scanShared(SRC);
    const regressions = Object.entries(now).flatMap(([f, c]) => {
      const base = DIRECTION_BASELINE[f] ?? { physical: 0, arrows: 0, sides: 0, hardRtl: 0 };
      return (["physical", "arrows", "sides", "hardRtl"] as const).filter(k => c[k] > base[k]).map(k => `${f}: ${k} ${base[k]} → ${c[k]}`);
    });
    expect(regressions).toEqual([]);
  });

  it("المرجع مطابق للواقع: أي تحسين يُسجَّل بتخفيض الرقم عمدًا (لا أرقام قديمة أكبر من الحقيقة)", () => {
    const now = scanShared(SRC);
    const stale = Object.entries(DIRECTION_BASELINE).flatMap(([f, base]) => {
      const c = now[f] ?? { physical: 0, arrows: 0, sides: 0, hardRtl: 0 };
      return (["physical", "arrows", "sides", "hardRtl"] as const).filter(k => c[k] < base[k]).map(k => `${f}: ${k} ${base[k]} → ${c[k]}`);
    });
    expect(stale).toEqual([]);
  });

  it("المجموع الحالي للمرجع: 139 فيزيائيًا · 20 سهمًا · 4 جوانب · 12 dir=\"rtl\" مكتوبًا في 45 ملفًا مشتركًا", () => {
    const sum = Object.values(DIRECTION_BASELINE).reduce((a, c) => ({ physical: a.physical + c.physical, arrows: a.arrows + c.arrows, sides: a.sides + c.sides, hardRtl: a.hardRtl + c.hardRtl }), { physical: 0, arrows: 0, sides: 0, hardRtl: 0 });
    expect([Object.keys(DIRECTION_BASELINE).length, sum]).toEqual([45, { physical: 139, arrows: 20, sides: 4, hardRtl: 12 }]);
  });
});
