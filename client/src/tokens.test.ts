import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حارس الثيم (Copper Signature × Clean Spatial — المرحلة 1):
 *   • أسماء shadcn القديمة كلها باقية في @theme inline و:root و.dark (لا مكوّن ينكسر).
 *   • المتغيرات الجديدة (surface-2, text-2, primary-soft, primary-text, rx-good, ai) معرّفة في الثلاثة.
 *   • القيم الأساسية = جدول Theme Spec §7 حرفيًا.
 *   • تباين WCAG AA يُحسب **للأزواج كما تُستخدم فعلًا** (نص على سطح، نص على زر، شارة حالة على
 *     خلفية 10%، عنصر سايدبار نشط، زر الحذف الداكن المركّب بـ60%)، لا للـTokens منفردة.
 *   • الخطوط والـtheme-color وتقليل الحركة وfocus ring موجودة، ولا أثر للبنفسجي القديم.
 */
const css = fs.readFileSync("client/src/index.css", "utf-8");
const html = fs.readFileSync("client/index.html", "utf-8");

const block = (selector: string): Record<string, string> => {
  const start = css.indexOf(`${selector} {`);
  expect(start, `block ${selector}`).toBeGreaterThan(-1);
  let depth = 0, i = start + selector.length + 1, end = -1;
  for (; i < css.length; i++) { if (css[i] === "{") depth++; else if (css[i] === "}") { depth--; if (depth === 0) { end = i; break; } } }
  const body = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
  return out;
};
const theme = block("@theme inline"), light = block(":root"), dark = block(".dark");

type RGB = [number, number, number];
const parse = (v: string): RGB | { rgba: RGB; a: number } => {
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)) as RGB;
  const rgba = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/i);
  if (rgba) return { rgba: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], a: rgba[4] !== undefined ? Number(rgba[4]) : 1 };
  throw new Error(`لون غير مفهوم: ${v}`);
};
/** لون نهائي فوق سطح: hex كما هو، وrgba تُمزج فوق السطح، ومعامل alpha اختياري للطبقات مثل bg-x/10. */
const resolve = (v: string, over: RGB, alpha = 1): RGB => {
  const p = parse(v);
  const [fg, a] = Array.isArray(p) ? [p, alpha] : [p.rgba, p.a * alpha];
  return fg.map((c, i) => Math.round(c * a + over[i] * (1 - a))) as RGB;
};
const lum = ([r, g, b]: RGB) => { const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const SHADCN = ["background", "foreground", "card", "card-foreground", "popover", "popover-foreground", "primary", "primary-foreground", "primary-dark", "secondary", "secondary-foreground", "muted", "muted-foreground", "accent", "accent-foreground", "destructive", "destructive-foreground", "success", "success-foreground", "warning", "warning-foreground", "info", "info-foreground", "error", "error-foreground", "purple", "purple-foreground", "cyan", "cyan-foreground", "amber", "amber-foreground", "orange", "orange-foreground", "delivered", "delivered-foreground", "border", "input", "ring", "chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "sidebar", "sidebar-foreground", "sidebar-primary", "sidebar-primary-foreground", "sidebar-accent", "sidebar-accent-foreground", "sidebar-border", "sidebar-ring"];
const NEW = ["surface-2", "text-2", "primary-soft", "primary-text", "rx-good", "rx-good-foreground", "ai", "ai-foreground"];

describe("🎨 Tokens — Copper Signature × Clean Spatial", () => {
  it("كل أسماء shadcn القديمة باقية في @theme inline و:root و.dark، والجديدة مضافة في الثلاثة", () => {
    for (const n of [...SHADCN, ...NEW]) {
      expect(theme[`--color-${n}`], `@theme --color-${n}`).toBe(`var(--${n})`);
      expect(light[`--${n}`], `:root --${n}`).toBeTruthy();
      expect(dark[`--${n}`], `.dark --${n}`).toBeTruthy();
    }
  });
  it("القيم الأساسية مطابقة لجدول Theme Spec §7 (Light/Dark)", () => {
    const spec: Record<string, [string, string]> = {
      background: ["#F5F5F3", "#121211"], card: ["#FFFFFF", "#1B1B1A"], "surface-2": ["#F8F8F6", "#20201F"], border: ["#E5E4E0", "#2F2E2B"],
      foreground: ["#141414", "#F3F2EE"], "text-2": ["#4A4946", "#BEBBB4"], "muted-foreground": ["#696863", "#94918A"],
      primary: ["#B4532A", "#E07A4B"], "primary-text": ["#9A421D", "#F29C70"], "primary-soft": ["#F7EBE4", "rgba(224, 122, 75, 0.15)"],
      // success الفاتح: الـPDF يذكر #12804A؛ اعتُمد #0F7443 (أعمق درجة) لأن #12804A = 4.35 فوق صبغة 10% في الشارات
      success: ["#0F7443", "#4CC98C"], warning: ["#A35800", "#F2A848"], destructive: ["#C2302A", "#F47167"], info: ["#1F5FC9", "#7AA9F6"],
      "rx-good": ["#0B7480", "#47C2CE"], ai: ["#FFF6D2", "rgba(242, 200, 80, 0.10)"],
    };
    for (const [n, [l, d]] of Object.entries(spec)) { expect(light[`--${n}`], `light ${n}`).toBe(l); expect(dark[`--${n}`], `dark ${n}`).toBe(d); }
    // القرار المعتمد: نص داكن فوق النحاسي في الوضع الداكن (الأبيض فوق #E07A4B = 2.98 يفشل AA)
    expect(dark["--primary-foreground"]).toBe("#121211");
    expect(light["--primary-foreground"]).toBe("#FFFFFF");
    // لا أثر للبنفسجي القديم في الـTokens أو HTML
    expect(css).not.toMatch(/#5B3DF5|#4527D6|#7C63F7/i);
    expect(html).not.toMatch(/#5B3DF5/i);
  });

  it("تباين WCAG AA للأزواج كما تُستخدم فعلًا — Light وDark", () => {
    const check = (mode: "light" | "dark") => {
      const t = mode === "light" ? light : dark;
      const bg = resolve(t["--background"], [0, 0, 0]);
      const card = resolve(t["--card"], bg);
      const sidebar = resolve(t["--sidebar"], bg);
      const failures: string[] = [];
      const need = (label: string, fg: RGB, over: RGB, min: number) => { const r = ratio(fg, over); if (r < min) failures.push(`${mode} ${label}: ${r.toFixed(2)} < ${min}`); };
      const c = (name: string, over: RGB, alpha = 1) => resolve(t[`--${name}`], over, alpha);
      // نصوص على الأسطح
      need("foreground/background", c("foreground", bg), bg, 4.5);
      need("foreground/card", c("foreground", card), card, 4.5);
      need("text-2/background", c("text-2", bg), bg, 4.5);
      need("muted-foreground/card", c("muted-foreground", card), card, 4.5);
      need("muted-foreground/background", c("muted-foreground", bg), bg, 4.5);
      need("muted-foreground/muted", c("muted-foreground", bg), c("muted", bg), 4.5);
      need("secondary-foreground/secondary", c("secondary-foreground", bg), c("secondary", bg), 4.5);
      need("primary-text/card", c("primary-text", card), card, 4.5);
      need("primary as text/card", c("primary", card), card, 4.5);
      // الزر الرئيسي والحالات الصلبة (نص × خلفية)
      for (const n of ["primary", "destructive", "success", "warning", "info", "rx-good", "error", "purple", "cyan", "amber", "orange", "delivered"])
        need(`${n}-foreground on ${n} (solid)`, c(`${n}-foreground`, bg), c(n, bg), 4.5);
      // zر الحذف في shadcn يكتب text-white فوق bg-destructive (و dark:bg-destructive/60) — نحسبه كما يُرسم
      const destructiveBtn = mode === "dark" ? c("destructive", card, 0.6) : c("destructive", card);
      need("white on destructive button (shadcn)", [255, 255, 255], destructiveBtn, 4.5);
      // شارات الحالة: نص اللون فوق خلفية 10% من اللون نفسه فوق البطاقة (StatusBadge)
      for (const n of ["success", "warning", "destructive", "info", "purple", "cyan", "amber", "orange", "delivered", "rx-good"])
        need(`${n} text on ${n}/10 badge`, c(n, card), c(n, card, 0.10), 4.5);
      // العنصر النشط والشارات الأساسية: accent-foreground فوق accent، primary-text فوق primary-soft
      need("accent-foreground/accent", c("accent-foreground", card), c("accent", card), 4.5);
      need("primary-text/primary-soft", c("primary-text", card), c("primary-soft", card), 4.5);
      need("ai-foreground/ai", c("ai-foreground", card), c("ai", card), 4.5);
      // السايدبار
      need("sidebar-foreground/sidebar", c("sidebar-foreground", sidebar), sidebar, 4.5);
      need("sidebar-accent-foreground/sidebar-accent", c("sidebar-accent-foreground", sidebar), c("sidebar-accent", sidebar), 4.5);
      need("sidebar-primary-foreground/sidebar-primary", c("sidebar-primary-foreground", sidebar), c("sidebar-primary", sidebar), 4.5);
      need("sidebar-primary (icon) on sidebar", c("sidebar-primary", sidebar), sidebar, 3);
      // عناصر غير نصية (WCAG 1.4.11): الحلقة والحدود ≥ 3:1
      need("ring/background", c("ring", bg), bg, 3);
      need("ring/card", c("ring", card), card, 3);
      need("primary (button fill)/background", c("primary", bg), bg, 3);
      expect(failures, failures.join("\n")).toEqual([]);
    };
    check("light"); check("dark");
  });

  it("الخطوط: DM Sans ثم Noto Kufi Arabic مع احتياطي نظامي، وGoogle Fonts بـdisplay=swap، والأرقام جدولية على body", () => {
    expect(html).toMatch(/fonts\.googleapis\.com\/css2\?family=Noto\+Kufi\+Arabic[^"]*family=DM\+Sans[^"]*display=swap/);
    expect(html).not.toMatch(/IBM\+Plex|family=Inter/);
    expect(html).toContain('rel="preconnect" href="https://fonts.gstatic.com" crossorigin');
    expect(light["--font-brand"]).toBe("'DM Sans', 'Noto Kufi Arabic', 'Segoe UI', 'Tahoma', 'Arial', sans-serif");
    expect(light["--font-brand-en"]).toMatch(/^'DM Sans'/);
    expect(theme["--font-sans"]).toBe("var(--font-brand)");
    const body = css.slice(css.indexOf("  body {"), css.indexOf("  body {") + 900);
    expect(body).toContain("font-variant-numeric: tabular-nums;");
    expect(body).toContain('font-feature-settings: "tnum";');
    expect(css).toContain(".tabular-nums {");
  });

  it("theme-color يتبع Light/Dark عبر media، وcolor-scheme معلن، وfocus ring واضح، وتقليل الحركة محترم", () => {
    expect(html).toContain('<meta name="theme-color" media="(prefers-color-scheme: light)" content="#F5F5F3" />');
    expect(html).toContain('<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#121211" />');
    expect(html).toContain('<meta name="color-scheme" content="light dark" />');
    expect(css).toMatch(/html\s*\{[^}]*color-scheme:\s*light;/);
    expect(css).toMatch(/html\.dark\s*\{[^}]*color-scheme:\s*dark;/);
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--ring\);\s*outline-offset:\s*2px;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*animation-duration:\s*0\.01ms !important;[\s\S]*transition-duration:\s*0\.01ms !important;/);
  });

  it("مقاييس الثيم: نصف أقطار 6/8/12/16/22/pill، ومقياس الخط ×--font-scale، وارتفاعات التحكم معلنة بلا استهلاك", () => {
    expect(light["--radius-brand-sm"]).toBe("6px"); expect(light["--radius-brand-md"]).toBe("8px"); expect(light["--radius-brand-lg"]).toBe("12px");
    expect(light["--radius-brand-xl"]).toBe("16px"); expect(light["--radius-brand-2xl"]).toBe("22px"); expect(light["--radius-brand-pill"]).toBe("999px");
    expect(light["--font-scale"]).toBe("1");
    for (const s of [12, 13, 14, 15, 17, 20, 24, 30]) expect(light[`--text-${s}`]).toBe(`calc(${s}px * var(--font-scale))`);
    expect(light["--control-h"]).toBe("42px"); expect(light["--control-h-compact"]).toBe("36px"); expect(light["--control-h-touch"]).toBe("44px");
  });
});
