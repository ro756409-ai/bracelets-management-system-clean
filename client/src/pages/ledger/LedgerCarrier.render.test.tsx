// @vitest-environment jsdom
/** تسوية شركة الشحن (المرحلة 3): معاينة بنفس المحلل، ضغط مزدوج = طلب واحد، حالة كل سطر بسببها، والتحويل بمبلغ يكتبه المستخدم. */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({ settleCalls: [] as any[], payoutCalls: [] as any[], result: null as any, refunds: [] as any[], refundError: null as any, payCalls: [] as any[], retainCalls: [] as any[], invalidated: 0 }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ ledger: { refunds: { list: { invalidate: async () => { state.invalidated++; } } } } }),
    ledger: {
      refunds: {
        list: { useQuery: () => ({ data: state.refunds, error: state.refundError }) },
        pay: { useMutation: () => ({ mutateAsync: async (i: any) => { state.payCalls.push(i); return { replay: false }; } }) },
        retain: { useMutation: () => ({ mutateAsync: async (i: any) => { state.retainCalls.push(i); return { replay: false }; } }) },
      },
      status: { useQuery: () => ({ data: { tablesPresent: true, enabled: true } }) },
      accounts: { list: { useQuery: () => ({ data: [{ id: 1, code: "BANK_MAIN", name: "البنك", kind: "bank" }, { id: 2, code: "COD_BOSTA", name: "بوسطة", kind: "carrier_receivable" }] }) } },
      carrier: {
        settle: { useMutation: () => ({ mutateAsync: async (i: any) => { state.settleCalls.push(i); await new Promise(r => setTimeout(r, 20)); return state.result; }, isPending: false }) },
        payout: { useMutation: () => ({ mutateAsync: async (i: any) => { state.payoutCalls.push(i); return { replay: false }; }, isPending: false }) },
      },
    },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import LedgerCarrier from "./LedgerCarrier";

beforeEach(() => {
  state.settleCalls = []; state.payoutCalls = []; state.refunds = []; state.refundError = null; state.payCalls = []; state.retainCalls = []; state.invalidated = 0;
  state.result = { statementRef: "ST-1", outcomes: [{ row: 2, shipment: "S1", status: "posted" }, { row: 3, shipment: "S9", status: "review", reason: "أكثر من أوردر بنفس الشحنة" }], expectedPayout: "700.0000", negativeNet: null, lines: 1, payoutTransactionId: null, parseErrors: [] };
});
afterEach(() => cleanup());

describe("🚛 تسوية شركة الشحن", () => {
  it("المعاينة المحلية بنفس المحلل، والتسوية بطلب واحد، وحالة كل سطر بسببه، ثم التحويل بمبلغ يكتبه المستخدم", async () => {
    render(<LedgerCarrier />);
    fireEvent.change(screen.getByTestId("carrier-ref"), { target: { value: "ST-1" } });
    fireEvent.change(screen.getByTestId("carrier-csv"), { target: { value: "shipment,cod,fees,net\nS1,750,50,700\nS9,100,5,90" } });
    expect(screen.getByTestId("carrier-preview").textContent).toContain("1 سطر صالح");
    expect(screen.getByTestId("carrier-preview").textContent).toContain("غير متسقة");
    const btn = screen.getByTestId("carrier-settle");
    fireEvent.click(btn); fireEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId("carrier-result")).toBeTruthy());
    expect(state.settleCalls).toHaveLength(1);
    expect(screen.getByTestId("carrier-line-3").textContent).toContain("أكثر من أوردر");
    expect(screen.getByTestId("carrier-expected").textContent).toContain("٧٠٠");
    expect((screen.getByTestId("carrier-pay-amount") as HTMLInputElement).value).toBe(""); // لا تعبئة مسبقة
    fireEvent.change(screen.getByTestId("carrier-pay-amount"), { target: { value: "700" } });
    fireEvent.click(screen.getByTestId("carrier-pay-run"));
    await waitFor(() => expect(state.payoutCalls).toEqual([expect.objectContaining({ statementRef: "ST-1", amount: "700", accountCode: "BANK_MAIN" })]));
    // حساب الاستلام نقدي فقط (لا COD)
    expect(screen.getByTestId("carrier-pay-account").textContent).not.toContain("بوسطة");
  });

  it("مبالغ مستحقة للعملاء: الرد من خزنة بالمبلغ القائم، والاحتجاز يتطلب سببًا؛ ونطاق نشاط واحد (رفض السيرفر) = القسم مخفي", async () => {
    state.refunds = [{ orderId: 7, orderNumber: "A-7", businessId: 1, outstanding: "500.0000" }];
    render(<LedgerCarrier />);
    expect(screen.getByTestId("refund-7").textContent).toContain("A-7");
    fireEvent.click(screen.getByTestId("refund-pay-7"));
    fireEvent.click(screen.getByTestId("refund-run"));
    await waitFor(() => expect(state.payCalls).toEqual([expect.objectContaining({ orderId: 7, amount: "500.0000", accountCode: "BANK_MAIN" })]));
    expect(state.invalidated).toBe(1);
    fireEvent.click(screen.getByTestId("refund-retain-7"));
    expect((screen.getByTestId("refund-run") as HTMLButtonElement).disabled).toBe(true); // بلا سبب
    fireEvent.change(screen.getByLabelText("السبب (إلزامي)"), { target: { value: "شحن المرتجع على العميل" } });
    fireEvent.click(screen.getByTestId("refund-run"));
    await waitFor(() => expect(state.retainCalls).toEqual([expect.objectContaining({ orderId: 7, reason: "شحن المرتجع على العميل" })]));
    cleanup();
    state.refundError = { data: { code: "FORBIDDEN" } };
    render(<LedgerCarrier />);
    expect(screen.queryByTestId("refunds")).toBeNull();
  });
});
