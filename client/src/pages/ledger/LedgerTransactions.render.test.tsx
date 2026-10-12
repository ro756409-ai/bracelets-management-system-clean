// @vitest-environment jsdom
/**
 * سجل الحركات (7E): بطاقات على الهاتف/جدول على الشاشة الواسعة (نسخة واحدة)، الأصل والعكس مرتبطان،
 * العكس بصلاحية وسبب وحارس ضغط مكرر، تفاصيل الحركة للقراءة فقط، والفترات بقفل/إعادة فتح مقيّدين بالصلاحية.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";

const state = vi.hoisted(() => ({ perms: [] as string[], rows: [] as any[], reverseCalls: [] as any[], periods: [] as any[], lockCalls: [] as any[], reopenCalls: [] as any[], desktop: true }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ ledger: { accounts: { list: { invalidate: async () => {} } } } }),
    ledger: {
      status: { useQuery: () => ({ data: { tablesPresent: true, enabled: true }, isLoading: false }) },
      transactions: { list: { useQuery: () => ({ data: { rows: state.rows, total: state.rows.length, page: 1, limit: 25 }, isLoading: false, error: null, refetch: async () => {} }) } },
      businesses: { list: { useQuery: () => ({ data: [{ id: 7, name: "براند A" }], isLoading: false }) } },
      periods: { list: { useQuery: () => ({ data: state.periods, isLoading: false, error: null, refetch: async () => {} }) } },
      period: {
        lock: { useMutation: () => ({ mutateAsync: async (input: any) => { state.lockCalls.push(input); await new Promise(r => setTimeout(r, 20)); return { periodId: 1, status: "locked", replay: false }; }, isPending: false }) },
        reopen: { useMutation: () => ({ mutateAsync: async (input: any) => { state.reopenCalls.push(input); await new Promise(r => setTimeout(r, 20)); return { periodId: 1, status: "open", replay: false }; }, isPending: false }) },
      },
      reverse: { useMutation: () => ({ mutateAsync: async (input: any) => { state.reverseCalls.push(input); await new Promise(r => setTimeout(r, 20)); return { transactionId: 99, replay: false }; }, isPending: false }) },
    },
  },
}));
vi.mock("@/hooks/usePermission", () => ({ usePermissions: () => ({ permissions: state.perms, isLoading: false, has: (p: string) => state.perms.includes(p) }) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => true }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import LedgerTransactions, { ReverseDialog, PeriodDialog } from "./LedgerTransactions";

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id, effectiveDate: "2026-10-07", kind: "expense", description: `حركة ${id}`, sourceBusinessId: 7, actorType: "employee", actorName: "سارة",
  reversalOfTransactionId: null, reversedByTransactionId: null,
  entries: [{ accountId: 7, side: "debit", amount: "300.0000", code: "EXPENSE", name: "مصروفات عامة" }, { accountId: 1, side: "credit", amount: "300.0000", code: "OFFICE_CASH", name: "خزنة المكتب" }],
  ...over,
});
beforeEach(() => {
  state.perms = ["ledger.view"]; state.desktop = true;
  state.rows = [row(1), row(2, { reversedByTransactionId: 3 }), row(3, { kind: "reversal", reversalOfTransactionId: 2, description: "عكس الحركة #2" })];
  state.reverseCalls = []; state.lockCalls = []; state.reopenCalls = [];
  state.periods = [{ id: 1, period: "2026-09", status: "locked", events: [{ id: 1, action: "lock", reason: "إقفال الشهر", createdAt: "2026-10-01" }] }, { id: 2, period: "2026-10", status: "open", events: [] }];
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width") ? state.desktop : !state.desktop, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => cleanup());

describe("📱 سجل الحركات", () => {
  it("Mobile: البطاقات وحدها تعرض التاريخ والنشاط والنوع والبيان والمبلغ ومن/إلى والمنفّذ؛ الأصل والعكس مرتبطان", () => {
    state.desktop = false;
    render(<LedgerTransactions />);
    expect(screen.queryByTestId("responsive-table-table")).toBeNull();
    const c1 = screen.getByTestId("ledger-card-1").textContent ?? "";
    for (const s of ["2026-10-07", "براند A", "مصروف", "حركة 1", "٣٠٠", "من: خزنة المكتب", "إلى: مصروفات عامة", "المنفّذ: سارة"]) expect(c1).toContain(s);
    expect(screen.getByTestId("ledger-reversed-2").textContent).toContain("معكوسة بـ #3");
    expect(screen.getByTestId("ledger-reverses-3").textContent).toContain("يعكس #2");
  });
  it("Desktop: الجدول وحده (لا بطاقات)، والتفاصيل حوار قراءة بلا تعديل/حذف", () => {
    render(<LedgerTransactions />);
    expect(screen.getByTestId("responsive-table-table")).toBeTruthy();
    expect(screen.queryByTestId("ledger-card-1")).toBeNull();
    fireEvent.click(screen.getByTestId("ledger-details-1"));
    const dlg = screen.getByTestId("ledger-details-dialog");
    expect(dlg.textContent).toContain("الحركة #1");
    expect(screen.getByTestId("ledger-details-amount").textContent).toContain("٣٠٠");
    expect(dlg.textContent).toContain("خزنة المكتب");
    expect(dlg.textContent).not.toMatch(/مدين|دائن|حذف الحركة|تعديل الحركة/);
    expect(screen.queryByTestId("ledger-details-reverse")).toBeNull(); // بلا ledger.reverse
  });
  it("بلا ledger.reverse: لا زر عكس؛ معه: يظهر للأصل غير المعكوس فقط (لا للمعكوسة ولا لحركة العكس)", () => {
    render(<LedgerTransactions />);
    expect(screen.queryByTestId("ledger-reverse-1")).toBeNull();
    cleanup();
    state.perms = ["ledger.view", "ledger.reverse"];
    render(<LedgerTransactions />);
    expect(screen.getByTestId("ledger-reverse-1")).toBeTruthy();
    expect(screen.queryByTestId("ledger-reverse-2")).toBeNull();
    expect(screen.queryByTestId("ledger-reverse-3")).toBeNull();
    fireEvent.click(screen.getByTestId("ledger-reverse-1"));
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

describe("🔒 الفترات المحاسبية", () => {
  it("بلا صلاحيات: الفترات تُعرض بحالتها بلا أي زر قفل/إعادة فتح", () => {
    render(<LedgerTransactions />);
    const sec = screen.getByTestId("ledger-periods");
    expect(within(sec).getByTestId("ledger-period-2026-09").textContent).toContain("مقفلة");
    expect(within(sec).getByTestId("ledger-period-2026-10").textContent).toContain("مفتوحة");
    expect(screen.queryByTestId("ledger-period-lock-2026-10")).toBeNull();
    expect(screen.queryByTestId("ledger-period-reopen-2026-09")).toBeNull();
    expect(screen.queryByTestId("ledger-period-lock-new")).toBeNull();
  });
  it("ledger.period.lock وحدها: قفل المفتوحة فقط — لا إعادة فتح (للمالك فقط)", () => {
    state.perms = ["ledger.view", "ledger.period.lock"];
    render(<LedgerTransactions />);
    expect(screen.getByTestId("ledger-period-lock-2026-10")).toBeTruthy();
    expect(screen.getByTestId("ledger-period-lock-new")).toBeTruthy();
    expect(screen.queryByTestId("ledger-period-reopen-2026-09")).toBeNull();
    fireEvent.click(screen.getByTestId("ledger-period-lock-2026-10"));
    expect(screen.getByTestId("ledger-period-dialog-lock").textContent).toContain("قفل فترة محاسبية");
  });
  it("ledger.period.reopen (المالك): زر إعادة الفتح للمقفلة؛ السبب إلزامي؛ double-click = طلب واحد", async () => {
    state.perms = ["ledger.view", "ledger.period.lock", "ledger.period.reopen"];
    render(<LedgerTransactions />);
    expect(screen.getByTestId("ledger-period-reopen-2026-09")).toBeTruthy();
    cleanup();
    const onClose = vi.fn();
    render(<PeriodDialog period="2026-09" action="reopen" onClose={onClose} onDone={async () => {}} />);
    fireEvent.click(screen.getByTestId("ledger-period-confirm"));
    await new Promise(r => setTimeout(r, 10));
    expect(state.reopenCalls).toHaveLength(0);
    fireEvent.change(screen.getByTestId("ledger-period-reason"), { target: { value: "تصحيح تاريخ" } });
    const btn = screen.getByTestId("ledger-period-confirm");
    fireEvent.click(btn); fireEvent.click(btn);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(state.reopenCalls).toEqual([{ period: "2026-09", reason: "تصحيح تاريخ" }]);
    expect(state.lockCalls).toHaveLength(0);
  });
  it("قفل الفترة: ملاحظة المراجعة إلزامية (بلا ملاحظة لا طلب)، double-click = طلب واحد بالفترة والملاحظة", async () => {
    const onClose = vi.fn();
    render(<PeriodDialog period="2026-10" action="lock" onClose={onClose} onDone={async () => {}} />);
    const btn = screen.getByTestId("ledger-period-confirm");
    fireEvent.click(btn);
    expect(state.lockCalls).toEqual([]);
    expect(screen.getByText("ملاحظة المراجعة (إلزامية)")).toBeTruthy();
    expect(screen.getByText(/الحركات تُرحّل فورًا/)).toBeTruthy();
    fireEvent.change(screen.getByTestId("ledger-period-reason"), { target: { value: "راجعت حركة الشهر" } });
    fireEvent.click(btn); fireEvent.click(btn);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(state.lockCalls).toEqual([{ period: "2026-10", reason: "راجعت حركة الشهر" }]);
  });
});
