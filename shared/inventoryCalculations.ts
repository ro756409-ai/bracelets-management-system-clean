/** Pure inventory calculations shared between the Inventory UI and its tests. */

export type StockStatus = "available" | "low" | "out" | "archived";

export function getStockStatus(isActive: boolean, currentStock: number, minStockLevel: number): StockStatus {
  if (!isActive) return "archived";
  if (currentStock <= 0) return "out";
  if (currentStock <= minStockLevel) return "low";
  return "available";
}

export interface VariantForTotals {
  isActive: boolean;
  currentStock: number;
  minStockLevel: number;
  costPrice: string | number | null | undefined;
}

export interface VariantTotals {
  totalStock: number;
  /** Sum of costPrice * currentStock across active variants that have a costPrice set.
   *  Null if none of the active variants have a costPrice (nothing to show). */
  totalValue: number | null;
  /** Count of active variants whose status is "low" or "out". */
  attentionCount: number;
}

/** Totals shown on a parent product's collapsed card — computed from its variants. */
export function computeVariantTotals(variants: VariantForTotals[]): VariantTotals {
  const active = variants.filter(v => v.isActive);
  const totalStock = active.reduce((sum, v) => sum + v.currentStock, 0);

  const withCostPrice = active.filter(v => v.costPrice != null);
  const totalValue = withCostPrice.length > 0
    ? withCostPrice.reduce((sum, v) => sum + Number(v.costPrice) * v.currentStock, 0)
    : null;

  const attentionCount = active.filter(v => {
    const status = getStockStatus(true, v.currentStock, v.minStockLevel);
    return status === "low" || status === "out";
  }).length;

  return { totalStock, totalValue, attentionCount };
}
