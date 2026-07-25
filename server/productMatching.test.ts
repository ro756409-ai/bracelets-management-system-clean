import { describe, expect, it } from "vitest";
import {
  matchExternalItem,
  normalizeArabic,
  extractVariantLabel,
  stripBraceletPrefix,
  type MatchCatalog,
} from "./productMatching";

// Mirrors the confirmed production catalog: one parent product with engraving variants,
// plus standalone non-bracelet products.
const catalog: MatchCatalog = {
  products: [
    { id: 1, name: "أسورة نحاس", sku: null, price: null },
    { id: 10, name: "مسند سيارة 5 في 1 متعدد الوظائف", sku: "CARMNT-001", price: "472.51" },
    { id: 11, name: "كفر مرتبة ووتر بروف", sku: "MATCVR-001", price: "297.10" },
  ],
  variants: [
    { id: 101, productId: 1, name: "آية الكرسي", sku: "AYAT-001", price: "180.00", isActive: true },
    { id: 102, productId: 1, name: "عين حورس", sku: "HORUS-001", price: "160.00", isActive: true },
    { id: 103, productId: 1, name: "ذكر التحصين", sku: "DHIKR-001", price: "175.00", isActive: true },
    { id: 104, productId: 1, name: "سادة", sku: "PLAIN-001", price: "150.00", isActive: true },
    { id: 199, productId: 1, name: "نوع مؤرشف", sku: "ARCHIVED-001", price: "1.00", isActive: false },
  ],
};

describe("normalizeArabic", () => {
  it("collapses alef/hamza/ta-marbuta/alef-maqsura spelling variants", () => {
    expect(normalizeArabic("آية")).toBe(normalizeArabic("اية"));
    expect(normalizeArabic("إنه")).toBe(normalizeArabic("انه"));
    expect(normalizeArabic("أسورة")).toBe(normalizeArabic("اسوره"));
    expect(normalizeArabic("مصطفى")).toBe(normalizeArabic("مصطفي"));
  });
  it("strips diacritics and tatweel", () => {
    expect(normalizeArabic("حافظاً")).toBe(normalizeArabic("حافظا"));
    expect(normalizeArabic("سـادة")).toBe(normalizeArabic("سادة"));
  });
});

describe("extractVariantLabel / stripBraceletPrefix", () => {
  it("pulls the engraving type out of option text", () => {
    expect(extractVariantLabel("نوع الحفر: آية الكرسي")).toBe("آية الكرسي");
    expect(extractVariantLabel("الحفر - عين حورس")).toBe("عين حورس");
  });
  it("returns the text unchanged when there is no known prefix", () => {
    expect(extractVariantLabel("اللون: ذهبي")).toBe("اللون: ذهبي");
  });
  it("strips generic bracelet wording from a legacy title", () => {
    expect(stripBraceletPrefix("أسورة نحاس آحمر طبي - نوع الحفر: آية الكرسي")).toBe(
      normalizeArabic("آية الكرسي")
    );
  });
});

describe("matchExternalItem — SKU first (highest confidence)", () => {
  it("matches a variant by its SKU and returns parent + variant", () => {
    const r = matchExternalItem({ sku: "AYAT-001", name: "أي اسم مختلف تمامًا" }, catalog);
    expect(r.matched).toBe(true);
    if (!r.matched) return;
    expect(r.method).toBe("variant_sku");
    expect(r.productId).toBe(1);
    expect(r.variantId).toBe(101);
    expect(r.unitPrice).toBe("180.00");
  });

  it("SKU match is case-insensitive and trims whitespace", () => {
    const r = matchExternalItem({ sku: "  ayat-001  " }, catalog);
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.variantId).toBe(101);
  });

  it("matches a standalone product by its SKU (no variant)", () => {
    const r = matchExternalItem({ sku: "CARMNT-001" }, catalog);
    expect(r.matched).toBe(true);
    if (!r.matched) return;
    expect(r.method).toBe("product_sku");
    expect(r.productId).toBe(10);
    expect(r.variantId).toBeUndefined();
  });

  it("SKU wins over a conflicting name", () => {
    // SKU says آية الكرسي, name says عين حورس — SKU must win.
    const r = matchExternalItem({ sku: "AYAT-001", name: "عين حورس" }, catalog);
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.variantId).toBe(101);
  });

  it("ignores variants that are archived", () => {
    const r = matchExternalItem({ sku: "ARCHIVED-001" }, catalog);
    expect(r.matched).toBe(false);
  });
});

describe("matchExternalItem — name fallback", () => {
  it("matches a variant by option text", () => {
    const r = matchExternalItem({ name: "أسورة نحاس", variantText: "نوع الحفر: عين حورس" }, catalog);
    expect(r.matched).toBe(true);
    if (!r.matched) return;
    expect(r.method).toBe("variant_name");
    expect(r.variantId).toBe(102);
  });

  it("matches despite Arabic spelling differences (اية vs آية)", () => {
    const r = matchExternalItem({ name: "أسورة اية الكرسي" }, catalog);
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.variantId).toBe(101);
  });

  it("matches a legacy title with the engraving embedded in the product name", () => {
    const r = matchExternalItem({ name: "اسورة نحاس آحمر طبي - نوع الحفر: ذكر التحصين" }, catalog);
    expect(r.matched).toBe(true);
    if (r.matched) expect(r.variantId).toBe(103);
  });

  it("matches a standalone product by name", () => {
    const r = matchExternalItem({ name: "كفر مرتبة ووتر بروف" }, catalog);
    expect(r.matched).toBe(true);
    if (!r.matched) return;
    expect(r.method).toBe("product_name");
    expect(r.productId).toBe(11);
  });
});

describe("matchExternalItem — never guesses", () => {
  it("returns unmatched for an unknown engraving type", () => {
    const r = matchExternalItem({ name: "أسورة مفتاح الحياة" }, catalog);
    expect(r.matched).toBe(false);
    if (r.matched) return;
    expect(r.reason).toContain("مفتاح الحياة");
  });

  it("returns unmatched for an unknown SKU with no usable name", () => {
    const r = matchExternalItem({ sku: "DOES-NOT-EXIST" }, catalog);
    expect(r.matched).toBe(false);
  });

  it("returns unmatched (not a guess) for an empty item", () => {
    const r = matchExternalItem({}, catalog);
    expect(r.matched).toBe(false);
  });

  it("reports ambiguity rather than picking one when several variants share a SKU", () => {
    const dupeCatalog: MatchCatalog = {
      products: [{ id: 1, name: "أسورة نحاس", sku: null, price: null }],
      variants: [
        { id: 1, productId: 1, name: "نوع أول", sku: "SAME-SKU", price: "10", isActive: true },
        { id: 2, productId: 1, name: "نوع ثاني", sku: "SAME-SKU", price: "20", isActive: true },
      ],
    };
    const r = matchExternalItem({ sku: "SAME-SKU" }, dupeCatalog);
    expect(r.matched).toBe(false);
    if (r.matched) return;
    expect(r.ambiguous).toBe(true);
    expect(r.candidates).toHaveLength(2);
  });

  it("never returns a productId when unmatched", () => {
    const r = matchExternalItem({ name: "منتج غير موجود إطلاقًا" }, catalog);
    expect(r.matched).toBe(false);
    expect(r).not.toHaveProperty("productId");
  });
});
