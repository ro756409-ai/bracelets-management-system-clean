import { describe, it, expect } from "vitest";
import {
  lineNet,
  linesTotal,
  variantLabel,
  emptyLine,
  newLineKey,
  type EditorLine,
} from "./OrderItemsEditor";

const line = (over: Partial<EditorLine> = {}): EditorLine => ({
  key: "k",
  productId: 1,
  productName: "أسورة نحاس",
  variantId: null,
  quantity: 1,
  unitPrice: 100,
  discount: 0,
  ...over,
});

describe("حساب البند", () => {
  it("كمية × سعر − خصم", () => {
    expect(lineNet(line({ quantity: 3, unitPrice: 250, discount: 50 }))).toBe(700);
  });

  it("من غير خصم", () => {
    expect(lineNet(line({ quantity: 2, unitPrice: 175 }))).toBe(350);
  });

  it("🔑 الخصم الأكبر من قيمة البند بينزّل لصفر مش لسالب", () => {
    expect(lineNet(line({ quantity: 1, unitPrice: 100, discount: 500 }))).toBe(0);
  });

  it("سعر صفر بند صالح — هدية مثلاً", () => {
    expect(lineNet(line({ quantity: 2, unitPrice: 0 }))).toBe(0);
  });

  it("كسور بتتحسب صح", () => {
    expect(lineNet(line({ quantity: 3, unitPrice: 33.33 }))).toBeCloseTo(99.99, 2);
  });
});

describe("إجمالي الأوردر", () => {
  it("مجموع البنود + الشحن", () => {
    const lines = [
      line({ quantity: 2, unitPrice: 250 }),
      line({ quantity: 1, unitPrice: 300 }),
    ];
    expect(linesTotal(lines, 60)).toBe(860);
  });

  it("🔑 قطعتين بنوعي حفر مختلفين — نفس المنتج، سطرين، الإجمالي بيجمعهم", () => {
    const lines = [
      line({ productId: 7, variantId: 11, quantity: 1, unitPrice: 400 }),
      line({ productId: 7, variantId: 12, quantity: 1, unitPrice: 400 }),
    ];
    expect(linesTotal(lines, 0)).toBe(800);
  });

  it("🔑 ٣ قطع بتلات أنواع مختلفة", () => {
    const lines = [
      line({ productId: 7, variantId: 11, quantity: 1, unitPrice: 400, discount: 0 }),
      line({ productId: 7, variantId: 12, quantity: 1, unitPrice: 400, discount: 50 }),
      line({ productId: 7, variantId: 13, quantity: 1, unitPrice: 450, discount: 0 }),
    ];
    expect(linesTotal(lines, 70)).toBe(1270);
  });

  it("الخصم على سطر واحد مابيأثرش على السطور التانية", () => {
    const withDiscount = [line({ unitPrice: 100, discount: 30 }), line({ unitPrice: 100 })];
    expect(linesTotal(withDiscount, 0)).toBe(170);
  });

  it("أوردر بغير بنود = الشحن بس", () => {
    expect(linesTotal([], 45)).toBe(45);
  });
});

describe("اسم النوع", () => {
  it("الاسم لو موجود", () => {
    expect(variantLabel({ id: 1, productId: 1, name: "عين حورس" })).toBe("عين حورس");
  });

  it("لون ومقاس لو مفيش اسم", () => {
    expect(variantLabel({ id: 1, productId: 1, color: "ذهبي", size: "L" })).toBe("ذهبي · L");
  });

  it("لون لوحده", () => {
    expect(variantLabel({ id: 1, productId: 1, color: "فضي" })).toBe("فضي");
  });

  it("الرقم كملاذ أخير — مايرجّعش نص فاضي", () => {
    expect(variantLabel({ id: 42, productId: 1 })).toBe("#42");
    expect(variantLabel({ id: 42, productId: 1, name: "  " })).toBe("#42");
  });
});

describe("البند الجديد", () => {
  it("بيبدأ فاضي بكمية ١", () => {
    const l = emptyLine();
    expect(l.productId).toBeNull();
    expect(l.variantId).toBeNull();
    expect(l.quantity).toBe(1);
    expect(l.unitPrice).toBe(0);
    expect(l.discount).toBe(0);
  });

  it("🔑 كل مفتاح فريد — لو اتكرر React بيلخبط السطور مع بعض", () => {
    const keys = new Set(Array.from({ length: 50 }, () => newLineKey()));
    expect(keys.size).toBe(50);
  });
});
