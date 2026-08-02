import { describe, expect, it } from "vitest";
import { allocateEvenly, allocateProportionally, fromMinorUnits, percentageOf, toMinorUnits } from "./accountingMoney";
import { businessDayRange } from "./businessTime";
import { allocateDaily } from "./accrualAllocation";
import { applyStockIn, applyStockOut, availableQuantity } from "./inventoryCosting";
import { calculateShippingCharge, shippingAdjustment } from "./shippingCharges";
import { assertContinuousPeriod, nextClosingStatus } from "./closingWorkflow";

describe("accounting money", () => {
  it("rounds to four decimal places without floating point arithmetic", () => {
    expect(fromMinorUnits(toMinorUnits("10.12345"))).toBe("10.1235");
    expect(fromMinorUnits(percentageOf("450.00", "2.50"))).toBe("11.2500");
  });

  it("puts an indivisible remainder on the final allocation", () => {
    expect(allocateEvenly("100.00", 3).map(v => fromMinorUnits(v))).toEqual([
      "33.3333", "33.3333", "33.3334",
    ]);
  });

  it("allocates proportionally and keeps the exact remainder", () => {
    const result = allocateProportionally("100.0000", [1n, 2n, 3n]);
    expect(result.reduce((sum, value) => sum + value, 0n)).toBe(toMinorUnits("100.0000"));
    expect(result.map(value => fromMinorUnits(value))).toEqual(["16.6667", "33.3333", "50.0000"]);
  });
});

describe("IANA business timezone", () => {
  it("uses Cairo daylight-saving offset in July", () => {
    const range = businessDayRange("2026-07-31", "Africa/Cairo");
    expect(range.from.toISOString()).toBe("2026-07-30T21:00:00.000Z");
    expect(range.toExclusive.toISOString()).toBe("2026-07-31T21:00:00.000Z");
  });

  it("uses Cairo standard offset in January", () => {
    const range = businessDayRange("2026-01-15", "Africa/Cairo");
    expect(range.from.toISOString()).toBe("2026-01-14T22:00:00.000Z");
  });
});

describe("moving average inventory", () => {
  it("recalculates average on valued stock in and snapshots it on stock out", () => {
    const opened = applyStockIn({ quantity: 10, inventoryValue: "1000", movingAverageCost: "100" }, 10, "200");
    expect(opened.movingAverageCost).toBe("150.0000");
    const issued = applyStockOut(opened, 4);
    expect(issued.unitCostSnapshot).toBe("150.0000");
    expect(issued.inventoryValue).toBe("2400.0000");
    expect(availableQuantity(issued.quantity, 5)).toBe(11);
  });

  it("blocks negative stock by default", () => {
    expect(() => applyStockOut({ quantity: 1, inventoryValue: "10", movingAverageCost: "10" }, 2))
      .toThrow("Insufficient available stock");
  });
});

describe("daily accrual", () => {
  it("allocates an inclusive service period and preserves the exact total", () => {
    const rows = allocateDaily("10", "2026-07-01", "2026-07-03");
    expect(rows.map(r => r.amount)).toEqual(["3.3333", "3.3333", "3.3334"]);
  });
});

describe("shipping charge strategies", () => {
  it("supports fixed and collected-amount percentage", () => {
    expect(calculateShippingCharge({ calculationType: "fixed", value: "65" }, "500")).toBe("65.0000");
    expect(calculateShippingCharge({ calculationType: "percentage", value: "2.5", percentageBase: "collected_amount" }, "500"))
      .toBe("12.5000");
    expect(shippingAdjustment("65", "70")).toBe("5.0000");
  });
});

describe("closing workflow", () => {
  it("requires re-approval after an adjustment", () => {
    expect(nextClosingStatus({ status: "approved", action: "add_adjustment" })).toBe("pending_approval");
  });

  it("blocks stale approval and non-contiguous periods", () => {
    expect(() => nextClosingStatus({ status: "pending_approval", action: "approve", isStale: true })).toThrow("stale");
    expect(() => assertContinuousPeriod(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-02T00:00:00Z")))
      .toThrow("continuous");
  });
});
