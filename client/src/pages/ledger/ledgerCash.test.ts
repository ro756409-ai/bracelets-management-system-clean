import { describe, it, expect } from "vitest";
import { availableCash, cashAccounts, carrierReceivables, moneyAccounts, type UiAccount } from "./ledgerUi";

/** المرحلة 0 — COD بوسطة ذمة على شركة الشحن، ليس نقدية متاحة. */
const acc = (code: string, kind: string, bal: string): UiAccount => ({ id: code.length, code, name: code, kind, normalSide: "debit", isActive: 1, currentBalance: bal, isSystem: true });
const ALL = [acc("OFFICE_CASH", "cash", "1000"), acc("BANK_MAIN", "bank", "5000.5"), acc("VF_CASH", "wallet", "200"), acc("INSTAPAY", "wallet", "0"), acc("COD_BOSTA", "carrier_receivable", "9000"), acc("REVENUE", "revenue", "0")];

describe("💵 النقدية المتاحة مقابل ذمة شركة الشحن", () => {
  it("النقدية المتاحة = خزنة + بنك + محافظ فقط (COD خارجها)", () => {
    expect(cashAccounts(ALL).map(a => a.code)).toEqual(["OFFICE_CASH", "BANK_MAIN", "VF_CASH", "INSTAPAY"]);
    expect(availableCash(ALL)).toBe("6200.5000");
  });
  it("COD بوسطة يظهر كذمة على شركة الشحن", () => {
    expect(carrierReceivables(ALL).map(a => a.code)).toEqual(["COD_BOSTA"]);
  });
  it("حسابات «يدخل إلى» للإيراد ما زالت تشمل COD (إيراد تحصيل بوسطة) — العرض فقط يفصلها", () => {
    expect(moneyAccounts(ALL).map(a => a.code)).toContain("COD_BOSTA");
  });
});
