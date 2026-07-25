import { describe, it, expect } from "vitest";
import {
  isBraceletItem,
  splitCompoundProduct,
  matchByName,
  resolveSegment,
  type CatalogProduct,
  type CatalogVariant,
} from "./import-legacy-orders";

describe("isBraceletItem", () => {
  it("recognizes all known أسورة spelling variants", () => {
    expect(isBraceletItem("أسورة آية الكرسي")).toBe(true);
    expect(isBraceletItem("اسورة نحاس آحمر طبي")).toBe(true);
    expect(isBraceletItem("آسوره فاللة خير حافظآ")).toBe(true);
  });

  it("rejects non-bracelet product lines", () => {
    expect(isBraceletItem("مسند سيارة 5 في 1 متعدد الوظائف")).toBe(false);
    expect(isBraceletItem("كفر مرتبة ووتر بروف")).toBe(false);
    expect(isBraceletItem("مسن سكاكين")).toBe(false);
  });
});

describe("splitCompoundProduct", () => {
  it("returns a single item with quantity 1 for a plain description", () => {
    expect(splitCompoundProduct("أسورة آية الكرسي")).toEqual([{ text: "أسورة آية الكرسي", qty: 1 }]);
  });

  it("splits a '+' compound description into multiple items", () => {
    expect(splitCompoundProduct("أسورة عين حورس + أسورة منقوش")).toEqual([
      { text: "أسورة عين حورس", qty: 1 },
      { text: "أسورة منقوش", qty: 1 },
    ]);
  });

  it("extracts a trailing ×N quantity multiplier per item", () => {
    expect(splitCompoundProduct("أسورة آية الكرسي ×2")).toEqual([{ text: "أسورة آية الكرسي", qty: 2 }]);
  });

  it("handles a mix of plain and ×N items in one compound description", () => {
    expect(splitCompoundProduct("أسورة ذكر التحصين + أسورة سادة + أسورة آية الكرسي ×3")).toEqual([
      { text: "أسورة ذكر التحصين", qty: 1 },
      { text: "أسورة سادة", qty: 1 },
      { text: "أسورة آية الكرسي", qty: 3 },
    ]);
  });

  it("drops empty segments (e.g. a trailing '+')", () => {
    expect(splitCompoundProduct("مسند سيارة 5 في 1 متعدد الوظائف +")).toEqual([
      { text: "مسند سيارة 5 في 1 متعدد الوظائف", qty: 1 },
    ]);
  });
});

describe("matchByName", () => {
  const candidates = [
    { id: 1, name: "آية الكرسي" },
    { id: 2, name: "عين حورس" },
    { id: 3, name: "سادة" },
  ];

  it("matches on exact (trimmed, case-insensitive) equality", () => {
    expect(matchByName("آية الكرسي", candidates)?.id).toBe(1);
    expect(matchByName("  آية الكرسي  ", candidates)?.id).toBe(1);
  });

  it("falls back to a single-candidate substring match", () => {
    expect(matchByName("أسورة آية الكرسي", candidates)?.id).toBe(1);
  });

  it("returns null when nothing matches", () => {
    expect(matchByName("قل أعوذ برب الفلق", candidates)).toBeNull();
  });

  it("returns null (never guesses) when multiple candidates match as substrings", () => {
    // "سادة" is a substring-ambiguous case if two candidate names both appear in the target
    const ambiguous = [
      { id: 10, name: "عين حورس" },
      { id: 11, name: "منقوش" },
    ];
    expect(matchByName("أسورة عين حورس + أسورة منقوش", ambiguous)).toBeNull();
  });

  it("returns null for blank input", () => {
    expect(matchByName("   ", candidates)).toBeNull();
  });
});

describe("resolveSegment", () => {
  const parentProduct: CatalogProduct = { id: 100, name: "أسورة نحاس", price: null };
  const parentVariants: CatalogVariant[] = [
    { id: 1, name: "آية الكرسي", price: "180.00" },
    { id: 2, name: "عين حورس", price: "160.00" },
  ];
  const standaloneProducts: CatalogProduct[] = [
    { id: 200, name: "مسند سيارة 5 في 1 متعدد الوظائف", price: "450.00" },
  ];

  it("resolves a bracelet item to the parent product + matching variant", () => {
    const r = resolveSegment("أسورة آية الكرسي", standaloneProducts, parentProduct, parentVariants);
    expect(r.ok).toBe(true);
    expect(r.productId).toBe(100);
    expect(r.variantId).toBe(1);
    expect(r.variantLabel).toBe("آية الكرسي");
    expect(r.unitPrice).toBe("180.00");
  });

  it("resolves a standalone (non-bracelet) product with no variant", () => {
    const r = resolveSegment("مسند سيارة 5 في 1 متعدد الوظائف", standaloneProducts, parentProduct, parentVariants);
    expect(r.ok).toBe(true);
    expect(r.productId).toBe(200);
    expect(r.variantId).toBeUndefined();
  });

  it("fails clearly when the parent product doesn't exist in the catalog yet", () => {
    const r = resolveSegment("أسورة آية الكرسي", standaloneProducts, undefined, []);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("أسورة نحاس");
  });

  it("fails (never guesses) when the engraving type has no matching variant", () => {
    const r = resolveSegment("أسورة كهيعص", standaloneProducts, parentProduct, parentVariants);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("كهيعص");
  });

  it("never silently creates a new variant — unmatched stays unmatched", () => {
    const r = resolveSegment("أسورة نوع غير موجود إطلاقًا", standaloneProducts, parentProduct, parentVariants);
    expect(r.ok).toBe(false);
    expect(r.productId).toBeUndefined();
    expect(r.variantId).toBeUndefined();
  });

  it("fails for a non-bracelet item with no matching standalone product", () => {
    const r = resolveSegment("كفر مرتبة ووتر بروف", standaloneProducts, parentProduct, parentVariants);
    expect(r.ok).toBe(false);
  });
});
