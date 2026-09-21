import { describe, it, expect } from "vitest";
import { allocateLinePrices, linesSumMatches, pasteSaveBlockers, aiSegmentSchema, aiSegmentsSchema } from "./orderParse";

const piastres = (n: number) => Math.round(n * 100);
/** لكل سطر: unitPrice × quantity = lineTotal بالقرش بالظبط، والمجموع = الإجمالي. */
function assertExact(lines: ReturnType<typeof allocateLinePrices>, total: number) {
  expect(lines).not.toBeNull();
  let sum = 0;
  for (const l of lines!) {
    expect(piastres(l.unitPrice) * l.quantity).toBe(piastres(l.lineTotal));
    sum += piastres(l.unitPrice) * l.quantity;
  }
  expect(sum).toBe(piastres(total));
}

describe("🔑 توزيع إجمالي الأصناف بالقرش — سياسة معلنة", () => {
  it("🔑 700 على [2,1,1] → 175 لكل قطعة بلا تقسيم", () => {
    const r = allocateLinePrices([{ quantity: 2 }, { quantity: 1 }, { quantity: 1 }], 700)!;
    expect(r.map(l => [l.index, l.quantity, l.unitPrice])).toEqual([[0, 2, 175], [1, 1, 175], [2, 1, 175]]);
    expect(r.every(l => l.priceSource === "allocated")).toBe(true);
    assertExact(r, 700);
  });
  it("🔑 غير قابل للقسمة: 700 على [2,1] (3 قطع) → 233.33 ×2 + 233.34 ×1", () => {
    const r = allocateLinePrices([{ quantity: 2 }, { quantity: 1 }], 700)!;
    expect(r.map(l => l.unitPrice)).toEqual([233.33, 233.34]);
    assertExact(r, 700);
  });
  it("🔑 غير قابل للقسمة وآخر سطر مجمّع: 500 على [3] → يتقسم 2×166.66 + 1×166.68 (مفيش قرش يضيع)", () => {
    const r = allocateLinePrices([{ quantity: 3 }], 500)!;
    expect(r).toEqual([
      { index: 0, quantity: 2, unitPrice: 166.66, lineTotal: 333.32, priceSource: "allocated" },
      { index: 0, quantity: 1, unitPrice: 166.68, lineTotal: 166.68, priceSource: "allocated" },
    ]);
    assertExact(r, 500);
  });
  it("🔑 1000 على [2,3] → 5 قطع: 200 لكل قطعة", () => {
    assertExact(allocateLinePrices([{ quantity: 2 }, { quantity: 3 }], 1000), 1000);
  });
  it("🔑 1001 على [2,3] → الباقي 1 قرش… 100100/5 = 20020 بلا باقي؛ 1000.01 → باقي على قطعة واحدة من آخر سطر", () => {
    const r = allocateLinePrices([{ quantity: 2 }, { quantity: 3 }], 1000.01)!;
    assertExact(r, 1000.01);
    expect(r.length).toBe(3); // السطر التاني اتقسم
    expect(r.filter(l => l.index === 1).map(l => l.quantity)).toEqual([2, 1]);
  });
  it("🔑 سعر مذكور لنوع → message كما هو، والباقي يتوزّع على البقية", () => {
    const r = allocateLinePrices([{ quantity: 2, fixedUnitPrice: 150 }, { quantity: 1 }, { quantity: 1 }], 700)!;
    expect(r[0]).toMatchObject({ index: 0, unitPrice: 150, lineTotal: 300, priceSource: "message" });
    expect(r[1].unitPrice).toBe(200); expect(r[2].unitPrice).toBe(200);
    assertExact(r, 700);
  });
  it("🔒 بلا إجمالي وبلا أسعار مذكورة → null (مفيش اختراع أسعار)", () => {
    expect(allocateLinePrices([{ quantity: 2 }, { quantity: 1 }], null)).toBeNull();
  });
  it("🔑 linesSumMatches بالقرش", () => {
    expect(linesSumMatches([{ quantity: 2, unitPrice: 233.33 }, { quantity: 1, unitPrice: 233.34 }], 700)).toBe(true);
    expect(linesSumMatches([{ quantity: 3, unitPrice: 233.33 }], 700)).toBe(false);
  });
});

describe("🔒 موانع حفظ أوردر اللصق", () => {
  const ok = [{ quantity: 2, unitPrice: 175, resolved: true }, { quantity: 1, unitPrice: 175, resolved: true }, { quantity: 1, unitPrice: 175, resolved: true }];
  const exp = { pieces: 4, itemsTotal: 700, shipping: 50, discount: 0 };
  it("🔑 الحالة الصحيحة: بلا موانع", () => expect(pasteSaveBlockers(ok, exp, 750)).toEqual([]));
  it("🔒 مجموع الكميات ≠ عدد القطع", () => {
    expect(pasteSaveBlockers(ok.slice(0, 2), exp, 575)[0]).toContain("عدد القطع لا يطابق");
  });
  it("🔒 مجموع السطور ≠ إجمالي المنتجات (سعر غير موزّع/كتالوج 160)", () => {
    const bad = ok.map(l => ({ ...l, unitPrice: 160 }));
    expect(pasteSaveBlockers(bad, exp, 690).some(b => b.includes("لا يساوي إجمالي المنتجات"))).toBe(true);
  });
  it("🔒 الإجمالي النهائي ≠ منتجات + شحن − خصم", () => {
    expect(pasteSaveBlockers(ok, exp, 700).some(b => b.includes("الإجمالي النهائي"))).toBe(true);
    expect(pasteSaveBlockers(ok, { ...exp, discount: 50 }, 700)).toEqual([]);
  });
  it("🔒 نوع غير محلول يمنع", () => {
    const u = ok.map((l, i) => (i === 1 ? { ...l, resolved: false } : l));
    expect(pasteSaveBlockers(u, exp, 750)).toEqual(["اختر نوع النقش للسطر رقم 2"]);
  });
});

describe("🔒 مخرج الـAI — Zod صارم بلا معرّفات", () => {
  it("🔒 productId/variantId مرفوضين", () => {
    expect(aiSegmentSchema.safeParse({ segmentText: "x", intendedText: "y", quantity: 1, unitPrice: null, confidence: 0.9, variantId: 5 }).success).toBe(false);
    expect(aiSegmentSchema.safeParse({ segmentText: "x", intendedText: "y", quantity: 1, unitPrice: null, confidence: 0.9, productId: 5 }).success).toBe(false);
  });
  it("🔑 الشكل الصحيح يمر، وأكتر من 20 جزء مرفوض", () => {
    expect(aiSegmentSchema.safeParse({ segmentText: "x", intendedText: "y", quantity: null, unitPrice: null, confidence: 0.5 }).success).toBe(true);
    expect(aiSegmentsSchema.safeParse(Array.from({ length: 21 }, () => ({ segmentText: "x", intendedText: "y", quantity: null, unitPrice: null, confidence: 0.5 }))).success).toBe(false);
  });
});
