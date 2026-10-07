import { describe, it, expect } from "vitest";
import { composeDailyPost, transactionAmount, transactionFlow, newOperationId, moneyAccounts, expenseAccounts, revenueAccounts, type UiAccount } from "./ledgerUi";

const acc = (id: number, code: string, kind: string, normalSide: "debit" | "credit" = "debit", isActive = 1): UiAccount =>
  ({ id, code, name: code, kind, normalSide, isActive, currentBalance: "0", isSystem: true });
const cash = acc(1, "OFFICE_CASH", "cash"), bank = acc(2, "BANK_MAIN", "bank"), cod = acc(3, "COD_BOSTA", "carrier_receivable");
const revenue = acc(4, "REVENUE", "revenue", "credit"), expense = acc(5, "EXPENSE", "expense"), rent = acc(6, "RENT", "expense"), off = acc(7, "OLD", "expense", "debit", 0);

describe("🧾 واجهة الدفتر — تكوين القيد بلا مدين/دائن ظاهر", () => {
  it("إيراد: مدين الحساب النقدي / دائن الإيراد؛ من مستحقات بوسطة → revenue_cod وإلا revenue_prepaid", () => {
    expect(composeDailyPost("revenue", { businessId: 9, moneyAccount: cash, counterAccount: revenue, amount: "750" })).toEqual({
      kind: "revenue_prepaid", sourceBusinessId: 9, entries: [{ accountId: 1, side: "debit", amount: "750" }, { accountId: 4, side: "credit", amount: "750" }],
    });
    expect(composeDailyPost("revenue", { businessId: 9, moneyAccount: cod, counterAccount: revenue, amount: "750" }).kind).toBe("revenue_cod");
  });
  it("مصروف: مدين التصنيف / دائن الحساب النقدي", () => {
    expect(composeDailyPost("expense", { businessId: 9, moneyAccount: cash, counterAccount: rent, amount: "2500.5" }).entries).toEqual([
      { accountId: 6, side: "debit", amount: "2500.5" }, { accountId: 1, side: "credit", amount: "2500.5" },
    ]);
  });
  it("تحويل: مدين المستلمة / دائن المصدر، على مستوى الشركة (بلا نشاط)", () => {
    expect(composeDailyPost("transfer", { businessId: 9, moneyAccount: bank, counterAccount: cash, amount: "5000" })).toEqual({
      kind: "transfer", sourceBusinessId: null, entries: [{ accountId: 1, side: "debit", amount: "5000", businessId: null }, { accountId: 2, side: "credit", amount: "5000", businessId: null }],
    });
  });
  it("مرفوض: مبلغ غير صالح/صفر، نفس الحساب، تصنيف من نوع خاطئ، بلا نشاط للإيراد/المصروف", () => {
    expect(() => composeDailyPost("expense", { businessId: 9, moneyAccount: cash, counterAccount: rent, amount: "0" })).toThrow();
    expect(() => composeDailyPost("expense", { businessId: 9, moneyAccount: cash, counterAccount: rent, amount: "12.34567" })).toThrow();
    expect(() => composeDailyPost("transfer", { businessId: 9, moneyAccount: cash, counterAccount: cash, amount: "1" })).toThrow();
    expect(() => composeDailyPost("revenue", { businessId: 9, moneyAccount: cash, counterAccount: rent, amount: "1" })).toThrow();
    expect(() => composeDailyPost("expense", { businessId: null, moneyAccount: cash, counterAccount: rent, amount: "1" })).toThrow();
  });
  it("لا owner_drawing ولا أي نوع آخر من الواجهة اليومية — الأنواع الناتجة محصورة", () => {
    const kinds = new Set([
      composeDailyPost("revenue", { businessId: 1, moneyAccount: cash, counterAccount: revenue, amount: "1" }).kind,
      composeDailyPost("revenue", { businessId: 1, moneyAccount: cod, counterAccount: revenue, amount: "1" }).kind,
      composeDailyPost("expense", { businessId: 1, moneyAccount: cash, counterAccount: expense, amount: "1" }).kind,
      composeDailyPost("transfer", { businessId: 1, moneyAccount: cash, counterAccount: bank, amount: "1" }).kind,
    ]);
    expect([...kinds].sort()).toEqual(["expense", "revenue_cod", "revenue_prepaid", "transfer"]);
  });
  it("القوائم: النقدية/الإيراد/المصروف النشطة فقط (الموقوف لا يظهر)", () => {
    const all = [cash, bank, cod, revenue, expense, rent, off];
    expect(moneyAccounts(all).map(a => a.code)).toEqual(["OFFICE_CASH", "BANK_MAIN", "COD_BOSTA"]);
    expect(revenueAccounts(all).map(a => a.code)).toEqual(["REVENUE"]);
    expect(expenseAccounts(all).map(a => a.code)).toEqual(["EXPENSE", "RENT"]);
  });
  it("عرض الحركة: المبلغ = مجموع المدين بدقة، من = الدائن، إلى = المدين", () => {
    const entries = [{ accountId: 6, side: "debit" as const, amount: "0.1000", name: "الإيجار" }, { accountId: 6, side: "debit" as const, amount: "0.2000", name: "الإيجار" }, { accountId: 1, side: "credit" as const, amount: "0.3000", name: "خزنة المكتب" }];
    expect(transactionAmount(entries)).toBe("0.3000");
    expect(transactionFlow(entries)).toEqual({ from: ["خزنة المكتب"], to: ["الإيجار", "الإيجار"] });
  });
  it("operationId فريد لكل فتح وثابت الشكل", () => {
    const a = newOperationId(), b = newOperationId();
    expect(a).not.toBe(b); expect(a.startsWith("ui:")).toBe(true); expect(a.length).toBeGreaterThanOrEqual(12);
  });
});
