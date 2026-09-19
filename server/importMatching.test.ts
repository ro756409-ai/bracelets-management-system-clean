import { describe, it, expect } from "vitest";
import {
  matchImportItem,
  normalizeSize,
  normalizeColor,
  normalizeDigits,
  type MatchCatalog,
} from "./productMatching";

/**
 * مطابقة استيراد الأوردرات (variant-aware، صارمة): Variant SKU ← Product SKU ← اسم+لون+مقاس،
 * مع تطبيع عربي/أرقام. ممنوع التخمين اللي يخصم من تركيبة غلط. يغطّي الأسود/البيج و6/8/10/12.
 */

// كتالوج اختبار: منتج ملابس بتركيبات (أسود/بيج × 6/8/10/12) + منتج بسيط بلا تركيبات.
const P_SUIT = 1;
const P_SIMPLE = 2;
let vid = 100;
const variants = [];
for (const color of ["أسود", "بيج"]) {
  for (const size of ["6", "8", "10", "12"]) {
    variants.push({
      id: vid, productId: P_SUIT, name: `${color}-${size}`,
      sku: `SUIT-${color === "أسود" ? "BLK" : "BEG"}-${size}`,
      price: "250.00", isActive: true, color, size,
    });
    vid++;
  }
}
const catalog: MatchCatalog = {
  products: [
    { id: P_SUIT, name: "بدلة كورن للأطفال", sku: null, price: "250.00", businessId: 1 },
    { id: P_SIMPLE, name: "مسند سيارة", sku: "HOLDER-1", price: "80.00", businessId: 1 },
  ],
  variants,
};
const skuOf = (color: string, size: string) => `SUIT-${color === "أسود" ? "BLK" : "BEG"}-${size}`;

describe("🔑 تطبيع", () => {
  it("🔑 الأرقام العربية → ASCII", () => {
    expect(normalizeDigits("٦")).toBe("6");
    expect(normalizeDigits("١٢")).toBe("12");
  });
  it("🔑 المقاس: «مقاس 6» و«6» و«من 6 سنين» كلها 6", () => {
    expect(normalizeSize("مقاس 6")).toBe("6");
    expect(normalizeSize("6")).toBe("6");
    expect(normalizeSize("من 6 سنين")).toBe("6");
    expect(normalizeSize("٨")).toBe("8");
    expect(normalizeSize("من 6 إلى 5 سنين")).toBe(normalizeSize("من 5 لـ6 سنين")); // نطاق مرتّب
  });
  it("🔑 اللون: «أسود» = «اسود»", () => {
    expect(normalizeColor("أسود")).toBe(normalizeColor("اسود"));
  });
});

describe("🔑 مطابقة الاستيراد — الأسود/البيج × 6/8/10/12", () => {
  for (const color of ["أسود", "بيج"]) {
    for (const size of ["6", "8", "10", "12"]) {
      it(`🔑 اسم+لون+مقاس: ${color} ${size}`, () => {
        const r = matchImportItem({ name: "بدلة كورن للأطفال", color, size }, catalog);
        expect(r.matched).toBe(true);
        if (r.matched) {
          expect(r.productId).toBe(P_SUIT);
          expect(r.sku).toBe(skuOf(color, size));
          expect(r.method).toBe("name_color_size");
        }
      });
      it(`🔑 Variant SKU: ${color} ${size}`, () => {
        const r = matchImportItem({ sku: skuOf(color, size) }, catalog);
        expect(r.matched).toBe(true);
        if (r.matched) { expect(r.variantId).toBeGreaterThan(0); expect(r.method).toBe("variant_sku"); }
      });
    }
  }

  it("🔑 المقاس بأرقام عربية والاسم فيه لون/مقاس مطبّع", () => {
    const r = matchImportItem({ name: "بدله كورن للاطفال", color: "اسود", size: "مقاس ٨" }, catalog);
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.sku).toBe("SUIT-BLK-8");
  });

  it("🔑 منتج بسيط (بلا تركيبات) بالاسم أو SKU → product_only", () => {
    const byName = matchImportItem({ name: "مسند سيارة" }, catalog);
    expect(byName.matched).toBe(true);
    if (byName.matched) expect(byName.method).toBe("product_only");
    const bySku = matchImportItem({ sku: "HOLDER-1" }, catalog);
    expect(bySku.matched).toBe(true);
    if (bySku.matched) {
      expect(bySku.productId).toBe(P_SIMPLE);
      expect(bySku.method).toBe("product_only");
    }
  });
});

describe("🔑 لا تخمين — فشل صريح بسبب دقيق", () => {
  it("🔑 لون غير موجود → فشل مع عرض المستلم", () => {
    const r = matchImportItem({ name: "بدلة كورن للأطفال", color: "أحمر", size: "6" }, catalog);
    expect(r.matched).toBe(false);
    if (!r.matched) {
      expect(r.received.color).toBe("أحمر");
      expect(r.received.size).toBe("6");
      expect(r.reason).toContain("مفيش تركيبة");
    }
  });
  it("🔑 مقاس غير موجود → فشل", () => {
    const r = matchImportItem({ name: "بدلة كورن للأطفال", color: "أسود", size: "20" }, catalog);
    expect(r.matched).toBe(false);
  });
  it("🔑 منتج له تركيبات بلا لون/مقاس → فشل (مايتخصمش من الأب)", () => {
    const r = matchImportItem({ name: "بدلة كورن للأطفال" }, catalog);
    expect(r.matched).toBe(false);
    if (!r.matched) expect(r.reason).toContain("تركيبات");
  });
  it("🔑 اسم غير معروف → فشل مع السبب", () => {
    const r = matchImportItem({ name: "منتج مش موجود خالص", color: "أسود", size: "6" }, catalog);
    expect(r.matched).toBe(false);
    if (!r.matched) expect(r.reason).toContain("لا يوجد منتج مطابق");
  });
});

describe("🔑 لا انحدار للأساور — مطابقة باسم التركيبة (نوع الحفر)", () => {
  const braceletCatalog: MatchCatalog = {
    products: [{ id: 9, name: "أسورة نحاس", sku: null, price: "100.00", businessId: 1 }],
    variants: [
      { id: 900, productId: 9, name: "آية الكرسي", sku: "BR-AYA", price: "120.00", isActive: true, color: null, size: null },
      { id: 901, productId: 9, name: "سادة", sku: "BR-SADA", price: "100.00", isActive: true, color: null, size: null },
    ],
  };
  it("🔑 variantText: «نوع الحفر: آية الكرسي» → التركيبة الصحيحة", () => {
    const r = matchImportItem(
      { name: "أسورة نحاس آحمر طبي", variantText: "نوع الحفر: آية الكرسي" },
      braceletCatalog
    );
    expect(r.matched).toBe(true);
    if (r.matched) { expect(r.variantId).toBe(900); expect(r.method).not.toBe("product_only"); }
  });
  it("🔑 الاسم المدمج فيه النوع → التركيبة الصحيحة", () => {
    const r = matchImportItem(
      { name: "أسورة نحاس - سادة" },
      braceletCatalog
    );
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.variantId).toBe(901);
  });
});
