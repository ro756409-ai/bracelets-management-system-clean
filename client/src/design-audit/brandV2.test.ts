import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ACCENT_IDS, contrast, deltaE, over, parseColor, parseThemeBlocks, resolvedThemes } from "./cssTokens";
import { measure } from "./contrastPairs";

/**
 * Matjarak 2.0 — المرحلة 1A: tokens الهوية الجديدة (Oxblood × Ice Blue) خلف data-brand="v2".
 * الهوية الحالية تبقى الافتراضي حرفيًا، والجديدة ألوان فقط، وألوان الحالات مستقلة، وOxblood مميَّز عن لون الخطأ،
 * وحدود الحقول ≥ 3:1، وIce Blue لا يُستخدم نصًا على الفاتح.
 */
const css = fs.readFileSync(path.resolve(__dirname, "../index.css"), "utf-8");
const blocks = parseThemeBlocks(css);
const themes = resolvedThemes(css);
const V2 = Object.keys(themes).filter(t => t.includes("v2"));
const color = (theme: string, token: string) => parseColor(themes[theme][`--${token}`], themes[theme])!;
const hex = (theme: string, token: string) => { const c = color(theme, token); return `#${[c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase(); };

/** بصمة tokens الهوية الحالية (الكتل بلا v2، وبلا الألوان الأساسية --mj-*) عند a3c2fed — أي تغيير فيها يُفشل الاختبار.
 *  أسماء المرحلة 1B-1 الجديدة (BRAND_TOKENS/COMPONENT_TOKENS) مستثناة هنا ومثبتة بقيمها في اختبار مستقل أدناه. */
const V1_FINGERPRINT = "2ebbfad90fa03a21fda2aa7c7fba3c4c11814d526f4ff4c5d08d912246673f34";
const BRAND_TOKENS = ["--brand-surface", "--brand-surface-strong", "--brand-on-surface", "--brand-mark", "--brand-mark-strong", "--brand-mark-foreground"];
const COMPONENT_TOKENS = ["--switch-track", "--switch-track-border", "--switch-thumb-off"];
const NEW_1B1 = new Set([...BRAND_TOKENS, ...COMPONENT_TOKENS]);
const STATUS = ["success", "warning", "destructive", "info", "error"];

describe("🎨 المرحلة 1A — الهوية الجديدة خلف data-brand=\"v2\"", () => {
  it("الهوية الحالية لم تتغير: بصمة tokens الكتل الحالية = a3c2fed (الافتراضي في كل البيئات)", () => {
    const sem = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith("--mj-") && !NEW_1B1.has(k)).sort(([a], [b]) => a.localeCompare(b)));
    const keys = Object.keys(blocks).filter(k => !k.includes("v2")).sort();
    const canon = JSON.stringify(keys.map(k => [k, sem(blocks[k])]));
    expect(crypto.createHash("sha256").update(canon).digest("hex")).toBe(V1_FINGERPRINT);
  });

  it("ألوان البراند الدقيقة: Oxblood #672A39 أساسي فاتح، Ice Blue #C5EAF2، Off-white وInk والرمادي الناعم", () => {
    expect([hex("light:v2", "primary"), hex("light:v2", "brand-ice"), hex("light:v2", "background"), hex("light:v2", "foreground"), hex("light:v2", "border")])
      .toEqual(["#672A39", "#C5EAF2", "#FAF9F7", "#252329", "#E8E5E4"]);
    expect(hex("dark:v2", "primary")).toBe("#D98B99"); // Oxblood نفسه 1.46:1 على الداكن
  });

  it("الهوية الجديدة ألوان فقط: لا خطوط ولا زوايا ولا ظلال ولا مقاسات ولا حركة في كتلتي v2", () => {
    const keys = [...Object.keys(blocks["light:v2"]), ...Object.keys(blocks["dark:v2"])];
    // --text-12…30 مقاسات خط (ممنوعة هنا)؛ --text-2 لون نص ثانوي (مسموح)
    expect(keys.filter(k => /^--(font|radius|text-\d{2}|shadow|control|duration|ease|space|pattern)/.test(k))).toEqual([]);
  });

  it("ألوان الحالات مستقلة: النجاح/التحذير/الخطر/المعلومات/الخطأ بنفس قيم الهوية الحالية، ولا تعرّفها كتلتا v2", () => {
    for (const s of STATUS) for (const k of [s, `${s}-foreground`]) {
      expect(blocks["light:v2"][`--${k}`], k).toBeUndefined();
      expect(blocks["dark:v2"][`--${k}`], k).toBeUndefined();
      expect(hex("light:v2", k), k).toBe(hex("light", k));
      expect(hex("dark:v2", k), k).toBe(hex("dark", k));
    }
  });

  it("Oxblood مميَّز عن لون الخطأ: ΔE*ab ≥ 25 بين الأساسي وكل من destructive وerror في الوضعين (وفي كل لون بديل)", () => {
    for (const t of V2) for (const s of ["destructive", "error"]) {
      const d = deltaE(color(t, "primary"), color(t, s));
      expect(d, `${t} primary vs ${s} = ${d.toFixed(1)}`).toBeGreaterThanOrEqual(25);
    }
    expect(Math.round(deltaE(color("light:v2", "primary"), color("light:v2", "destructive")))).toBe(48);
    expect(Math.round(deltaE(color("dark:v2", "primary"), color("dark:v2", "destructive")))).toBe(31);
  });

  it("حدود الحقول ≥ 3:1 (WCAG 1.4.11) على الخلفية والبطاقة في كل ثيمات v2 — كانت 1.17–1.38", () => {
    for (const t of V2) for (const m of measure(t, themes[t]).filter(x => x.id.startsWith("input/"))) {
      expect(m.ratio!, `${t} ${m.id}`).toBeGreaterThanOrEqual(3);
    }
    expect(measure("light:v2", themes["light:v2"]).find(m => m.id === "input/card")!.ratio).toBe(3.63);
  });

  it("كل أزواج النص (4.5:1) والعناصر (3:1) تنجح في ثيمات v2 الثمانية (الفاتح والداكن × الافتراضي و3 ألوان بديلة)", () => {
    expect(V2.sort()).toEqual(["dark:v2", "dark:v2:indigo", "dark:v2:olive", "dark:v2:teal", "light:v2", "light:v2:indigo", "light:v2:olive", "light:v2:teal"]);
    const fails = V2.flatMap(t => measure(t, themes[t])).filter(m => !m.ok).map(m => `${m.theme} ${m.id} ${m.ratio}`);
    expect(fails).toEqual([]);
  });

  it("Ice Blue ليس نصًا على الفاتح (1.28:1): لا token نصي في الفاتح يساوي Ice Blue، وهو سطح بنص Ink (≥ 12:1)", () => {
    const textTokens = ["foreground", "card-foreground", "popover-foreground", "primary-text", "accent-foreground", "muted-foreground", "secondary-foreground", "text-2"];
    for (const t of V2.filter(x => x.startsWith("light"))) for (const k of textTokens) expect(hex(t, k), `${t} ${k}`).not.toBe("#C5EAF2");
    const ice = color("light:v2", "brand-ice"), ink = color("light:v2", "brand-ice-foreground");
    expect(deltaE(ice, ink)).toBeGreaterThan(50);
  });

});

/**
 * أولوية التطبيق مع الألوان المحفوظة للمستخدم (نحاسي/تركواز/نيلي/زيتوني) — بلا تضارب غير مقصود:
 *  1) كل الكتل الملوّنة بسمة واحدة لها نفس الأولوية (0,2,0): :root[data-brand], .dark[data-brand], :root[data-accent], .dark[data-accent]
 *     — أعلى من :root و .dark (0,1,0)؛ فالأحدث في الملف يغلب عند التساوي.
 *  2) الترتيب في index.css: :root ← .dark ← v2 فاتح ← v2 داكن ← لون محفوظ فاتح ← لون محفوظ داكن.
 *  3) النتيجة: tokens الهوية العامة (الخلفية، النص، الحدود، الحقول، الحالات…) من v2، وtokens اللون المحفوظ فقط (primary
 *     وعائلته وring وchart-1 وsidebar-primary) من اختيار المستخدم. «نحاسي» = بلا كتلة لون ⇒ Oxblood تحت v2.
 */
const ACCENT_SCOPE = ["--primary", "--primary-foreground", "--primary-text", "--primary-dark", "--primary-soft", "--accent", "--accent-foreground",
  "--ring", "--chart-1", "--sidebar-primary", "--sidebar-primary-foreground", "--gradient-brand"];

describe("🎚️ المرحلة 1A — أولوية الألوان المحفوظة مع data-brand=\"v2\"", () => {
  const order = (sel: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").search(new RegExp(`(^|\\n)\\s*${sel.replace(/[.[\]"]/g, m => `\\${m}`)}\\s*\\{`));

  it("الترتيب في الملف: كتلتا v2 بعد :root و .dark وقبل كل كتل الألوان المحفوظة (فاللون المحفوظ يغلب عند التساوي)", () => {
    const v2 = [order(':root[data-brand="v2"]'), order('.dark[data-brand="v2"]')];
    const accents = ACCENT_IDS.flatMap(a => [order(`:root[data-accent="${a}"]`), order(`.dark[data-accent="${a}"]`)]);
    expect([...v2, ...accents].every(i => i > 0)).toBe(true);
    expect(v2[0]).toBeGreaterThan(order(".dark"));
    expect(v2[1]).toBeGreaterThan(v2[0]);
    expect(Math.min(...accents)).toBeGreaterThan(Math.max(...v2));
  });

  it("نفس الأولوية: كل محددات البراند والألوان بسمة واحدة بالضبط على :root أو .dark (لا محدد مركّب يقلب الترتيب)", () => {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const sels = (clean.match(/(^|\n)\s*(:root|\.dark)\[data-(brand|accent)[^\n{]*\{/g) ?? []).map(x => x.trim().replace(/\s*\{$/, ""));
    expect(sels.length).toBe(2 + ACCENT_IDS.length * 2);
    for (const s of sels) expect(s, s).toMatch(/^(:root|\.dark)\[data-(brand|accent)="[a-z0-9]+"\]$/);
    // أي كتلة أخرى بسمة على الجذر (مثل data-density للكثافة) لا تعرّف أي token لون — فلا تتقاطع مع الهوية أو اللون المحفوظ
    const others = [...clean.matchAll(/(:root|\.dark)\[data-(?!brand|accent)[a-z-]+="[^"]*"\]\s*\{([^}]*)\}/g)];
    expect(others.length).toBeGreaterThan(0);
    const COLOR_TOKENS = new Set(Object.keys(blocks["light:v2"]));
    for (const m of others) {
      const keys = [...m[2].matchAll(/(--[a-z0-9-]+)\s*:/g)].map(k => k[1]);
      expect(keys.filter(k => COLOR_TOKENS.has(k) || ACCENT_SCOPE.includes(k)), m[0].slice(0, 40)).toEqual([]);
    }
  });

  it("الألوان المحفوظة لا تلمس إلا tokens اللون نفسه — لا خلفيات ولا نصوص ولا حدود ولا حقول ولا ألوان حالات", () => {
    for (const a of ACCENT_IDS) for (const mode of ["light", "dark"]) {
      const extra = Object.keys(blocks[`${mode}:${a}`] ?? {}).filter(k => !ACCENT_SCOPE.includes(k));
      expect(extra, `${mode}:${a}`).toEqual([]);
    }
  });

  it("النتيجة لكل تركيبة (4 ألوان × فاتح/داكن × مع/بدون v2): اللون المحفوظ يغلب في نطاقه فقط، والباقي من الهوية", () => {
    const tokensOf = (t: string) => themes[t];
    const v2Only = (mode: string) => ({ ...blocks["light:v2"], ...(mode === "dark" ? blocks["dark:v2"] : {}) });
    for (const mode of ["light", "dark"]) {
      const v2 = v2Only(mode);
      // نحاسي (الافتراضي، بلا كتلة لون): كل شيء من v2 — Oxblood
      expect(hex(`${mode}:v2`, "primary")).toBe(mode === "light" ? "#672A39" : "#D98B99");
      for (const a of ACCENT_IDS) {
        const t = `${mode}:v2:${a}`, accentBlock = { ...blocks[`light:${a}`], ...(mode === "dark" ? blocks[`dark:${a}`] : {}) };
        for (const k of ACCENT_SCOPE.filter(k => accentBlock[k] != null)) expect(tokensOf(t)[k], `${t} ${k}`).toBe(accentBlock[k]);
        for (const k of Object.keys(v2).filter(k => !ACCENT_SCOPE.includes(k))) expect(tokensOf(t)[k], `${t} ${k}`).toBe(v2[k]);
        // بدون v2: نفس اللون المحفوظ فوق الهوية الحالية كما كان
        expect(tokensOf(`${mode}:${a}`)["--primary"]).toBe(accentBlock["--primary"]);
        expect(tokensOf(`${mode}:${a}`)["--background"]).toBe(tokensOf(mode)["--background"]);
      }
    }
  });
});

/**
 * المرحلة 1B-1 — ألوان البراند الثابتة مفصولة عن لون مساحة العمل، وألوان الـSwitch مفصولة عن --input.
 * في الهوية الحالية الأسماء الجديدة = القيم المستخدمة اليوم حرفيًا (لا تغيير مرئي)، وتحت v2 البراند ثابت مهما كان لون المستخدم.
 */
describe("🏛️ المرحلة 1B-1 — البراند الثابت × مساحة العمل × ألوان المكوّنات", () => {
  const solid = (t: string, k: string) => { const tk = themes[t]; return over(parseColor(tk[`--${k}`], tk)!, parseColor(tk["--card"], tk)!); };
  const ratio = (t: string, a: string, b: string) => Math.round(contrast(solid(t, a), solid(t, b)) * 100) / 100;
  const CURRENT = Object.keys(themes).filter(t => !t.includes("v2"));

  it("الهوية الحالية: الأسماء الجديدة تساوي القيم المستخدمة اليوم حرفيًا (فاتح/داكن × الألوان الأربعة)", () => {
    for (const t of CURRENT) {
      const tk = themes[t];
      expect([tk["--brand-surface"], tk["--brand-surface-strong"], tk["--brand-on-surface"], tk["--brand-mark"], tk["--brand-mark-strong"], tk["--brand-mark-foreground"]], t)
        .toEqual(["var(--primary)", "var(--primary-dark)", "var(--primary-foreground)", "var(--primary)", "var(--primary-dark)", "#FFFFFF"]);
      expect(tk["--switch-track-border"], t).toBe("transparent");
      if (t.startsWith("light")) expect([tk["--switch-track"], tk["--switch-thumb-off"]], t).toEqual(["var(--input)", "var(--background)"]);
      // نفس صيغة Tailwind لمسار الداكن (input بشفافية 80%) ونفس مقبضه (لون foreground)
      else expect([tk["--switch-track"], tk["--switch-thumb-off"]], t).toEqual(["color-mix(in oklab, var(--input) 80%, transparent)", "var(--foreground)"]);
      // ولهذا يتبع البراند لون المستخدم في الهوية الحالية كما اليوم بالضبط
      expect(hex(t, "brand-surface"), t).toBe(hex(t, "primary"));
    }
  });

  it("تحت v2: البراند ثابت (Oxblood) في كل لون محفوظ، بينما لون مساحة العمل يتبع اختيار المستخدم", () => {
    const expected = { light: ["#672A39", "#51202D", "#FFFFFF", "#672A39", "#51202D", "#FFFFFF"], dark: ["#4A1D28", "#2E1118", "#FFFFFF", "#7E3445", "#672A39", "#FFFFFF"] };
    for (const mode of ["light", "dark"] as const) for (const a of ["", ...ACCENT_IDS.map(x => `:${x}`)]) {
      const t = `${mode}:v2${a}`;
      expect(BRAND_TOKENS.map(k => hex(t, k.slice(2))), t).toEqual(expected[mode]);
      if (a) expect(hex(t, "primary"), t).not.toBe(hex(`${mode}:v2`, "primary")); // مساحة العمل = لون المستخدم
    }
  });

  it("كتل الألوان المحفوظة لا تعرّف أي لون براند أو مكوّن — في الهويتين", () => {
    for (const a of ACCENT_IDS) for (const mode of ["light", "dark"]) {
      const keys = Object.keys(blocks[`${mode}:${a}`] ?? {});
      expect(keys.filter(k => NEW_1B1.has(k) || k.startsWith("--brand-")), `${mode}:${a}`).toEqual([]);
    }
  });

  it("تباين البراند تحت v2: النص على أسطح البراند ورمز الشعار على دائرته ≥ 4.5:1 في الوضعين", () => {
    for (const t of ["light:v2", "dark:v2"]) {
      for (const bg of ["brand-surface", "brand-surface-strong"]) expect(ratio(t, "brand-on-surface", bg), `${t} ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const bg of ["brand-mark", "brand-mark-strong"]) expect(ratio(t, "brand-mark-foreground", bg), `${t} ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect([ratio("light:v2", "brand-on-surface", "brand-surface"), ratio("dark:v2", "brand-on-surface", "brand-surface")]).toEqual([10.68, 14.02]);
  });

  it("الـSwitch المقفول تحت v2 (الخيار ب): الحد ≥ 3:1 مع الخلفية والبطاقة، والمقبض ≥ 3:1 على المسار وعلى البطاقة — في كل لون محفوظ", () => {
    for (const t of V2) {
      expect(ratio(t, "switch-track-border", "background"), `${t} border/bg`).toBeGreaterThanOrEqual(3);
      expect(ratio(t, "switch-track-border", "card"), `${t} border/card`).toBeGreaterThanOrEqual(3);
      expect(ratio(t, "switch-thumb-off", "switch-track"), `${t} thumb/track`).toBeGreaterThanOrEqual(3);
      expect(ratio(t, "switch-thumb-off", "card"), `${t} thumb/card`).toBeGreaterThanOrEqual(3);
    }
    // المسار نفسه لم يعد --input: فاتح ناعم بدل الرمادي الداكن
    expect([hex("light:v2", "switch-track"), hex("light:v2", "input")]).toEqual(["#E8E5E4", "#8A8588"]);
    expect([ratio("light:v2", "switch-thumb-off", "switch-track"), ratio("dark:v2", "switch-thumb-off", "switch-track")]).toEqual([4.52, 5.35]);
  });
});
