// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ProductVariantGroups, filterVariants, variantStatus, type VariantRow } from "./ProductVariantGroups";

/** أنواع وهمية بشكل بيانات `variants.all` — أرقام مخزون شبيهة بالإنتاج بلا أسماء نشاط. */
const rows: VariantRow[] = [
  { id: 1, productId: 10, productName: "منتج بأنواع", name: "نوع أ", sku: "A-1", price: "190", currentStock: 780, minStockLevel: 10, isActive: true },
  { id: 2, productId: 10, productName: "منتج بأنواع", name: "نوع ب", sku: "A-2", price: "190", currentStock: 0, minStockLevel: 10, isActive: true },
  { id: 3, productId: 10, productName: "منتج بأنواع", name: "نوع ج", sku: "A-3", price: "190", currentStock: 5, minStockLevel: 10, isActive: true },
  { id: 4, productId: 11, productName: "منتج ثانٍ", name: "نوع د", sku: "B-1", price: "250", currentStock: 30, minStockLevel: 5, isActive: true },
  { id: 5, productId: 11, productName: "منتج ثانٍ", name: "مؤرشف", sku: "B-2", price: "250", currentStock: 30, minStockLevel: 5, isActive: false },
];
afterEach(() => cleanup());

describe("🔑 المخزون حسب المنتج", () => {
  it("🔑 الحالة والفلاتر (نقية): متوفر/منخفض/نفد، والمؤرشف مخفي", () => {
    expect(rows.map(variantStatus)).toEqual(["available", "out", "low", "available", "archived"]);
    expect(filterVariants(rows, "", "all").map(v => v.id)).toEqual([1, 2, 3, 4]);
    expect(filterVariants(rows, "", "low").map(v => v.id)).toEqual([3]);
    expect(filterVariants(rows, "", "out").map(v => v.id)).toEqual([2]);
    expect(filterVariants(rows, "b-1", "all").map(v => v.id)).toEqual([4]);
    expect(filterVariants(rows, "نوع ج", "available")).toEqual([]);
  });
  it("🔑 Accordion لكل منتج، الأعمدة السبعة على الديسكتوب، وكروت على الموبايل، والأرقام كما هي", () => {
    render(<ProductVariantGroups variants={rows} canEdit onAdjust={() => {}} />);
    expect(screen.getByTestId("vg-product-10")).toBeTruthy();
    expect(screen.getByTestId("vg-product-11")).toBeTruthy();
    for (const h of ["النوع", "SKU", "المتاح", "الحد الأدنى", "سعر البيع", "الحالة", "الإجراءات"]) expect(screen.getAllByText(h).length).toBeGreaterThan(0);
    expect(screen.getByTestId("vg-stock-1").textContent).toBe("780");
    expect(screen.getByTestId("vg-card-1")).toBeTruthy(); // نسخة الموبايل (sm:hidden)
    // المنتج الأول مفتوح افتراضيًا، الثاني مطوي حتى الضغط
    expect(screen.queryByTestId("vg-row-4")).toBeNull();
    fireEvent.click(screen.getByTestId("vg-toggle-11"));
    expect(screen.getByTestId("vg-row-4")).toBeTruthy();
  });
  it("🔒 بلا صلاحية تعديل: لا أزرار تعديل ولا عمود إجراءات؛ معها: زر يفتح التعديل للنوع الصحيح", () => {
    render(<ProductVariantGroups variants={rows} canEdit={false} />);
    expect(screen.queryByTestId("vg-edit-1")).toBeNull();
    expect(screen.queryByText("الإجراءات")).toBeNull();
    cleanup();
    const onAdjust = vi.fn();
    render(<ProductVariantGroups variants={rows} canEdit onAdjust={onAdjust} />);
    fireEvent.click(screen.getByTestId("vg-edit-3"));
    expect(onAdjust).toHaveBeenCalledWith(expect.objectContaining({ id: 3, name: "نوع ج" }));
  });
  it("🔑 الفلتر والبحث في الواجهة", () => {
    render(<ProductVariantGroups variants={rows} canEdit={false} />);
    fireEvent.click(screen.getByTestId("vg-filter-out"));
    expect(screen.getByTestId("vg-row-2")).toBeTruthy();
    expect(screen.queryByTestId("vg-row-1")).toBeNull();
    fireEvent.click(screen.getByTestId("vg-filter-all"));
    fireEvent.change(screen.getByTestId("vg-search"), { target: { value: "نوع د" } });
    expect(screen.queryByTestId("vg-product-10")).toBeNull();
    expect(screen.getByTestId("vg-product-11")).toBeTruthy();
  });
  it("📱 360/390/430px: كل عنصر لمس ≥ 44px وكروت الموبايل بلا عرض ثابت أكبر من الشاشة", () => {
    for (const w of [360, 390, 430]) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
      const { container, unmount } = render(<ProductVariantGroups variants={rows} canEdit onAdjust={() => {}} />);
      const controls = container.querySelectorAll('button, input');
      expect(controls.length).toBeGreaterThan(0);
      controls.forEach(el => expect(el.className).toContain("min-h-[44px]"));
      container.querySelectorAll<HTMLElement>('[data-testid^="vg-cards-"] *').forEach(el => {
        const m = /(?:^|\s)w-\[(\d+)px\]/.exec(el.className || "");
        if (m) expect(Number(m[1])).toBeLessThanOrEqual(w);
      });
      // جدول الديسكتوب مخفي على الموبايل (hidden sm:table) والكروت ظاهرة (sm:hidden)
      expect(container.querySelector('[data-testid="vg-table-10"]')!.className).toContain("hidden");
      expect(container.querySelector('[data-testid="vg-cards-10"]')!.className).toContain("sm:hidden");
      unmount();
    }
  });
});
