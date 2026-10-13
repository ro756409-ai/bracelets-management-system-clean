// @vitest-environment jsdom
/**
 * المرحلة 4 — واجهات: لوحة «تسليم لمندوب الشحن» بعد المسح (تظهر فقط حين تكون مفعّلة، ضغط مزدوج = طلب واحد، بلا أرقام
 * تكلفة لموظف المخزن)، وقسم المخزون الافتتاحي للمالك بعد التفعيل (مرة لكل مخزن، الجرد بلا تكلفة مثبتة لا يُعتمد).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({ active: true, handoverCalls: 0, handoverResult: { duplicate: false, cost: "120.0000" } as any, candidates: [] as any[], postCalls: [] as number[], pkCalls: [] as any[] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    inventoryLedger: {
      status: { useQuery: () => ({ data: { active: state.active } }) },
      handover: { useMutation: () => ({ mutateAsync: async () => { state.handoverCalls++; await new Promise(r => setTimeout(r, 20)); return state.handoverResult; }, isPending: false }) },
    },
    ledger: {
      status: { useQuery: () => ({ data: { tablesPresent: true, enabled: true } }) },
      businesses: { list: { useQuery: () => ({ data: [{ id: 3, name: "براند A" }, { id: 4, name: "براند B" }] }) } },
      inventory: {
        packagingOpening: { useMutation: () => ({ mutateAsync: async (i: any) => { state.pkCalls.push(i); await new Promise(r => setTimeout(r, 20)); return { replay: false }; } }) },
        openingCandidates: { useQuery: () => ({ data: { goLiveDate: "2026-10-01", rows: state.candidates }, isLoading: false, error: null, refetch: async () => {} }) },
        openingFromStocktake: { useMutation: () => ({ mutateAsync: async (i: any) => { state.postCalls.push(i.stocktakeId); await new Promise(r => setTimeout(r, 20)); return { replay: false }; }, isPending: false }) },
      },
    },
  },
}));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: 1, tenantId: 10 }, loading: false }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { HandoverPanel } from "@/components/inventory/HandoverPanel";
import LedgerOpening from "./LedgerOpening";

beforeEach(() => {
  state.active = true; state.handoverCalls = 0; state.handoverResult = { duplicate: false, cost: "120.0000" }; state.postCalls = []; state.pkCalls = [];
  state.candidates = [
    { stocktakeId: 5, businessName: "براند A", warehouseName: "المكتب", approvedDay: "2026-09-30", value: "4000.0000", postedFromStocktakeId: null },
    { stocktakeId: 6, businessName: "براند A", warehouseName: "الورشة", approvedDay: "2026-10-01", value: null, postedFromStocktakeId: null },
    { stocktakeId: 7, businessName: "براند B", warehouseName: "المكتب", approvedDay: "2026-10-01", value: "900.0000", postedFromStocktakeId: 3 },
  ];
});
afterEach(() => cleanup());

describe("🚚 تسليم لمندوب الشحن بعد المسح", () => {
  it("مخفية حين لا يكون التسليم مفعّلًا للنشاط", () => {
    state.active = false;
    render(<HandoverPanel order={{ id: 1, businessId: 7 }} />);
    expect(screen.queryByTestId("handover-panel")).toBeNull();
  });
  it("ضغط مزدوج = طلب واحد، ورسالة التمام بلا رقم تكلفة", async () => {
    render(<HandoverPanel order={{ id: 1, businessId: 7 }} />);
    const btn = screen.getByTestId("handover-run");
    fireEvent.click(btn); fireEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId("handover-done")).toBeTruthy());
    expect(state.handoverCalls).toBe(1);
    expect(screen.getByTestId("handover-panel").textContent).not.toMatch(/120|١٢٠/);
  });
});

describe("🏷️ المخزون الافتتاحي (المالك بعد التفعيل)", () => {
  it("يعرض الجرود بقيمتها؛ بلا تكلفة مثبتة = معطّل؛ مخزن مسجّل من جرد آخر = بلا زر؛ ضغط مزدوج = طلب واحد", async () => {
    render(<LedgerOpening />);
    expect(screen.getByTestId("ledger-inventory-opening")).toBeTruthy();
    expect(screen.queryByTestId("ledger-opening")).toBeNull(); // نموذج النقدية لا يظهر بعد التفعيل
    expect((screen.getByTestId("ledger-inventory-opening-post-6") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("ledger-inventory-opening-post-7")).toBeNull();
    expect(screen.getByTestId("ledger-inventory-opening-7").textContent).toContain("من جرد آخر");
    const btn = screen.getByTestId("ledger-inventory-opening-post-5");
    fireEvent.click(btn); fireEvent.click(btn);
    await waitFor(() => expect(state.postCalls).toEqual([5]));
  });

  it("رصيد التغليف الافتتاحي: تاريخ العدّ = يوم Go-live دائمًا، قيمة غير صالحة = معطّل، ضغط مزدوج = طلب واحد", async () => {
    render(<LedgerOpening />);
    const run = screen.getByTestId("pk-run") as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("pk-amount"), { target: { value: "12.345678" } });
    expect(run.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("pk-biz"), { target: { value: "4" } });
    fireEvent.change(screen.getByTestId("pk-amount"), { target: { value: "250" } });
    fireEvent.click(run); fireEvent.click(run);
    await waitFor(() => expect(state.pkCalls).toEqual([{ businessId: 4, amount: "250", countedOn: "2026-10-01" }]));
  });
});
