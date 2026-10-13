// @vitest-environment jsdom
/**
 * «الموردون والورشة» (المرحلة 6): رسالة واضحة قبل 0049؛ الفاتورة على مخزون/مصروف تشغيلي فقط (لا حساب آلي)؛ الدفعة من خزنة؛
 * إلغاء المستند بسبب؛ العجز لا يُسجَّل بلا اختيار صريح (على الورشة أم خسارة).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({ list: null as any, statement: null as any, batches: [] as any[], calls: [] as [string, any][] }));
const mut = vi.hoisted(() => (name: string) => ({ useMutation: () => ({ isPending: false, mutateAsync: async (i: any) => { state.calls.push([name, i]); await new Promise(r => setTimeout(r, 10)); return { replay: false }; } }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ ledger: { suppliers: { list: { invalidate: async () => {} }, statement: { invalidate: async () => {} }, batches: { invalidate: async () => {} } } } }),
    ledger: {
      status: { useQuery: () => ({ data: { tablesPresent: true, enabled: true } }) },
      businesses: { list: { useQuery: () => ({ data: [{ id: 3, name: "براند A" }] }) } },
      accounts: { list: { useQuery: () => ({ data: [
        { id: 1, code: "OFFICE_CASH", name: "خزنة المكتب", kind: "cash", isActive: 1 }, { id: 2, code: "INV_RAW", name: "مخزون خامات", kind: "inventory", isActive: 1 },
        { id: 3, code: "RETURNS_PENDING", name: "مرتجعات قيد الفحص", kind: "inventory", isActive: 1 }, { id: 4, code: "EXP_RENT", name: "إيجار", kind: "expense", isActive: 1 },
        { id: 5, code: "EXP_CARRIER_FEES", name: "رسوم شركة الشحن", kind: "expense", isActive: 1 },
      ] }) } },
      suppliers: {
        list: { useQuery: () => ({ data: state.list }) },
        statement: { useQuery: () => ({ data: state.statement }) },
        batches: { useQuery: () => ({ data: state.batches }) },
        ensureAccounts: mut("ensure"), create: mut("create"), postDocument: mut("post"), cancelDocument: mut("cancel"), createBatch: mut("batch"), workshopEvent: mut("event"),
      },
    },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import LedgerSuppliers from "./LedgerSuppliers";

beforeEach(() => {
  state.calls = [];
  state.list = { available: true, accountsReady: true, suppliers: [{ id: 9, code: "WS-01", name: "ورشة الأسطى", isWorkshop: true, isActive: true, payable: "98.3333", advance: "0.0000" }] };
  state.statement = { supplier: { id: 9, name: "ورشة الأسطى", isWorkshop: true }, payable: "98.3333", advance: "0.0000", aging: { notDue: "98.3333", d1_30: "0.0000", d31_60: "0.0000", d61_90: "0.0000", d90plus: "0.0000" },
    documents: [{ id: 51, docType: "invoice", docNo: "INV-1", docDate: "2026-10-05", dueDate: "2026-10-20", amount: "5000.0000", cancelled: false }], advancesOpen: [], lines: [] };
  state.batches = [{ id: 4, reference: "B-1", status: "partially_received", sentQuantity: 30, receivedQuantity: 10, shortageQuantity: 0, remainingQuantity: 20, remainingValue: "666.6667", events: [] }];
});
afterEach(() => cleanup());

describe("🏭 الموردون والورشة", () => {
  it("قبل 0049: رسالة واضحة بلا أقسام", () => {
    state.list = { available: false, reason: "0049", suppliers: [] };
    render(<LedgerSuppliers />);
    expect(screen.getByText(/جداول الموردين \(0049\)/)).toBeTruthy();
    expect(screen.queryByTestId("ledger-suppliers")).toBeNull();
  });

  it("الفاتورة على مخزون/مصروف تشغيلي فقط (لا «قيد الفحص» ولا رسوم الشحن الآلية)؛ الدفعة من خزنة؛ الإلغاء بسبب", async () => {
    render(<LedgerSuppliers />);
    fireEvent.click(screen.getByTestId("supplier-open-9"));
    const items = screen.getByTestId("dc-item").textContent!;
    expect(items).toContain("مخزون خامات"); expect(items).toContain("إيجار");
    expect(items).not.toContain("قيد الفحص"); expect(items).not.toContain("رسوم شركة الشحن");
    fireEvent.change(screen.getByTestId("dc-type"), { target: { value: "payment" } });
    expect(screen.queryByTestId("dc-item")).toBeNull();
    fireEvent.change(screen.getByTestId("dc-no"), { target: { value: "PAY-1" } });
    fireEvent.change(screen.getByTestId("dc-amount"), { target: { value: "50" } });
    fireEvent.click(screen.getByTestId("dc-post"));
    await waitFor(() => expect(state.calls).toContainEqual(["post", expect.objectContaining({ supplierId: 9, docType: "payment", docNo: "PAY-1", amount: "50", cashAccountCode: "OFFICE_CASH", businessId: null })]));
    fireEvent.click(screen.getByText("إلغاء", { selector: "button" }));
    expect((screen.getByTestId("doc-cancel-run") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("doc-cancel-reason"), { target: { value: "رقم مكرر" } });
    fireEvent.click(screen.getByTestId("doc-cancel-run"));
    await waitFor(() => expect(state.calls).toContainEqual(["cancel", { documentId: 51, reason: "رقم مكرر" }]));
  });

  it("العجز لا يُسجَّل بلا اختيار صريح؛ بالاختيار يُرسل chargeTo نفسه", async () => {
    render(<LedgerSuppliers />);
    fireEvent.click(screen.getByTestId("supplier-open-9"));
    fireEvent.click(screen.getByTestId("ev-shortage-4"));
    fireEvent.change(screen.getByTestId("ev-q"), { target: { value: "2" } });
    expect((screen.getByTestId("ev-run") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("ev-charge-loss"));
    fireEvent.click(screen.getByTestId("ev-run"));
    await waitFor(() => expect(state.calls).toContainEqual(["event", expect.objectContaining({ batchId: 4, eventType: "shortage", quantity: 2, chargeTo: "loss", operationId: expect.stringMatching(/^ui:/) })]));
  });
});
