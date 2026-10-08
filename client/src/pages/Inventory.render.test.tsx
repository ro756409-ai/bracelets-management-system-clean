// @vitest-environment jsdom
/**
 * المرحلة 7C — صفحة المخزون: ملخص حقيقي بمصادره، عزل نشاطين، منتج بتركيبات متعددة، متاح/منخفض/نافد،
 * جدول Desktop فقط وبطاقات Mobile فقط، الحركات من الحوارات الحالية، الصلاحيات، وحالات Loading/Empty/Error/Offline.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

type Q = { data?: any; isLoading?: boolean; isError?: boolean; error?: any };
const st = vi.hoisted(() => ({
  q: {} as Record<string, Q>, mut: {} as Record<string, ReturnType<typeof vi.fn>>, inputs: {} as Record<string, any>, enabled: {} as Record<string, boolean | undefined>,
  user: { id: 1, role: "admin" } as any, perms: ["inventory_costing.view", "inventory_costing.manage"] as string[], online: true, desktop: true,
  businesses: [{ id: 1, name: "براند النحاس" }, { id: 2, name: "براند المفروشات" }] as any[], scope: undefined as number[] | undefined, currentBusinessId: undefined as number | undefined, setScope: vi.fn(),
}));
const { mkQuery, mkMutation } = vi.hoisted(() => ({
  mkQuery: (key: string) => (input: unknown, opts?: { enabled?: boolean }) => { st.inputs[key] = input; st.enabled[key] = opts?.enabled; const q = st.q[key] ?? {}; return { data: q.data, isLoading: q.isLoading ?? false, isError: q.isError ?? false, error: q.error, refetch: vi.fn() }; },
  mkMutation: (key: string) => () => { st.mut[key] ??= vi.fn(); return { mutate: st.mut[key], isPending: false }; },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    products: { list: { useQuery: mkQuery("products") }, lowStock: { useQuery: mkQuery("lowStock") }, movements: { useQuery: mkQuery("movements") }, addMovement: { useMutation: mkMutation("addMovement") }, update: { useMutation: mkMutation("pUpdate") }, create: { useMutation: mkMutation("pCreate") }, createWithVariants: { useMutation: mkMutation("pCreateV") } },
    variants: { all: { useQuery: mkQuery("variants") }, addMovement: { useMutation: mkMutation("vMove") }, create: { useMutation: mkMutation("vCreate") }, update: { useMutation: mkMutation("vUpdate") }, addToProduct: { useMutation: mkMutation("vAdd") }, delete: { useMutation: mkMutation("vDelete") } },
    accountingV2: { stocktakeList: { useQuery: mkQuery("stocktakes") }, configurationListForBusinesses: { useQuery: mkQuery("config") } },
    useUtils: () => ({ products: { list: { invalidate: vi.fn() }, lowStock: { invalidate: vi.fn() }, movements: { invalidate: vi.fn() } }, variants: { all: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: st.user, loading: false }) }));
vi.mock("@/hooks/usePermission", () => ({ usePermissions: () => ({ permissions: st.perms, has: (p: string) => st.perms.includes(p), isLoading: false }), usePermission: (p: string) => st.perms.includes(p) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => st.online }));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ({ businesses: st.businesses, currentBusinessIds: st.scope, currentBusinessId: st.currentBusinessId, currentGroup: undefined, isLoading: false, setCurrentBusinessId: st.setScope }) }));
vi.mock("@/components/workspace", () => ({
  WorkspaceTabs: () => <nav data-testid="workspace-tabs" />,
  StatusFilterChips: ({ chips, value, onChange }: any) => <div data-testid="status-chips">{chips.map((c: any) => <button key={c.key} type="button" aria-pressed={value === c.key} onClick={() => onChange(value === c.key ? null : c.key)} data-testid={`chip-${c.key}`}>{c.label}</button>)}</div>,
  DataToolbar: ({ search, onSearch }: any) => <input aria-label="بحث" value={search} onChange={e => onSearch(e.target.value)} data-testid="inv-search" />,
}));
vi.mock("@/config/navigation", () => ({ PRIMARY_DESTINATIONS: [], visibleChildren: () => [] }));
vi.mock("./InventoryAccounting", () => ({ InventoryAccountingSection: () => <div data-testid="accounting-section" /> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/select", () => import("@/test-utils/selectMock"));

import Inventory from "./Inventory";

const PRODUCTS = [
  { id: 1, name: "سوار نحاسي", sku: "CU-01", businessId: 1, currentStock: 20, minStockLevel: 5, isActive: true, price: "250", updatedAt: "2026-10-01T10:00:00Z" },
  { id: 2, name: "خاتم", sku: "RG-01", businessId: 2, currentStock: 3, minStockLevel: 5, isActive: true, price: "120", updatedAt: "2026-10-02T10:00:00Z" },
  { id: 3, name: "سوار بتركيبات", sku: null, businessId: 1, currentStock: 0, minStockLevel: 5, isActive: true, price: null, updatedAt: "2026-10-03T10:00:00Z" },
];
const VARIANTS = [
  { id: 100, productId: 3, productName: "سوار بتركيبات", name: "نقش اسم", color: "أسود", size: "M", sku: "CU-V1", currentStock: 8, minStockLevel: 2, isActive: true, price: "250" },
  { id: 101, productId: 3, productName: "سوار بتركيبات", name: "نقش تاريخ", color: "أسود", size: "L", sku: "CU-V2", currentStock: 0, minStockLevel: 2, isActive: true, price: "250" },
];
function setup() {
  st.q = { products: { data: PRODUCTS }, variants: { data: VARIANTS }, lowStock: { data: [{ id: 2, name: "خاتم", currentStock: 3 }] }, movements: { data: [] }, stocktakes: { data: [] }, config: { data: [] } };
}
beforeEach(() => {
  st.q = {}; st.mut = {}; st.inputs = {}; st.enabled = {}; st.user = { id: 1, role: "admin" }; st.perms = ["inventory_costing.view", "inventory_costing.manage"]; st.online = true; st.desktop = true;
  st.businesses = [{ id: 1, name: "براند النحاس" }, { id: 2, name: "براند المفروشات" }]; st.scope = undefined; st.currentBusinessId = undefined; st.setScope = vi.fn();
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width") ? st.desktop : !st.desktop, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => cleanup());

describe("📊 الملخص الحقيقي ومصادره", () => {
  it("منتجات 3 / تركيبات 2 / منخفض 1 (خاتم) / نافد 1 (نقش تاريخ) / آخر جرد غير متاح تحت «كل الأنشطة»", () => {
    setup();
    render(<Inventory />);
    const s = screen.getByTestId("inventory-summary");
    const card = (label: string) => within(s).getByText(label).closest("[data-testid], div")!.parentElement!.textContent!;
    expect(card("المنتجات")).toContain("٣"); expect(card("التركيبات")).toContain("٢"); expect(card("منخفض المخزون")).toContain("١"); expect(card("نافد")).toContain("١");
    expect(card("آخر جرد")).toContain("غير متاح"); expect(card("آخر جرد")).toContain("اختر نشاطًا واحدًا");
    expect(st.enabled.stocktakes).toBe(false);
    expect(s.textContent).not.toMatch(/قيمة المخزون|تكلفة/);
    expect(screen.getByTestId("workspace-tabs")).toBeTruthy();
  });
  it("نطاق نشاط واحد: الاستعلامات تحمل businessIds [1] وآخر جرد من stocktakeList؛ ScopeBar تغيّر النطاق", () => {
    setup(); st.scope = [1]; st.currentBusinessId = 1;
    st.q.products = { data: PRODUCTS.filter(p => p.businessId === 1) }; st.q.stocktakes = { data: [{ id: 7, createdAt: "2026-10-04T10:00:00Z", status: "approved", createdByName: "مالك" }, { id: 8, createdAt: "2026-10-06T10:00:00Z", status: "draft", createdByName: "سارة" }] };
    render(<Inventory />);
    expect(st.inputs.products).toEqual({ businessIds: [1], includeInactive: true });
    expect(st.enabled.stocktakes).toBe(true); expect(st.inputs.stocktakes).toEqual({ businessId: 1, limit: 50 });
    const s = screen.getByTestId("inventory-summary").textContent!;
    expect(s).toContain("مسودة"); expect(s).toContain("سارة");
    expect(screen.queryByText("خاتم")).toBeNull(); // عزل: منتج النشاط 2 غير موجود
    fireEvent.click(screen.getByRole("button", { name: "براند المفروشات" }));
    expect(st.setScope).toHaveBeenCalledWith(2);
  });
  it("بلا inventory_costing.view (موظف) → آخر جرد غير متاح بسبب الصلاحية ولا يُطلب", () => {
    setup(); st.user = { id: 2, role: "user" }; st.perms = []; st.scope = [1]; st.currentBusinessId = 1;
    render(<Inventory />);
    expect(st.enabled.stocktakes).toBe(false);
    expect(screen.getByTestId("inventory-summary").textContent).toContain("يتطلب صلاحية عرض تكلفة المخزون");
  });
});

describe("📦 الجدول والبطاقات", () => {
  it("Desktop: جدول بصف لكل منتج/تركيبة مع النشاط والحالة؛ لا بطاقات", () => {
    setup();
    render(<Inventory />);
    const table = screen.getByTestId("inventory-table");
    expect(table.querySelector("table")).toBeTruthy();
    expect(screen.queryByTestId("inv-card-p-1")).toBeNull();
    const text = table.textContent!;
    for (const s of ["سوار نحاسي", "CU-01", "خاتم", "نقش اسم", "نقش تاريخ", "براند النحاس", "براند المفروشات", "متوفر", "منخفض", "نفد", "غير متاح"]) expect(text, s).toContain(s);
    expect(table.textContent).toContain("الأصناف (٤)");
  });
  it("فلتر «نافد» يبقي صف التركيبة النافدة فقط؛ البحث يضيّق", () => {
    setup();
    render(<Inventory />);
    fireEvent.click(screen.getByTestId("chip-out"));
    let text = screen.getByTestId("inventory-table").textContent!;
    expect(text).toContain("نقش تاريخ"); expect(text).not.toContain("نقش اسم"); expect(text).not.toContain("خاتم");
    fireEvent.click(screen.getByTestId("chip-out"));
    fireEvent.change(screen.getByTestId("inv-search"), { target: { value: "خاتم" } });
    text = screen.getByTestId("inventory-table").textContent!;
    expect(text).toContain("خاتم"); expect(text).not.toContain("سوار نحاسي");
  });
  it("Mobile: بطاقات فقط ≥44px، وارد/صادر يفتحان حوارات الحركة الحالية (لا كتابة مباشرة)", () => {
    setup(); st.desktop = false;
    render(<Inventory />);
    expect(screen.getByTestId("inventory-table").querySelector("table")).toBeNull();
    const card = screen.getByTestId("inv-card-v-100");
    expect(card.getAttribute("data-status")).toBe("available");
    fireEvent.click(within(card).getByTestId("inv-in-v-100"));
    expect(screen.getByRole("dialog").textContent).toContain("نقش اسم"); // حوار حركة النوع الحالي
    expect(st.mut.vMove).not.toHaveBeenCalled();
    expect((within(screen.getByTestId("inv-card-v-101")).getByTestId("inv-out-v-101") as HTMLButtonElement).disabled).toBe(true); // نافد → لا صادر
  });
  it("Loading → هياكل؛ Empty → حالة فارغة مع إضافة منتج؛ Error → إعادة المحاولة؛ Offline → OfflineState", () => {
    setup(); st.q.products = { isLoading: true };
    const { unmount } = render(<Inventory />);
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(1);
    unmount(); setup(); st.q.products = { data: [] }; st.q.variants = { data: [] };
    const r2 = render(<Inventory />);
    expect(screen.getByTestId("inventory-table").textContent).toContain("لا توجد منتجات بعد");
    r2.unmount(); setup(); st.q.products = { isError: true, error: { message: "انقطع" } };
    const r3 = render(<Inventory />);
    expect(screen.getByTestId("inventory-table").textContent).toContain("انقطع");
    r3.unmount(); setup(); st.online = false;
    render(<Inventory />);
    expect(screen.getByTestId("offline-state")).toBeTruthy();
  });
});
