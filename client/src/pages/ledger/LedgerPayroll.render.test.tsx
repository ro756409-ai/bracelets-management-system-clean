// @vitest-environment jsdom
/**
 * «المرتبات والسلف» (المرحلة 5): غير متاحة قبل 0046/0048 برسالة واضحة؛ سطر «مراجعة» يمنع الاعتماد؛ البونص/الخصم بسبب إلزامي؛
 * حساب الصرف المُرسل = المعروض؛ الإلغاء بسبب إلزامي؛ صرف السلفة بضغط مزدوج = طلب واحد بنفس معرّف العملية.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  runs: { available: true, runs: [] as any[] } as any, detail: null as any, calls: [] as [string, any][],
  advances: { available: true, advances: [] as any[] } as any,
}));
const mut = vi.hoisted(() => (name: string, ret: any = {}) => ({ useMutation: () => ({ isPending: false, mutateAsync: async (i: any) => { state.calls.push([name, i]); await new Promise(r => setTimeout(r, 15)); return ret; } }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ ledger: { payroll: { runs: { invalidate: async () => {} }, run: { invalidate: async () => {} }, advances: { list: { invalidate: async () => {} } } } } }),
    employees: { list: { useQuery: () => ({ data: [{ id: 7, name: "سارة" }, { id: 8, name: "مينا" }] }) } },
    ledger: {
      status: { useQuery: () => ({ data: { tablesPresent: true, enabled: true } }) },
      accounts: { list: { useQuery: () => ({ data: [{ id: 1, code: "BANK_MAIN", name: "البنك", kind: "bank", isActive: 1 }, { id: 2, code: "COD_BOSTA", name: "بوسطة", kind: "carrier_receivable", isActive: 1 }] }) } },
      payroll: {
        runs: { useQuery: () => ({ data: state.runs }) },
        run: { useQuery: () => ({ data: state.detail }) },
        ensureAccounts: mut("ensure", { created: [] }),
        create: mut("create", { runId: 3, replay: false }),
        recompute: mut("recompute"), approve: mut("approve"), pay: mut("pay"), cancel: mut("cancel"), adjust: mut("adjust"),
        advances: { list: { useQuery: () => ({ data: state.advances }) }, issue: mut("issue", { advanceId: 1, replay: false }), cancel: mut("advCancel") },
      },
    },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import LedgerPayroll from "./LedgerPayroll";

const okLine = (employeeId: number, name: string) => ({ employeeId, employeeName: name, gross: "3045.0000", totalDeductions: "420.0000", net: "2625.0000", inputs: { adjustments: { bonuses: [], deductions: [] } },
  result: { status: "ok", earnings: [{ key: "base", label: "المرتب الأساسي", amount: "3000.0000" }], deductions: [{ key: "absence", label: "غياب 1 يوم", amount: "120.0000" }] } });

beforeEach(() => {
  state.calls = [];
  state.runs = { available: true, runs: [{ id: 3, period: "2026-09", status: "draft", net: "2625.0000" }] };
  state.detail = { run: { id: 3, period: "2026-09", status: "draft", gross: "3045.0000", totalDeductions: "420.0000", net: "2625.0000" }, lines: [okLine(7, "سارة")] };
  state.advances = { available: true, advances: [] };
});
afterEach(() => cleanup());

describe("💼 المرتبات والسلف", () => {
  it("قبل 0048: رسالة واضحة بلا أي قسم", () => {
    state.runs = { available: false, reason: "0048", runs: [] };
    render(<LedgerPayroll />);
    expect(screen.getByText(/جداول المرتبات \(0048\)/)).toBeTruthy();
    expect(screen.queryByTestId("ledger-payroll")).toBeNull();
  });

  it("سطر «مراجعة» يمنع الاعتماد؛ البونص بسبب ≥ 3 أحرف ومبلغ صالح فقط", async () => {
    state.detail.lines.push({ employeeId: 8, employeeName: "مينا", gross: "0.0000", totalDeductions: "0.0000", net: "0.0000", inputs: { adjustments: { bonuses: [], deductions: [] } }, result: { status: "review", reason: "2 يوم حضور يحتاج مراجعة" } });
    render(<LedgerPayroll />);
    fireEvent.click(screen.getByTestId("payroll-open-3"));
    expect(screen.getByTestId("payroll-review-count").textContent).toContain("1 سطر");
    expect((screen.getByTestId("payroll-approve") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("payroll-adjust-7"));
    fireEvent.click(screen.getByTestId("payroll-add-bonus"));
    const save = screen.getByTestId("payroll-adjust-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("سبب البونص"), { target: { value: "حافز" } });
    fireEvent.change(screen.getByLabelText("مبلغ البونص"), { target: { value: "50" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(state.calls).toContainEqual(["adjust", { runId: 3, employeeId: 7, bonuses: [{ label: "حافز", amount: "50" }], deductions: [] }]));
  });

  it("الصرف من حساب نقدي فقط (بلا ذمة بوسطة) والمُرسل = المعروض؛ الإلغاء بسبب إلزامي", async () => {
    state.detail.run.status = "approved";
    render(<LedgerPayroll />);
    fireEvent.click(screen.getByTestId("payroll-open-3"));
    expect(screen.getByTestId("payroll-from").textContent).not.toContain("بوسطة");
    fireEvent.click(screen.getByTestId("payroll-pay"));
    await waitFor(() => expect(state.calls).toContainEqual(["pay", expect.objectContaining({ runId: 3, fromAccountCode: "BANK_MAIN" })]));
    expect((screen.getByTestId("payroll-cancel") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("payroll-cancel-reason"), { target: { value: "خطأ في الحضور" } });
    await waitFor(() => expect((screen.getByTestId("payroll-cancel") as HTMLButtonElement).disabled).toBe(false)); // بعد انتهاء الصرف
    fireEvent.click(screen.getByTestId("payroll-cancel"));
    await waitFor(() => expect(state.calls).toContainEqual(["cancel", { runId: 3, reason: "خطأ في الحضور" }]));
  });

  it("السلفة: ضغط مزدوج = طلب واحد، والموظف والحساب المرسلان = المعروضان", async () => {
    render(<LedgerPayroll />);
    fireEvent.change(screen.getByTestId("adv-amount"), { target: { value: "900" } });
    const btn = screen.getByTestId("adv-issue");
    fireEvent.click(btn); fireEvent.click(btn);
    await waitFor(() => expect(state.calls.filter(c => c[0] === "issue")).toHaveLength(1));
    expect(state.calls.find(c => c[0] === "issue")![1]).toMatchObject({ employeeId: 7, principal: "900", installmentsCount: 3, fromAccountCode: "BANK_MAIN", operationId: expect.stringMatching(/^ui:/) });
  });
});
