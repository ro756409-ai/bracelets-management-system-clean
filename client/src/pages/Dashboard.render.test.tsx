// @vitest-environment jsdom
/**
 * المرحلة 7A — لوحة التحكم: ما يظهر لكل دور، عدم جلب أقسام غير مصرح بها، عدم عرض أرقام وهمية،
 * وحالات Loading/Empty/Error/Offline/Permission.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

type Q = { data?: any; isLoading?: boolean; isError?: boolean; error?: any };
const st = vi.hoisted(() => ({
  user: { id: 1, name: "مالك تجريبي", role: "admin" } as any,
  permissions: [] as string[],
  online: true,
  q: {} as Record<string, Q>,
  enabled: {} as Record<string, boolean | undefined>,
  refetch: {} as Record<string, ReturnType<typeof vi.fn>>,
  navigated: [] as string[],
}));
// داخل hoisted لأن vi.mock يُرفع إلى أعلى الملف
const { mkQuery, mkMutation } = vi.hoisted(() => ({
  mkQuery: (key: string) => (_input: unknown, opts?: { enabled?: boolean }) => {
    st.enabled[key] = opts?.enabled;
    st.refetch[key] ??= vi.fn();
    const q = st.q[key] ?? {};
    return { data: q.data, isLoading: q.isLoading ?? false, isError: q.isError ?? false, error: q.error, refetch: st.refetch[key] };
  },
  mkMutation: () => () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    reports: { dashboard: { useQuery: mkQuery("dashboard") }, dailyChart: { useQuery: mkQuery("chart") }, mergeAlert: { useQuery: mkQuery("merge") } },
    products: { lowStock: { useQuery: mkQuery("lowStock") } },
    orders: { todayConfirmed: { useQuery: mkQuery("today") } },
    broadcast: { getActive: { useQuery: mkQuery("broadcast") }, send: { useMutation: mkMutation() }, clear: { useMutation: mkMutation() } },
    seed: { init: { useMutation: mkMutation() } },
    useUtils: () => ({ broadcast: { getActive: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: st.user, loading: false }) }));
vi.mock("@/hooks/usePermission", () => ({ usePermissions: () => ({ permissions: st.permissions, has: (p: string) => st.permissions.includes(p), isLoading: false }), usePermission: (p: string) => st.permissions.includes(p) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => st.online }));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ({ businesses: [{ id: 1, name: "براند A" }, { id: 2, name: "براند B" }], currentBusinessIds: undefined, currentBusinessId: undefined, setCurrentBusinessId: vi.fn(), activeBusiness: undefined }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/dashboard", (to: string) => { st.navigated.push(to); }] }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("xlsx", () => ({ utils: { json_to_sheet: vi.fn(() => ({})), book_new: vi.fn(() => ({})), book_append_sheet: vi.fn() }, writeFile: vi.fn() }));
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="recharts">{children}</div>, BarChart: ({ children }: any) => <div>{children}</div>,
  Bar: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, Legend: () => null,
}));

import Dashboard from "./Dashboard";

const ALL = ["dashboard.view", "orders.view", "accounting.view", "employees.view", "settings.view"];
const STATS = { statusStats: [{ status: "new", count: 3 }, { status: "confirmed", count: 4 }, { status: "printed", count: 1 }, { status: "cancelled", count: 2 }, { status: "delivered", count: 5 }], governorateStats: [{ governorate: "القاهرة", count: 7 }, { governorate: "الجيزة", count: 3 }], sourceStats: [], totalRevenue: 1250, confirmedToday: 5, cancelledToday: 2, shippedToday: 6 };
const CHART = [{ date: "2026-10-01", total: 4, confirmed: 2, cancelled: 1 }, { date: "2026-10-02", total: 6, confirmed: 5, cancelled: 0 }];
const TODAY = { total: 1, orders: [{ id: 9, customerName: "منى", customerPhone: "0100", governorate: "القاهرة", productName: "سوار", totalAmount: "350", easyOrderShortId: 77, confirmedAt: "2026-10-08T10:00:00Z" }] };

beforeEach(() => {
  st.user = { id: 1, name: "مالك تجريبي", role: "admin" }; st.permissions = [...ALL]; st.online = true; st.q = {}; st.enabled = {}; st.navigated = [];
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

describe("👑 المالك (كل الصلاحيات)", () => {
  it("كل الأقسام بأرقام من الاستعلامات الحقيقية ومصدر كل رقم مكتوب؛ الاستعلامات مفعّلة", () => {
    st.q = { dashboard: { data: STATS }, chart: { data: CHART }, lowStock: { data: [{ id: 1, name: "سوار نحاسي", currentStock: 2, minStockLevel: 5 }] }, merge: { data: { hasAlert: true, count: 2 } }, today: { data: TODAY }, broadcast: { data: null } };
    render(<Dashboard />);
    expect(st.enabled.dashboard).toBe(true); expect(st.enabled.today).toBe(true); expect(st.enabled.chart).toBe(true);
    const kpis = screen.getByTestId("dashboard-kpis");
    expect(within(kpis).getByText("أوردرات الفترة").parentElement!.textContent).toContain("١٥"); // 3+4+1+2+5
    expect(within(kpis).getByText("تحتاج قرار").parentElement!.textContent).toContain("٣");
    expect(within(kpis).getByText("مؤكدة").parentElement!.textContent).toContain("٥"); // confirmed+printed
    expect(within(kpis).getByText("تم شحنها").parentElement!.textContent).toContain("٦"); // shippedToday
    expect(within(kpis).getByText("تم توصيلها").parentElement!.textContent).toContain("٥");
    expect(kpis.textContent).toContain("reports.dashboard".length ? "بحالة «جديد»" : "");
    expect(kpis.textContent).toContain("ليست نقدًا محصّلًا");
    // يحتاج انتباهك + مؤكدات اليوم + الرسم + المحافظات + المخزون + الشحن + الإجراءات + الأدوات
    expect(screen.getByLabelText("يحتاج انتباهك").textContent).toContain("طلبات تنتظر التأكيد");
    expect(screen.getByTestId("dashboard-today-confirmed").textContent).toContain("منى");
    expect(screen.getByTestId("dashboard-chart-totals").textContent).toContain("١٠"); // 4+6
    expect(screen.getByTestId("dashboard-chart-table").querySelectorAll("tbody tr")).toHaveLength(2);
    expect(screen.getByTestId("dashboard-governorates").textContent).toContain("القاهرة");
    expect(screen.getByTestId("dashboard-inventory").textContent).toContain("سوار نحاسي");
    expect(screen.getByTestId("dashboard-shipping").textContent).toContain("غير متاح");
    expect(screen.getByTestId("dashboard-collection-unavailable").textContent).not.toMatch(/[0-9٠-٩]/);
    expect(screen.getAllByTestId(/^quick-/).map(b => b.getAttribute("data-testid"))).toEqual(["quick-orders", "quick-workspace", "quick-inventory", "quick-reports", "quick-employees"]);
    expect(screen.getByTestId("dashboard-owner-tools")).toBeTruthy();
    expect(screen.getByTestId("partner-logo-easyorders")).toBeTruthy();
    // بطاقة قابلة للضغط فقط بوجهة حقيقية
    fireEvent.click(within(kpis).getByText("تحتاج قرار").closest("[role=button]")!);
    expect(st.navigated).toEqual(["/orders"]);
    expect(within(kpis).getByText("تم شحنها").closest("[role=button]")).toBeNull();
  });
});

describe("🧑‍💼 المدير الصناعي بلا accounting.view", () => {
  it("لا يُطلب reports.dashboard أصلًا؛ قسم المؤشرات PermissionDenied؛ مؤكدات اليوم (orders.view) تعمل؛ لا قسم شحن", () => {
    st.permissions = ["dashboard.view", "orders.view"]; st.q = { today: { data: TODAY }, chart: { data: CHART }, lowStock: { data: [] } };
    render(<Dashboard />);
    expect(st.enabled.dashboard).toBe(false); expect(st.enabled.today).toBe(true);
    expect(screen.queryByTestId("dashboard-kpis")).toBeNull();
    expect(screen.getAllByText("لا تملك صلاحية الوصول").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("dashboard-today-confirmed").textContent).toContain("منى");
    expect(screen.queryByTestId("dashboard-shipping")).toBeNull();
    expect(screen.getByLabelText("يحتاج انتباهك").textContent).not.toContain("طلبات تنتظر التأكيد"); // لا رقم جديد بلا الاستعلام
    expect(screen.getAllByTestId(/^quick-/).map(b => b.getAttribute("data-testid"))).toEqual(["quick-orders", "quick-workspace", "quick-inventory", "quick-reports", "quick-employees"]);
  });
});

describe("🙍 مستخدم غير مدير", () => {
  it("لا جلب لأي قسم إداري ولا أرقام؛ الإجراءات السريعة مفلترة (بلا الموظفين)", () => {
    st.user = { id: 2, name: "مستخدم", role: "user" }; st.permissions = ["orders.view"];
    render(<Dashboard />);
    for (const k of ["dashboard", "chart", "lowStock", "merge", "today", "broadcast"]) expect(st.enabled[k], k).toBe(false);
    expect(screen.queryByTestId("dashboard-kpis")).toBeNull(); expect(screen.queryByTestId("dashboard-chart")).toBeNull(); expect(screen.queryByTestId("dashboard-owner-tools")).toBeNull();
    expect(screen.getAllByTestId(/^quick-/).map(b => b.getAttribute("data-testid"))).toEqual(["quick-orders", "quick-workspace", "quick-inventory", "quick-reports"]);
  });
});

describe("⏳ Loading / Empty / Error / Offline", () => {
  it("Loading: هياكل بدل الأرقام (لا 0 وهمي)", () => {
    st.q = { dashboard: { isLoading: true }, chart: { isLoading: true }, lowStock: { isLoading: true }, today: { isLoading: true } };
    render(<Dashboard />);
    expect(screen.queryByTestId("dashboard-kpis")).toBeNull();
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(3);
  });
  it("Empty: بيانات فارغة حقيقية → حالات فارغة واضحة", () => {
    st.q = { dashboard: { data: { ...STATS, governorateStats: [] } }, chart: { data: [] }, lowStock: { data: [] }, today: { data: { total: 0, orders: [] } } };
    render(<Dashboard />);
    expect(screen.getByTestId("dashboard-chart").textContent).toContain("لا توجد بيانات كافية");
    expect(screen.getByTestId("dashboard-inventory").textContent).toContain("لا تنبيهات مخزون");
    expect(screen.getByTestId("dashboard-today-confirmed").textContent).toContain("لا توجد أوردرات مؤكدة اليوم");
    expect(screen.getByTestId("dashboard-governorates").textContent).toContain("لا توجد بيانات كافية");
  });
  it("Error عام → ErrorState مع إعادة المحاولة (refetch)؛ FORBIDDEN من السيرفر → PermissionDenied", () => {
    st.q = { dashboard: { isError: true, error: { message: "انقطع" } }, chart: { data: CHART } };
    render(<Dashboard />);
    const alert = screen.getAllByRole("alert")[0]; expect(alert.textContent).toContain("انقطع");
    fireEvent.click(within(alert).getByRole("button", { name: /إعادة المحاولة/ })); expect(st.refetch.dashboard).toHaveBeenCalled();
    cleanup();
    st.q = { dashboard: { isError: true, error: { message: "x", data: { code: "FORBIDDEN" } } } };
    render(<Dashboard />);
    expect(screen.getByText("رفض السيرفر طلب المؤشرات لهذه الجلسة.")).toBeTruthy();
  });
  it("Offline: OfflineState بدل أخطاء الشبكة، وإعادة المحاولة تستدعي كل الاستعلامات", () => {
    st.online = false; st.q = { dashboard: { isError: true, error: { message: "Failed to fetch" } }, chart: { isError: true }, lowStock: { isError: true }, today: { isError: true } };
    render(<Dashboard />);
    expect(screen.getByTestId("offline-state")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /إعادة المحاولة/ }));
    for (const k of ["dashboard", "chart", "lowStock", "today"]) expect(st.refetch[k], k).toHaveBeenCalled();
  });
});
