import { describe, expect, it } from "vitest";
import { getStockStatus, computeVariantTotals } from "./inventoryCalculations";

describe("getStockStatus", () => {
  it("returns archived for an inactive item regardless of stock", () => {
    expect(getStockStatus(false, 100, 10)).toBe("archived");
    expect(getStockStatus(false, 0, 10)).toBe("archived");
  });
  it("returns out when currentStock is zero (and active)", () => {
    expect(getStockStatus(true, 0, 10)).toBe("out");
  });
  it("returns low when currentStock is at or below minStockLevel but above zero", () => {
    expect(getStockStatus(true, 5, 10)).toBe("low");
    expect(getStockStatus(true, 10, 10)).toBe("low");
  });
  it("returns available when currentStock is above minStockLevel", () => {
    expect(getStockStatus(true, 11, 10)).toBe("available");
  });
});

describe("computeVariantTotals — parent product card totals", () => {
  it("sums current stock across active variants only", () => {
    const { totalStock } = computeVariantTotals([
      { isActive: true, currentStock: 10, minStockLevel: 5, costPrice: null },
      { isActive: true, currentStock: 20, minStockLevel: 5, costPrice: null },
      { isActive: false, currentStock: 999, minStockLevel: 5, costPrice: null }, // archived — excluded
    ]);
    expect(totalStock).toBe(30);
  });

  it("returns null total value when no active variant has a costPrice", () => {
    const { totalValue } = computeVariantTotals([
      { isActive: true, currentStock: 10, minStockLevel: 5, costPrice: null },
    ]);
    expect(totalValue).toBeNull();
  });

  it("computes total value as sum(costPrice * currentStock) for variants that have one", () => {
    const { totalValue } = computeVariantTotals([
      { isActive: true, currentStock: 10, minStockLevel: 5, costPrice: "50.00" },
      { isActive: true, currentStock: 4, minStockLevel: 5, costPrice: 25 },
      { isActive: true, currentStock: 100, minStockLevel: 5, costPrice: null }, // no costPrice — excluded from value
      { isActive: false, currentStock: 1000, minStockLevel: 5, costPrice: "9999" }, // archived — excluded
    ]);
    // 10*50 + 4*25 = 500 + 100 = 600
    expect(totalValue).toBe(600);
  });

  it("counts active variants that are low or out of stock as needing attention", () => {
    const { attentionCount } = computeVariantTotals([
      { isActive: true, currentStock: 0, minStockLevel: 5, costPrice: null },  // out
      { isActive: true, currentStock: 3, minStockLevel: 5, costPrice: null },  // low
      { isActive: true, currentStock: 50, minStockLevel: 5, costPrice: null }, // available
      { isActive: false, currentStock: 0, minStockLevel: 5, costPrice: null }, // archived — excluded
    ]);
    expect(attentionCount).toBe(2);
  });

  it("returns all-zero/null totals for an empty variant list (standalone product)", () => {
    expect(computeVariantTotals([])).toEqual({ totalStock: 0, totalValue: null, attentionCount: 0 });
  });
});
