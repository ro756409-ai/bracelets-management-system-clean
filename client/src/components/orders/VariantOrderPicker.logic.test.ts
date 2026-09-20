import { describe, it, expect } from "vitest";
import {
  variantDimensions,
  optionsFor,
  resolveVariant,
  variantLabel,
  DIM_LABEL,
  type CatalogVariant,
} from "./VariantOrderPicker";

/**
 * المرحلة A — منتقي عام مدفوع بأبعاد التركيبات الموجودة فعلًا:
 * الأساور (name = نوع الحفر) / Afandy (color+size) / منتج بسيط (بلا تركيبات).
 * ممنوع الاختيار الصامت لأول تركيبة؛ الحسم فقط عند تطابق واحد ووحيد.
 */

const v = (p: Partial<CatalogVariant> & { id: number; productId: number }): CatalogVariant => ({
  name: null, color: null, size: null, sku: null, price: "100", isActive: true, currentStock: 5, ...p,
});

// أسورة: 3 أنواع حفر (name فقط، بلا لون/مقاس)
const BRACELET: CatalogVariant[] = [
  v({ id: 1, productId: 10, name: "آية الكرسي", sku: "BR-AYA" }),
  v({ id: 2, productId: 10, name: "ذكر التحصين", sku: "BR-TAH" }),
  v({ id: 3, productId: 10, name: "سادة", sku: "BR-SADA" }),
];
// Afandy: لون × مقاس (بلا name)
const CLOTHES: CatalogVariant[] = [
  v({ id: 11, productId: 20, color: "أسود", size: "6", sku: "AF-BLK-6" }),
  v({ id: 12, productId: 20, color: "أسود", size: "8", sku: "AF-BLK-8" }),
  v({ id: 13, productId: 20, color: "بيج", size: "6", sku: "AF-BEG-6" }),
];

describe("🔑 اكتشاف الأبعاد من بيانات التركيبات (بلا اسم منتج/براند)", () => {
  it("🔑 الأساور: بُعد واحد = النوع (name)", () => {
    expect(variantDimensions(BRACELET)).toEqual(["name"]);
  });
  it("🔑 Afandy: لون + مقاس فقط — بلا نوع حفر", () => {
    expect(variantDimensions(CLOTHES)).toEqual(["color", "size"]);
  });
  it("🔑 منتج بسيط (بلا تركيبات) → بلا أبعاد", () => {
    expect(variantDimensions([])).toEqual([]);
  });
  it("🔑 نوع ثابت + لون مميِّز → اللون بس (قائمة نوع بخيار واحد مالهاش لازمة)", () => {
    const multi = [
      v({ id: 31, productId: 30, name: "منقوش", color: "ذهبي" }),
      v({ id: 32, productId: 30, name: "منقوش", color: "فضي" }),
    ];
    expect(variantDimensions(multi)).toEqual(["color"]);
  });

  it("🔑 نوع مميِّز + لون → الاتنين لازمين", () => {
    const multi = [
      v({ id: 33, productId: 30, name: "منقوش", color: "ذهبي" }),
      v({ id: 34, productId: 30, name: "سادة", color: "ذهبي" }),
    ];
    expect(variantDimensions(multi)).toEqual(["name", "color"]);
  });
});

describe("🔒 ممنوع الاختيار الصامت لأول تركيبة", () => {
  it("🔒 الأساور بلا اختيار → مفيش تركيبة (incomplete) مش أول نوع", () => {
    const r = resolveVariant(BRACELET, ["name"], {});
    expect(r.variant).toBeNull();
    expect(r.reason).toBe("incomplete");
  });
  it("🔒 Afandy باختيار اللون فقط → incomplete (لسه المقاس)", () => {
    const r = resolveVariant(CLOTHES, ["color", "size"], { color: "أسود" });
    expect(r.variant).toBeNull();
    expect(r.reason).toBe("incomplete");
  });
  it("🔑 اختيار كامل → تطابق واحد ووحيد", () => {
    expect(resolveVariant(BRACELET, ["name"], { name: "سادة" }).variant?.id).toBe(3);
    expect(resolveVariant(CLOTHES, ["color", "size"], { color: "أسود", size: "8" }).variant?.id).toBe(12);
  });
  it("🔒 تركيبة غير موجودة → none بلا تخمين", () => {
    const r = resolveVariant(CLOTHES, ["color", "size"], { color: "بيج", size: "8" });
    expect(r.variant).toBeNull();
    expect(r.reason).toBe("none");
  });
  it("🔒 تطابق متعدد → ambiguous بلا تخمين", () => {
    const dup = [
      v({ id: 41, productId: 40, name: "سادة" }),
      v({ id: 42, productId: 40, name: "سادة" }),
    ];
    const r = resolveVariant(dup, ["name"], { name: "سادة" });
    expect(r.variant).toBeNull();
    expect(r.reason).toBe("ambiguous");
  });
});

describe("🔑 قوائم الخيارات تتفلتر حسب المختار", () => {
  it("🔑 الأساور: كل أنواع الحفر متاحة", () => {
    expect(optionsFor(BRACELET, "name", {})).toEqual(["آية الكرسي", "ذكر التحصين", "سادة"]);
  });
  it("🔑 Afandy: مقاسات اللون المختار فقط", () => {
    expect(optionsFor(CLOTHES, "size", { color: "أسود" })).toEqual(["6", "8"]);
    expect(optionsFor(CLOTHES, "size", { color: "بيج" })).toEqual(["6"]);
  });
});

describe("🔑 وصف التركيبة للعرض/الطباعة", () => {
  it("🔑 الأساور → اسم النوع", () => expect(variantLabel(BRACELET[0])).toBe("آية الكرسي"));
  it("🔑 Afandy → لون / مقاس", () => expect(variantLabel(CLOTHES[1])).toBe("أسود / 8"));
  it("🔑 بلا تركيبة → فاضي", () => expect(variantLabel(null)).toBe(""));
});

// ── قاعدة العرض: الاسم اللي هو نفسه الـSKU مش «نوع» ──
// بيانات إنتاج حقيقية: تركيبات ملابس اتسجّل فيها الـSKU في عمود الاسم
// (name='AFK-BLK-6' و sku='AFK-BLK-6') واللون والمقاس مملوءين صح جنبها.
const CLOTHES_SKU_NAMED: CatalogVariant[] = [
  v({ id: 21, productId: 30, name: "AFK-BLK-6", sku: "AFK-BLK-6", color: "اسود", size: "6" }),
  v({ id: 22, productId: 30, name: "AFK-BLK-8", sku: "AFK-BLK-8", color: "اسود", size: "8" }),
  v({ id: 23, productId: 30, name: "AFK-BEG-6", sku: "AFK-BEG-6", color: "بيج", size: "6" }),
];

describe("🔒 SKU مايتعرضش كـ«نوع»", () => {
  it("🔒 name === sku → البُعد يتشال، واللون والمقاس بس يظهروا", () => {
    expect(variantDimensions(CLOTHES_SKU_NAMED)).toEqual(["color", "size"]);
  });
  it("🔒 مفيش أي كود AFK في قوائم الخيارات", () => {
    const all = [
      ...optionsFor(CLOTHES_SKU_NAMED, "color", {}),
      ...optionsFor(CLOTHES_SKU_NAMED, "size", { color: "اسود" }),
    ];
    expect(all.some(o => o.startsWith("AFK"))).toBe(false);
    expect(all).toContain("اسود");
  });
  it("🔒 وصف التركيبة للطباعة/بوسطة بلا SKU", () => {
    expect(variantLabel(CLOTHES_SKU_NAMED[0])).toBe("اسود / 6");
    expect(variantLabel(CLOTHES_SKU_NAMED[0], variantDimensions(CLOTHES_SKU_NAMED))).toBe(
      "اسود / 6"
    );
  });
  it("🔑 لا انحدار: اسم بشري مختلف عن الـSKU يفضل ظاهر", () => {
    // الأساور: name عربي و sku مثل AYAT-001 — مستحيل يتساووا
    expect(variantDimensions(BRACELET)).toEqual(["name"]);
    expect(variantLabel(BRACELET[0])).toBe("آية الكرسي");
  });
  it("🔑 التركيبة لسه بتتحسم صح باللون والمقاس", () => {
    const r = resolveVariant(CLOTHES_SKU_NAMED, ["color", "size"], { color: "اسود", size: "8" });
    expect(r.variant?.id).toBe(22);
  });
  it("🔑 ملاذ أخير: تركيبات مميّزة بالـSKU بس → بُعد «الرمز» مش «النوع»", () => {
    const onlySku = [
      v({ id: 41, productId: 40, name: "K-1", sku: "K-1" }),
      v({ id: 42, productId: 40, name: "K-2", sku: "K-2" }),
    ];
    expect(variantDimensions(onlySku)).toEqual(["sku"]);
    expect(DIM_LABEL.sku).toBe("الرمز");
    expect(resolveVariant(onlySku, ["sku"], { sku: "K-2" }).variant?.id).toBe(42);
  });
});

describe("🔒 «النوع» بيتشال لما اللون+المقاس كافيين", () => {
  const withName = (name: string, color: string, size: string, id: number) =>
    v({ id, productId: 50, name, color, size, sku: `S-${id}` });

  it("🔒 اسم = اسم المنتج → لون ومقاس بس", () => {
    const vs = [
      withName("بدلة اطفالي", "اسود", "6", 1),
      withName("بدلة اطفالي", "بيج", "10", 2),
    ];
    expect(variantDimensions(vs)).toEqual(["color", "size"]);
  });

  it("🔒 اسم = إعادة صياغة للّون والمقاس («اسود 10») → لون ومقاس بس", () => {
    const vs = [withName("اسود 6", "اسود", "6", 1), withName("بيج 10", "بيج", "10", 2)];
    expect(variantDimensions(vs)).toEqual(["color", "size"]);
    expect(variantLabel(vs[0], variantDimensions(vs))).toBe("اسود / 6");
  });

  it("🔒 اسم = SKU → لون ومقاس بس (نفس السلوك)", () => {
    expect(variantDimensions(CLOTHES_SKU_NAMED)).toEqual(["color", "size"]);
  });

  it("🔑 اسم حقيقي بيميّز تركيبات بنفس اللون والمقاس → «النوع» بيفضل", () => {
    // نفس اللون والمقاس بنوعين مختلفين — اللون+المقاس مش كافيين هنا
    const vs = [
      withName("قطن", "اسود", "6", 1),
      withName("كتان", "اسود", "6", 2),
    ];
    expect(variantDimensions(vs)).toEqual(["name", "color", "size"]);
  });

  it("🔑 لا انحدار: الأساور (بلا لون/مقاس) بتفضل بالنوع", () => {
    expect(variantDimensions(BRACELET)).toEqual(["name"]);
  });

  it("🔑 التركيبة بتتحسم باللون والمقاس بعد إخفاء النوع", () => {
    const vs = [
      withName("بدلة اطفالي", "اسود", "6", 1),
      withName("بدلة اطفالي", "بيج", "10", 2),
    ];
    const dims = variantDimensions(vs);
    expect(resolveVariant(vs, dims, { color: "بيج", size: "10" }).variant?.id).toBe(2);
    // اختيار اللون بس مش كفاية
    expect(resolveVariant(vs, dims, { color: "بيج" }).reason).toBe("incomplete");
    // واللون بيفلتر المقاسات المتاحة
    expect(optionsFor(vs, "size", { color: "بيج" })).toEqual(["10"]);
    expect(optionsFor(vs, "size", { color: "اسود" })).toEqual(["6"]);
  });
});
