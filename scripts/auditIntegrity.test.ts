import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حارس سكربت تدقيق السلامة — لازم يفضل **قراءة فقط**. ممكن يتشغّل على الإنتاج للتشخيص،
 * فأي كتابة فيه بتحوّله لخطر. القرار المعتمد: تشخيص بس، مفيش إصلاح تلقائي.
 */
const src = fs.readFileSync("scripts/auditIntegrity.ts", "utf-8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("🔑 تدقيق السلامة قراءة فقط", () => {
  it("🔑 مفيش كتابة في الملف كله", () => {
    for (const forbidden of [
      ".insert(",
      ".update(",
      ".delete(",
      "transaction(",
      "db:push",
      "INSERT ",
      "UPDATE ",
      "DELETE ",
      "DROP ",
      "ALTER ",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("🔑 بيغطّي العلاقات الأساسية", () => {
    for (const rel of [
      "order_items → orders",
      "order_items → products",
      "order_items → product_variants",
      "product_variants → products",
      "inventory_movements → products",
      "payroll_items → payroll_periods",
      "payroll_items → employees",
    ]) {
      expect(src).toContain(rel);
    }
  });

  it("🔑 بيصنّف MATCH/ORPHAN/WRONG_PARENT/NULL_REF", () => {
    expect(src).toContain("ORPHAN");
    expect(src).toContain("WRONG_PARENT");
    expect(src).toContain("NULL_REF");
  });

  it("بيرجّع كود خروج غير صفر لو فيه مشكلة (CI)", () => {
    expect(code).toContain("process.exit(anyIssue ? 2 : 0)");
  });
});
