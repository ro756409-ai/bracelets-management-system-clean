import { describe, it, expect } from "vitest";
import {
  variantDimensions,
  optionsFor,
  resolveVariant,
  variantLabel,
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
  it("🔑 منتج بأبعاد متعددة (نوع + لون) يعرضهم كلهم", () => {
    const multi = [
      v({ id: 31, productId: 30, name: "منقوش", color: "ذهبي" }),
      v({ id: 32, productId: 30, name: "منقوش", color: "فضي" }),
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
