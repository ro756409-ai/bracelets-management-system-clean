// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { LegacyEngravingPicker } from "./LegacyEngravingPicker";
import { VariantOrderPicker, type Catalog, type PickedItem } from "./VariantOrderPicker";

/**
 * القالب المبسّط (bracelets_legacy) فعليًا على الشاشة: أعمدة «نوع الحفر | الكمية | سعر الوحدة |
 * إجمالي السطر»، وبلا منتقي المنتج/اللون/المقاس بتاع القالب الكامل. الكتالوج هنا شكل بيانات بس.
 */
const catalog: Catalog = {
  products: [{ id: 10, name: "منتج بأنواع", sku: null, price: "190" }],
  variants: [
    { id: 101, productId: 10, name: "نوع أ", sku: null, price: "190", isActive: true, currentStock: 9 },
    { id: 102, productId: 10, name: "نوع ب", sku: null, price: "190", isActive: true, currentStock: 9 },
    { id: 103, productId: 10, name: "نوع ج", sku: null, price: "190", isActive: true, currentStock: 9 },
  ],
};
const lines: PickedItem[] = [
  { productId: 10, productName: "منتج بأنواع", variantId: 101, optionLabel: "نوع أ", quantity: 1, unitPrice: 190, availableStock: 9, priceSource: "allocated", confidence: "confident", segmentText: "نوع أ" },
  { productId: 10, productName: "منتج بأنواع", variantId: 102, optionLabel: "نوع ب", quantity: 1, unitPrice: 190, availableStock: 9, priceSource: "allocated", confidence: "ambiguous", aiAssisted: true, segmentText: "نوع بـ" },
  { productId: 0, productName: "نوع مجهول", quantity: 1, unitPrice: 190, availableStock: 0, priceSource: "allocated", confidence: "unresolved", needsPick: true, segmentText: "نوع مجهول", pickReason: "غير موجود" },
];

afterEach(() => cleanup());

describe("🔑 bracelets_legacy — الشاشة", () => {
  it("🔑 العناوين الأربعة ظاهرة، ومفيش منتقي منتج/لون/مقاس بتاع القالب الكامل", () => {
    render(<LegacyEngravingPicker catalog={catalog} value={lines} onChange={() => {}} />);
    for (const h of ["نوع الحفر", "الكمية", "سعر الوحدة", "إجمالي السطر"]) expect(screen.getAllByText(h).length).toBeGreaterThan(0);
    expect(screen.getByTestId("legacy-lines")).toBeTruthy();
    expect(screen.queryByTestId("vop-product")).toBeNull();
    expect(screen.queryByTestId("vop-color")).toBeNull();
    expect(screen.queryByTestId("vop-size")).toBeNull();
    expect(document.body.textContent).not.toMatch(/اللون|المقاس/);
  });
  it("🔑 ثلاثة سطور بأسعارها وإجمالي كل سطر: 190 × 1", () => {
    render(<LegacyEngravingPicker catalog={catalog} value={lines} onChange={() => {}} />);
    for (let i = 0; i < 3; i++) {
      expect((screen.getByTestId(`legacy-line-price-${i}`) as HTMLInputElement).value).toBe("190");
      expect(screen.getByTestId(`legacy-line-total-${i}`).textContent).toBe("190.00");
    }
  });
  it("🔑 اقتراح AI أصفر بعبارة «اقتراح AI — راجع الاختيار» والقائمة مفتوحة؛ غير المحلول أحمر بنص الرسالة وقائمة اختيار", () => {
    render(<LegacyEngravingPicker catalog={catalog} value={lines} onChange={() => {}} />);
    const ai = screen.getByTestId("legacy-line-1");
    expect(ai.className).toContain("bg-[var(--warning)]/10");
    expect(screen.getByTestId("legacy-line-ai-1").textContent).toContain("اقتراح AI — راجع الاختيار");
    expect(screen.getByTestId("legacy-line-type-1")).toBeTruthy(); // Select trigger — مش نص مقفول
    const un = screen.getByTestId("legacy-line-2");
    expect(un.className).toContain("bg-destructive/5");
    expect(screen.getByTestId("legacy-line-segment-2").textContent).toContain("نوع مجهول");
    expect(screen.getByTestId("legacy-line-pick-2")).toBeTruthy();
  });
  it("🔒 القالب الكامل (catalog_variants) لسه بمنتقي المنتج — بلا تغيير", () => {
    render(<VariantOrderPicker catalog={catalog} value={[]} onChange={() => {}} />);
    expect(screen.getByTestId("vop-product")).toBeTruthy();
    expect(screen.queryByTestId("legacy-lines")).toBeNull();
  });
});
