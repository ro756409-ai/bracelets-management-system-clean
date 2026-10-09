// @vitest-environment jsdom
/**
 * المرحلة 7G — التقارير: غير المدير ممنوع (الاستعلامات معطّلة)، الملخص من مجاميع dailyChart، الفترات تغيّر
 * الطلب، جدول الأداء (Desktop) / بطاقات (Mobile) بنِسَب السيرفر، الجداول البديلة للرسوم، وحالات Empty/Loading.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

type Q = { data?: any; isLoading?: boolean; isError?: boolean; error?: any };
const st = vi.hoisted(() => ({ q: {} as Record<string, Q>, role: "admin", desktop: true, calls: [] as any[] }));
const { mkQuery } = vi.hoisted(() => ({
  mkQuery: (key: string) => (input: any, opts: any) => { st.calls.push({ key, input, enabled: opts?.enabled }); const q = st.q[key] ?? {}; return { data: opts?.enabled === false ? undefined : q.data, isLoading: q.isLoading ?? false, isError: q.isError ?? false, error: q.error, refetch: vi.fn() }; },
}));
vi.mock("@/lib/trpc", () => ({ trpc: { reports: { employeePerformance: { useQuery: mkQuery("perf") }, cancellationReasons: { useQuery: mkQuery("cancel") }, dailyChart: { useQuery: mkQuery("chart") } } } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: 1, role: st.role }, loading: false }) }));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ({ currentBusinessIds: [1] }) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => true }));
vi.mock("recharts", () => {
  const Box = ({ children }: any) => <div data-testid="recharts">{children}</div>;
  return { ResponsiveContainer: Box, BarChart: Box, Bar: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, PieChart: Box, Pie: ({ children }: any) => <div>{children}</div>, Cell: () => null };
});

import Reports from "./Reports";

const PERF = [{ employeeId: 1, employeeName: "سارة", total: 10, confirmed: 7, cancelled: 1, postponed: 2, confirmRate: 70, cancelRate: 10 }, { employeeId: 2, employeeName: "منى", total: 4, confirmed: 1, cancelled: 2, postponed: 1, confirmRate: 25, cancelRate: 50 }];
const CANCEL = [{ reason: "price", count: 3 }, { reason: "duplicate", count: 1 }];
const CHART = [{ date: "10-08", total: 5, confirmed: 3, cancelled: 1 }, { date: "10-09", total: 7, confirmed: 4, cancelled: 2 }];
function setup() { st.q = { perf: { data: PERF }, cancel: { data: CANCEL }, chart: { data: CHART } }; }
beforeEach(() => {
  st.q = {}; st.role = "admin"; st.desktop = true; st.calls = [];
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width") ? st.desktop : !st.desktop, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => cleanup());

describe("📊 التقارير", () => {
  it("غير المدير: الاستعلامات معطّلة وحالة رفض بلا رسوم", () => {
    st.role = "user"; setup();
    render(<Reports />);
    expect(st.calls.every(c => c.enabled === false)).toBe(true);
    expect(screen.getByText("التقارير متاحة للمديرين فقط.")).toBeTruthy();
    expect(screen.queryByTestId("reports-daily-chart")).toBeNull();
  });
  it("الملخص = مجاميع dailyChart؛ الفترة تغيّر days؛ الجداول البديلة للرسوم موجودة", () => {
    setup();
    render(<Reports />);
    const sum = screen.getByTestId("reports-summary").textContent ?? "";
    expect(sum).toContain("١٢"); expect(sum).toContain("٧"); expect(sum).toContain("٣");
    expect(st.calls.find(c => c.key === "chart")!.input.days).toBe(30);
    fireEvent.click(screen.getByTestId("reports-range-week"));
    expect(st.calls.filter(c => c.key === "chart").pop()!.input.days).toBe(7);
    expect(screen.getByTestId("reports-range-week").getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByTestId("reports-daily-table")).getAllByRole("row")).toHaveLength(3);
    const cancel = within(screen.getByTestId("reports-cancel-table"));
    expect(cancel.getByText("السعر")).toBeTruthy(); expect(cancel.getByText("75%")).toBeTruthy();
    expect(screen.getByTestId("reports-cancel-chart").textContent).toContain("٤ إلغاء");
  });
  it("الأداء: Desktop جدول مرتّب بنسبة التأكيد ونِسَب السيرفر كما هي؛ Mobile بطاقات وحدها", () => {
    setup();
    const { unmount } = render(<Reports />);
    const table = screen.getByTestId("responsive-table-table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0].textContent).toContain("سارة"); expect(rows[0].textContent).toContain("70%"); expect(rows[0].textContent).toContain("10%");
    expect(rows[1].textContent).toContain("منى"); expect(rows[1].textContent).toContain("25%");
    unmount(); st.desktop = false;
    render(<Reports />);
    expect(screen.queryByTestId("responsive-table-table")).toBeNull();
    expect(screen.getByTestId("reports-perf-card-2").textContent).toContain("50%");
  });
  it("Empty / Loading", () => {
    st.q = { perf: { data: [] }, cancel: { data: [] }, chart: { data: [] } };
    const r = render(<Reports />);
    expect(screen.getByText("لا توجد بيانات كافية")).toBeTruthy();
    expect(screen.getByText("لا توجد إلغاءات في هذه الفترة")).toBeTruthy();
    expect(screen.getByText("لا توجد بيانات أداء في هذه الفترة")).toBeTruthy();
    r.unmount(); st.q = { perf: { isLoading: true }, cancel: { isLoading: true }, chart: { isLoading: true } };
    render(<Reports />);
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(2);
  });
});
