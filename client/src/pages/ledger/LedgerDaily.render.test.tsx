// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  perms: [] as string[], status: null as any, accounts: [] as any[], mutateAsync: null as any, postInputs: [] as any[],
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ ledger: { accounts: { list: { invalidate: async () => {} } }, transactions: { list: { invalidate: async () => {} } }, reconciliation: { invalidate: async () => {} } } }),
    ledger: {
      status: { useQuery: () => ({ data: state.status, isLoading: false, error: null }) },
      accounts: { list: { useQuery: () => ({ data: state.accounts, isLoading: false }) } },
      // أنشطة الجلسة من الدفتر نفسه (لا BusinessContext) — نشاط واحد → يُختار تلقائيًا
      businesses: { list: { useQuery: () => ({ data: [{ id: 7, name: "براند A" }], isLoading: false }) } },
      post: { useMutation: () => ({ mutateAsync: state.mutateAsync, isPending: false }) },
    },
  },
}));
vi.mock("@/hooks/usePermission", () => ({ usePermissions: () => ({ permissions: state.perms, isLoading: false, has: (p: string) => state.perms.includes(p) }), usePermission: (p: string) => state.perms.includes(p) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import LedgerDaily, { DailyOperationDialog } from "./LedgerDaily";

const acc = (id: number, code: string, name: string, kind: string, balance: string, normalSide: "debit" | "credit" = "debit") => ({ id, code, name, kind, normalSide, isActive: 1, currentBalance: balance, isSystem: true });
const ACCOUNTS = [
  acc(1, "OFFICE_CASH", "خزنة المكتب", "cash", "1000.0000"), acc(2, "BANK_MAIN", "البنك", "bank", "5000.0000"), acc(3, "VF_CASH", "فودافون كاش", "wallet", "0.0000"),
  acc(4, "INSTAPAY", "إنستا باي", "wallet", "0.0000"), acc(5, "COD_BOSTA", "مستحقات بوسطة", "carrier_receivable", "750.0000"),
  acc(6, "REVENUE", "إيرادات المبيعات", "revenue", "750.0000", "credit"), acc(7, "EXPENSE", "مصروفات عامة", "expense", "0.0000"),
];
beforeEach(() => { state.perms = ["ledger.view"]; state.status = { tablesPresent: true, enabled: true, goLiveDate: "2026-10-01" }; state.accounts = ACCOUNTS; state.postInputs = []; state.mutateAsync = vi.fn(async (input: any) => { state.postInputs.push(input); await new Promise(r => setTimeout(r, 30)); return { transactionId: 1, replay: false }; }); });
afterEach(() => cleanup());

describe("📱 الحسابات اليومية", () => {
  it("الجداول غير موجودة / الدفتر غير مفعّل → حالة واضحة بلا بطاقات ولا أزرار (لا سقوط على القديم)", () => {
    state.status = { tablesPresent: false, enabled: false };
    render(<LedgerDaily />);
    expect(screen.getByTestId("ledger-state").textContent).toContain("غير مهيأ");
    cleanup();
    state.status = { tablesPresent: true, enabled: false };
    render(<LedgerDaily />);
    expect(screen.getByTestId("ledger-state").textContent).toContain("غير مفعّل");
    expect(screen.queryByTestId("ledger-balance-cards")).toBeNull();
  });
  it("نطاق المحاسب: رصيد الخزنة المشتركة المحجوب يظهر «محجوب عن نطاقك» والنقدية المتاحة محجوبة — لا مجموع جزئي ولا صفر", () => {
    state.accounts = ACCOUNTS.map(a => (a.code === "OFFICE_CASH" ? { ...a, currentBalance: null, balanceHidden: true } : a));
    render(<LedgerDaily />);
    const cards = screen.getByTestId("ledger-balance-cards").textContent ?? "";
    expect(cards).toContain("محجوب عن نطاقك");
    expect(cards.split("٥٬٠٠٠").length - 1).toBe(1); // البنك في بطاقته فقط — لا يتحول وحده إلى «النقدية المتاحة»
    expect(cards).toContain("الإجمالي للمالك ومدير الحسابات");
    expect(screen.getByTestId("ledger-account-OFFICE_CASH").textContent).toContain("محجوب عن نطاقك");
    expect(screen.getByTestId("ledger-account-BANK_MAIN").textContent).toContain("٥٬٠٠٠");
  });
  it("بطاقات النقدية الأربع بالترتيب + النقدية المتاحة بدون COD؛ COD بوسطة ذمة منفصلة؛ وصلاحية العرض فقط لا تُظهر أزرار التسجيل", () => {
    render(<LedgerDaily />);
    const cards = screen.getByTestId("ledger-balance-cards").textContent ?? "";
    for (const name of ["خزنة المكتب", "البنك", "فودافون كاش", "إنستا باي"]) expect(cards).toContain(name);
    expect(cards.indexOf("خزنة المكتب")).toBeLessThan(cards.indexOf("إنستا باي"));
    // المرحلة 0: COD بوسطة ليس نقدية متاحة — خارج قسم النقدية وخارج المجموع (1000 + 5000 = 6000، لا 6750)
    expect(cards).not.toContain("مستحقات بوسطة");
    expect(cards).toContain("النقدية المتاحة");
    expect(cards).toContain("٦٬٠٠٠٫٠٠");
    expect(cards).not.toContain("٦٬٧٥٠");
    const receivables = screen.getByTestId("ledger-carrier-receivables").textContent ?? "";
    expect(receivables).toContain("ذمة على شركة الشحن");
    expect(receivables).toContain("مستحقات بوسطة");
    expect(cards).not.toContain("إيرادات المبيعات");
    expect(screen.queryByTestId("ledger-actions")).toBeNull();
    expect(screen.getByTestId("ledger-no-post")).toBeTruthy();
  });
  it("مع ledger.post: الأزرار الثلاثة تظهر وتفتح النموذج الصحيح — بلا أي مدين/دائن ظاهر", () => {
    state.perms = ["ledger.view", "ledger.post"];
    render(<LedgerDaily />);
    fireEvent.click(screen.getByTestId("ledger-action-expense"));
    const form = screen.getByTestId("ledger-form-expense");
    expect(form.textContent).toContain("تسجيل مصروف");
    expect(form.textContent).not.toMatch(/مدين|دائن|debit|credit/);
    expect(form.textContent).not.toContain("مسحوبات");
  });
  it("double-click على حفظ = طلب واحد بنفس operationId؛ والقيد المكوَّن صحيح", async () => {
    const onDone = vi.fn(async () => {}), onClose = vi.fn();
    render(<DailyOperationDialog op="expense" accounts={ACCOUNTS as any} onClose={onClose} onDone={onDone} initial={{ businessId: 7, moneyId: 1, counterId: 7 }} />);
    fireEvent.change(screen.getByTestId("ledger-field-amount"), { target: { value: "300" } });
    fireEvent.change(screen.getByTestId("ledger-field-description"), { target: { value: "نظافة" } });
    const save = screen.getByTestId("ledger-save");
    fireEvent.click(save); fireEvent.click(save); fireEvent.click(save);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(state.mutateAsync).toHaveBeenCalledTimes(1);
    const input = state.postInputs[0];
    expect(input).toMatchObject({ kind: "expense", sourceBusinessId: 7, currency: "EGP", description: "نظافة", sourceType: "daily_ui" });
    expect(input.entries).toEqual([{ accountId: 7, side: "debit", amount: "300" }, { accountId: 1, side: "credit", amount: "300" }]);
    expect(input.idempotencyKey).toMatch(/^ui:/);
    expect(onDone).toHaveBeenCalled();
  });
  it("إيراد من مستحقات بوسطة → revenue_cod؛ تحويل بين خزنتين على مستوى الشركة", async () => {
    const onClose = vi.fn();
    render(<DailyOperationDialog op="revenue" accounts={ACCOUNTS as any} onClose={onClose} onDone={async () => {}} initial={{ businessId: 7, moneyId: 5, counterId: 6 }} />);
    fireEvent.change(screen.getByTestId("ledger-field-amount"), { target: { value: "750" } });
    fireEvent.change(screen.getByTestId("ledger-field-description"), { target: { value: "تسليم" } });
    fireEvent.click(screen.getByTestId("ledger-save"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(state.postInputs[0]).toMatchObject({ kind: "revenue_cod", entries: [{ accountId: 5, side: "debit", amount: "750" }, { accountId: 6, side: "credit", amount: "750" }] });
    cleanup();
    const onClose2 = vi.fn();
    render(<DailyOperationDialog op="transfer" accounts={ACCOUNTS as any} onClose={onClose2} onDone={async () => {}} initial={{ moneyId: 2, counterId: 1 }} />);
    fireEvent.change(screen.getByTestId("ledger-field-amount"), { target: { value: "5000" } });
    fireEvent.change(screen.getByTestId("ledger-field-description"), { target: { value: "تغذية" } });
    fireEvent.click(screen.getByTestId("ledger-save"));
    await waitFor(() => expect(onClose2).toHaveBeenCalled());
    expect(state.postInputs[1]).toMatchObject({ kind: "transfer", sourceBusinessId: null, entries: [{ accountId: 1, side: "debit", amount: "5000", businessId: null }, { accountId: 2, side: "credit", amount: "5000", businessId: null }] });
  });
  it("مبلغ غير صالح أو بيان فارغ → لا طلب", async () => {
    render(<DailyOperationDialog op="expense" accounts={ACCOUNTS as any} onClose={() => {}} onDone={async () => {}} initial={{ businessId: 7, moneyId: 1, counterId: 7 }} />);
    fireEvent.change(screen.getByTestId("ledger-field-amount"), { target: { value: "-5" } });
    fireEvent.change(screen.getByTestId("ledger-field-description"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("ledger-save"));
    await new Promise(r => setTimeout(r, 20));
    expect(state.mutateAsync).not.toHaveBeenCalled();
  });
});
