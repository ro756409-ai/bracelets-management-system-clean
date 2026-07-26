import { describe, expect, it } from "vitest";
import {
  parseFacebookOrder,
  extractItemPhrases,
  arabicWordToNumber,
  toEnglishDigits,
  detectGovernorate,
  extractPhone,
  matchItem,
  type ParserCatalog,
} from "./facebookOrderParser";

/** Mirrors the confirmed production catalog: one parent + engraving variants + standalones. */
const catalog: ParserCatalog = {
  products: [
    { id: 1, name: "أسورة نحاس", sku: null, price: null },
    { id: 10, name: "مسند سيارة 5 في 1 متعدد الوظائف", sku: "CARMNT-001", price: "472.51" },
    { id: 11, name: "كفر مرتبة ووتر بروف", sku: "MATCVR-001", price: "297.10" },
  ],
  variants: [
    { id: 1, productId: 1, name: "سادة", sku: "PLAIN-001", price: "150.00", isActive: true },
    { id: 2, productId: 1, name: "آية الكرسي", sku: "AYAT-001", price: "180.00", isActive: true },
    { id: 3, productId: 1, name: "ذكر التحصين", sku: "DHIKR-001", price: "175.00", isActive: true },
    { id: 4, productId: 1, name: "فالله خير حافظاً", sku: "HAFIZ-001", price: "185.00", isActive: true },
    { id: 5, productId: 1, name: "منقوش", sku: "ENGR-001", price: "200.00", isActive: true },
    { id: 6, productId: 1, name: "عين حورس", sku: "HORUS-001", price: "160.00", isActive: true },
    { id: 7, productId: 1, name: "قل أعوذ برب الفلق", sku: "FALAQ-001", price: "180.00", isActive: true },
    { id: 8, productId: 1, name: "إنه من سليمان", sku: "SULAI-001", price: "185.00", isActive: true },
    { id: 9, productId: 1, name: "كهيعص", sku: "KAHYA-001", price: "185.00", isActive: true },
  ],
};

const itemFor = (r: ReturnType<typeof parseFacebookOrder>, variantName: string) =>
  r.items.find(i => i.variantName === variantName);

// ==================== helpers ====================
describe("Arabic quantity normalization", () => {
  it("maps written singular/dual/plural forms to numbers", () => {
    expect(arabicWordToNumber("واحدة")).toBe(1);
    expect(arabicWordToNumber("واحد")).toBe(1);
    expect(arabicWordToNumber("قطعة")).toBe(1);
    expect(arabicWordToNumber("قطعتين")).toBe(2);
    expect(arabicWordToNumber("اتنين")).toBe(2);
    expect(arabicWordToNumber("اثنين")).toBe(2);
    expect(arabicWordToNumber("ثلاثة")).toBe(3);
    expect(arabicWordToNumber("تلاته")).toBe(3);
    expect(arabicWordToNumber("أربعة")).toBe(4);
  });
  it("returns null for a non-quantity word", () => {
    expect(arabicWordToNumber("حورس")).toBeNull();
  });
});

describe("digit normalization", () => {
  it("converts Arabic-Indic digits to English", () => {
    expect(toEnglishDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(toEnglishDigits("٢ آية الكرسي")).toBe("2 آية الكرسي");
  });
  it("leaves English digits untouched", () => {
    expect(toEnglishDigits("01012345678")).toBe("01012345678");
  });
});

// ==================== 1. one bracelet variant ====================
describe("one bracelet variant", () => {
  it("parses a single variant with an explicit digit quantity", () => {
    const r = parseFacebookOrder("2 آية الكرسي", catalog);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].status).toBe("matched");
    expect(r.items[0].variantName).toBe("آية الكرسي");
    expect(r.items[0].productId).toBe(1);
    expect(r.items[0].quantity).toBe(2);
    expect(r.totalQuantity).toBe(2);
  });
});

// ==================== 2. two variants (Example 1) ====================
describe("two variants", () => {
  it("parses the full Example 1 message", () => {
    const r = parseFacebookOrder(
      `محمد أحمد
01012345678
القاهرة - مدينة نصر
2 آية الكرسي و1 عين حورس
الإجمالي 810 والشحن 60`,
      catalog
    );
    expect(r.customerName.value).toBe("محمد أحمد");
    expect(r.phone.value).toBe("01012345678");
    expect(r.governorate.value).toBe("القاهرة");
    expect(r.address.value).toContain("مدينة نصر");
    expect(r.items).toHaveLength(2);
    expect(itemFor(r, "آية الكرسي")?.quantity).toBe(2);
    expect(itemFor(r, "عين حورس")?.quantity).toBe(1);
    expect(r.totalQuantity).toBe(3);
    expect(r.orderTotal.value).toBe(810);
    expect(r.shipping.value).toBe(60);
    // every item resolved to the same parent product
    expect(r.items.every(i => i.productId === 1)).toBe(true);
  });
});

// ==================== 3. three and four total pieces (Example 2) ====================
describe("three and four total pieces", () => {
  it("parses Example 2 into 3 items totalling 4 pieces", () => {
    const r = parseFacebookOrder(
      `أحمد علي 01111111111
الجيزة فيصل
أريد 4 أساور:
2 ذكر التحصين
1 فالله خير حافظا
1 آية من سليمان`,
      catalog
    );
    expect(r.phone.value).toBe("01111111111");
    expect(r.governorate.value).toBe("الجيزة");
    const named = r.items.filter(i => i.status === "matched");
    expect(named.length).toBeGreaterThanOrEqual(3);
    expect(itemFor(r, "ذكر التحصين")?.quantity).toBe(2);
    expect(itemFor(r, "فالله خير حافظاً")?.quantity).toBe(1);
    expect(itemFor(r, "إنه من سليمان")?.quantity).toBe(1);
    // "آية من سليمان" is a known alias of "إنه من سليمان"
    expect(itemFor(r, "إنه من سليمان")?.status).toBe("matched");
  });

  it("sums three items to a total quantity of 4", () => {
    const r = parseFacebookOrder("2 ذكر التحصين\n1 فالله خير حافظا\n1 عين حورس", catalog);
    expect(r.items).toHaveLength(3);
    expect(r.totalQuantity).toBe(4);
  });
});

// ==================== 4. Arabic written quantities (Examples 3 & 4) ====================
describe("Arabic written quantities", () => {
  it("parses Example 3 — قطعتين", () => {
    const r = parseFacebookOrder("قطعتين آية الكرسي", catalog);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].variantName).toBe("آية الكرسي");
    expect(r.items[0].quantity).toBe(2);
  });

  it("parses Example 4 — digit + written word mixed", () => {
    const r = parseFacebookOrder("3 عين حورس وواحدة ذكر التحصين", catalog);
    expect(itemFor(r, "عين حورس")?.quantity).toBe(3);
    expect(itemFor(r, "ذكر التحصين")?.quantity).toBe(1);
    expect(r.totalQuantity).toBe(4);
  });
});

// ==================== 5. English and Arabic digits ====================
describe("English and Arabic digits", () => {
  it("parses Arabic-Indic digit quantities and phone", () => {
    const r = parseFacebookOrder("٢ آية الكرسي\n٠١٠١٢٣٤٥٦٧٨", catalog);
    expect(itemFor(r, "آية الكرسي")?.quantity).toBe(2);
    expect(r.phone.value).toBe("01012345678");
  });
  it("treats both digit systems identically", () => {
    const ar = parseFacebookOrder("٣ عين حورس", catalog);
    const en = parseFacebookOrder("3 عين حورس", catalog);
    expect(ar.items[0].quantity).toBe(en.items[0].quantity);
  });
});

// ==================== 6. incomplete phone ====================
describe("incomplete phone", () => {
  it("flags a too-short number with low confidence instead of inventing digits", () => {
    const f = extractPhone("محمد\n0101234");
    expect(f.confidence).not.toBe("high");
    expect(f.value).not.toBe("01012340000");
  });
  it("marks phone as needing attention in the parsed result", () => {
    const r = parseFacebookOrder("محمد أحمد\n0101234\n2 آية الكرسي", catalog);
    expect(r.needsAttention).toContain("phone");
  });
  it("reports a missing phone rather than fabricating one", () => {
    const r = parseFacebookOrder("محمد أحمد\nالقاهرة\n2 آية الكرسي", catalog);
    expect(r.phone.value).toBeUndefined();
    expect(r.phone.confidence).toBe("missing");
    expect(r.needsAttention).toContain("phone");
  });
});

// ==================== 7. unknown governorate ====================
describe("unknown governorate", () => {
  it("returns null for text with no recognizable governorate", () => {
    expect(detectGovernorate("مكان غير معروف تمامًا")).toBeNull();
  });
  it("flags governorate for attention without guessing one", () => {
    const r = parseFacebookOrder("محمد أحمد\n01012345678\nمنطقة مجهولة\n2 آية الكرسي", catalog);
    expect(r.governorate.value).toBeUndefined();
    expect(r.needsAttention).toContain("governorate");
  });
  it("resolves a well-known area to its governorate", () => {
    expect(detectGovernorate("مدينة نصر")?.gov).toBe("القاهرة");
    expect(detectGovernorate("فيصل")?.gov).toBe("الجيزة");
  });
});

// ==================== 8. ambiguous engraving ====================
describe("ambiguous engraving", () => {
  it("returns candidates and does NOT pick one", () => {
    const ambiguousCatalog: ParserCatalog = {
      products: [{ id: 1, name: "أسورة نحاس", sku: null, price: null }],
      variants: [
        { id: 1, productId: 1, name: "آية الكرسي كبير", sku: "A1", price: "10", isActive: true },
        { id: 2, productId: 1, name: "آية الكرسي صغير", sku: "A2", price: "20", isActive: true },
      ],
    };
    const res = matchItem("آية الكرسي", ambiguousCatalog);
    expect(res.status).toBe("ambiguous");
    expect(res.candidates).toHaveLength(2);
    expect(res.variantId).toBeUndefined();
    expect(res.productId).toBeUndefined();
  });

  it("surfaces ambiguity as needing attention", () => {
    const ambiguousCatalog: ParserCatalog = {
      products: [{ id: 1, name: "أسورة نحاس", sku: null, price: null }],
      variants: [
        { id: 1, productId: 1, name: "منقوش ذهبي", sku: "M1", price: "10", isActive: true },
        { id: 2, productId: 1, name: "منقوش فضي", sku: "M2", price: "20", isActive: true },
      ],
    };
    const r = parseFacebookOrder("2 منقوش", ambiguousCatalog);
    expect(r.items[0].status).toBe("ambiguous");
    expect(r.needsAttention).toContain("items");
  });
});

// ==================== 9. unknown engraving ====================
describe("unknown engraving", () => {
  it("marks an engraving absent from the catalog as unmatched", () => {
    const r = parseFacebookOrder("2 مفتاح الحياة", catalog);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].status).toBe("unmatched");
    expect(r.items[0].productId).toBeUndefined();
    expect(r.items[0].variantId).toBeUndefined();
    expect(r.items[0].rawText).toContain("مفتاح الحياة");
    expect(r.needsAttention).toContain("items");
  });

  it("never invents a product or variant id for unmatched text", () => {
    const r = parseFacebookOrder("5 منتج غير موجود إطلاقا", catalog);
    for (const item of r.items) {
      if (item.status === "unmatched") {
        expect(item.productId).toBeUndefined();
        expect(item.variantId).toBeUndefined();
      }
    }
  });

  it("ignores archived variants", () => {
    const archivedCatalog: ParserCatalog = {
      products: [{ id: 1, name: "أسورة نحاس", sku: null, price: null }],
      variants: [{ id: 1, productId: 1, name: "نوع مؤرشف", sku: "ARC", price: "10", isActive: false }],
    };
    expect(matchItem("نوع مؤرشف", archivedCatalog).status).toBe("unmatched");
  });
});

// ==================== 10. missing total ====================
describe("missing total", () => {
  it("leaves the total undefined rather than defaulting to zero", () => {
    const r = parseFacebookOrder("محمد أحمد\n01012345678\nالقاهرة\n2 آية الكرسي", catalog);
    expect(r.orderTotal.value).toBeUndefined();
    expect(r.orderTotal.confidence).toBe("missing");
    expect(r.needsAttention).toContain("orderTotal");
  });
  it("still parses everything else when the total is absent", () => {
    const r = parseFacebookOrder("محمد أحمد\n01012345678\nالقاهرة\n2 آية الكرسي", catalog);
    expect(r.phone.value).toBe("01012345678");
    expect(r.items[0].status).toBe("matched");
  });
});

// ==================== 11. conversational extra content ====================
describe("pasted text with extra conversational content", () => {
  it("extracts the order from a chatty message", () => {
    const r = parseFacebookOrder(
      `السلام عليكم ورحمة الله
ازيك يا فندم عايز اطلب من فضلك
الاسم: سارة محمود
الرقم: 01234567890
العنوان: الإسكندرية سيدي بشر شارع جمال عبد الناصر
عايزة 2 عين حورس و1 سادة
الإجمالي 470 والشحن 50
ملاحظات: التوصيل بعد 5 العصر
شكرا جزيلا`,
      catalog
    );
    expect(r.customerName.value).toBe("سارة محمود");
    expect(r.governorate.value).toBe("الإسكندرية");
    expect(itemFor(r, "عين حورس")?.quantity).toBe(2);
    expect(itemFor(r, "سادة")?.quantity).toBe(1);
    expect(r.orderTotal.value).toBe(470);
    expect(r.shipping.value).toBe(50);
    expect(r.notes.value).toContain("بعد 5 العصر");
  });

  it("does not mistake greetings for the customer name", () => {
    const r = parseFacebookOrder("السلام عليكم\nمحمد أحمد\n01012345678\n2 آية الكرسي", catalog);
    expect(r.customerName.value).not.toContain("السلام");
  });
});

// ==================== 12. confidence + attention ====================
describe("confidence indicator", () => {
  it("scores a complete, fully-matched order high", () => {
    const r = parseFacebookOrder(
      `محمد أحمد
01012345678
القاهرة - مدينة نصر
2 آية الكرسي و1 عين حورس
الإجمالي 810 والشحن 60`,
      catalog
    );
    expect(r.overallConfidence).toBeGreaterThanOrEqual(80);
    expect(r.needsAttention).toHaveLength(0);
  });

  it("scores a sparse order low and lists what to fix", () => {
    const r = parseFacebookOrder("عايز اسورة", catalog);
    expect(r.overallConfidence).toBeLessThan(50);
    expect(r.needsAttention.length).toBeGreaterThan(0);
  });

  it("always keeps confidence within 0–100", () => {
    for (const t of ["", "محمد", "2 آية الكرسي", "نص عشوائي تماما"]) {
      const c = parseFacebookOrder(t, catalog).overallConfidence;
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(100);
    }
  });
});

// ==================== 13. must not auto-submit ====================
describe("parser must not auto-submit", () => {
  it("is a pure function returning a draft — it performs no side effects", () => {
    const r = parseFacebookOrder("محمد أحمد\n01012345678\n2 آية الكرسي", catalog);
    // The returned draft carries no submission/persistence signal of any kind.
    expect(r).not.toHaveProperty("submitted");
    expect(r).not.toHaveProperty("orderId");
    expect(r).not.toHaveProperty("orderNumber");
    expect(r).not.toHaveProperty("saved");
  });

  it("returns the same result when called repeatedly (no state mutation)", () => {
    const text = "محمد أحمد\n01012345678\nالقاهرة\n2 آية الكرسي";
    expect(JSON.stringify(parseFacebookOrder(text, catalog)))
      .toBe(JSON.stringify(parseFacebookOrder(text, catalog)));
  });

  it("does not mutate the catalog it is given", () => {
    const snapshot = JSON.stringify(catalog);
    parseFacebookOrder("2 آية الكرسي و1 عين حورس", catalog);
    expect(JSON.stringify(catalog)).toBe(snapshot);
  });

  it("preserves the original pasted text verbatim for audit", () => {
    const text = "  محمد أحمد\n01012345678\n2 آية الكرسي  ";
    expect(parseFacebookOrder(text, catalog).rawText).toBe(text);
  });
});

// ==================== quantity phrase extraction edge cases ====================
describe("extractItemPhrases", () => {
  it("defaults to quantity 1 when a bare product name is listed", () => {
    const phrases = extractItemPhrases("1 عين حورس");
    expect(phrases[0].quantity).toBe(1);
  });
  it("handles the ×N multiplier form", () => {
    const phrases = extractItemPhrases("آية الكرسي ×3");
    expect(phrases[0].quantity).toBe(3);
  });
  it("returns no phrases for text with no products", () => {
    expect(extractItemPhrases("السلام عليكم ازيك").length).toBe(0);
  });
  it("records how each quantity was expressed", () => {
    expect(extractItemPhrases("قطعتين آية الكرسي")[0].quantityEvidence).toContain("قطعتين");
    expect(extractItemPhrases("2 آية الكرسي")[0].quantityEvidence).toContain("2");
  });
});
