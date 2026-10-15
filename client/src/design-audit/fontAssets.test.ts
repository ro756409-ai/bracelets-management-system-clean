import { describe, it, expect } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { ACCENT_IDS, resolvedThemes } from "./cssTokens";

/**
 * Matjarak 2.0 — المرحلة 1C-1: ملفات الخطوط الرسمية + تعريفات @font-face؛ والمرحلة 1C-2: تفعيلها تحت v2 فقط.
 * يثبّت: الملفات كما هي من مصدرها (SHA-256)، التراخيص بجوارها، التعريفات لا تشير إلا لملفات موجودة،
 * والعائلات الجديدة لا يطلبها إلا --font-brand/--font-brand-en في كتلة v2 (فـv1 لا ينزّل شيئًا وخطه كما هو).
 */
const ROOT = path.resolve(__dirname, "../../..");
const PUBLIC = path.join(ROOT, "client/public");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf-8");
const css = read("client/src/index.css");
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(path.join(PUBLIC, f))).digest("hex");

// المصدر الرسمي لكل ملف — أي تعديل/ضغط/تقسيم لاحق يكسر الـhash (ترخيص Plex يحجز اسم «Plex» للنسخ المعدّلة)
const FILES: Record<string, { sha256: string; bytes: number; source: string }> = {
  "fonts/ibm-plex-sans-arabic/1.1.0/IBMPlexSansArabic-Regular.woff2": { sha256: "74112e1b7bf2e2c547989a4e947a60cba6cd1f9156e0065670134636e717199d", bytes: 71904, source: "npm @ibm/plex-sans-arabic@1.1.0 fonts/complete/woff2" },
  "fonts/ibm-plex-sans-arabic/1.1.0/IBMPlexSansArabic-Medium.woff2": { sha256: "c72f6986f50ded745d06e71e508096209c52a55a6b3a81029954e33c52ba1dd2", bytes: 75936, source: "npm @ibm/plex-sans-arabic@1.1.0 fonts/complete/woff2" },
  "fonts/ibm-plex-sans-arabic/1.1.0/IBMPlexSansArabic-SemiBold.woff2": { sha256: "869b2acd0a9660607a2025f0fe1c640110bf23d33417509328f07722922b8063", bytes: 76408, source: "npm @ibm/plex-sans-arabic@1.1.0 fonts/complete/woff2" },
  "fonts/ibm-plex-sans-arabic/1.1.0/IBMPlexSansArabic-Bold.woff2": { sha256: "db6650a05969c144ab5ab9bb6c3beca6ca4dbb3537bb5f2311c878dd293875b4", bytes: 73788, source: "npm @ibm/plex-sans-arabic@1.1.0 fonts/complete/woff2" },
  "fonts/ibm-plex-sans-arabic/1.1.0/LICENSE.txt": { sha256: "7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da", bytes: 4456, source: "npm @ibm/plex-sans-arabic@1.1.0 LICENSE.txt" },
  "fonts/noto-kufi-arabic-digits/v27/NotoKufiArabic-digits.woff2": { sha256: "2d1af255a8efef19fba25f3919d000405087e23e372c0a7857859844354e8044", bytes: 3704, source: "Google Fonts css2 Noto Kufi Arabic wght@400..700 text=U+0660–066C (v27)" },
  "fonts/noto-kufi-arabic-digits/v27/OFL.txt": { sha256: "07fc70bfeb985cc1a87a8587d0a0c80bab11c86c9dc3fd95b6f0cb332f983e96", bytes: 4382, source: "github.com/google/fonts ofl/notokufiarabic/OFL.txt" },
};
const NEW_FAMILIES = ["IBM Plex Sans Arabic", "Noto Kufi Arabic Digits"];
const fontFaces = () => [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(m => m[1]);
const withoutFontFaces = () => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@font-face\s*\{[^}]*\}/g, ""); // التعليقات ليست استخدامًا

describe("🔤 المرحلة 1C-1 — ملفات الخطوط والتراخيص", () => {
  it("كل ملف موجود بنفس البايتات الرسمية (SHA-256 والحجم)، وملفات الخط WOFF2 حقيقية", () => {
    for (const [f, { sha256, bytes }] of Object.entries(FILES)) {
      expect(fs.existsSync(path.join(PUBLIC, f)), f).toBe(true);
      expect([sha(f), fs.statSync(path.join(PUBLIC, f)).size], f).toEqual([sha256, bytes]);
      if (f.endsWith(".woff2")) expect(fs.readFileSync(path.join(PUBLIC, f)).subarray(0, 4).toString("latin1"), f).toBe("wOF2");
    }
  });

  it("لا ملفات زائدة في مجلد الخطوط — كل ملف معروف المصدر", () => {
    const all: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(path.join(PUBLIC, d), { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : all.push(path.join(d, e.name)); };
    walk("fonts");
    expect(all.sort()).toEqual(Object.keys(FILES).sort());
  });

  it("التراخيص: SIL OFL 1.1 بجوار كل خط — Plex باسم محجوز «Plex» (لا تعديل ولا تقسيم)، وNoto بلا اسم محجوز", () => {
    const plex = fs.readFileSync(path.join(PUBLIC, "fonts/ibm-plex-sans-arabic/1.1.0/LICENSE.txt"), "utf-8");
    expect(plex).toContain('Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"');
    expect(plex).toContain("SIL Open Font License, Version 1.1");
    const noto = fs.readFileSync(path.join(PUBLIC, "fonts/noto-kufi-arabic-digits/v27/OFL.txt"), "utf-8");
    expect(noto.split("\n")[0]).toBe("Copyright 2022 The Noto Project Authors (https://github.com/notofonts/arabic)");
    expect(noto).toContain("SIL Open Font License, Version 1.1");
  });

  it(".gitattributes ضيّق: يستثني نصّي الترخيص فقط (حفظ البايتات الأصلية) — لا قواعد على الكود أو الـCSS أو ملفات الخطوط", () => {
    const rules = read(".gitattributes").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    expect(rules).toEqual([
      "client/public/fonts/ibm-plex-sans-arabic/1.1.0/LICENSE.txt -text -whitespace",
      "client/public/fonts/noto-kufi-arabic-digits/v27/OFL.txt -text -whitespace",
    ]);
  });

  it("لا اعتماديات npm للخطوط (حزم @ibm فيها telemetry عند التثبيت)", () => {
    const pkg = JSON.parse(read("package.json"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter(d => /^@ibm\/|^@fontsource|plex|noto/i.test(d))).toEqual([]);
  });
});

describe("🔤 المرحلة 1C-1/1C-2 — @font-face معرّفة، ومستخدمة تحت v2 فقط", () => {
  it("خمس تعريفات بالضبط: Plex Arabic 400/500/600/700 + الأرقام الهندية فقط (U+0660–066C)، بلا local() وكل url لملف موجود", () => {
    const faces = fontFaces();
    expect(faces).toHaveLength(5);
    const plex = faces.filter(f => f.includes('"IBM Plex Sans Arabic"'));
    expect(plex.map(f => f.match(/font-weight:\s*(\d+)/)?.[1])).toEqual(["400", "500", "600", "700"]);
    const digits = faces.filter(f => f.includes('"Noto Kufi Arabic Digits"'));
    expect(digits).toHaveLength(1);
    expect(digits[0]).toMatch(/unicode-range:\s*U\+0660-066C;/);
    expect(digits[0]).toMatch(/font-weight:\s*400 700;/);
    for (const f of faces) {
      expect(f).toContain("font-display: swap;");
      expect(f).not.toMatch(/local\(/);
      const url = f.match(/url\("([^"]+)"\)/)![1];
      expect(Object.keys(FILES), url).toContain(url.slice(1));
    }
  });

  it("العائلات الجديدة لا تُذكر إلا في --font-brand/--font-brand-en داخل كتلة v2 (1C-2) — v1 كما هو، ولا font-family آخر ولا مكونات", () => {
    const V2_STACKS = [
      "--font-brand: 'Noto Kufi Arabic Digits', 'IBM Plex Sans Arabic', 'Segoe UI', 'Tahoma', 'Arial', sans-serif;",
      "--font-brand-en: 'Noto Kufi Arabic Digits', 'IBM Plex Sans Arabic', 'Segoe UI', 'Arial', sans-serif;",
    ];
    const v2Block = css.match(/:root\[data-brand="v2"\]\s*\{([^}]*)\}/)![1];
    for (const l of V2_STACKS) expect(v2Block, l).toContain(l);
    let rest = withoutFontFaces(); for (const l of V2_STACKS) rest = rest.replace(l, "");
    for (const fam of NEW_FAMILIES) expect(rest, fam).not.toContain(fam);
    expect(css).toContain("--font-brand: 'DM Sans', 'Noto Kufi Arabic', 'Segoe UI', 'Tahoma', 'Arial', sans-serif;");
    expect(css).toContain("--font-brand-en: 'DM Sans', 'Segoe UI', 'Arial', sans-serif;");
    // قالبا الطباعة يذكران «IBM Plex Sans Arabic» من قبل 1C في نافذة منفصلة (window.open) بلا هذا الـCSS — لا يتأثران
    const PRINT_WINDOWS = ["client/src/lib/printExpenses.ts", "client/src/lib/printPayslip.ts"];
    const walk = (d: string): string[] => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const users = walk("client/src").filter(f => /\.(tsx?|css)$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== "client/src/index.css")
      .filter(f => NEW_FAMILIES.some(fam => read(f).includes(fam)));
    expect(users.sort()).toEqual(PRINT_WINDOWS);
    for (const f of PRINT_WINDOWS) expect(read(f)).toContain("window.open(");
  });

  it("index.html كما هو: لا preload ولا إشارة لملفات /fonts/", () => {
    const html = read("client/index.html");
    expect(html).not.toContain("/fonts/");
    expect(html).not.toMatch(/rel="preload"/);
  });
});

describe("🔤 المرحلة 1C-2 — Plex Arabic تحت v2 فقط بأرقام هندية جدولية", () => {
  const themes = resolvedThemes(css);
  const V1 = ["DM Sans", "Noto Kufi Arabic", "Segoe UI"];
  const fams = (t: string, k: string) => themes[t][k].split(",").map(f => f.trim().replace(/^'|'$/g, ""));

  it("الهوية الحالية (كل الأوضاع والألوان المحفوظة): نفس عائلتي الخط حرفيًا", () => {
    for (const t of Object.keys(themes).filter(t => !t.includes("v2"))) {
      expect(fams(t, "--font-brand").slice(0, 3), t).toEqual(V1);
      expect(fams(t, "--font-brand-en").slice(0, 2), t).toEqual(["DM Sans", "Segoe UI"]);
    }
  });

  it("v2 (فاتح وداكن وكل الألوان الأربعة): الأرقام الهندية من Noto Kufi Digits أولًا ثم Plex Arabic — في الواجهة وفي font-en (المبالغ)", () => {
    const v2 = Object.keys(themes).filter(t => t.includes("v2"));
    expect(v2.length).toBe(2 + 2 * ACCENT_IDS.length);
    for (const t of v2) for (const k of ["--font-brand", "--font-brand-en"]) {
      expect(fams(t, k).slice(0, 2), `${t} ${k}`).toEqual(["Noto Kufi Arabic Digits", "IBM Plex Sans Arabic"]);
      expect(fams(t, k), `${t} ${k}`).not.toContain("DM Sans");
    }
  });

  it("وجه الأرقام لا يأخذ إلا U+0660–066C — فالمسافة واللاتيني والعربي من Plex", () => {
    const digits = fontFaces().find(f => f.includes('"Noto Kufi Arabic Digits"'))!;
    expect(digits.match(/unicode-range:\s*([^;]+);/)![1].trim()).toBe("U+0660-066C");
  });
});

describe("🧾 تخطيط تحت v2 فقط (1C-2) — بمتغير brand-v2 فلا يتغير v1", () => {
  it("المتغير brand-v2 معرّف على <html data-brand=\"v2\"> فقط", () => {
    expect(css).toContain('@custom-variant brand-v2 (&:where([data-brand="v2"] *));');
  });

  it("جدول الأوردرات: الإجمالي ورسوم الشحن والمحصَّل لا تلتف تحت v2 (brand-v2:whitespace-nowrap) مع tabular-nums وfont-en كما كانت", () => {
    const src = read("client/src/components/orders/OrdersTable.tsx");
    for (const v of ["order.totalAmount", "order.projectedShippingCostSnapshot", "order.collectedAmount"]) {
      const span = src.match(new RegExp(`<span className="([^"]*)">\\{money\\(${v.replace(".", "\\.")}\\)\\}</span>`));
      expect(span, v).not.toBeNull();
      const cls = span![1].split(" ");
      for (const c of ["font-en", "tabular-nums", "brand-v2:whitespace-nowrap"]) expect(cls, `${v} ${c}`).toContain(c);
      expect(cls, `${v} بلا nowrap عام يمس v1`).not.toContain("whitespace-nowrap");
    }
  });

  it("سجل الحركات: عمود «من ← إلى» بعرض أدنى 7.5rem تحت v2 فقط (الخلية والعنوان)", () => {
    const src = read("client/src/pages/ledger/LedgerTransactions.tsx");
    const flow = src.match(/\{ id: "flow",[^\n]*/)![0];
    expect(flow).toContain('className: "brand-v2:min-w-[7.5rem]"');
    expect(flow).toContain('headerClassName: "brand-v2:min-w-[7.5rem]"');
  });
});
