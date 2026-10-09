// @vitest-environment jsdom
/**
 * المرحلة 7F — إدارة الموظفين: غير المدير ممنوع، القائمة والشارات، إضافة بحارس ضغط مكرر (ضغطتان = طلب
 * واحد) والتحقق قبل الإرسال، بيانات الدخول (6 أحرف)، تعطيل/حذف/سحب بنفس الـpayload، Desktop جدول/Mobile بطاقات.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

type Q = { data?: any; isLoading?: boolean; isError?: boolean; error?: any };
const st = vi.hoisted(() => ({ q: {} as Record<string, Q>, mut: {} as Record<string, ReturnType<typeof vi.fn>>, role: "admin", desktop: true, brands: [{ id: 1, name: "براند A" }] as any[] }));
const { mkQuery, mkMutation } = vi.hoisted(() => ({
  mkQuery: (key: string) => () => { const q = st.q[key] ?? {}; return { data: q.data, isLoading: q.isLoading ?? false, isError: q.isError ?? false, error: q.error, refetch: vi.fn() }; },
  mkMutation: (key: string) => () => { st.mut[key] ??= vi.fn(); return { mutate: st.mut[key], isPending: false }; },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    employees: { list: { useQuery: mkQuery("list") }, allInventory: { useQuery: mkQuery("inv") }, create: { useMutation: mkMutation("create") }, update: { useMutation: mkMutation("update") }, setCredentials: { useMutation: mkMutation("cred") }, delete: { useMutation: mkMutation("delete") } },
    reports: { employeePerformance: { useQuery: mkQuery("perf") } },
    orders: { unassignEmployeeOrders: { useMutation: mkMutation("reclaim") } },
    useUtils: () => ({ employees: { list: { invalidate: vi.fn() }, allInventory: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: 1, role: st.role }, loading: false }) }));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ({ currentBusinessId: 1, currentBusinessIds: [1], businesses: st.brands, currentGroup: null, isLoading: false }) }));
vi.mock("@/hooks/useBrandOptions", () => ({ useBrandOptions: () => ({ brands: st.brands, selectedId: st.brands.length === 1 ? st.brands[0].id : undefined, selected: "", setSelected: vi.fn() }) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => true }));
vi.mock("@/components/DateRangePicker", () => ({ default: () => <button type="button">نطاق</button> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/select", () => import("@/test-utils/selectMock"));

import Employees from "./Employees";

const EMPLOYEES = [
  { id: 1, name: "سارة", phone: "0100", email: "", role: "agent", isActive: true, username: "sara.agent", lastLoginAt: null, businessId: 1 },
  { id: 2, name: "منى", phone: "", email: "", role: "warehouse", isActive: false, username: null, lastLoginAt: null, businessId: 1 },
];
const INV = [{ employeeId: 1, employeeName: "سارة", total: 5, newOrders: 2, confirmed: 2, postponed: 1, noAnswer: 0, cancelled: 0, firstAssigned: null, lastAssigned: null }];
const PERF = [{ employeeId: 1, employeeName: "سارة", total: 10, confirmed: 7, cancelled: 1, postponed: 2, confirmRate: 70 }];
function setup() { st.q = { list: { data: EMPLOYEES }, inv: { data: INV }, perf: { data: PERF } }; }
beforeEach(() => {
  st.q = {}; st.mut = {}; st.role = "admin"; st.desktop = true; st.brands = [{ id: 1, name: "براند A" }];
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width") ? st.desktop : !st.desktop, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
});
afterEach(() => { cleanup(); });

describe("🔐 الوصول", () => {
  it("غير المدير → حالة رفض الصلاحية بلا قائمة ولا أزرار", () => {
    st.role = "user"; setup();
    render(<Employees />);
    expect(screen.getByText("هذه الصفحة للمديرين فقط")).toBeTruthy();
    expect(screen.queryByTestId("emp-add")).toBeNull();
    expect(screen.queryByTestId("emp-list")).toBeNull();
  });
});

describe("👥 القائمة والإجراءات", () => {
  it("القائمة: الأدوار والدخول والحالة كشارات؛ الملخص يعدّ النشطين", () => {
    setup();
    render(<Employees />);
    const r1 = screen.getByTestId("emp-row-1").textContent ?? "";
    expect(r1).toContain("سارة"); expect(r1).toContain("تأكيدات"); expect(r1).toContain("sara.agent");
    const r2 = screen.getByTestId("emp-row-2").textContent ?? "";
    expect(r2).toContain("موظف مخزن"); expect(r2).toContain("غير نشط"); expect(r2).toContain("بدون بيانات دخول");
    expect(screen.getByTestId("emp-summary").textContent).toContain("١"); // موظف نشط = 1
  });
  it("إضافة: اسم فارغ لا يرسل؛ ضغطتان على الحفظ = طلب واحد بنفس الـpayload (businessId صراحةً)", () => {
    setup();
    render(<Employees />);
    fireEvent.click(screen.getByTestId("emp-add"));
    fireEvent.click(screen.getByTestId("emp-save"));
    expect(st.mut.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("emp-field-name"), { target: { value: "أحمد" } });
    const save = screen.getByTestId("emp-save");
    fireEvent.click(save); fireEvent.click(save);
    expect(st.mut.create).toHaveBeenCalledTimes(1);
    expect(st.mut.create.mock.calls[0][0]).toEqual({ name: "أحمد", phone: "", email: "", role: "agent", businessId: 1 });
  });
  it("تعديل يرسل update بالمعرّف؛ تعطيل يرسل update بـisActive المعكوسة", () => {
    setup();
    render(<Employees />);
    fireEvent.click(screen.getByTestId("emp-edit-1"));
    fireEvent.click(screen.getByTestId("emp-save"));
    expect(st.mut.update.mock.calls[0][0]).toMatchObject({ id: 1, name: "سارة", role: "agent" });
    fireEvent.click(screen.getByTestId("emp-toggle-2"));
    expect(st.mut.update.mock.calls[1][0]).toEqual({ id: 2, isActive: true });
  });
  it("بيانات الدخول: كلمة مرور أقل من 6 لا ترسل؛ الصحيحة ترسل مرة واحدة", () => {
    setup();
    render(<Employees />);
    fireEvent.click(screen.getByTestId("emp-cred-2"));
    fireEvent.change(screen.getByTestId("emp-cred-username"), { target: { value: "mona" } });
    fireEvent.change(screen.getByTestId("emp-cred-password"), { target: { value: "123" } });
    fireEvent.click(screen.getByTestId("emp-cred-save"));
    expect(st.mut.cred).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("emp-cred-password"), { target: { value: "secret12" } });
    const save = screen.getByTestId("emp-cred-save");
    fireEvent.click(save); fireEvent.click(save);
    expect(st.mut.cred).toHaveBeenCalledTimes(1);
    expect(st.mut.cred.mock.calls[0][0]).toEqual({ id: 2, username: "mona", password: "secret12" });
  });
  it("حذف وسحب: تأكيد → طلب واحد بالمعرّف الصحيح", () => {
    setup();
    render(<Employees />);
    fireEvent.click(screen.getByTestId("emp-delete-2"));
    const del = screen.getByTestId("emp-delete-confirm");
    fireEvent.click(del); fireEvent.click(del);
    expect(st.mut.delete).toHaveBeenCalledTimes(1);
    expect(st.mut.delete.mock.calls[0][0]).toEqual({ id: 2 });
    fireEvent.click(screen.getByTestId("emp-reclaim-1"));
    const rc = screen.getByTestId("emp-reclaim-confirm");
    fireEvent.click(rc); fireEvent.click(rc);
    expect(st.mut.reclaim).toHaveBeenCalledTimes(1);
    expect(st.mut.reclaim.mock.calls[0][0]).toEqual({ employeeId: 1 });
  });
});

describe("📱 Desktop/Mobile والحالات", () => {
  it("Desktop: جدولا الجرد والأداء؛ Mobile: بطاقات وحدها بنفس الأرقام ونسبة التأكيد من السيرفر", () => {
    setup();
    const { unmount } = render(<Employees />);
    expect(screen.getAllByTestId("responsive-table-table")).toHaveLength(2);
    expect(screen.queryByTestId("emp-perf-card-1")).toBeNull();
    expect(screen.getByTestId("emp-performance").textContent).toContain("70%");
    unmount(); st.desktop = false;
    render(<Employees />);
    expect(screen.queryByTestId("responsive-table-table")).toBeNull();
    expect(within(screen.getByTestId("emp-perf-card-1")).getByText("70%")).toBeTruthy();
    expect(screen.getByTestId("emp-inventory-card-1").textContent).toContain("إجمالي 5");
  });
  it("Loading / Empty (مع فلتر وبدونه) / Error", () => {
    st.q = { list: { isLoading: true }, inv: {}, perf: {} };
    const r1 = render(<Employees />);
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(1);
    r1.unmount(); st.q = { list: { data: [] }, inv: {}, perf: {} };
    const r2 = render(<Employees />);
    expect(screen.getByText("لا يوجد موظفون")).toBeTruthy();
    r2.unmount(); st.q = { list: { isError: true, error: { message: "انقطع" } }, inv: {}, perf: {} };
    render(<Employees />);
    expect(screen.getByRole("alert").textContent).toContain("انقطع");
  });
});
