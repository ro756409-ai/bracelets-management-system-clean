import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * الحارس المعماري لـ**محرّك ربح واحد**.
 *
 * القرار المعتمد (C-P2b): صافي الربح الفعلي بيتحسب في مكان واحد بس —
 * `computeRealizedProfit` — وكل شاشة/دالة بتقرا منه، مفيش معادلة ربح مستقلة في أي مكان.
 * الاختبارات دي بتقرا الكود المصدري وبتقفل على الخاصية دي، فأي رجوع لمحرّكين بيوقّعها.
 *
 * مش محتاجة قاعدة بيانات: بما إن صفحة المحاسبة ومركز التحكّم بينادوا **نفس الدالة**
 * بنفس نافذة الفترة، فـ"نفس الفترة = نفس صافي الربح" مضمونة بالبناء مش بالصدفة.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const accountingV2 = fs.readFileSync("server/accountingV2.service.ts", "utf-8");
const db = fs.readFileSync("server/db.ts", "utf-8");

function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`مالقيتش ${signature}`);
  // من التوقيع لحد أول `\nexport ` بعده — كفاية للتحقق البنيوي.
  const rest = src.slice(start + signature.length);
  const next = rest.indexOf("\nexport ");
  return rest.slice(0, next < 0 ? rest.length : next);
}

describe("🔑 محرّك ربح واحد — التعريف والمصدر", () => {
  it("computeRealizedProfit موجود ومصدَّر مرة واحدة", () => {
    const matches = accountingV2.match(/export async function computeRealizedProfit/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("المرتب في المحرّك بيتحسب بالبدائية المشتركة salaryCostForProfit بس", () => {
    const body = fnBody(accountingV2, "export async function computeRealizedProfit");
    expect(body).toContain("salaryCostForProfit(");
    // مفيش إعادة تعريف لصيغة المرتب هنا (أساسي + أوفرتايم …) — البدائية هي المصدر.
    expect(codeOnly(body)).not.toMatch(/baseSalary\s*\+\s*.*overtimeAmount/);
  });

  it("أحداث المرتبات (payroll_period) مستبعدة من سلة المصروفات — مافيش ازدواج", () => {
    const body = fnBody(accountingV2, "export async function computeRealizedProfit");
    expect(body).toContain('event.sourceType === "payroll_period"');
    expect(codeOnly(body)).toMatch(/payroll_period"\)\s*continue/);
  });

  it("الإعلان بيتفرز بعضوية ad_spend_entries — بند مستقل مش مخصوم مرتين", () => {
    const body = fnBody(accountingV2, "export async function computeRealizedProfit");
    expect(body).toContain("adSpendEntries");
    expect(body).toContain("advertising");
    expect(body).toContain("operatingExpenses");
  });
});

describe("🔑 كل الشاشات بتقرا من نفس المحرّك — مفيش معادلة مستقلة", () => {
  it("لوحة المحاسبة (getBusinessEventDashboard) بتفوّض للمحرّك", () => {
    const body = fnBody(accountingV2, "export async function getBusinessEventDashboard");
    expect(body).toContain("await computeRealizedProfit(");
    // مفيش جمع أحداث ربح يدوي هنا بعد التفويض.
    expect(codeOnly(body)).not.toMatch(/realizedProfit\s*=\s*[^;]*[-]/);
  });

  it("مركز التحكّم (getAccountingControlCenter) بيفوّض للمحرّك مش لمعادلة تانية", () => {
    const body = fnBody(db, "export async function getAccountingControlCenter");
    expect(body).toContain("computeRealizedProfit({");
    expect(body).not.toContain("getAccountingDashboard({");
  });

  it("getAccountingDashboard مابيحسبش صافي ربح مستقل — بيفوّض للمحرّك", () => {
    const body = fnBody(db, "export async function getAccountingDashboard");
    expect(body).toContain("computeRealizedProfit({");
    expect(body).toContain("netProfit: realized.netProfit");
    // مفيش معادلة netProfit = … − … هنا تاني.
    expect(codeOnly(body)).not.toMatch(/const\s+netProfit\s*=\s*[^;]*[-]/);
  });

  it("ملخّص الخزنة كمان بيقرا الربح من نفس المحرّك (fallback)", () => {
    const body = fnBody(db, "export async function getTreasurySummary");
    expect(body).toContain("computeRealizedProfit(");
    expect(body).not.toMatch(/getAccountingDashboard\([^)]*\)\s*\)?\s*\.netProfit/);
  });
});
