import { describe, it, expect } from "vitest";
import { buildDraftLines, distributeSubtotal, summarizeCart, saveBlockers } from "./orderLines";

describe("🔑 سطر لكل نوع مذكور", () => {
  it("🔑 نوعان وعدد القطع 2 → سطران بكمية 1", () => {
    expect(buildDraftLines(["عين حورس", "ذكر التحصين"], 2)).toEqual([
      { term: "عين حورس", quantity: 1, needsPick: true },
      { term: "ذكر التحصين", quantity: 1, needsPick: true },
    ]);
  });

  it("🔑 نوع واحد وعدد القطع 2 → سطر واحد بكمية 2 (مش سطرين)", () => {
    expect(buildDraftLines(["آية الكرسي"], 2)).toEqual([
      { term: "آية الكرسي", quantity: 2, needsPick: true },
    ]);
  });

  it("🔒 عدد القطع 3 والأنواع 2 → سطر ثالث ناقص بلا تخمين", () => {
    const lines = buildDraftLines(["عين حورس", "ذكر التحصين"], 3);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toEqual({ term: "", quantity: 1, needsPick: true });
    expect(lines.reduce((s, l) => s + l.quantity, 0)).toBe(3);
  });

  it("🔒 5 قطع ونوعان → خمسة سطور، تلاتة منهم فاضيين", () => {
    const lines = buildDraftLines(["عين حورس", "سادة"], 5);
    expect(lines).toHaveLength(5);
    expect(lines.filter(l => l.term === "")).toHaveLength(3);
    expect(lines.reduce((s, l) => s + l.quantity, 0)).toBe(5);
  });

  it("🔒 مفيش أنواع → سطر واحد ناقص بكل الكمية", () => {
    expect(buildDraftLines([], 4)).toEqual([{ term: "", quantity: 4, needsPick: true }]);
  });

  it("🔑 4 أنواع مختلفة → أربعة سطور", () => {
    const lines = buildDraftLines(["أ", "ب", "ج", "د"].map(x => x + "ـنوع"), 4);
    expect(lines).toHaveLength(4);
    expect(lines.every(l => l.quantity === 1)).toBe(true);
  });

  it("🔒 كمية صفر أو سالبة → قطعة واحدة على الأقل", () => {
    expect(buildDraftLines(["سادة"], 0)[0].quantity).toBe(1);
    expect(buildDraftLines(["سادة"], -3)[0].quantity).toBe(1);
  });
});

describe("🔑 توزيع إجمالي الأصناف — المجموع يساوي الإجمالي بالظبط", () => {
  const sum = (a: number[]) => Math.round(a.reduce((s, n) => s + n, 0) * 100) / 100;

  it("🔑 قطعتان بإجمالي 400 → 200 + 200", () => {
    const r = distributeSubtotal([1, 1], 400);
    expect(r.lineTotals).toEqual([200, 200]);
    expect(r.unitPrices).toEqual([200, 200]);
  });

  it("🔑 4 قطع بإجمالي 600 → 150 لكل قطعة", () => {
    const r = distributeSubtotal([1, 1, 1, 1], 600);
    expect(r.lineTotals).toEqual([150, 150, 150, 150]);
  });

  it("🔑 3 قطع بإجمالي 550 → المجموع 550 بالظبط", () => {
    const r = distributeSubtotal([1, 1, 1], 550);
    expect(sum(r.lineTotals)).toBe(550);
  });

  it("🔑 كميات مختلفة: سطر بكمية 2 وسطر بكمية 1، إجمالي 550", () => {
    const r = distributeSubtotal([2, 1], 550);
    expect(sum(r.lineTotals)).toBe(550);
    // 550 ÷ 3 قطع = 183.33 وباقي قرش واحد. الباقي بيروح لآخر سطر عن قصد — فالفرق
    // بين أسعار الوحدة قرش واحد بالكتير، والمجموع بيفضل 550 بالظبط.
    expect(Math.abs(r.unitPrices[0] - r.unitPrices[1])).toBeLessThanOrEqual(0.01);
    expect(r.lineTotals[0]).toBe(366.66);
    expect(r.lineTotals[1]).toBe(183.34);
  });

  it("🔒 فرق الكسور بيروح لآخر سطر — 3 قطع بإجمالي 100", () => {
    const r = distributeSubtotal([1, 1, 1], 100);
    expect(sum(r.lineTotals)).toBe(100);
    expect(r.lineTotals[0]).toBe(33.33);
    expect(r.lineTotals[2]).toBe(33.34);
  });

  it("🔑 5 قطع بأنواع مختلفة وإجمالي 1111 → المجموع مطابق", () => {
    const r = distributeSubtotal([1, 1, 1, 1, 1], 1111);
    expect(sum(r.lineTotals)).toBe(1111);
  });

  it("🔑 سطر واحد → الإجمالي كله له", () => {
    expect(distributeSubtotal([3], 660).lineTotals).toEqual([660]);
    expect(distributeSubtotal([3], 660).unitPrices).toEqual([220]);
  });

  it("🔑 عرض كمية: قطعتان بـ400 بدل 220×2 — الإجمالي محفوظ", () => {
    const r = distributeSubtotal([2], 400);
    expect(r.lineTotals).toEqual([400]);
    expect(r.unitPrices).toEqual([200]); // مش 220 — سعر الكتالوج مالوش دعوة
  });

  it("🔒 إجمالي صفر → أصفار بلا NaN", () => {
    const r = distributeSubtotal([1, 1], 0);
    expect(r.lineTotals).toEqual([0, 0]);
    expect(r.unitPrices.every(n => Number.isFinite(n))).toBe(true);
  });
});

describe("🔑 ملخّص السلة بيتحدّث مع كل تعديل", () => {
  const L = (q: number, p: number) => ({ productId: 1, quantity: q, unitPrice: p });

  it("🔑 4 قطع، أصناف 600، شحن 50 → إجمالي 650", () => {
    const s = summarizeCart([L(2, 150), L(2, 150)], 50, 0);
    expect(s).toEqual({ pieces: 4, itemsSubtotal: 600, shipping: 50, discount: 0, total: 650 });
  });
  it("🔑 الخصم بينزل من الإجمالي", () => {
    expect(summarizeCart([L(1, 400)], 50, 20).total).toBe(430);
  });
  it("🔑 تغيير الكمية بيعيد الحساب", () => {
    expect(summarizeCart([L(1, 200)], 0, 0).total).toBe(200);
    expect(summarizeCart([L(3, 200)], 0, 0).total).toBe(600);
  });
  it("🔑 تغيير السعر بيعيد الحساب", () => {
    expect(summarizeCart([L(2, 100)], 0, 0).itemsSubtotal).toBe(200);
    expect(summarizeCart([L(2, 175.5)], 0, 0).itemsSubtotal).toBe(351);
  });
  it("🔑 سلة فاضية → أصفار", () => {
    expect(summarizeCart([], 0, 0)).toEqual({
      pieces: 0, itemsSubtotal: 0, shipping: 0, discount: 0, total: 0,
    });
  });
});

describe("🔒 أسباب منع الحفظ بالعربي", () => {
  const ok = { productId: 7, quantity: 1, unitPrice: 100 };
  const base = { shipping: 0, discount: 0 };

  it("🔑 سلة سليمة → مفيش موانع", () => {
    expect(saveBlockers([ok], base)).toEqual([]);
  });
  it("🔒 سلة فاضية", () => {
    expect(saveBlockers([], base)).toContain("أضف صنفًا واحدًا على الأقل");
  });
  it("🔒 سطر بلا منتج → السبب بيسمّي رقم الصنف", () => {
    const b = saveBlockers([ok, { ...ok, productId: null }], base);
    expect(b).toContain("اختر المنتج والنوع للصنف رقم 2");
  });
  it("🔒 سطر محتاج اختيار نوع (needsPick)", () => {
    expect(saveBlockers([{ ...ok, needsPick: true }], base)).toContain(
      "اختر المنتج والنوع للصنف رقم 1"
    );
  });
  it("🔒 تركيبة اتمسحت من مسودة قديمة (needsVariantReview)", () => {
    expect(saveBlockers([{ ...ok, needsVariantReview: true }], base)).toContain(
      "اختر المنتج والنوع للصنف رقم 1"
    );
  });
  it("🔒 سعر سالب أو غير رقمي", () => {
    expect(saveBlockers([{ ...ok, unitPrice: -5 }], base)).toContain(
      "راجع الأسعار — لا تقبل قيمة سالبة أو غير رقمية"
    );
    expect(saveBlockers([{ ...ok, unitPrice: NaN }], base)).toContain(
      "راجع الأسعار — لا تقبل قيمة سالبة أو غير رقمية"
    );
  });
  it("🔒 شحن/خصم غير صالح", () => {
    expect(saveBlockers([ok], { ...base, shipping: NaN })).toContain("راجع قيمة الشحن");
    expect(saveBlockers([ok], { ...base, discount: -1 })).toContain("راجع قيمة الخصم");
  });
  it("🔒 الخصم أكبر من الأصناف", () => {
    expect(saveBlockers([ok], { shipping: 0, discount: 500 })).toContain(
      "الخصم أكبر من إجمالي الأصناف"
    );
  });
  it("🔒 مجموع الكميات لا يساوي عدد القطع المستخرج", () => {
    expect(saveBlockers([ok], { ...base, expectedPieces: 3 })).toContain(
      "راجع عدد القطع — الرسالة تقول 3 والسلة فيها 1"
    );
    expect(saveBlockers([{ ...ok, quantity: 3 }], { ...base, expectedPieces: 3 })).toEqual([]);
  });
  it("🔒 الإجمالي محتاج تأكيد", () => {
    expect(saveBlockers([ok], { ...base, totalNeedsConfirm: true })).toContain(
      "الإجمالي يحتاج مراجعة — أكّده قبل الحفظ"
    );
  });
  it("🔑 **المخزون مش مانع** — كمية 5 ومتاح 1 لسه مسموح", () => {
    expect(saveBlockers([{ ...ok, quantity: 5 }], base)).toEqual([]);
  });
});

describe("🔑 أزواج لون/مقاس → سطر لكل قطعة", () => {
  const pairs = [
    { color: "بيج", size: "10" },
    { color: "اسود", size: "6" },
  ];

  it("🔑 منتج واحد + زوجان → سطران بنفس المنتج وتركيبتين", () => {
    const lines = buildDraftLines(["طقم اطفال"], 2, pairs);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ term: "طقم اطفال", color: "بيج", size: "10", quantity: 1 });
    expect(lines[1]).toMatchObject({ term: "طقم اطفال", color: "اسود", size: "6", quantity: 1 });
  });

  it("🔑 الترتيب محفوظ — بيج مع 10 وأسود مع 6", () => {
    const lines = buildDraftLines(["طقم اطفال"], 2, pairs);
    expect(lines.map(l => `${l.color}/${l.size}`)).toEqual(["بيج/10", "اسود/6"]);
  });

  it("🔑 زوج واحد → سطر واحد بكل الكمية واللون والمقاس", () => {
    const lines = buildDraftLines(["طقم اطفال"], 2, [{ color: "اسود", size: "8" }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 2, color: "اسود", size: "8" });
  });

  it("🔒 عدد القطع أكبر من الأزواج → سطر ناقص للباقي", () => {
    const lines = buildDraftLines(["طقم اطفال"], 3, pairs);
    expect(lines).toHaveLength(3);
    expect(lines[2].color).toBeUndefined();
    expect(lines.reduce((s, l) => s + l.quantity, 0)).toBe(3);
  });

  it("🔑 بلا أزواج → السلوك القديم زي ما هو", () => {
    expect(buildDraftLines(["عين حورس", "ذكر التحصين"], 2)).toEqual([
      { term: "عين حورس", quantity: 1, needsPick: true },
      { term: "ذكر التحصين", quantity: 1, needsPick: true },
    ]);
  });
});
