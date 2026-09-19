import { describe, it, expect } from "vitest";
import {
  matchImportItem,
  resolveProductByAlias,
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
  });
  it("🔑 نطاقات Easy Orders → الحد الأعلى", () => {
    expect(normalizeSize("من 5 إلى 6 سنين")).toBe("6");
    expect(normalizeSize("من 6 إلى 8 سنين")).toBe("8");
    expect(normalizeSize("من 8 إلى 10 سنين")).toBe("10");
    expect(normalizeSize("من 10 إلى 12 سنة")).toBe("12");
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
  it("🔑 اسم غير معروف + لون/مقاس غير موجودين → فشل مع السبب", () => {
    const r = matchImportItem({ name: "منتج مش موجود خالص", color: "أحمر", size: "99" }, catalog);
    expect(r.matched).toBe(false);
    if (!r.matched) expect(r.reason).toContain("لا يوجد منتج مطابق");
  });
});

// كتالوج Afandy Kids الحقيقي: المنتج اسمه «ملابس اطفالي» والصفوف بتيجي باسم «بدلة كورن...».
const afandyCatalog: MatchCatalog = {
  products: [{ id: 50, name: "ملابس اطفالي", sku: null, price: "300.00", businessId: 7 }],
  variants: [
    { id: 500, productId: 50, name: null, sku: "AF-BLK-8", price: "300.00", isActive: true, color: "أسود", size: "8" },
    { id: 501, productId: 50, name: null, sku: "AF-BEG-10", price: "300.00", isActive: true, color: "بيج", size: "10" },
  ],
};
// كتالوج نشاط الأسورة (منفصل) — لإثبات عدم التطابق العابر للأنشطة.
const braceletBiz: MatchCatalog = {
  products: [{ id: 1, name: "أسورة نحاس", sku: "BRAC-1", price: "100.00", businessId: 99 }],
  variants: [{ id: 10, productId: 1, name: "سادة", sku: "BR-SADA", price: "100.00", isActive: true, color: null, size: null }],
};

describe("🔑 أسماء بديلة آمنة (aliases) — داخل النشاط فقط", () => {
  it("🔑 «بدلة كورن للأطفال» → منتج «ملابس اطفالي» عبر الاسم البديل", () => {
    const r = matchImportItem({ name: "بدلة كورن للأطفال", color: "أسود", size: "من 6 إلى 8 سنين" }, afandyCatalog);
    expect(r.matched).toBe(true);
    if (r.matched) { expect(r.productId).toBe(50); expect(r.sku).toBe("AF-BLK-8"); }
  });
  it("🔑 «طقم اطفال» و«بدله كورن للاطفال» → نفس المنتج", () => {
    expect(resolveProductByAlias("طقم اطفال", afandyCatalog.products).hit?.id).toBe(50);
    expect(resolveProductByAlias("بدله كورن للاطفال", afandyCatalog.products).hit?.id).toBe(50);
  });
  it("🔑 الاسم البديل لو أدّى لأكثر من منتج → غموض بلا تخمين", () => {
    const twoMatches: MatchCatalog = {
      products: [
        { id: 50, name: "ملابس اطفالي", sku: null, price: "1", businessId: 7 },
        { id: 51, name: "طقم اطفال", sku: null, price: "1", businessId: 7 },
      ],
      variants: [],
    };
    const res = resolveProductByAlias("بدلة كورن للأطفال", twoMatches.products);
    expect(res.hit).toBeNull();
    expect(res.ambiguous).toBe(true);
  });
});

describe("🔑 fallback حتمي — تركيبة واحدة فريدة باللون+المقاس (بلا اسم مطابق)", () => {
  it("🔑 اسم مختلف تمامًا لكن لون+مقاس يحدّدان تركيبة فريدة → مطابقة", () => {
    // اسم الملف مش في الـaliases ومش اسم المنتج، لكن (أسود,8) تركيبة واحدة في النشاط.
    const r = matchImportItem({ name: "منتج باسم غريب مش معروف", color: "أسود", size: "من 6 إلى 8 سنين" }, afandyCatalog);
    expect(r.matched).toBe(true);
    if (r.matched) { expect(r.method).toBe("color_size_unique"); expect(r.sku).toBe("AF-BLK-8"); }
  });
  it("🔒 الغموض يمنع الـfallback: تركيبتان بنفس اللون+المقاس → لا مطابقة", () => {
    const dupCatalog: MatchCatalog = {
      products: [
        { id: 1, name: "منتج أ", sku: null, price: "1", businessId: 7 },
        { id: 2, name: "منتج ب", sku: null, price: "1", businessId: 7 },
      ],
      variants: [
        { id: 11, productId: 1, name: null, sku: "A-BLK-8", price: "1", isActive: true, color: "أسود", size: "8" },
        { id: 22, productId: 2, name: null, sku: "B-BLK-8", price: "1", isActive: true, color: "أسود", size: "8" },
      ],
    };
    expect(matchImportItem({ name: "مجهول", color: "أسود", size: "8" }, dupCatalog).matched).toBe(false);
  });
  it("🔑 سبب الفشل بيعرض منتجات النشاط المتاحة (تشخيص)", () => {
    const r = matchImportItem({ name: "مش موجود", color: "أحمر", size: "99" }, afandyCatalog);
    expect(r.matched).toBe(false);
    if (!r.matched) expect(r.reason).toContain("ملابس اطفالي");
  });
});

describe("🔒 عزل عبر الأنشطة — Afandy Kids لا يطابق منتجات الأسورة", () => {
  it("🔒 fallback اللون+المقاس مايوصلش منتج نشاط تاني (الأساور بلا تركيبات لون/مقاس)", () => {
    // كتالوج الأسورة مافيهوش تركيبات بلون/مقاس، فالـfallback مايتفعّلش عليه.
    expect(matchImportItem({ name: "أي اسم", color: "أسود", size: "8" }, braceletBiz).matched).toBe(false);
  });
  it("🔒 اسم/بديل ملابس على كتالوج الأسورة → لا مطابقة", () => {
    expect(matchImportItem({ name: "بدلة كورن للأطفال", color: "أسود", size: "8" }, braceletBiz).matched).toBe(false);
    expect(matchImportItem({ name: "ملابس اطفالي", color: "أسود", size: "8" }, braceletBiz).matched).toBe(false);
    expect(resolveProductByAlias("بدلة كورن للأطفال", braceletBiz.products).hit).toBeNull();
  });
  it("🔒 SKU الأسورة على كتالوج Afandy → لا مطابقة (مش fallback)", () => {
    expect(matchImportItem({ sku: "BRAC-1" }, afandyCatalog).matched).toBe(false);
    expect(matchImportItem({ sku: "BR-SADA" }, afandyCatalog).matched).toBe(false);
  });
  it("🔒 العكس: اسم الأسورة على كتالوج Afandy → لا مطابقة", () => {
    expect(matchImportItem({ name: "أسورة نحاس", variantText: "نوع الحفر: سادة" }, afandyCatalog).matched).toBe(false);
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
