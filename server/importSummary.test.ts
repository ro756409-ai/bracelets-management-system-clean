import { describe, it, expect } from "vitest";
import fs from "fs";
import { findPotentialDuplicates } from "./duplicateDetection";

/**
 * ملخّص الاستيراد (imported/already_existing/failed_matching) ودلالات التكرار:
 *   • أوردر بـUUID موجود فعلًا → already_existing (يُتخطّى، مايتكتبش).
 *   • أوردر بـUUID **غير موجود** → مايتحسبش مكرر.
 *   • الاستيراد status="new" فمفيش خصم مخزون؛ الكل-أو-لا-شيء (atomic).
 */
const src = fs.readFileSync("server/importExcel.ts", "utf-8");

describe("🔑 ملخّص الاستيراد + دلالات التكرار (حراس مصدر)", () => {
  it("🔑 الاستجابة فيها imported/already_existing/failed_matching + reports لكل صف", () => {
    expect(src).toContain("already_existing: duplicates");
    expect(src).toContain("failed_matching: skipped");
    expect(src).toContain("reports,");
    expect(src).toContain('status: "imported"');
    expect(src).toContain('status: "already_existing"');
    expect(src).toContain('status: "failed_matching"');
  });
  it("🔑 المكرر بيُتخطّى (continue) ومايُضافش لـtoInsert (مايتكتبش/مايخصمش مخزون)", () => {
    // كل مسار duplicate بينتهي بـcontinue قبل استدعاء المطابقة/الإدخال.
    const dupStart = src.indexOf("isDuplicateByUUID");
    const dupBlock = src.slice(dupStart, src.indexOf("matchImportItem(", dupStart));
    expect((dupBlock.match(/continue;/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(dupBlock).not.toContain("toInsert.push");
  });
  it("🔑 الاستيراد status=new (مفيش خصم مخزون وقت الاستيراد)", () => {
    expect(src).toContain('status: "new"');
  });
  it("🔑 مطابقة صارمة قبل الإدخال — أوردر غير محسوم مايتكتبش", () => {
    expect(src).toContain("if (!match.matched)");
    const afterFail = src.slice(src.indexOf("if (!match.matched)"), src.indexOf("if (!match.matched)") + 1100);
    expect(afterFail).toContain("continue;");
  });
});

describe("🔑 findPotentialDuplicates — UUID غير موجود مايتحسبش مكرر", () => {
  const existing = [
    { id: 1, customerPhone: "01000000000", productName: "منتج", externalOrderId: "uuid-EXISTS" },
  ];
  it("🔑 UUID موجود فعلًا → إشارة sameExternalOrderId", () => {
    const m = findPotentialDuplicates({ customerPhone: "0", productName: "x", externalOrderId: "uuid-EXISTS" }, existing);
    expect(m.some(x => x.signals.includes("sameExternalOrderId"))).toBe(true);
  });
  it("🔑 UUID جديد (مش موجود) → مفيش إشارة تكرار UUID", () => {
    const m = findPotentialDuplicates({ customerPhone: "0", productName: "x", externalOrderId: "uuid-NEW" }, existing);
    expect(m.some(x => x.signals.includes("sameExternalOrderId"))).toBe(false);
  });
  it("🔑 UUID فارغ مايطابقش أوردر بلا externalOrderId (مفيش إيجابية كاذبة)", () => {
    const m = findPotentialDuplicates(
      { customerPhone: "0", productName: "x", externalOrderId: undefined },
      [{ id: 2, customerPhone: "0", productName: "y", externalOrderId: null }]
    );
    expect(m.some(x => x.signals.includes("sameExternalOrderId"))).toBe(false);
  });
});
