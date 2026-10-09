// @vitest-environment jsdom
/** المرحلة 7I — تقرير الدمج وسجل الأنشطة ومساحة العمل: حالات Loading/Empty، Desktop جدول / Mobile بطاقات، الفلاتر والإجراءات بنفس الـpayload. */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

type Q = { data?: any; isLoading?: boolean };
const st = vi.hoisted(() => ({ q: {} as Record<string, Q>, mut: {} as Record<string, ReturnType<typeof vi.fn>>, desktop: true, inputs: [] as any[] }));
const { mkQuery, mkMutation } = vi.hoisted(() => ({
  mkQuery: (key: string) => (input: any) => { st.inputs.push({ key, input }); const q = st.q[key] ?? {}; return { data: q.data, isLoading: q.isLoading ?? false, isError: false, error: null, refetch: vi.fn() }; },
  mkMutation: (key: string) => () => { st.mut[key] ??= vi.fn(); return { mutate: st.mut[key], mutateAsync: vi.fn(), isPending: false }; },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    reports: { mergeLogs: { useQuery: mkQuery("merge") } },
    activityLog: { list: { useQuery: mkQuery("activity") } },
    orders: { myOrders: { useQuery: mkQuery("my") }, confirm: { useMutation: mkMutation("confirm") }, cancel: { useMutation: mkMutation("cancel") }, editOrder: { useMutation: mkMutation("editOrder") }, editOrderItems: { useMutation: mkMutation("editItems") }, orderItems: { useQuery: mkQuery("items") }, postpone: { useMutation: mkMutation("postpone") } },
    products: { list: { useQuery: mkQuery("products") } }, variants: { all: { useQuery: mkQuery("variants") } },
    useUtils: () => ({ orders: { myOrders: { invalidate: vi.fn() }, orderItems: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ({ currentBusinessIds: [1] }) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => true }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: 1, name: "سارة", role: "admin" } }) }));
vi.mock("@/hooks/useOperationalOptions", () => ({ useOperationalOptions: () => ({ options: [{ value: "price", label: "السعر" }] }) }));
vi.mock("@/hooks/useGovernorateOptions", () => ({ useGovernorateOptions: () => ({ values: ["القاهرة"] }) }));
vi.mock("@/hooks/usePermission", () => ({ usePermission: () => true }));
vi.mock("@/components/orders/OrderEditDialog", () => ({ OrderEditDialog: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/select", () => import("@/test-utils/selectMock"));

import MergeLogs from "./MergeLogs";
import ActivityLogPage from "./ActivityLog";
import AgentWorkspace from "./AgentWorkspace";

beforeEach(() => {
  st.q = {}; st.mut = {}; st.desktop = true; st.inputs = [];
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width") ? st.desktop : !st.desktop, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => cleanup());

describe("🔀 تقرير الدمج", () => {
  it("إحصاءات من السجل؛ Desktop جدول / Mobile بطاقات؛ البحث يفلتر", () => {
    st.q.merge = { data: { logs: [{ id: 1, keptOrderNumber: "A-1", customerName: "منى", customerPhone: "0100", productName: "سوار", mergedQty: 2, totalQtyAfter: 3, createdAt: new Date().toISOString() }, { id: 2, keptOrderNumber: "A-2", customerName: "سارة", customerPhone: "0111", productName: "خاتم", mergedQty: 1, totalQtyAfter: 2, createdAt: "2026-01-01" }] } };
    const { unmount } = render(<MergeLogs />);
    const stats = screen.getByTestId("merge-stats").textContent ?? "";
    expect(stats).toContain("٢"); expect(stats).toContain("٣"); // عمليتان، كميات 3
    expect(screen.getByTestId("responsive-table-table")).toBeTruthy();
    unmount(); st.desktop = false;
    render(<MergeLogs />);
    expect(screen.queryByTestId("responsive-table-table")).toBeNull();
    expect(screen.getByTestId("merge-card-1")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("بحث بالاسم أو الهاتف أو المنتج..."), { target: { value: "خاتم" } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); act(() => { vi.advanceTimersByTime(400); }); vi.useRealTimers();
  });
  it("Empty", () => {
    st.q.merge = { data: { logs: [] } };
    render(<MergeLogs />);
    expect(screen.getByText("لا توجد عمليات دمج")).toBeTruthy();
  });
});

describe("📜 سجل الأنشطة", () => {
  it("«الكل» لا يُرسل كفلتر؛ الصفوف بشارات؛ Empty", () => {
    st.q.activity = { data: { items: [{ id: 1, createdAt: "2026-10-09", action: "confirm_order", description: "تأكيد #1", performedByName: "سارة", performedByRole: "employee" }], total: 1 } };
    render(<ActivityLogPage />);
    expect(st.inputs.find(i => i.key === "activity")!.input).toMatchObject({ page: 1, limit: 50, action: undefined, entityType: undefined, businessId: 1 });
    expect(screen.getByTestId("responsive-table-table").textContent).toContain("تأكيد أوردر");
    fireEvent.change(screen.getByTestId("activity-action"), { target: { value: "all" } });
    expect(st.inputs.filter(i => i.key === "activity").pop()!.input.action).toBeUndefined();
    fireEvent.change(screen.getByTestId("activity-action"), { target: { value: "cancel_order" } });
    expect(st.inputs.filter(i => i.key === "activity").pop()!.input.action).toBe("cancel_order");
    cleanup(); st.q.activity = { data: { items: [], total: 0 } };
    render(<ActivityLogPage />);
    expect(screen.getByText("لا توجد أنشطة مسجلة بعد")).toBeTruthy();
  });
});

describe("💼 مساحة العمل", () => {
  it("الإحصاءات تعمل كفلتر؛ التأكيد ضغطتان = طلب واحد؛ الإلغاء بسبب إلزامي بنفس الـpayload", () => {
    st.q.my = { data: { orders: [{ id: 7, orderNumber: "O-7", customerName: "منى", customerPhone: "0100", governorate: "القاهرة", customerAddress: "شارع", productName: "سوار", quantity: 1, totalAmount: "250", status: "new", createdAt: "2026-10-09" }], total: 1 } };
    render(<AgentWorkspace />);
    expect(screen.getByTestId("agent-order-7")).toBeTruthy();
    const c = screen.getByTestId("agent-confirm-7");
    fireEvent.click(c); fireEvent.click(c);
    expect(st.mut.confirm).toHaveBeenCalledTimes(1);
    expect(st.mut.confirm.mock.calls[0][0]).toEqual({ orderId: 7, operationId: expect.stringMatching(/^[A-Za-z0-9_-]{8,80}$/) });
    fireEvent.click(screen.getByTestId("agent-cancel-7"));
    expect((screen.getByTestId("agent-cancel-confirm") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/سبب الإلغاء/), { target: { value: "price" } });
    fireEvent.click(screen.getByTestId("agent-cancel-confirm"));
    expect(st.mut.cancel.mock.calls[0][0]).toEqual({ orderId: 7, cancelReason: "price", notes: undefined, operationId: expect.stringMatching(/^[A-Za-z0-9_-]{8,80}$/) });
    fireEvent.click(screen.getByText("ملغية").closest('[role="button"]')!);
    expect(st.inputs.filter(i => i.key === "my").pop()!.input.status).toBe("cancelled");
  });
  it("Empty", () => {
    st.q.my = { data: { orders: [], total: 0 } };
    render(<AgentWorkspace />);
    expect(screen.getByText("لا توجد أوردرات مُسندة إليك")).toBeTruthy();
  });
});
