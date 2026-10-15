import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { ACCENTS, ACCENT_IDS } from "./displayPrefs";
import { V2_DEFAULT_ACCENT, accentGroupText, accentPresentation } from "./accentPresentation";
import { parseColor, resolvedThemes } from "../design-audit/cssTokens";

/**
 * Matjarak 2.0 — المرحلة 1B-3: عرض ألوان مساحة العمل في نافذة «تخصيص العرض».
 * الهوية الحالية كما هي حرفيًا؛ تحت v2 الافتراضي «عنابي — الافتراضي» بلون Oxblood المطابق لـ index.css، والباقي كما هو.
 */
const themes = resolvedThemes(fs.readFileSync(path.resolve(__dirname, "../index.css"), "utf-8"));
const hexOf = (t: string, k: string) => { const c = parseColor(themes[t][k], themes[t])!; return `#${[c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase(); };

describe("🎨 accentPresentation — عرض ألوان مساحة العمل", () => {
  it("الهوية الحالية (بلا v2): الأسماء والألوان والعنوان كما كانت حرفيًا للألوان الأربعة في الوضعين", () => {
    for (const id of ACCENT_IDS) for (const mode of ["light", "dark"] as const)
      expect(accentPresentation(id, mode, null)).toEqual({ label: ACCENTS[id].label, swatch: ACCENTS[id][mode].primary });
    expect(accentPresentation("copper", "light", null).label).toBe("نحاسي");
    expect(accentGroupText(null)).toEqual({ title: "اللون الرئيسي", hint: "ألوان الحالات (نجاح/تحذير/خطر) لا تتغير مع اللون الرئيسي." });
  });

  it("تحت v2: الافتراضي (القيمة المحفوظة copper) يظهر «عنابي — الافتراضي» بلون --primary الفعلي في كتلتي v2", () => {
    expect(accentPresentation("copper", "light", "v2")).toEqual({ label: "عنابي — الافتراضي", swatch: hexOf("light:v2", "--primary") });
    expect(accentPresentation("copper", "dark", "v2")).toEqual({ label: "عنابي — الافتراضي", swatch: hexOf("dark:v2", "--primary") });
    expect([V2_DEFAULT_ACCENT.light, V2_DEFAULT_ACCENT.dark]).toEqual(["#672A39", "#D98B99"]);
    expect(accentGroupText("v2").title).toBe("لون مساحة العمل");
  });

  it("تحت v2: تركوازي/نيلي/زيتوني بأسمائها وألوانها كما هي، ومطابقة لكتل الألوان المحفوظة الفعلية", () => {
    for (const id of ["teal", "indigo", "olive"] as const) for (const mode of ["light", "dark"] as const) {
      expect(accentPresentation(id, mode, "v2")).toEqual({ label: ACCENTS[id].label, swatch: ACCENTS[id][mode].primary });
      expect(ACCENTS[id][mode].primary.toUpperCase()).toBe(hexOf(`${mode}:v2:${id}`, "--primary"));
    }
  });
});
