import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حارس سكربت تصنيف الرواتب التاريخية — لازم يفضل **قراءة فقط**.
 *
 * السكربت ممكن يتشغّل على قاعدة الإنتاج للتشخيص، فأي كتابة فيه — حتى بالغلط — بتحوّل
 * أداة تشخيص لخطر. القرار المعتمد: مافيش backfill ولا تعديل أحداث دلوقتي.
 */
const src = fs.readFileSync("scripts/classifyPayrollHistory.ts", "utf-8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("🔑 تصنيف الرواتب التاريخية قراءة فقط", () => {
  it("🔑 مفيش كتابة في الملف كله", () => {
    for (const forbidden of [
      ".insert(",
      ".update(",
      ".delete(",
      "transaction(",
      "db:push",
      "execute(",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("🔑 الحساب في المشترك المُختبَر مش في السكربت", () => {
    expect(code).toContain('from "../shared/payrollCalc"');
    expect(code).toContain("classifyPayrollHistory");
    expect(code).toContain("salaryCostForProfit");
  });

  it("🔑 بيقرا من الجداول مباشرة", () => {
    expect(code).toContain(".select(");
    expect(code).toContain("payrollItems");
    expect(code).toContain("businessEvents");
  });

  it("بيشتغل على نشاط واحد أو الكل", () => {
    expect(code).toContain('arg("business")');
  });
});
