import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حارس سكربت التدقيق.
 *
 * السكربت ده الوحيد اللي المفروض يتشغّل على قاعدة بيانات الإنتاج. لو كتب أي حاجة —
 * حتى بالغلط — التدقيق نفسه بيبقى خطر أكبر من اللي بيدوّر عليه.
 */

const src = fs.readFileSync("scripts/reconcile.ts", "utf-8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("🔑 التدقيق قراءة فقط", () => {
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

  it("🔑 وبيقرا من الجداول مباشرة مش من خدمة بتكتب", () => {
    expect(code).toContain(".select(");
    expect(code).toContain("getSupplierSummaries");
  });

  it("🔑 والحساب في المشترك المُختبَر مش هنا", () => {
    // لو المعادلة كانت جوه السكربت، مكانش فيه طريقة نتأكد إنها بتمسك الغلط.
    expect(code).toContain('from "../shared/reconciliation"');
    expect(code).toContain("reconcileTreasury");
    expect(code).toContain("reconcileSupplier");
    expect(code).toContain("reconcileOnce");
  });

  it("🔑 وبيرجّع كود خروج غير صفر لما يفشل — عشان ينفع في CI", () => {
    expect(code).toContain("process.exit(allOk ? 0 : 1)");
  });

  it("بيشتغل على نشاط واحد أو الكل", () => {
    expect(code).toContain('process.argv.indexOf("--business")');
  });

  it("الافتتاحي محسوب من أول صف مش مفترض صفر", () => {
    // خزنة بدأت برصيد مش صفر كانت هتطلع «مش متوازنة» غلط.
    expect(code).toContain("const openingBalance =");
    expect(code).toContain('first.direction === "in"');
  });
});
