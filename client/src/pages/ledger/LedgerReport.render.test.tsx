// @vitest-environment jsdom
/**
 * التقرير اليومي (المرحلة 2): الأرقام من السيرفر كما هي؛ لا بطاقة ربح بلا reports.view_profit (لا صفر)؛ الرصيد المحجوب
 * «محجوب عن نطاقك»؛ ما قبل Go-live «غير متاح»؛ الإلغاء بقيد عكسي لصاحب ledger.reverse فقط.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const state = vi.hoisted(() => ({ perms: [] as string[], report: null as any, lastInput: null as any }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ ledger: { accounts: { list: { invalidate: async () => {} } } } }),
    ledger: {
      status: { useQuery: () => ({ data: { tablesPresent: true, enabled: true }, isLoading: false }) },
      businesses: { list: { useQuery: () => ({ data: [{ id: 7, name: "براند A" }, { id: 8, name: "براند B" }], isLoading: false }) } },
      reports: { daily: { useQuery: (input: any) => { state.lastInput = input; return { data: state.report, isLoading: false, error: null, refetch: async () => {} }; } } },
      reverse: { useMutation: () => ({ mutateAsync: async () => ({ transactionId: 99, replay: false }), isPending: false }) },
    },
  },
}));
vi.mock("@/hooks/usePermission", () => ({ usePermissions: () => ({ permissions: state.perms, isLoading: false, has: (p: string) => state.perms.includes(p) }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import LedgerReport from "./LedgerReport";

const tx = (id: number, over: Record<string, unknown> = {}) => ({ id, effectiveDate: "2026-10-05", kind: "expense", description: `حركة ${id}`, sourceBusinessId: 7, actorName: "سارة", actorType: "employee",
  reversalOfTransactionId: null, reversedByTransactionId: null, entries: [{ accountId: 1, side: "debit", amount: "100.0000", code: "EXP_OFFICE", name: "مصروفات المكتب" }, { accountId: 2, side: "credit", amount: "100.0000", code: "OFFICE_CASH", name: "خزنة" }], ...over });
const base = () => ({
  date: "2026-10-05", transactions: { rows: [tx(1), tx(2, { kind: "inventory_purchase", description: "شراء خامات" })], total: 2 }, countsByKind: [],
  revenue: "500.0000", expenses: { total: "100.0000", byCategory: [{ accountId: 1, code: "EXP_OFFICE", name: "مصروفات المكتب", amount: "100.0000" }] },
  purchases: "300.0000", cogs: "0.0000", transfers: "50.0000", availableCash: "1100.0000", codReceivable: "0.0000", balances: [], profit: "400.0000", profitHidden: false, beforeGoLive: false,
});
beforeEach(() => { state.perms = ["ledger.view"]; state.report = base(); state.lastInput = null; });
afterEach(() => cleanup());

describe("📊 التقرير اليومي", () => {
  it("المالك (ربح مسموح): بطاقات الإيراد والمصروف والمشتريات (أصل) والنقدية والربح؛ التصنيفات والحركات", () => {
    render(<LedgerReport />);
    const cards = screen.getByTestId("ledger-report-cards").textContent ?? "";
    for (const s of ["الإيراد", "٥٠٠", "المصروفات التشغيلية", "مشتريات بضاعة/خامات", "أصل مخزون — ليست مصروفًا", "١٬١٠٠", "صافي اليوم", "٤٠٠"]) expect(cards).toContain(s);
    expect(screen.getByTestId("ledger-report-category-EXP_OFFICE").textContent).toContain("١٠٠");
    expect(screen.getByTestId("ledger-report-tx-2").textContent).toContain("شراء بضاعة/خامات");
    expect(state.lastInput).toEqual({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), businessId: undefined });
  });
  it("بلا reports.view_profit: لا بطاقة ربح أصلًا (لا صفر)، والنقدية المحجوبة «محجوب عن نطاقك»", () => {
    state.report = { ...base(), profit: null, profitHidden: true, availableCash: null };
    render(<LedgerReport />);
    const cards = screen.getByTestId("ledger-report-cards").textContent ?? "";
    expect(cards).not.toContain("صافي اليوم");
    expect(cards).toContain("محجوب عن نطاقك");
  });
  it("قبل Go-live: «غير متاح» للأرصدة وتنبيه واضح", () => {
    state.report = { ...base(), beforeGoLive: true, availableCash: null, codReceivable: null, profit: null };
    render(<LedgerReport />);
    expect(screen.getByTestId("ledger-report-before-golive")).toBeTruthy();
    expect(screen.getByTestId("ledger-report-cards").textContent).toContain("غير متاح (قبل بداية الدفتر)");
  });
  it("الإلغاء بقيد عكسي: لصاحب ledger.reverse فقط، ولا يظهر لحركة معكوسة أو لحركة عكس", () => {
    state.report = { ...base(), transactions: { rows: [tx(1), tx(2, { reversedByTransactionId: 3 }), tx(3, { kind: "reversal", reversalOfTransactionId: 2 })], total: 3 } };
    render(<LedgerReport />);
    expect(screen.queryByTestId("ledger-report-reverse-1")).toBeNull();
    cleanup();
    state.perms = ["ledger.view", "ledger.reverse"];
    render(<LedgerReport />);
    expect(screen.getByTestId("ledger-report-reverse-1")).toBeTruthy();
    expect(screen.queryByTestId("ledger-report-reverse-2")).toBeNull();
    expect(screen.queryByTestId("ledger-report-reverse-3")).toBeNull();
    fireEvent.click(screen.getByTestId("ledger-report-reverse-1"));
    expect(screen.getByTestId("ledger-reverse-dialog").textContent).toContain("عكس الحركة #1");
  });
  it("فلتر النشاط يُرسل للسيرفر (النطاق يُفحص هناك)", () => {
    render(<LedgerReport />);
    fireEvent.change(screen.getByTestId("ledger-report-business"), { target: { value: "8" } });
    expect(state.lastInput.businessId).toBe(8);
  });
});
