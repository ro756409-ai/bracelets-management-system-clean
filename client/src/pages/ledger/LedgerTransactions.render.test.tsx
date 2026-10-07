// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({ perms: [] as string[], rows: [] as any[], reverseCalls: [] as any[] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ ledger: { accounts: { list: { invalidate: async () => {} } } } }),
    ledger: {
      status: { useQuery: () => ({ data: { tablesPresent: true, enabled: true }, isLoading: false }) },
      transactions: { list: { useQuery: () => ({ data: { rows: state.rows, total: state.rows.length, page: 1, limit: 25 }, isLoading: false, error: null, refetch: async () => {} }) } },
      businesses: { list: { useQuery: () => ({ data: [{ id: 7, name: "براند A" }], isLoading: false }) } },
      reverse: { useMutation: () => ({ mutateAsync: async (input: any) => { state.reverseCalls.push(input); await new Promise(r => setTimeout(r, 20)); return { transactionId: 99, replay: false }; }, isPending: false }) },
    },
  },
}));
vi.mock("@/hooks/usePermission", () => ({ usePermissions: () => ({ permissions: state.perms, isLoading: false, has: (p: string) => state.perms.includes(p) }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import LedgerTransactions, { ReverseDialog } from "./LedgerTransactions";

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id, effectiveDate: "2026-10-07", kind: "expense", description: `حركة ${id}`, sourceBusinessId: 7, actorType: "employee", actorName: "سارة",
  reversalOfTransactionId: null, reversedByTransactionId: null,
  entries: [{ accountId: 7, side: "debit", amount: "300.0000", code: "EXPENSE", name: "مصروفات عامة" }, { accountId: 1, side: "credit", amount: "300.0000", code: "OFFICE_CASH", name: "خزنة المكتب" }],
  ...over,
});
beforeEach(() => { state.perms = ["ledger.view"]; state.rows = [row(1), row(2, { reversedByTransactionId: 3 }), row(3, { kind: "reversal", reversalOfTransactionId: 2, description: "عكس الحركة #2" })]; state.reverseCalls = []; });
afterEach(() => cleanup());

describe("📱 سجل الحركات", () => {
  it("البطاقات تعرض التاريخ والنشاط والنوع والبيان والمبلغ ومن/إلى والمنفّذ؛ الأصل والعكس مرتبطان", () => {
    render(<LedgerTransactions />);
    const c1 = screen.getByTestId("ledger-card-1").textContent ?? "";
    for (const s of ["2026-10-07", "براند A", "مصروف", "حركة 1", "٣٠٠", "من: خزنة المكتب", "إلى: مصروفات عامة", "المنفّذ: سارة"]) expect(c1).toContain(s);
    // jsdom لا يطبّق md:hidden فالبطاقة والصف كلاهما في الشجرة
    expect(screen.getAllByTestId("ledger-reversed-2")[0].textContent).toContain("معكوسة بـ #3");
    expect(screen.getAllByTestId("ledger-reverses-3")[0].textContent).toContain("يعكس #2");
  });
  it("بلا ledger.reverse: لا زر عكس؛ معه: يظهر للأصل غير المعكوس فقط (لا للمعكوسة ولا لحركة العكس)", () => {
    render(<LedgerTransactions />);
    expect(screen.queryByTestId("ledger-reverse-1")).toBeNull();
    cleanup();
    state.perms = ["ledger.view", "ledger.reverse"];
    render(<LedgerTransactions />);
    expect(screen.getAllByTestId("ledger-reverse-1").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("ledger-reverse-2")).toBeNull();
    expect(screen.queryByTestId("ledger-reverse-3")).toBeNull();
    fireEvent.click(screen.getAllByTestId("ledger-reverse-1")[0]);
    expect(screen.getByTestId("ledger-reverse-dialog").textContent).toContain("عكس الحركة #1");
  });
  it("العكس يتطلب سببًا؛ double-click = طلب واحد بنفس operationId وبالسبب", async () => {
    const onClose = vi.fn();
    render(<ReverseDialog row={row(1) as any} onClose={onClose} onDone={async () => {}} />);
    fireEvent.click(screen.getByTestId("ledger-reverse-confirm"));
    await new Promise(r => setTimeout(r, 10));
    expect(state.reverseCalls).toHaveLength(0);
    fireEvent.change(screen.getByTestId("ledger-reverse-reason"), { target: { value: "خطأ في المبلغ" } });
    const btn = screen.getByTestId("ledger-reverse-confirm");
    fireEvent.click(btn); fireEvent.click(btn);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(state.reverseCalls).toHaveLength(1);
    expect(state.reverseCalls[0]).toMatchObject({ transactionId: 1, reason: "خطأ في المبلغ" });
    expect(state.reverseCalls[0].idempotencyKey).toMatch(/^ui:/);
  });
});
