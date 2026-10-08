// @vitest-environment jsdom
/**
 * المرحلة 7C — استلام البضاعة: ثلاث خطوات في الصفحة نفسها، استلام كمية صحيحة (payload كما كان)، رفض الصفر
 * والسالب مع بقاء السطور، ضغطتان = طلب واحد، بقاء البيانات عند خطأ السيرفر، نتيجة الحفظ ظاهرة،
 * الصلاحيات (manage/approve)، والقائمة جدول Desktop/بطاقات Mobile.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";

type Q = { data?: any; isLoading?: boolean; isError?: boolean; error?: any };
const st = vi.hoisted(() => ({
  q: {} as Record<string, Q>, mut: {} as Record<string, ReturnType<typeof vi.fn>>, mutOpts: {} as Record<string, any>, pending: {} as Record<string, boolean>,
  inputs: {} as Record<string, any>, perms: [] as string[], online: true, desktop: true,
  businesses: [{ id: 1, name: "براند النحاس" }] as any[],
}));
const { mkQuery, mkMutation } = vi.hoisted(() => ({
  mkQuery: (key: string) => (input: unknown) => { st.inputs[key] = input; const q = st.q[key] ?? {}; return { data: q.data, isLoading: q.isLoading ?? false, isError: q.isError ?? false, error: q.error, isFetching: false, refetch: vi.fn(async () => ({ data: q.data })) }; },
  mkMutation: (key: string) => (opts?: any) => { st.mut[key] ??= vi.fn(); st.mutOpts[key] = opts; return { mutate: st.mut[key], isPending: st.pending[key] ?? false }; },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    businesses: { warehouses: { useQuery: mkQuery("warehouses") }, createWarehouse: { useMutation: mkMutation("createWarehouse") } },
    products: { list: { useQuery: mkQuery("products") } },
    variants: { all: { useQuery: mkQuery("variants") } },
    accountingV2: {
      inventoryControlData: { useQuery: mkQuery("control") },
      purchaseReceiptCreate: { useMutation: mkMutation("create") }, purchaseReceiptSubmit: { useMutation: mkMutation("submit") },
      purchaseReceiptApprove: { useMutation: mkMutation("approve") }, purchaseReceiptVoid: { useMutation: mkMutation("void") },
    },
    useUtils: () => ({ products: { list: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ({ businesses: st.businesses, currentBusinessIds: st.businesses.map(b => b.id), currentBusinessId: undefined, currentGroup: undefined, isLoading: false, setCurrentBusinessId: vi.fn() }) }));
vi.mock("@/hooks/usePermission", () => ({ usePermission: (p: string) => st.perms.includes(p), usePermissions: () => ({ permissions: st.perms, has: (p: string) => st.perms.includes(p), isLoading: false }) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => st.online }));
vi.mock("wouter", () => ({ useLocation: () => ["/goods-receipt", vi.fn()] }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/ui/select", () => import("@/test-utils/selectMock"));

import GoodsReceipt from "./GoodsReceipt";

const PRODUCTS = [{ id: 10, name: "سوار نحاسي", businessId: 1 }, { id: 11, name: "خاتم", businessId: 1 }];
const VARIANTS = [{ id: 100, productId: 10, name: "نقش اسم", color: null, size: null }, { id: 101, productId: 10, name: "نقش تاريخ", color: null, size: null }];
const RECEIPTS = [
  { id: 1, receiptDate: "2026-10-01", supplierName: "ورشة أ", totalAmount: "300.00", status: "draft" },
  { id: 2, receiptDate: "2026-10-02", supplierName: "ورشة ب", totalAmount: "120.00", status: "pending_approval" },
  { id: 3, receiptDate: "2026-10-03", supplierName: "ورشة ج", totalAmount: "500.00", status: "approved" },
];
function setup() {
  st.q = { warehouses: { data: [{ id: 5, name: "المخزن الرئيسي", isActive: true }] }, products: { data: PRODUCTS }, variants: { data: VARIANTS }, control: { data: { receipts: RECEIPTS } } };
  st.perms = ["inventory_costing.view", "inventory_costing.manage", "inventory_costing.approve"];
}
const setVal = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
function fillHeader() {
  setVal(document.getElementById("gr-warehouse")!, "5");
  setVal(document.getElementById("gr-workshop")!, "ورشة أ");
}

beforeEach(() => {
  st.q = {}; st.mut = {}; st.mutOpts = {}; st.pending = {}; st.inputs = {}; st.online = true; st.desktop = true; st.businesses = [{ id: 1, name: "براند النحاس" }];
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width") ? st.desktop : !st.desktop, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  (window as any).requestAnimationFrame = (cb: () => void) => { cb(); return 0; };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

describe("🧭 الخطوات والصلاحيات", () => {
  it("ثلاث خطوات مرقّمة + قائمة الاستلامات؛ نشاط واحد يُختار تلقائيًا ويظهر اسمه", () => {
    setup();
    render(<GoodsReceipt />);
    for (const t of ["receipt-step-1", "receipt-step-2", "receipt-step-3", "receipt-list"]) expect(screen.getByTestId(t)).toBeTruthy();
    expect(screen.getByTestId("gr-business-single").textContent).toBe("براند النحاس");
    expect(st.inputs.control).toEqual({ businessId: 1 });
  });
  it("بلا inventory_costing.manage → لا نموذج (PermissionDenied) والقائمة تبقى؛ بلا approve → لا أزرار اعتماد/إلغاء", () => {
    setup(); st.perms = ["inventory_costing.view"];
    render(<GoodsReceipt />);
    expect(screen.queryByTestId("receipt-step-2")).toBeNull();
    expect(screen.getByText("لا تملك صلاحية الوصول")).toBeTruthy();
    expect(screen.getByTestId("receipt-list").textContent).toContain("ورشة أ");
    expect(screen.queryByTestId("receipt-approve-2")).toBeNull(); expect(screen.queryByTestId("receipt-void-1")).toBeNull(); expect(screen.queryByTestId("receipt-submit-1")).toBeNull();
  });
  it("المالك/المدير (approve): إرسال للمسودة، اعتماد للمعلّق، إلغاء بسبب إلزامي عبر حوار (نفس voidMutation)", () => {
    setup();
    render(<GoodsReceipt />);
    fireEvent.click(screen.getByTestId("receipt-submit-1")); expect(st.mut.submit).toHaveBeenCalledWith({ businessId: 1, receiptId: 1 });
    fireEvent.click(screen.getByTestId("receipt-approve-2")); expect(st.mut.approve).toHaveBeenCalledWith({ businessId: 1, receiptId: 2 });
    fireEvent.click(screen.getByTestId("receipt-void-3"));
    const dlg = screen.getByTestId("receipt-void-dialog");
    expect((within(dlg).getByTestId("receipt-void-confirm") as HTMLButtonElement).disabled).toBe(true);
    setVal(within(dlg).getByLabelText(/سبب الإلغاء/), "تالف");
    fireEvent.click(within(dlg).getByTestId("receipt-void-confirm"));
    expect(st.mut.void).toHaveBeenCalledWith({ businessId: 1, receiptId: 3, reason: "تالف" });
  });
});

describe("🧾 الاستلام والتحقق", () => {
  it("كمية صحيحة: سطر سادة 3×10 + محفور 2×12 بنوع → payload بسطرين كما كان، المراجعة تعرضهما، ونتيجة الحفظ تظهر", () => {
    setup();
    render(<GoodsReceipt />);
    fillHeader();
    setVal(screen.getByTestId("receipt-product-0"), "10");
    setVal(screen.getByTestId("receipt-plain-qty-0"), "3"); setVal(screen.getByTestId("receipt-plain-cost-0"), "10");
    setVal(screen.getByTestId("receipt-variant-0"), "100");
    setVal(screen.getByTestId("receipt-eng-qty-0"), "2"); setVal(screen.getByTestId("receipt-eng-cost-0"), "12");
    const review = screen.getByTestId("receipt-review");
    expect(review.textContent).toContain("سادة"); expect(review.textContent).toContain("نقش اسم");
    expect(screen.getByTestId("receipt-pieces").textContent).toBe("5");
    fireEvent.click(screen.getByTestId("receipt-save"));
    expect(st.mut.create).toHaveBeenCalledTimes(1);
    const p = st.mut.create.mock.calls[0][0];
    expect(p.items).toEqual([{ productId: 10, quantity: 3, unitCost: "10.0000" }, { productId: 10, variantId: 100, quantity: 2, unitCost: "12.0000" }]);
    expect(p.supplierName).toBe("ورشة أ"); expect(p.warehouseId).toBe(5); expect(p.receiptType).toBe("purchase"); expect(p.businessId).toBe(1);
    // نجاح الحفظ → رسالة نتيجة واضحة
    act(() => { st.mutOpts.create.onSuccess(); });
    expect(screen.getByTestId("receipt-saved-notice").textContent).toContain("ورشة أ");
  });
  it("كمية صفر → خطأ مرتبط بالسطر، لا طلب، والقيم باقية", () => {
    setup();
    render(<GoodsReceipt />);
    fillHeader(); setVal(screen.getByTestId("receipt-product-0"), "10");
    fireEvent.click(screen.getByTestId("receipt-save"));
    expect(st.mut.create).not.toHaveBeenCalled();
    expect(screen.getByTestId("receipt-line-0").textContent).toContain("اكتب كمية سادة أو محفور");
    expect(screen.getByTestId("receipt-errors").textContent).toContain("صنف 1");
    expect((document.getElementById("gr-workshop") as HTMLInputElement).value).toBe("ورشة أ");
  });
  it("كمية سالبة → مرفوضة؛ محفور بلا نوع → مرفوض", () => {
    setup();
    render(<GoodsReceipt />);
    fillHeader(); setVal(screen.getByTestId("receipt-product-0"), "10");
    setVal(screen.getByTestId("receipt-plain-qty-0"), "-2");
    fireEvent.click(screen.getByTestId("receipt-save"));
    expect(st.mut.create).not.toHaveBeenCalled();
    expect(screen.getByTestId("receipt-line-0").textContent).toContain("الكمية ماتكونش بالسالب");
    setVal(screen.getByTestId("receipt-plain-qty-0"), "0"); setVal(screen.getByTestId("receipt-eng-qty-0"), "2");
    fireEvent.click(screen.getByTestId("receipt-save"));
    expect(st.mut.create).not.toHaveBeenCalled();
    expect(screen.getByTestId("receipt-line-0").textContent).toContain("اختار نوع الحفر");
  });
  it("ضغطتان سريعتان → طلب واحد؛ خطأ من السيرفر لا يفرّغ السطور", () => {
    setup();
    render(<GoodsReceipt />);
    fillHeader(); setVal(screen.getByTestId("receipt-product-0"), "11"); setVal(screen.getByTestId("receipt-plain-qty-0"), "4");
    const save = screen.getByTestId("receipt-save");
    fireEvent.click(save); fireEvent.click(save);
    expect(st.mut.create).toHaveBeenCalledTimes(1);
    act(() => { st.mutOpts.create.onError(new Error("رفض السيرفر")); });
    expect((screen.getByTestId("receipt-plain-qty-0") as HTMLInputElement).value).toBe("4");
    expect((screen.getByTestId("receipt-product-0") as HTMLSelectElement).value).toBe("11");
  });
  it("حقول الكمية numeric والتكلفة decimal", () => {
    setup();
    render(<GoodsReceipt />);
    expect(screen.getByTestId("receipt-plain-qty-0").getAttribute("inputmode")).toBe("numeric");
    expect(screen.getByTestId("receipt-plain-cost-0").getAttribute("inputmode")).toBe("decimal");
  });
});

describe("📱 القائمة والحالات", () => {
  it("Desktop: جدول؛ Mobile: بطاقات فقط", () => {
    setup();
    const { unmount } = render(<GoodsReceipt />);
    expect(screen.getByTestId("receipt-list").querySelector("table")).toBeTruthy();
    expect(screen.queryByTestId("receipt-card-1")).toBeNull();
    unmount(); st.desktop = false;
    render(<GoodsReceipt />);
    expect(screen.getByTestId("receipt-list").querySelector("table")).toBeNull();
    expect(screen.getByTestId("receipt-card-1")).toBeTruthy();
  });
  it("Loading/Empty/Error/Offline للقائمة", () => {
    setup(); st.q.control = { isLoading: true };
    const { unmount } = render(<GoodsReceipt />);
    expect(within(screen.getByTestId("receipt-list")).getAllByRole("status").length).toBeGreaterThanOrEqual(1);
    unmount(); setup(); st.q.control = { data: { receipts: [] } };
    const r2 = render(<GoodsReceipt />);
    expect(screen.getByTestId("receipt-list").textContent).toContain("مفيش استلامات لسه");
    r2.unmount(); setup(); st.q.control = { isError: true, error: { message: "انقطع" } };
    const r3 = render(<GoodsReceipt />);
    expect(screen.getByTestId("receipt-list").textContent).toContain("انقطع");
    r3.unmount(); setup(); st.online = false;
    render(<GoodsReceipt />);
    expect(screen.getByTestId("offline-state")).toBeTruthy();
  });
});
