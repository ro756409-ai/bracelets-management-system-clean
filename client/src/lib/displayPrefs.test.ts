/**
 * المرحلة 5 — تخصيص العرض: الهوية والمفاتيح والحفظ/الاسترجاع بلا تسرب، التباين الفعلي للألوان الأربعة
 * في الوضعين، وتطابق Tokens في index.css مع lib/displayPrefs.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ACCENTS, ACCENT_IDS, DEFAULT_PREFS, FONT_SCALES, PREFS_KEY_PREFIX, accentContrastTable, clearPrefs, contrastRatio, loadPrefs,
  resolveIdentity, resolveReduceMotion, resolveTheme, sanitizePrefs, savePrefs, storageKey,
} from "./displayPrefs";

class MemStorage { map = new Map<string, string>(); getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; } setItem(k: string, v: string) { this.map.set(k, v); } removeItem(k: string) { this.map.delete(k); } }

describe("🪪 هوية الجلسة → مفتاح تخزين منفصل", () => {
  it("مالك حقيقي u:<userId>، صناعية s:<employeeId> (id سالب من السيرفر)، موظف e:<employeeId>، زائر null", () => {
    expect(resolveIdentity({ id: 12 }, null)).toEqual({ kind: "u", id: 12 });
    expect(resolveIdentity({ id: -7, loginMethod: "employee" }, { employeeId: 7 })).toEqual({ kind: "s", id: 7 });
    expect(resolveIdentity(null, { employeeId: 9 })).toEqual({ kind: "e", id: 9 });
    expect(resolveIdentity(null, null)).toBeNull();
    expect(resolveIdentity({ id: 0 }, null)).toBeNull();
    expect(resolveIdentity(undefined, { employeeId: 0 })).toBeNull();
  });
  it("صيغة المفتاح matjarak:display-prefs:v1:<identity> ولا مفتاح للزائر ولا tenantId", () => {
    expect(storageKey({ kind: "u", id: 12 })).toBe("matjarak:display-prefs:v1:u:12");
    expect(storageKey({ kind: "e", id: 9 })).toBe("matjarak:display-prefs:v1:e:9");
    expect(storageKey({ kind: "s", id: 7 })).toBe("matjarak:display-prefs:v1:s:7");
    expect(storageKey(null)).toBeNull();
    expect(PREFS_KEY_PREFIX).not.toMatch(/tenant/);
  });
  it("نفس employeeId بنوعي جلسة مختلفين = مفتاحان مختلفان (لا اشتراك)", () => {
    expect(storageKey({ kind: "e", id: 7 })).not.toBe(storageKey({ kind: "s", id: 7 }));
    expect(storageKey({ kind: "u", id: 7 })).not.toBe(storageKey({ kind: "e", id: 7 }));
  });
});

describe("💾 الحفظ والاسترجاع لكل نوع جلسة بلا تسرب", () => {
  it("كل هوية تسترجع إعداداتها فقط؛ الزائر لا يُحفظ ولا يقرأ إعدادات غيره", () => {
    const st = new MemStorage();
    const u = { kind: "u", id: 1 } as const, e = { kind: "e", id: 2 } as const, s = { kind: "s", id: 2 } as const;
    expect(savePrefs(u, { ...DEFAULT_PREFS, accent: "teal", fontScale: 1.25 }, st)).toBe(true);
    expect(savePrefs(e, { ...DEFAULT_PREFS, theme: "dark" }, st)).toBe(true);
    expect(savePrefs(null, { ...DEFAULT_PREFS, accent: "olive" }, st)).toBe(false);
    expect(loadPrefs(u, st)).toMatchObject({ accent: "teal", fontScale: 1.25, theme: "system" });
    expect(loadPrefs(e, st)).toMatchObject({ accent: "copper", theme: "dark" });
    expect(loadPrefs(s, st)).toEqual(DEFAULT_PREFS); // نفس الرقم 2 لكن جلسة صناعية → مستقلة
    expect(loadPrefs(null, st)).toEqual(DEFAULT_PREFS);
    expect([...st.map.keys()]).toEqual(["matjarak:display-prefs:v1:u:1", "matjarak:display-prefs:v1:e:2"]);
    clearPrefs(u, st); expect(loadPrefs(u, st)).toEqual(DEFAULT_PREFS); expect(loadPrefs(e, st).theme).toBe("dark");
  });
  it("قيمة تالفة/غير معروفة → الافتراضي لذلك الحقل فقط؛ JSON تالف → الافتراضي كله", () => {
    expect(sanitizePrefs({ fontScale: 3, theme: "dark", accent: "neon", density: "compact", motion: "x" })).toEqual({ fontScale: 1, theme: "dark", accent: "copper", density: "compact", motion: "system" });
    const st = new MemStorage(); st.setItem("matjarak:display-prefs:v1:u:5", "{nope");
    expect(loadPrefs({ kind: "u", id: 5 }, st)).toEqual(DEFAULT_PREFS);
    expect(FONT_SCALES).toEqual([0.9, 1, 1.1, 1.25]);
  });
  it("الافتراضي: نحاسي، 100%، حسب الجهاز، مريحة، حسب الجهاز", () => {
    expect(DEFAULT_PREFS).toEqual({ fontScale: 1, theme: "system", accent: "copper", density: "comfortable", motion: "system" });
  });
});

describe("🌓 حلّ الوضع والحركة", () => {
  it("system يتبع النظام؛ light/dark صريحان؛ تقليل الحركة: system يتبع، reduce يفعّل، allow يلغي", () => {
    expect(resolveTheme("system", true)).toBe("dark"); expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light"); expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveReduceMotion("system", true)).toBe(true); expect(resolveReduceMotion("system", false)).toBe(false);
    expect(resolveReduceMotion("reduce", false)).toBe(true); expect(resolveReduceMotion("allow", true)).toBe(false);
  });
});

describe("🎨 الألوان الأربعة — تباين فعلي (WCAG) في الوضعين", () => {
  it("نص الزر الرئيسي ≥ 4.5:1 · اللون على الخلفية والبطاقة ≥ 3:1 · primary-text على الخلفية والسطح الناعم ≥ 4.5:1", () => {
    const table = accentContrastTable();
    expect(table).toHaveLength(8);
    for (const row of table) {
      const tag = `${row.accent}/${row.mode}`;
      expect(row.buttonText, `${tag} buttonText`).toBeGreaterThanOrEqual(4.5);
      expect(row.primaryOnBackground, `${tag} primaryOnBackground`).toBeGreaterThanOrEqual(3);
      expect(row.primaryOnCard, `${tag} primaryOnCard`).toBeGreaterThanOrEqual(3);
      expect(row.primaryTextOnBackground, `${tag} primaryTextOnBackground`).toBeGreaterThanOrEqual(4.5);
      expect(row.primaryTextOnSoft, `${tag} primaryTextOnSoft`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 0);
  });
  it("النحاسي هو الافتراضي وقيمه مطابقة لـ:root/.dark الحالية؛ الأسماء عربية؛ لا لون حر", () => {
    expect(ACCENT_IDS[0]).toBe("copper");
    expect(ACCENTS.copper.light.primary).toBe("#B4532A"); expect(ACCENTS.copper.dark.primary).toBe("#E07A4B");
    for (const id of ACCENT_IDS) expect(ACCENTS[id].label).toMatch(/^[؀-ۿ ]+$/);
  });
});

describe("🧱 Tokens في index.css مطابقة للمكتبة", () => {
  const css = readFileSync(path.resolve(__dirname, "..", "index.css"), "utf8");
  it("لكل لون غير افتراضي كتلتان :root[data-accent] و .dark[data-accent] بنفس القيم (primary/foreground/text/soft/accent/ring)", () => {
    for (const id of ACCENT_IDS.filter(a => a !== "copper")) {
      const light = css.match(new RegExp(`:root\\[data-accent="${id}"\\] \\{([^}]*)\\}`))?.[1];
      const dark = css.match(new RegExp(`\\.dark\\[data-accent="${id}"\\] \\{([^}]*)\\}`))?.[1];
      expect(light, `${id} light block`).toBeTruthy(); expect(dark, `${id} dark block`).toBeTruthy();
      const L = ACCENTS[id].light, D = ACCENTS[id].dark;
      expect(light).toContain(`--primary: ${L.primary};`); expect(light).toContain(`--primary-foreground: ${L.primaryForeground};`); expect(light).toContain(`--primary-text: ${L.primaryText};`); expect(light).toContain(`--primary-soft: ${L.primarySoft};`); expect(light).toContain(`--accent: ${L.accent};`); expect(light).toContain(`--ring: ${L.primary};`);
      expect(dark).toContain(`--primary: ${D.primary};`); expect(dark).toContain(`--primary-foreground: ${D.primaryForeground};`); expect(dark).toContain(`--primary-text: ${D.primaryText};`); expect(dark).toContain(`--ring: ${D.primary};`);
      // لا تمسّ ألوان الحالات
      for (const sem of ["--success", "--warning", "--destructive", "--info"]) { expect(light).not.toContain(sem + ":"); expect(dark).not.toContain(sem + ":"); }
    }
    // لكل لون: كتلة الداكن بعد كتلة الفاتح (نفس الخصوصية 0,2,0 → الترتيب يحسم)، وكلتاهما بعد .dark الأساسية
    const baseDark = css.indexOf("\n.dark {");
    for (const id of ACCENT_IDS.filter(a => a !== "copper")) {
      const light = css.indexOf(`:root[data-accent="${id}"]`), dark = css.indexOf(`.dark[data-accent="${id}"]`);
      expect(light, id).toBeGreaterThan(baseDark); expect(dark, id).toBeGreaterThan(light);
    }
  });
  it("حجم الخط عبر --font-scale على html؛ الكثافة المدمجة ≥768px فقط؛ تقليل الحركة يستثني مؤشرات التحميل ويحترم «غير مفعّل»", () => {
    expect(css).toContain("font-size: calc(100% * var(--font-scale));");
    expect(css).toMatch(/@media \(min-width: 768px\) \{\s*:root\[data-density="compact"\]/);
    expect(css).toContain('html[data-reduce-motion="on"] *:not(.animate-spin):not([role="progressbar"])');
    expect(css).toContain('html:not([data-reduce-motion="off"]) *:not(.animate-spin):not([role="progressbar"])');
    expect(css).not.toMatch(/prefers-reduced-motion: reduce\) \{\s*\*, \*::before/);
  });
});
