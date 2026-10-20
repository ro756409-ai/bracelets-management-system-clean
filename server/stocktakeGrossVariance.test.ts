import { describe, it, expect } from "vitest";
import { stocktakeVarianceFromMovements } from "./ledgerInventory.service";
import { LEDGER_DAILY_ACCOUNTS, OTHER_INCOME_CODES } from "../shared/ledgerDailyAccounts";

/** BUG-89A — اشتقاق الربح/الخسارة من حركات V2 (بلا قاعدة بيانات) ومواصفة الحساب. */
describe("stocktakeVarianceFromMovements", () => {
  it("يفصل الزيادة عن العجز بقيم الحركات الفعلية", () => {
    expect(stocktakeVarianceFromMovements([
      { transactionType: "stocktake_gain", quantityDelta: 2, valueDelta: "40.0000" },
      { transactionType: "stocktake_loss", quantityDelta: -1, valueDelta: "-50.0000" },
      { transactionType: "stocktake_loss", quantityDelta: -2, valueDelta: "-12.5000" },
    ])).toEqual({ gain: 400000n, loss: 625000n });
    expect(stocktakeVarianceFromMovements([])).toEqual({ gain: 0n, loss: 0n });
  });

  it("حركة غير متسقة (نوع/إشارة) = رفض بلا قيمة مخمّنة", () => {
    expect(() => stocktakeVarianceFromMovements([{ transactionType: "stocktake_gain", quantityDelta: 1, valueDelta: "-5.0000" }])).toThrow(/غير متسقة/);
    expect(() => stocktakeVarianceFromMovements([{ transactionType: "stocktake_loss", quantityDelta: 1, valueDelta: "-5.0000" }])).toThrow(/غير متسقة/);
    expect(() => stocktakeVarianceFromMovements([{ transactionType: "purchase_receipt", quantityDelta: 1, valueDelta: "5.0000" }])).toThrow(/غير متسقة/);
  });
});

describe("مواصفة INV_GAIN", () => {
  it("إيراد دائن نظامي ضمن «إيرادات أخرى»، و«فروقات الجرد» كما هو", () => {
    const gain = LEDGER_DAILY_ACCOUNTS.find(a => a.code === "INV_GAIN")!;
    expect(gain).toMatchObject({ kind: "revenue", normalSide: "credit", systemPosted: true });
    expect(OTHER_INCOME_CODES).toContain("INV_GAIN");
    expect(LEDGER_DAILY_ACCOUNTS.find(a => a.code === "INV_VARIANCE")).toMatchObject({ name: "فروقات الجرد", kind: "expense", normalSide: "debit" });
  });
});
