import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AR_LOCALE, arLocaleFor, LATIN_DIGITS_AR_LOCALE } from "./format";
import { formatNumber } from "@/components/public/PricingCards";

/**
 * تنسيق الأرقام: v2 = أرقام غربية بأسماء شهور عربية، v1 = زي ما هو. مصدر واحد (AR_LOCALE) بلا أي تعديل عام على Intl/prototypes.
 */
const INDIC = /[٠-٩]/;
const d = new Date("2026-10-19T12:05:00Z");
const v2 = arLocaleFor("v2"), v1 = arLocaleFor(null);

describe("🔢 locale العرض العربي", () => {
  it("v2 ⇒ ar-EG-u-nu-latn، v1 ⇒ ar-EG، والاختبارات (من غير VITE_BRAND) ⇒ سلوك v1", () => {
    expect(v2).toBe(LATIN_DIGITS_AR_LOCALE);
    expect(v1).toBe("ar-EG");
    expect(AR_LOCALE).toBe("ar-EG");
  });
  it("v2 عربي: مبالغ وأعداد ونِسَب وتواريخ وأوقات بأرقام غربية، والشهر و«م/ص» عربي", () => {
    const out = {
      amount: `${(2010).toLocaleString(v2)} ج.م`,
      decimal: (1999.5).toLocaleString(v2, { minimumFractionDigits: 2 }),
      count: new Intl.NumberFormat(v2).format(28),
      percent: new Intl.NumberFormat(v2, { style: "percent" }).format(0.21),
      date: d.toLocaleDateString(v2, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }),
      short: d.toLocaleDateString(v2, { day: "numeric", month: "short", timeZone: "UTC" }),
      time: d.toLocaleTimeString(v2, { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }),
    };
    for (const [k, v] of Object.entries(out)) expect(v, k).not.toMatch(INDIC);
    expect(out.amount).toBe("2,010 ج.م");
    expect(out.decimal).toBe("1,999.50");
    expect(out.date).toBe("19 أكتوبر 2026");
    expect(out.time).toMatch(/^12:05\s?م$/);
  });
  it("v1 عربي: نفس الأرقام الهندية الحالية (مفيش تغيير)", () => {
    expect((2010).toLocaleString(v1)).toBe("٢٬٠١٠");
    expect(d.toLocaleDateString(v1, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })).toBe("١٩ أكتوبر ٢٠٢٦");
  });
  it("الإنجليزي والأسعار: أرقام غربية دايمًا (500 / 1,999 / 3,999، و399.80)", () => {
    expect([500, 1999, 3999, 399.8, 333.25].map(formatNumber)).toEqual(["500", "1,999", "3,999", "399.80", "333.25"]);
    expect(d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })).not.toMatch(INDIC);
    expect(new Intl.NumberFormat("en-US").format(1999)).toBe("1,999");
  });
});

describe("🛡️ مفيش تعديل عام ولا locale مكتوب يدويًا", () => {
  const SRC = path.resolve(__dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p); } };
  walk(SRC);
  it("مفيش \"ar-EG\" مكتوب في أي ملف واجهة غير lib/format.ts — كل التنسيق من AR_LOCALE", () => {
    const offenders = files.filter(f => !f.endsWith(path.join("lib", "format.ts")) && /(["'])ar-EG\1/.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map(f => path.relative(SRC, f))).toEqual([]);
  });
  it("مفيش monkey-patching لـIntl أو toLocale*String في الواجهة", () => {
    const patched = files.filter(f => /(Number|Date)\.prototype\.toLocale\w*\s*=|\(Intl as any\)\.\w+\s*=|Intl\.(NumberFormat|DateTimeFormat)\s*=/.test(fs.readFileSync(f, "utf8")));
    expect(patched.map(f => path.relative(SRC, f))).toEqual([]);
  });
});
