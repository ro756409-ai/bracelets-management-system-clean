// @vitest-environment jsdom
/**
 * المرحلة 1 المحاسبية — واجهات: الحسابات وأرصدتها (إدارة خلف ledger.manage_accounts)، مراجعة الشهر وإقفاله (ملاحظة
 * إلزامية، بلا علامة «معتمدة»)، وتجهيز الأرصدة الافتتاحية (مسودة الصفحة فقط، تحقق قراءة، تنزيل ملف الخادم حرفيًا).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  perms: [] as string[], user: { id: 1, tenantId: 10, role: "admin" } as any,
  accounts: [] as any[], review: null as any, periods: [] as any[],
  calls: { create: [] as any[], rename: [] as any[], setActive: [] as any[], grant: [] as any[], revoke: [] as any[], lock: [] as any[], reopen: [] as any[], validate: [] as any[] },
  validateResult: null as any, ledgerEnabled: true,
}));
const { slowMutation } = vi.hoisted(() => ({
  slowMutation: (key: string, result: () => any) => ({ useMutation: () => ({ mutateAsync: async (input: any) => { (state.calls as any)[key].push(input); await new Promise(r => setTimeout(r, 20)); return result(); }, isPending: false }) }),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ ledger: { accounts: { list: { invalidate: async () => {} } } } }),
    ledger: {
      status: { useQuery: () => ({ data: { tablesPresent: true, enabled: state.ledgerEnabled }, isLoading: false }) },
      accounts: { list: { useQuery: () => ({ data: state.accounts, isLoading: false, error: null, refetch: async () => {} }) } },
      businesses: { list: { useQuery: () => ({ data: [{ id: 7, name: "براند A" }, { id: 8, name: "براند B" }], isLoading: false }) } },
      periods: { list: { useQuery: () => ({ data: state.periods, isLoading: false, error: null, refetch: async () => {} }) } },
      period: {
        review: { useQuery: () => ({ data: state.review, isLoading: false, error: null, refetch: async () => {} }) },
        lock: slowMutation("lock", () => ({ periodId: 1, status: "locked", replay: false })),
        reopen: slowMutation("reopen", () => ({ periodId: 1, status: "open", replay: false })),
      },
      account: {
        create: slowMutation("create", () => ({ id: 50, replay: false })),
        updateName: slowMutation("rename", () => ({ ok: true })),
        setActive: slowMutation("setActive", () => ({ ok: true })),
        grantBusiness: slowMutation("grant", () => ({ ok: true })),
        revokeBusiness: slowMutation("revoke", () => ({ ok: true })),
      },
      opening: { validate: slowMutation("validate", () => state.validateResult) },
    },
  },
}));
vi.mock("@/hooks/usePermission", () => ({ usePermissions: () => ({ permissions: state.perms, isLoading: false, has: (p: string) => state.perms.includes(p) }) }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: state.user, loading: false }) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import LedgerAccounts from "./LedgerAccounts";
import LedgerPeriods from "./LedgerPeriods";
import LedgerOpening from "./LedgerOpening";

const acct = (id: number, code: string, name: string, kind: string, balance: string, over: Record<string, unknown> = {}) =>
  ({ id, code, name, kind, normalSide: kind === "revenue" ? "credit" : "debit", isActive: 1, currentBalance: balance, isSystem: true, businesses: [{ businessId: 7, canPost: true }], ...over });

beforeEach(() => {
  state.perms = ["ledger.view"];
  state.user = { id: 1, tenantId: 10, role: "admin" };
  state.accounts = [
    acct(1, "OFFICE_CASH", "خزنة المكتب", "cash", "1000.5000"), acct(2, "BANK_MAIN", "البنك", "bank", "2000.2500"),
    acct(3, "COD_BOSTA", "مستحقات بوسطة", "carrier_receivable", "700.0000"), acct(4, "REVENUE", "إيرادات المبيعات", "revenue", "5000"),
    acct(5, "RENT", "إيجار", "expense", "300", { isSystem: false, businesses: [{ businessId: 7, canPost: true }, { businessId: 8, canPost: false }] }),
  ];
  state.periods = [{ id: 1, period: "2026-09", status: "locked", events: [] }];
  state.review = {
    period: "2026-10", status: "open", transactionsCount: 3,
    events: [{ action: "lock", reason: "راجعت الشهر", actorName: "مدير الحسابات كريم", createdAt: "2026-10-01T10:00:00Z" }, { action: "reopen", reason: "تصحيح تاريخ", actorName: "المالكة سارة", createdAt: "2026-10-02T10:00:00Z" }],
    accounts: [{ accountId: 5, code: "RENT", name: "إيجار", kind: "expense", debit: "300.0000", credit: "0.0000", transactions: 1 }],
    businesses: [{ businessId: 7, name: "براند A", debit: "300.0000", credit: "300.0000" }, { businessId: null, name: null, debit: "10.0000", credit: "10.0000" }],
    reversals: [{ transactionId: 9, reversalOfTransactionId: 4, description: "عكس مصروف مكرر", effectiveDate: "2026-10-05", actorName: "مدير الحسابات كريم" }],
  };
  for (const k of Object.keys(state.calls) as (keyof typeof state.calls)[]) state.calls[k] = [];
  state.validateResult = null; state.ledgerEnabled = true;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("🏦 الحسابات وأرصدتها", () => {
  it("قراءة: النقدية المتاحة بلا COD، ذمة COD منفصلة، مجموعات واضحة، ولا أزرار إدارة بلا ledger.manage_accounts", () => {
    render(<LedgerAccounts />);
    expect(screen.getByTestId("ledger-accounts-cash-total").textContent).toContain("٣٬٠٠٠٫٧٥"); // 1000.50 + 2000.25 — بلا 700 COD
    expect(screen.getByTestId("ledger-accounts-cod-total").textContent).toContain("٧٠٠");
    expect(screen.getByTestId("ledger-accounts-group-cash").textContent).not.toContain("مستحقات بوسطة");
    expect(screen.getByTestId("ledger-accounts-group-cod").textContent).toContain("مستحقات بوسطة");
    expect(screen.getByTestId("ledger-account-RENT").textContent).toContain("براند A");
    expect(screen.getByTestId("ledger-account-RENT").textContent).not.toContain("براند B"); // canPost=0 لا يظهر كربط
    expect(screen.queryByTestId("ledger-account-new")).toBeNull();
    expect(screen.queryByTestId("ledger-account-manage-RENT")).toBeNull();
  });
  it("نطاق المحاسب: الرصيد المحجوب من السيرفر يظهر «محجوب عن نطاقك» والإجمالي محجوب — لا صفر ولا مجموع جزئي", () => {
    state.accounts = state.accounts.map(a => (a.code === "OFFICE_CASH" ? { ...a, currentBalance: null, balanceHidden: true } : a));
    render(<LedgerAccounts />);
    expect(screen.getByTestId("ledger-account-balance-OFFICE_CASH").textContent).toBe("محجوب عن نطاقك");
    expect(screen.getByTestId("ledger-accounts-cash-total").textContent).toBe("محجوب عن نطاقك");
    expect(screen.getByTestId("ledger-accounts-cod-total").textContent).toContain("٧٠٠");
    expect(screen.getByTestId("ledger-accounts-hidden-note").textContent).toContain("للمالك ومدير الحسابات فقط");
  });
  it("إضافة حساب: الجانب مشتق من النوع، الكود ثابت داخل النافذة، وضغط مزدوج = طلب واحد", async () => {
    state.perms = ["ledger.view", "ledger.manage_accounts"];
    render(<LedgerAccounts />);
    fireEvent.click(screen.getByTestId("ledger-account-new"));
    fireEvent.change(screen.getByTestId("ledger-account-kind"), { target: { value: "revenue" } });
    fireEvent.change(screen.getByTestId("ledger-account-name"), { target: { value: "إيراد ورشة" } });
    const code = (screen.getByTestId("ledger-account-code") as HTMLInputElement).value;
    expect(code).toMatch(/^REV_[A-Z0-9]{5}$/);
    fireEvent.click(screen.getByTestId("ledger-account-create-confirm"));
    fireEvent.click(screen.getByTestId("ledger-account-create-confirm"));
    await waitFor(() => expect(screen.queryByTestId("ledger-account-create-dialog")).toBeNull());
    expect(state.calls.create).toEqual([{ code, name: "إيراد ورشة", kind: "revenue", normalSide: "credit" }]);
  });
  it("إدارة: حساب النظام بلا إيقاف؛ الحساب الإضافي يُوقف ويُربط/يُفك ربطه بنشاط — طلب واحد في كل مرة", async () => {
    state.perms = ["ledger.view", "ledger.manage_accounts"];
    render(<LedgerAccounts />);
    fireEvent.click(screen.getByTestId("ledger-account-manage-OFFICE_CASH"));
    expect(screen.getByTestId("ledger-account-manage-dialog").textContent).toContain("حساب نظام — لا يُوقف");
    expect(screen.queryByTestId("ledger-account-toggle-active")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("ledger-account-manage-dialog")).toBeNull());

    fireEvent.click(screen.getByTestId("ledger-account-manage-RENT"));
    fireEvent.click(screen.getByTestId("ledger-account-toggle-active"));
    fireEvent.click(screen.getByTestId("ledger-account-toggle-active"));
    await waitFor(() => expect(state.calls.setActive).toHaveLength(1));
    expect(state.calls.setActive[0]).toEqual({ accountId: 5, isActive: false });
    await waitFor(() => expect((screen.getByTestId("ledger-account-biz-toggle-7") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId("ledger-account-biz-toggle-7").textContent).toBe("فك الربط");
    expect(screen.getByTestId("ledger-account-biz-toggle-8").textContent).toBe("ربط");
    fireEvent.click(screen.getByTestId("ledger-account-biz-toggle-7"));
    await waitFor(() => expect(state.calls.revoke).toEqual([{ accountId: 5, businessId: 7 }]));
    await waitFor(() => expect((screen.getByTestId("ledger-account-biz-toggle-8") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("ledger-account-biz-toggle-8"));
    await waitFor(() => expect(state.calls.grant).toEqual([{ accountId: 5, businessId: 8 }]));
    fireEvent.change(screen.getByTestId("ledger-account-rename"), { target: { value: "إيجار المخزن" } });
    await waitFor(() => expect((screen.getByTestId("ledger-account-rename-save") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("ledger-account-rename-save"));
    await waitFor(() => expect(state.calls.rename).toEqual([{ accountId: 5, name: "إيجار المخزن" }]));
  });
});

describe("🗓️ مراجعة الشهر وإقفاله", () => {
  it("توضيح الترحيل الفوري، حركة الحسابات والأنشطة والعكوس، والسجل بالأسماء — بلا علامة «معتمدة/لم تُراجع»", () => {
    render(<LedgerPeriods />);
    expect(screen.getByTestId("ledger-periods-explainer").textContent).toContain("تُرحّل فور إدخالها");
    expect(screen.getByTestId("ledger-review-count").textContent).toContain("3");
    expect(screen.getByTestId("ledger-review-account-RENT").textContent).toContain("٣٠٠");
    expect(screen.getByTestId("ledger-review-businesses").textContent).toContain("مستوى الشركة");
    expect(screen.getByTestId("ledger-review-reversals").textContent).toContain("تعكس #4");
    expect(screen.getByTestId("ledger-review-event-0").textContent).toContain("مدير الحسابات كريم");
    expect(screen.getByTestId("ledger-review-event-0").textContent).toContain("راجعت الشهر");
    expect(screen.getByTestId("ledger-review-event-1").textContent).toContain("المالكة سارة");
    expect(document.body.textContent).not.toMatch(/معتمدة|لم تُراجع|غير مراجعة/);
    expect(screen.queryByTestId("ledger-review-lock")).toBeNull(); // بلا ledger.period.lock
  });
  it("وقت الحدث يُعرض بتوقيت القاهرة مهما كان توقيت المتصفح: 21:30Z يوم 30/9 = 1/10 00:30 بالقاهرة", () => {
    const prev = process.env.TZ; process.env.TZ = "UTC";
    try {
      const at = new Date("2026-09-30T21:30:00Z");
      state.review = { ...state.review, events: [{ action: "lock", reason: "حد الشهر", actorName: "كريم", createdAt: at }] };
      render(<LedgerPeriods />);
      const fmt = (timeZone: string) => at.toLocaleString("ar-EG", { timeZone, dateStyle: "medium", timeStyle: "short" });
      const text = screen.getByTestId("ledger-review-event-0").textContent ?? "";
      expect(text).toContain(fmt("Africa/Cairo"));
      expect(fmt("Africa/Cairo")).not.toBe(fmt("UTC"));
      expect(text).not.toContain(fmt("UTC"));
    } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
  });
  it("الإقفال بملاحظة مراجعة إلزامية: فارغة = لا طلب؛ مع الملاحظة = طلب واحد بنفس الشهر", async () => {
    state.perms = ["ledger.view", "ledger.period.lock"];
    render(<LedgerPeriods />);
    fireEvent.click(screen.getByTestId("ledger-review-lock"));
    expect(screen.getByTestId("ledger-period-dialog-lock").textContent).toContain("الحركات تُرحّل فورًا");
    fireEvent.click(screen.getByTestId("ledger-period-confirm"));
    expect(state.calls.lock).toEqual([]);
    fireEvent.change(screen.getByTestId("ledger-period-reason"), { target: { value: "راجعت حركة أكتوبر" } });
    fireEvent.click(screen.getByTestId("ledger-period-confirm"));
    fireEvent.click(screen.getByTestId("ledger-period-confirm"));
    await waitFor(() => expect(state.calls.lock).toEqual([{ period: "2026-10", reason: "راجعت حركة أكتوبر" }]));
  });
  it("إعادة الفتح تظهر للشهر المقفل لمن لديه ledger.period.reopen فقط (المالك)، ومدير الحسابات لا يراها", () => {
    state.review = { ...state.review, status: "locked" };
    state.perms = ["ledger.view", "ledger.period.lock"];
    const { unmount } = render(<LedgerPeriods />);
    expect(screen.queryByTestId("ledger-review-reopen")).toBeNull();
    expect(screen.queryByTestId("ledger-review-lock")).toBeNull();
    unmount();
    state.perms = ["ledger.view", "ledger.period.lock", "ledger.period.reopen"];
    render(<LedgerPeriods />);
    expect(screen.getByTestId("ledger-review-reopen")).toBeTruthy();
  });
});

describe("🧾 تجهيز الأرصدة الافتتاحية", () => {
  beforeEach(() => { state.ledgerEnabled = false; }); // التجهيز قبل التفعيل
  const fill = (code: string, amount: string, ref = "", by = "") => {
    fireEvent.change(screen.getByTestId(`ledger-opening-amount-${code}`), { target: { value: amount } });
    if (ref) fireEvent.change(screen.getByTestId(`ledger-opening-ref-${code}`), { target: { value: ref } });
    if (by) fireEvent.change(screen.getByTestId(`ledger-opening-by-${code}`), { target: { value: by } });
  };
  const serverFile = { goLiveDate: "2026-11-01", currency: "EGP", openingBalances: { OFFICE_CASH: "12500.00", BANK_MAIN: "0", COD_BOSTA: "3300.50", VF_CASH: "0", INSTAPAY: "0" }, reconciliation: null, openingEquity: "15800.5000", _source: "جرد ومطابقة فعلية يوم Go-live — بلا أي رقم من V1/V2" };

  it("مبلغ بلا دليل = أخطاء محلية بلا أي طلب؛ COD في مجموعة منفصلة عن النقدية", () => {
    render(<LedgerOpening />);
    expect(screen.getByTestId("ledger-opening-cash").textContent).not.toContain("مستحقات بوسطة");
    expect(screen.getByTestId("ledger-opening-cod").textContent).toContain("مستحقات بوسطة");
    fireEvent.change(screen.getByTestId("ledger-opening-date"), { target: { value: "2026-11-01" } });
    fill("OFFICE_CASH", "12500.00");
    fill("BANK_MAIN", "1,500");
    fireEvent.click(screen.getByTestId("ledger-opening-validate"));
    const errs = screen.getByTestId("ledger-opening-local-errors").textContent ?? "";
    expect(errs).toContain("خزنة المكتب: اذكر مرجع الجرد");
    expect(errs).toContain("البنك: المبلغ رقم عشري");
    expect(state.calls.validate).toEqual([]);
    expect((screen.getByTestId("ledger-opening-download") as HTMLButtonElement).disabled).toBe(true);
  });
  it("تحقق ناجح → تنزيل ملف الخادم حرفيًا (Blob + revoke)؛ أي تعديل بعده يُبطل التنزيل؛ لا تخزين في المتصفح", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    state.validateResult = { ok: true, errors: [], blockers: [], warnings: ["تحذير تجريبي"], totals: { cashAvailable: "12500.0000", codReceivable: "3300.5000", openingEquity: "15800.5000" }, businessCoverage: [{ id: 7, name: "براند A", active: true, inPlan: true, result: "" }], v2Reconciliation: { generatedAt: "x", ok: false, differences: 2 }, ledgerEnabled: false, file: serverFile };
    render(<LedgerOpening />);
    fireEvent.change(screen.getByTestId("ledger-opening-date"), { target: { value: "2026-11-01" } });
    fill("OFFICE_CASH", "12500.00", "محضر جرد الخزنة", "سارة");
    fill("COD_BOSTA", "3300.50", "كشف تسوية بوسطة", "سارة");
    fireEvent.click(screen.getByTestId("ledger-opening-ack"));
    fireEvent.click(screen.getByTestId("ledger-opening-validate"));
    fireEvent.click(screen.getByTestId("ledger-opening-validate"));
    await waitFor(() => expect(screen.getByTestId("ledger-opening-result")).toBeTruthy());
    expect(state.calls.validate).toEqual([{
      goLiveDate: "2026-11-01", balances: { OFFICE_CASH: "12500.00", COD_BOSTA: "3300.50" },
      evidence: { OFFICE_CASH: { reference: "محضر جرد الخزنة", countedBy: "سارة" }, COD_BOSTA: { reference: "كشف تسوية بوسطة", countedBy: "سارة" } },
      acknowledgeV2Differences: true,
    }]);
    expect(screen.getByTestId("ledger-opening-v2").textContent).toContain("2 فرق");
    expect(screen.getByTestId("ledger-opening-warnings").textContent).toContain("تحذير تجريبي");

    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => { blobs.push(b); return "blob:test"; });
    const revoke = vi.fn();
    (URL as any).createObjectURL = create; (URL as any).revokeObjectURL = revoke;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(screen.getByTestId("ledger-opening-download"));
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await blobs[0].text())).toEqual(serverFile);
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:test"));

    fill("OFFICE_CASH", "12600.00");
    expect((screen.getByTestId("ledger-opening-download") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("ledger-opening-stale")).toBeTruthy();
    expect(setItem).not.toHaveBeenCalled();
  });
  it("المسودة تُمسح عند تغيير الشركة/الجلسة (إعادة إنشاء النموذج فارغًا)", () => {
    const { rerender } = render(<LedgerOpening />);
    fill("OFFICE_CASH", "100", "محضر", "سارة");
    expect((screen.getByTestId("ledger-opening-amount-OFFICE_CASH") as HTMLInputElement).value).toBe("100");
    state.user = { id: 1, tenantId: 11, role: "admin" };
    rerender(<LedgerOpening />);
    expect((screen.getByTestId("ledger-opening-amount-OFFICE_CASH") as HTMLInputElement).value).toBe("");
  });
});
