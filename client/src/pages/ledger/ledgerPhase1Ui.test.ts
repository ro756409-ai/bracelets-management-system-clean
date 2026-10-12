import { describe, it, expect } from "vitest";
import { buildOpeningDraft, codReceivableTotal, availableCash, balanceText, HIDDEN_BALANCE_LABEL, emptyOpeningRow, groupAccounts, normalSideForKind, openingFileDownload, openingGroupTotals, suggestAccountCode, ACCOUNT_CODE_RE, OPENING_ACCOUNTS, type UiAccount } from "./ledgerUi";

const acc = (code: string, kind: string, bal: string, isActive = 1): UiAccount => ({ id: code.length, code, name: code, kind, normalSide: "debit", isActive, currentBalance: bal, isSystem: true });
const rows = (o: Record<string, Partial<ReturnType<typeof emptyOpeningRow>>>) => Object.fromEntries(OPENING_ACCOUNTS.map(a => [a.code, { ...emptyOpeningRow(), ...(o[a.code] ?? {}) }]));

describe("🧮 منطق واجهة المرحلة 1", () => {
  it("الحسابات: COD منفصلة عن النقدية (BigInt بلا float)، والمجموعات بالترتيب", () => {
    const list = [acc("OFFICE_CASH", "cash", "0.1"), acc("BANK_MAIN", "bank", "0.2"), acc("COD_BOSTA", "carrier_receivable", "500.0001"), acc("OLD_COD", "carrier_receivable", "9", 0), acc("OPENING_EQUITY", "equity", "1")];
    expect(availableCash(list)).toBe("0.3000");
    expect(codReceivableTotal(list)).toBe("500.0001");
    expect(groupAccounts(list).map(g => g.key)).toEqual(["cash", "cod", "other"]);
  });
  it("رصيد محجوب عن نطاق المحاسب (null): لا إجمالي مخترع من الباقي، والعرض «محجوب» لا صفر", () => {
    const hidden = { ...acc("OFFICE_CASH", "cash", "0"), currentBalance: null, balanceHidden: true };
    const list = [hidden, acc("A1_PETTY", "cash", "5"), acc("COD_BOSTA", "carrier_receivable", "9")];
    expect(availableCash(list)).toBeNull();
    expect(codReceivableTotal(list)).toBe("9.0000");
    expect(codReceivableTotal([{ ...acc("COD_BOSTA", "carrier_receivable", "0"), currentBalance: null }])).toBeNull();
    expect(balanceText(null)).toBe(HIDDEN_BALANCE_LABEL);
    expect(balanceText("5")).toContain("ج.م");
  });
  it("كود مقترح لاتيني صالح ببادئة النوع، والجانب الطبيعي مشتق من النوع", () => {
    for (let i = 0; i < 50; i++) expect(suggestAccountCode("expense")).toMatch(ACCOUNT_CODE_RE);
    expect(suggestAccountCode("wallet", () => 0)).toBe("WALLET_AAAAA");
    expect(normalSideForKind("revenue")).toBe("credit");
    expect(normalSideForKind("expense")).toBe("debit");
    expect(normalSideForKind("carrier_receivable")).toBe("debit");
  });
  it("مسودة الافتتاحي: المبلغ الفارغ لا يُرسل، غير الصفري يحتاج دليلًا، الصفر الصريح بلا دليل مقبول، ولا مفاتيح زائدة", () => {
    const ok = buildOpeningDraft("2026-11-01", rows({ OFFICE_CASH: { amount: "10.5", reference: "محضر", countedBy: "سارة", note: "  " }, BANK_MAIN: { amount: "0" } }), false);
    expect(ok.errors).toEqual([]);
    expect(ok.draft).toEqual({ goLiveDate: "2026-11-01", balances: { OFFICE_CASH: "10.5", BANK_MAIN: "0" }, evidence: { OFFICE_CASH: { reference: "محضر", countedBy: "سارة" } }, acknowledgeV2Differences: false });
    const bad = buildOpeningDraft("", rows({ VF_CASH: { amount: "5" }, INSTAPAY: { amount: "-1" }, COD_BOSTA: { reference: "كشف" } }), true);
    expect(bad.errors.join("|")).toMatch(/Go-live/);
    expect(bad.errors.join("|")).toMatch(/فودافون كاش: اذكر مرجع/);
    expect(bad.errors.join("|")).toMatch(/إنستا باي: المبلغ/);
    expect(bad.errors.join("|")).toMatch(/مستحقات بوسطة: اذكر القائم بالعد/);
  });
  it("مجموعات المسودة: COD وحدها، والنقدية بلا COD — بلا float", () => {
    expect(openingGroupTotals(rows({ OFFICE_CASH: { amount: "0.1" }, BANK_MAIN: { amount: "0.2" }, COD_BOSTA: { amount: "3300.5" }, VF_CASH: { amount: "x" } })))
      .toEqual({ cashAvailable: "0.3000", codReceivable: "3300.5000" });
  });
  it("ملف التنزيل = كائن الخادم كما هو باسم ثابت", () => {
    const file = { goLiveDate: "2026-11-01", openingBalances: { OFFICE_CASH: "1" }, _source: "جرد" };
    const d = openingFileDownload(file);
    expect(d.filename).toBe("ledger-v3-opening-2026-11-01.json");
    expect(JSON.parse(d.json)).toEqual(file);
  });
});
