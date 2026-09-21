import { describe, it, expect } from "vitest";
import { parsePasteMessage, parseProductSegments } from "./pasteParser";
import { expandSegments, allocateQuantities } from "../shared/orderLines";
import { isExactCatalogTerm, matchImportItem, type MatchCatalog } from "./productMatching";
import { analyzePaste } from "./pasteLines";

/**
 * حالة Production حقيقية فشل فيها الـparser — النص حرفيًا كما لصقه الموظف.
 *
 * الأعطال اللي كانت فيه: مصدر الإعلان بياخد «التاريخ» معاه، العنوان بيبلع سطري الهاتف
 * (`\b` في JS مابتفهمش «رقم» العربية)، الهاتف التاني مش موجود، سطر المنتج بياخد
 * «عدد القطع: 4» معاه، والكميات ملزوقة في أسماء الأنواع («٢ ساده»، «1 نقش»).
 */
const REAL = `بيدج:عتبة  التاريخ: 20/9
الاسم :محمد جمال محمد
العنوان :القليوبيه طوخ مسجد الزعايره جانب اداره المرور
رقم الفون(١):01095286405
رقم الفون(٢):01094366135
نوع المنتج : ٢ ساده، 1 نقش وعين حورس عدد القطع: 4
السعر:  700 الشحن: 50   الاجمالي:750`;

describe("🔑 النص الحقيقي — حقول العميل", () => {
  const p = parsePasteMessage(REAL);
  it("🔑 الاسم", () => expect(p.customerName).toBe("محمد جمال محمد"));
  it("🔑 الهاتف الأساسي", () => expect(p.customerPhone).toBe("01095286405"));
  it("🔑 الهاتف التاني منفصل", () => expect(p.customerPhone2).toBe("01094366135"));
  it("🔒 العنوان مابيبلعش سطور الهاتف", () => {
    expect(p.customerAddress).toBe("القليوبيه طوخ مسجد الزعايره جانب اداره المرور");
    expect(p.customerAddress).not.toContain("0109");
    expect(p.customerAddress).not.toContain("رقم");
  });
  it("🔑 المحافظة: القليوبية", () => expect(p.governorate).toBe("القليوبية"));
  it("🔑 المدينة/المركز: طوخ", () => expect(p.city).toBe("طوخ"));
  it("🔑 مصدر الإعلان «عتبة» بس — مش «التاريخ» معاه", () => expect(p.adName).toBe("عتبة"));
});

describe("🔑 النص الحقيقي — الأرقام بالـlabel", () => {
  const p = parsePasteMessage(REAL);
  it("🔑 سعر الأصناف 700", () => expect(p.itemsSubtotal).toBe(700));
  it("🔒 الشحن 50 — مش 750", () => {
    expect(p.shipping).toBe(50);
    expect(p.shipping).not.toBe(750);
  });
  it("🔑 الإجمالي 750", () => expect(p.totalAmount).toBe(750));
  it("🔑 totalMismatch=false", () => expect(p.totalMismatch).toBe(false));
  it("🔑 عدد القطع 4 ومكتوب صراحة", () => {
    expect(p.quantity).toBe(4);
    expect(p.quantityGiven).toBe(true);
  });
});

describe("🔑 النص الحقيقي — سطر المنتج", () => {
  const p = parsePasteMessage(REAL);
  it("🔒 سطر المنتج ماياخدش «عدد القطع» معاه", () => {
    expect(p.productName).toBe("٢ ساده، 1 نقش وعين حورس");
  });
  it("🔑 الأجزاء بكمياتها (الفصل على الفاصلة بس)", () => {
    expect(p.productSegments).toEqual([
      { text: "ساده", qty: 2 },
      { text: "نقش وعين حورس", qty: 1 },
    ]);
  });
  it("🔒 مفيش جزء اسمه «٢ ساده» أو «1 نقش»", () => {
    expect(p.productSegments.some(s => /\d/.test(s.text))).toBe(false);
  });
});

describe("🔑 parseProductSegments", () => {
  it("🔑 ٢ = 2", () => expect(parseProductSegments("٢ سادة")).toEqual([{ text: "سادة", qty: 2 }]));
  it("🔑 الفاصلة العربية والعادية و+", () => {
    expect(parseProductSegments("٢ سادة، 1 منقوش")).toHaveLength(2);
    expect(parseProductSegments("2 سادة, 1 منقوش")).toHaveLength(2);
    expect(parseProductSegments("سادة + منقوش")).toHaveLength(2);
  });
  it("🔑 الكمية بعد الاسم «سادة ×2» و«سادة x2»", () => {
    expect(parseProductSegments("سادة ×2")).toEqual([{ text: "سادة", qty: 2 }]);
    expect(parseProductSegments("سادة x2")).toEqual([{ text: "سادة", qty: 2 }]);
  });
  it("🔑 بلا كمية → null", () =>
    expect(parseProductSegments("عين حورس")).toEqual([{ text: "عين حورس", qty: null }]));
  it("🔒 «و» مابتتفصلش هنا — ده دور الكتالوج", () =>
    expect(parseProductSegments("نقش وعين حورس")).toEqual([{ text: "نقش وعين حورس", qty: null }]));
});

// ── كتالوج نشاط الأساور (زي Production: منتج واحد بتركيبات + منتجات بسيطة) ──
const CATALOG: MatchCatalog = {
  products: [
    { id: 10, name: "مسند سيارة 5 في 1 متعدد الوظائف", sku: null, price: "300" },
    { id: 12, name: "مسن سكاكين", sku: null, price: "150" },
    { id: 13, name: "أسورة نحاس", sku: null, price: null },
  ],
  variants: [
    { id: 1, productId: 13, name: "سادة", sku: "PLAIN-001", price: "150", isActive: true },
    { id: 5, productId: 13, name: "منقوش", sku: "ENGR-001", price: "200", isActive: true },
    { id: 6, productId: 13, name: "عين حورس", sku: "HORUS-001", price: "160", isActive: true },
    { id: 3, productId: 13, name: "ذكر التحصين", sku: "DHIKR-001", price: "175", isActive: true },
  ],
};
const known = (t: string) => isExactCatalogTerm(t, CATALOG);

describe("🔑 مسار الإنتاج الحقيقي (analyzePaste) — نفس اللي الـendpoint بيرجّعه", () => {
  // **مفيش إعادة تركيب للمنطق هنا.** `analyzePaste` هي الدالة اللي
  // `facebookEntry.parsePaste` بيستدعيها حرفيًا (حارس المصدر بيثبت ده)، فأي خطأ في
  // توصيل الـparser بالمطابقة بالتوزيع بيظهر هنا مش بيتخبّى ورا نسخة في الاختبار.
  const r = analyzePaste(REAL, CATALOG);

  it("🔑 3 أسطر: سادة ×2، نقش ×1، عين حورس ×1", () => {
    expect(r.lines.map(l => [l.term, l.quantity])).toEqual([
      ["ساده", 2],
      ["نقش", 1],
      ["عين حورس", 1],
    ]);
  });
  it("🔑 مجموع الكميات 4", () =>
    expect(r.lines.reduce((s, l) => s + l.quantity, 0)).toBe(4));

  it("🔑 سعر الوحدة 175 وإجمالي الأسطر 350 + 175 + 175 = 700", () => {
    expect(r.lines.map(l => l.unitPrice)).toEqual([175, 175, 175]);
    expect(r.lines.map(l => l.unitPrice * l.quantity)).toEqual([350, 175, 175]);
    expect(r.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0)).toBe(700);
  });

  it("🔑 كل سطر بتركيبته تحت «أسورة نحاس» — مش منتج مستقل", () => {
    expect(r.lines.map(l => l.match?.variantId)).toEqual([1, 5, 6]);
    expect(r.lines.every(l => l.match?.productId === 13)).toBe(true);
    expect(r.lines.every(l => l.match?.productName === "أسورة نحاس")).toBe(true);
    expect(r.lines.some(l => /\d/.test(l.term))).toBe(false);
  });

  it("🔑 الحقول من نفس المسار", () => {
    expect(r.parsed.customerPhone2).toBe("01094366135");
    expect(r.parsed.shipping).toBe(50);
    expect(r.parsed.totalAmount).toBe(750);
    expect(r.parsed.governorate).toBe("القليوبية");
  });

  it("🔒 تركيبة مش متطابقة → السطر بيفضل بكميته وسعره للمراجعة", () => {
    const x = analyzePaste(
      "نوع المنتج : ٢ ساده، 1 حاجة مش موجودة عدد القطع: 3\nالسعر: 450",
      CATALOG
    );
    expect(x.lines).toHaveLength(2);
    const missing = x.lines.find(l => !l.match)!;
    expect(missing.quantity).toBe(1);
    expect(missing.unitPrice).toBe(150);
    expect(missing.matchReason).toBeTruthy();
  });
});

describe("🔒 «و» مابتتفصلش عشوائيًا", () => {
  it("🔒 اسم مركّب معروف فيه «و» بيفضل واحد", () => {
    const cat: MatchCatalog = {
      products: [{ id: 1, name: "أسورة", sku: null, price: null }],
      variants: [{ id: 9, productId: 1, name: "الشمس والقمر", sku: "SM", price: "1", isActive: true }],
    };
    const out = expandSegments([{ text: "الشمس والقمر", qty: 1 }], t => isExactCatalogTerm(t, cat));
    expect(out).toEqual([{ text: "الشمس والقمر", qty: 1 }]);
  });
  it("🔒 جزء واحد مش معروف → مابنفصلش (سطر واحد للمراجعة)", () => {
    const out = expandSegments([{ text: "نقش وحاجة مش موجودة", qty: 1 }], known);
    expect(out).toEqual([{ text: "نقش وحاجة مش موجودة", qty: 1 }]);
  });
  it("🔒 «نقش وعين حورس» ماتتحسبش «عين حورس» بالاحتواء", () => {
    expect(known("نقش وعين حورس")).toBe(false);
  });
});

describe("🔑 alias «نقش» → «منقوش» داخل النشاط بس", () => {
  it("🔑 «نقش» بيطابق «منقوش» لو هي الموجودة", () => {
    const m = matchImportItem({ name: "نقش" }, CATALOG);
    expect(m.matched && m.variantId).toBe(5);
  });
  it("🔒 مفيش «منقوش» في الكتالوج → مفيش مطابقة (مش من نشاط تاني)", () => {
    const other: MatchCatalog = { ...CATALOG, variants: CATALOG.variants.filter(v => v.id !== 5) };
    expect(matchImportItem({ name: "نقش" }, other).matched).toBe(false);
  });
});

describe("🔒 أكتر من منتج محتمل → لا تخمين", () => {
  it("🔒 «سادة» تحت منتجين → غموض صريح", () => {
    const two: MatchCatalog = {
      products: [...CATALOG.products, { id: 20, name: "خاتم", sku: null, price: null }],
      variants: [
        ...CATALOG.variants,
        { id: 99, productId: 20, name: "سادة", sku: "RING-PLAIN", price: "90", isActive: true },
      ],
    };
    const m = matchImportItem({ name: "سادة" }, two);
    expect(m.matched).toBe(false);
    if (!m.matched) expect(m.reason).toContain("اختر المنتج");
  });
});

describe("🔑 توزيع الكميات", () => {
  it("🔑 سطر واحد بلا كمية ياخد الباقي كله", () => {
    expect(allocateQuantities([{ text: "سادة", qty: null }], 3, true)).toEqual([
      { term: "سادة", quantity: 3, needsPick: true },
    ]);
  });
  it("🔑 نوعان بلا كمية وعدد القطع 2 → 1 لكل واحد", () => {
    const l = allocateQuantities([{ text: "أ ب", qty: null }, { text: "ج د", qty: null }], 2, true);
    expect(l.map(x => x.quantity)).toEqual([1, 1]);
  });
  it("🔒 كمية زيادة مالهاش نوع → سطر ناقص للمراجعة", () => {
    const l = allocateQuantities([{ text: "سادة", qty: 2 }], 3, true);
    expect(l).toEqual([
      { term: "سادة", quantity: 2, needsPick: true },
      { term: "", quantity: 1, needsPick: true },
    ]);
  });
  it("🔑 «عدد القطع» مش مكتوب → مفيش سطر ناقص وهمي", () => {
    const l = allocateQuantities([{ text: "سادة", qty: 2 }, { text: "منقوش", qty: 1 }], 1, false);
    expect(l.map(x => x.quantity)).toEqual([2, 1]);
  });
});
