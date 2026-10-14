import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { resolvedThemes } from "./cssTokens";
import { CONTRAST_PAIRS, measure } from "./contrastPairs";

/**
 * Matjarak 2.0 — المرحلة 0: مرجع تباين الألوان الحالية (قبل أي تغيير هوية).
 * كل زوج نص/خلفية وعنصر واجهة في كل الثيمات (فاتح/داكن × الألوان الأربعة) يُقاس من index.css مباشرة.
 * المشاكل الموجودة مسبقًا مسجّلة بأرقامها في KNOWN_BASELINE — الاختبار يفشل لو ظهرت مشكلة جديدة،
 * أو لو تحسّن زوج معروف (فيُحذف من القائمة عمدًا لا بالصدفة).
 */
const css = fs.readFileSync(path.resolve(__dirname, "../index.css"), "utf-8");
const themes = resolvedThemes(css);

/** موجود مسبقًا عند 23be803 في الهوية الحالية: حدود الحقول (--input) أقل من 3:1 مع الخلفية والبطاقة في كل ثيماتها.
 *  الهوية الجديدة (v2، المرحلة 1A) تصلحها — لا مشكلة معروفة فيها (brandV2.test). */
const KNOWN_BASELINE: Record<string, number> = Object.fromEntries(
  Object.keys(themes).filter(t => !t.includes("v2")).flatMap(t => {
    const dark = t.startsWith("dark");
    return [[`${t}|input/background`, dark ? 1.38 : 1.17], [`${t}|input/card`, 1.27]] as [string, number][];
  }),
);

describe("🎨 المرحلة 0 — تباين tokens الحالية (WCAG)", () => {
  it("الثيمات مقروءة: الحالية (فاتح/داكن × الافتراضي + 3 ألوان بديلة) والجديدة v2 بنفس الثمانية، وكل زوج له قيمة محسوبة", () => {
    const current = ["dark", "dark:indigo", "dark:olive", "dark:teal", "light", "light:indigo", "light:olive", "light:teal"];
    expect(Object.keys(themes).sort()).toEqual([...current, ...current.map(t => t.replace(/^(light|dark)/, "$1:v2"))].sort());
    for (const [name, tokens] of Object.entries(themes))
      for (const m of measure(name, tokens).filter(x => x.kind !== "info")) expect(m.ratio, `${name} ${m.id}`).not.toBeNull();
    expect(CONTRAST_PAIRS.length).toBeGreaterThanOrEqual(50);
  });

  it("لا مشكلة تباين جديدة: كل فشل حالي مسجّل في المرجع بنفس القيمة", () => {
    const failures = Object.entries(themes).flatMap(([n, t]) => measure(n, t)).filter(m => !m.ok);
    const found = Object.fromEntries(failures.map(f => [`${f.theme}|${f.id}`, f.ratio]));
    expect(found).toEqual(KNOWN_BASELINE);
  });

  it("النص الأساسي والأزرار والحالات وشارات الحالة تحقق 4.5:1 في كل الثيمات (الحالي سليم)", () => {
    const text = Object.entries(themes).flatMap(([n, t]) => measure(n, t)).filter(m => m.kind === "text");
    expect(text.filter(m => !m.ok).map(m => `${m.theme} ${m.id} ${m.ratio}`)).toEqual([]);
  });
});
