// @vitest-environment jsdom
/**
 * المرحلة 7C — لوحة الجرد: القائمة وبدء جلسة (ضغطتان = طلب واحد)، سطور مطابق/زيادة/عجز من أرقام السيرفر،
 * حفظ العدّ صريح (Enter/زر) برقم صحيح ≥ 0 ولا يحرّك الرصيد، لا تنفيذ بمجرد تغيير الحقل، ملخص قبل الإرسال/
 * الاعتماد عبر حوار، الاعتماد لصاحب الصلاحية فقط، وحالات Loading/Error/Empty/Offline.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

type Q = { data?: any; isLoading?: boolean; isError?: boolean; error?: any };
const st = vi.hoisted(() => ({
  q: {} as Record<string, Q>, mut: {} as Record<string, ReturnType<typeof vi.fn>>, mutOpts: {} as Record<string, any>, pending: {} as Record<string, boolean>,
  perms: [] as string[], online: true, desktop: true,
}));
const { mkQuery, mkMutation } = vi.hoisted(() => ({
  mkQuery: (key: string) => () => { const q = st.q[key] ?? {}; return { data: q.data, isLoading: q.isLoading ?? false, isError: q.isError ?? false, error: q.error, refetch: vi.fn() }; },
  mkMutation: (key: string) => (opts?: any) => { st.mut[key] ??= vi.fn(); st.mutOpts[key] = opts; return { mutate: st.mut[key], isPending: st.pending[key] ?? false }; },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    businesses: { warehouses: { useQuery: mkQuery("warehouses") } },
    products: { list: { useQuery: mkQuery("products") } },
    variants: { all: { useQuery: mkQuery("variants") } },
    accountingV2: {
      stocktakeList: { useQuery: mkQuery("list") }, stocktakeGet: { useQuery: mkQuery("get") },
      stocktakeCreate: { useMutation: mkMutation("create") }, stocktakeLineUpdate: { useMutation: mkMutation("line") },
      stocktakeSubmit: { useMutation: mkMutation("submit") }, stocktakeApprove: { useMutation: mkMutation("approve") },
    },
    useUtils: () => ({ accountingV2: { stocktakeList: { invalidate: vi.fn() }, stocktakeGet: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/hooks/usePermission", () => ({ usePermission: (p: string) => st.perms.includes(p), usePermissions: () => ({ permissions: st.perms, has: (p: string) => st.perms.includes(p), isLoading: false }) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => st.online }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/select", () => import("@/test-utils/selectMock"));

import StocktakeBoard from "./StocktakeBoard";

const LINES = [
  { id: 1, productId: 10, variantId: null, systemQuantity: 5, countedQuantity: 5, differenceQuantity: 0, unitCostSnapshot: "10.00", differenceValue: "0.00" },
  { id: 2, productId: 10, variantId: 100, systemQuantity: 3, countedQuantity: 5, differenceQuantity: 2, unitCostSnapshot: "12.00", differenceValue: "24.00" },
  { id: 3, productId: 11, variantId: null, systemQuantity: 4, countedQuantity: 3, differenceQuantity: -1, unitCostSnapshot: "7.50", differenceValue: "-7.50" },
];
const session = (status: string) => ({ id: 9, status, createdAt: "2026-10-05T10:00:00Z", createdByName: "مالك", warehouseId: 5, lines: LINES });
function setup(status = "draft") {
  st.q = {
    warehouses: { data: [{ id: 5, name: "المخزن الرئيسي", isActive: true }] },
    list: { data: [{ id: 9, createdAt: "2026-10-05T10:00:00Z", warehouseId: 5, status, createdByName: "مالك" }] },
    get: { data: session(status) },
    products: { data: [{ id: 10, name: "سوار نحاسي" }, { id: 11, name: "خاتم" }] },
    variants: { data: [{ id: 100, productId: 10, name: "نقش اسم" }] },
  };
  st.perms = ["inventory_costing.view", "inventory_costing.manage", "inventory_costing.approve"];
}
beforeEach(() => {
  st.q = {}; st.mut = {}; st.mutOpts = {}; st.pending = {}; st.online = true; st.desktop = true;
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width") ? st.desktop : !st.desktop, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => cleanup());

describe("📋 القائمة وبدء الجرد", () => {
  it("القائمة تعرض الجلسات بحالتها؛ بدء الجرد يتطلب مخزنًا وضغطتان = طلب واحد", () => {
    setup();
    render(<StocktakeBoard businessId={1} />);
    expect(screen.getByTestId("stocktake-sessions").textContent).toContain("المخزن الرئيسي");
    const btn = screen.getByTestId("stocktake-create") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("stocktake-warehouse"), { target: { value: "5" } });
    fireEvent.click(btn); fireEvent.click(btn);
    expect(st.mut.create).toHaveBeenCalledTimes(1);
    expect(st.mut.create.mock.calls[0][0]).toEqual({ businessId: 1, warehouseId: 5 });
  });
  it("بلا manage: لا بدء جرد (عرض فقط) والقائمة تبقى؛ Mobile بطاقات", () => {
    setup(); st.perms = ["inventory_costing.view"]; st.desktop = false;
    render(<StocktakeBoard businessId={1} />);
    expect(screen.queryByTestId("stocktake-create")).toBeNull();
    expect(screen.getByTestId("stocktake-readonly")).toBeTruthy();
    expect(screen.getByTestId("stocktake-card-9")).toBeTruthy();
    expect(screen.getByTestId("stocktake-sessions").querySelector("table")).toBeNull();
  });
});

describe("🔢 الجلسة: مطابق/زيادة/عجز والعدّ", () => {
  function openSession() { fireEvent.click(screen.getByTestId("stocktake-open-9")); }
  it("السطور الثلاثة بحالاتها والفروق من السيرفر؛ الملخص يعدّها ويقدّر القيم من differenceValue", () => {
    setup();
    render(<StocktakeBoard businessId={1} />);
    openSession();
    const cards = ["st-diff-1", "st-diff-2", "st-diff-3"].map(t => screen.getByTestId(t).textContent);
    expect(cards).toEqual(["0", "+2", "-1"]);
    const lines = screen.getByTestId("stocktake-lines");
    expect(within(lines).getByText("مطابق")).toBeTruthy(); expect(within(lines).getByText("زيادة")).toBeTruthy(); expect(within(lines).getByText("عجز")).toBeTruthy();
    const sum = screen.getByTestId("stocktake-summary").textContent!;
    expect(sum).toContain("٢٤٫٠٠"); expect(sum).toContain("٧٫٥٠");
    expect(lines.textContent).toContain("نقش اسم");
  });
  it("حفظ العدّ صريح: تغيير الحقل وحده لا يرسل؛ Enter يرسل countedQuantity فقط؛ سالب/كسر مرفوض؛ الإرسال معطّل مع عدّ غير محفوظ", () => {
    setup();
    render(<StocktakeBoard businessId={1} />);
    openSession();
    const input = screen.getByTestId("st-count-input-1");
    fireEvent.change(input, { target: { value: "7" } });
    expect(st.mut.line).not.toHaveBeenCalled();
    expect((screen.getByTestId("stocktake-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(st.mut.line).toHaveBeenCalledWith({ businessId: 1, stocktakeId: 9, lineId: 1, countedQuantity: 7 });
    expect(st.mut.line.mock.calls[0][0]).not.toHaveProperty("currentStock");
    const input3 = screen.getByTestId("st-count-input-3");
    fireEvent.change(input3, { target: { value: "-1" } }); fireEvent.click(screen.getByTestId("st-count-save-3"));
    expect(st.mut.line).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("stocktake-lines").textContent).toContain("رقم صحيح مش سالب");
    fireEvent.change(input3, { target: { value: "2.5" } }); fireEvent.click(screen.getByTestId("st-count-save-3"));
    expect(st.mut.line).toHaveBeenCalledTimes(1);
  });
  it("إرسال للاعتماد عبر حوار يعرض الملخص؛ لا يُنفَّذ شيء قبل التأكيد؛ ضغطتان = طلب واحد", () => {
    setup();
    render(<StocktakeBoard businessId={1} />);
    openSession();
    fireEvent.click(screen.getByTestId("stocktake-submit"));
    const dlg = screen.getByTestId("stocktake-confirm-dialog");
    expect(dlg.textContent).toContain("عجز"); expect(dlg.textContent).toContain("زيادة"); expect(dlg.textContent).toContain("مطابق");
    expect(st.mut.submit).not.toHaveBeenCalled();
    const ok = within(dlg).getByTestId("stocktake-submit-confirm");
    fireEvent.click(ok); fireEvent.click(ok);
    expect(st.mut.submit).toHaveBeenCalledTimes(1);
    expect(st.mut.submit.mock.calls[0][0]).toEqual({ businessId: 1, stocktakeId: 9 });
  });
  it("جلسة معلّقة: لا إدخال للعدّ؛ الاعتماد يظهر لصاحب approve فقط ويحتاج تأكيدًا", () => {
    setup("pending_approval");
    const { unmount } = render(<StocktakeBoard businessId={1} />);
    openSession();
    expect(screen.queryByTestId("st-count-input-1")).toBeNull();
    expect(screen.getByTestId("st-counted-1").textContent).toBe("5");
    fireEvent.click(screen.getByTestId("stocktake-approve"));
    fireEvent.click(screen.getByTestId("stocktake-approve-confirm"));
    expect(st.mut.approve.mock.calls[0][0]).toEqual({ businessId: 1, stocktakeId: 9 });
    unmount(); setup("pending_approval"); st.perms = ["inventory_costing.view", "inventory_costing.manage"];
    render(<StocktakeBoard businessId={1} />);
    openSession();
    expect(screen.queryByTestId("stocktake-approve")).toBeNull();
  });
  it("جلسة معتمدة: عرض فقط بلا شريط إجراءات", () => {
    setup("approved");
    render(<StocktakeBoard businessId={1} />);
    openSession();
    expect(screen.queryByTestId("stocktake-submit")).toBeNull(); expect(screen.queryByTestId("stocktake-approve")).toBeNull();
    expect(screen.queryByTestId("st-count-input-1")).toBeNull();
  });
  it("Mobile: بطاقات السطور مع حالة السطر", () => {
    setup(); st.desktop = false;
    render(<StocktakeBoard businessId={1} />);
    fireEvent.click(screen.getByTestId("stocktake-open-m-9"));
    expect(screen.getByTestId("st-card-3").getAttribute("data-state")).toBe("shortage");
    expect(screen.getByTestId("stocktake-lines").querySelector("table")).toBeNull();
  });
});

describe("⏳ Loading / Error / Empty / Offline", () => {
  it("الجلسة: تحميل → status؛ خطأ → ErrorState مع إعادة المحاولة؛ بلا بيانات → EmptyState", () => {
    setup(); st.q.get = { isLoading: true };
    const { unmount } = render(<StocktakeBoard businessId={1} />);
    fireEvent.click(screen.getByTestId("stocktake-open-9"));
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(1);
    unmount(); setup(); st.q.get = { isError: true, error: { message: "انقطع" } };
    const r2 = render(<StocktakeBoard businessId={1} />);
    fireEvent.click(screen.getByTestId("stocktake-open-9"));
    expect(screen.getByRole("alert").textContent).toContain("انقطع");
    r2.unmount(); setup(); st.q.get = { data: undefined };
    render(<StocktakeBoard businessId={1} />);
    fireEvent.click(screen.getByTestId("stocktake-open-9"));
    expect(screen.getByText("الجلسة مش موجودة")).toBeTruthy();
  });
  it("القائمة فارغة → EmptyState؛ Offline → OfflineState", () => {
    setup(); st.q.list = { data: [] };
    const { unmount } = render(<StocktakeBoard businessId={1} />);
    expect(screen.getByTestId("stocktake-sessions").textContent).toContain("مفيش جلسات جرد");
    unmount(); setup(); st.online = false;
    render(<StocktakeBoard businessId={1} />);
    expect(screen.getByTestId("offline-state")).toBeTruthy();
  });
});
