import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { assertNoGoogleFonts, stripGoogleFonts } from "./brandHtml";

/**
 * Matjarak 2.0 — المرحلة 1C-3B: إزالة روابط Google Fonts من HTML بتاع v2 فقط، على client/index.html الحقيقي.
 */
const ROOT = path.resolve(__dirname, "../../..");
const html = fs.readFileSync(path.join(ROOT, "client/index.html"), "utf-8");
const lines = (s: string) => s.split("\n");

describe("🌐 stripGoogleFonts — HTML بتاع v2 بلا Google Fonts", () => {
  it("يشيل تعليق الخطوط + preconnect ×2 + stylesheet بالظبط، ومايلمسش أي سطر تاني", () => {
    const out = stripGoogleFonts(html);
    expect(out).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(out).not.toContain("Google Fonts");
    // الأسطر المحذوفة = كتلة متصلة واحدة (8 أسطر: تعليق سطرين + preconnect ×2 + stylesheet 4 أسطر)، وبقية الملف بنفس الترتيب حرفيًا
    const src = lines(html); const start = src.findIndex(l => l.includes("<!--") && l.includes("Noto Kufi Arabic"));
    const block = src.slice(start, start + 8);
    expect(block.join("\n")).toMatch(/Google Fonts/);
    expect(block.filter(l => /<link/.test(l)).length).toBe(3);
    expect(block.at(-1)!.trim()).toBe("/>");
    expect(lines(out)).toEqual([...src.slice(0, start), ...src.slice(start + 8)]);
  });

  it("التعليقات والوسوم التانية سليمة (theme-color، color-scheme، favicon، title، السكربت)", () => {
    const out = stripGoogleFonts(html);
    for (const keep of ['<meta name="theme-color" media="(prefers-color-scheme: light)"', '<meta name="theme-color" media="(prefers-color-scheme: dark)"',
      '<meta name="color-scheme" content="light dark" />', '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />', "<title>", '<script type="module" src="/src/main.tsx">', "لون شريط المتصفح"])
      expect(out, keep).toContain(keep);
  });

  it("idempotent، وassertNoGoogleFonts يقبل الناتج ويرفض الأصل", () => {
    const out = stripGoogleFonts(html);
    expect(stripGoogleFonts(out)).toBe(out);
    expect(() => assertNoGoogleFonts(out)).not.toThrow();
    expect(() => assertNoGoogleFonts(html)).toThrow(/Google Fonts links remain/);
    // رسالة واضحة للمطور: الرابط المتبقي بنصّه + طريقة الإصلاح
    const odd = stripGoogleFonts(html.replace('href="https://fonts.googleapis.com" />', 'href="//fonts.googleapis.com" />'));
    expect(() => assertNoGoogleFonts(odd)).toThrow(/leftover: <link rel="preconnect" href="\/\/fonts\.googleapis\.com" \/>/);
    expect(() => assertNoGoogleFonts(odd)).toThrow(/Fix: remove that link from client\/index\.html, or extend the pattern in client\/src\/lib\/brandHtml\.ts/);
  });

  it("تعليق قبل تعليق الخطوط مايتمسحش معاه (الإزالة جوه حدود تعليق واحد)", () => {
    const sample = "<head>\n    <!-- أ -->\n    <meta a />\n    <!-- الخطوط: Google Fonts\n         سطر تاني -->\n    <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\" />\n</head>\n";
    expect(stripGoogleFonts(sample)).toBe("<head>\n    <!-- أ -->\n    <meta a />\n</head>\n");
  });
});

describe("🔌 brandHtmlPlugin في vite.config — v2 فقط، بنفس قراءة VITE_BRAND اللي الواجهة بتاخدها", () => {
  const cfg = fs.readFileSync(path.join(ROOT, "vite.config.ts"), "utf-8");
  it("مسجّل، ويقرأ config.env.VITE_BRAND عبر brandFromEnv، ويطبّق الإزالة لما brand === \"v2\" بس", () => {
    expect(cfg).toMatch(/brandHtmlPlugin\(\),\n\];/);
    expect(cfg).toContain("brand = brandFromEnv(config.env.VITE_BRAND);");
    expect(cfg).toContain('if (brand !== "v2") return html;');
    expect(cfg).toContain("assertNoGoogleFonts(out);");
  });
  it("الواجهة بتقرأ نفس المتغير (main.tsx)", () => {
    expect(fs.readFileSync(path.join(ROOT, "client/src/main.tsx"), "utf-8")).toContain("applyBrandFlag(document.documentElement, import.meta.env.VITE_BRAND);");
  });
});
