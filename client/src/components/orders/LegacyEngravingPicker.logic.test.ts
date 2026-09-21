import { describe, it, expect } from "vitest";
import { findLegacyProducts } from "./LegacyEngravingPicker";
import type { Catalog, CatalogVariant } from "./VariantOrderPicker";

/**
 * القالب المبسّط بيختار المنتج **من شكل بياناته** (تركيبات بالنوع فقط) — مش باسم
 * مكتوب في الكود. الكتالوج ده على شكل نشاط الأساور في الإنتاج بالظبط.
 */
const v = (p: Partial<CatalogVariant> & { id: number; productId: number }): CatalogVariant => ({
  name: null, color: null, size: null, sku: null, price: "100", isActive: true, currentStock: 5, ...p,
});

const CATALOG: Catalog = {
  products: [
    { id: 10, name: "مسند سيارة", sku: "S1", price: "300" },        // بسيط بلا تركيبات
    { id: 13, name: "منتج بأنواع", sku: null, price: null },        // نوع فقط
    { id: 14, name: "منتج ملابس", sku: null, price: null },         // لون+مقاس
  ],
  variants: [
    v({ id: 1, productId: 13, name: "سادة", sku: "PLAIN-001" }),
    v({ id: 2, productId: 13, name: "منقوش", sku: "ENGR-001" }),
    v({ id: 3, productId: 14, name: "منتج ملابس", color: "اسود", size: "6", sku: "AFK-BLK-6" }),
    v({ id: 4, productId: 14, name: "منتج ملابس", color: "بيج", size: "10", sku: "AFK-BEG-10" }),
  ],
};

describe("🔑 findLegacyProducts — من البيانات لا من الاسم", () => {
  it("🔑 المنتج اللي تركيباته بالنوع فقط هو الوحيد", () => {
    expect(findLegacyProducts(CATALOG).map(p => p.id)).toEqual([13]);
  });
  it("🔒 منتج اللون/المقاس مش قالب مبسّط", () => {
    expect(findLegacyProducts(CATALOG).some(p => p.id === 14)).toBe(false);
  });
  it("🔒 المنتج البسيط (بلا تركيبات) مش قالب مبسّط", () => {
    expect(findLegacyProducts(CATALOG).some(p => p.id === 10)).toBe(false);
  });
  it("🔒 كتالوج فاضي → مفيش منتجات (مش انهيار)", () => {
    expect(findLegacyProducts({ products: [], variants: [] })).toEqual([]);
  });
  it("🔒 التركيبات الموقوفة مابتتحسبش", () => {
    const c: Catalog = {
      products: [{ id: 20, name: "x", sku: null, price: null }],
      variants: [v({ id: 9, productId: 20, name: "نوع", isActive: false })],
    };
    expect(findLegacyProducts(c)).toEqual([]);
  });
  it("🔑 أكتر من منتج بالنوع فقط → الاتنين (الواجهة تعرض قائمة، مش تخمين)", () => {
    const c: Catalog = {
      ...CATALOG,
      products: [...CATALOG.products, { id: 15, name: "خاتم", sku: null, price: null }],
      variants: [...CATALOG.variants, v({ id: 8, productId: 15, name: "سادة", sku: "R1" })],
    };
    expect(findLegacyProducts(c).map(p => p.id).sort()).toEqual([13, 15]);
  });
});
