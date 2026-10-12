import { describe, it, expect } from "vitest";
import { composeDailyPost, inventoryAccounts, kindLabel, OPERATION_META, type UiAccount } from "./ledgerUi";

const acc = (id: number, code: string, kind: string): UiAccount => ({ id, code, name: code, kind, normalSide: "debit", isActive: 1, currentBalance: "0", isSystem: false });
const cash = acc(1, "OFFICE_CASH", "cash"), cod = acc(2, "COD_BOSTA", "carrier_receivable"), goods = acc(3, "INV_GOODS", "inventory"), ads = acc(4, "EXP_ADS", "expense");

describe("🛒 الشراء أصل مخزون لا مصروف (واجهة)", () => {
  it("قيد الشراء: مدين مخزون / دائن خزنة بنوع inventory_purchase ونشاط إلزامي", () => {
    expect(composeDailyPost("purchase", { businessId: 9, moneyAccount: cash, counterAccount: goods, amount: "300" })).toEqual({
      kind: "inventory_purchase", sourceBusinessId: 9, entries: [{ accountId: 3, side: "debit", amount: "300" }, { accountId: 1, side: "credit", amount: "300" }],
    });
    expect(OPERATION_META.purchase.kind).toBe("inventory_purchase");
    expect(kindLabel("inventory_purchase")).toBe("شراء بضاعة/خامات");
  });
  it("يرفض: مصروف كطرف شراء، الدفع من ذمة COD، وبلا نشاط", () => {
    expect(() => composeDailyPost("purchase", { businessId: 9, moneyAccount: cash, counterAccount: ads, amount: "1" })).toThrow(/مخزون/);
    expect(() => composeDailyPost("purchase", { businessId: 9, moneyAccount: cod, counterAccount: goods, amount: "1" })).toThrow(/خزنة أو بنك/);
    expect(() => composeDailyPost("purchase", { businessId: null, moneyAccount: cash, counterAccount: goods, amount: "1" })).toThrow(/النشاط/);
    expect(inventoryAccounts([cash, goods, ads]).map(a => a.code)).toEqual(["INV_GOODS"]);
  });
});
