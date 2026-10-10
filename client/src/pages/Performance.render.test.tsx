// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const st = vi.hoisted(() => ({ perms: [] as string[], enabled: false, team: [] as any[], mine: [] as any[], desktop: true }));
const q = (data: any) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });
vi.mock("@/lib/trpc", () => ({
  trpc: {
    performance: {
      status: { useQuery: () => q({ enabled: st.enabled }) },
      team: { useQuery: (_i: any, o: any) => q(o?.enabled ? { enabled: true, rows: st.team, minSample: 20 } : undefined) },
      mine: { useQuery: (_i: any, o: any) => q(o?.enabled ? { enabled: true, rows: st.mine, minSample: 20 } : undefined) },
    },
    employeePortal: { /* مدخل الرسائل في القشرة: العلم معطل (الافتراضي) */ messages: { status: { useQuery: () => ({ data: { enabled: false } }) }, conversations: { useQuery: () => ({ data: undefined, refetch: async () => ({}) }) } },  myPerformance: { useQuery: () => q(st.enabled ? { enabled: true, rows: st.mine } : { enabled: false }) }, me: { useQuery: () => q({ name: "سارة" }) } },
    useUtils: () => ({ performance: { exportCsv: { fetch: vi.fn() } } }),
  },
}));
vi.mock("@/hooks/usePermission", () => ({ usePermissions: () => ({ permissions: st.perms, isLoading: false, has: (p: string) => st.perms.includes(p) }) }));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ({ currentBusinessIds: [1] }) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => true }));
vi.mock("wouter", () => ({ useLocation: () => ["/x", () => {}] }));

import Performance, { PERFORMANCE_RATE_LABEL } from "./Performance";
import MyPerformance from "./MyPerformance";

const row = (p: any) => ({ employeeId: 1, employeeName: "سارة", isActive: true, decisionEligibleOrders: 25, confirmedOrders: 20, confirmationRate: 80, noAnswerOrders: 3, noAnswerAttempts: 5, postponedOrders: 1, cancelledOrders: 1, workloadOrders: 26, assignedOrders: 30, activeDays: 5, rankable: true, rank: 1, ...p });
beforeEach(() => {
  st.perms = []; st.enabled = false; st.team = []; st.mine = [];
  (window as any).matchMedia = (m: string) => ({ matches: m.includes("min-width") ? st.desktop : !st.desktop, media: m, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => cleanup());

describe("📈 أداء الموظفين (سجل الأحداث)", () => {
  it("بلا صلاحية: رفض واضح", () => {
    render(<Performance />);
    expect(screen.getByText(/عرض الأداء يحتاج صلاحية/)).toBeTruthy();
  });
  it("العلم معطل: «غير مفعّل بعد» بلا جدول ولا تصدير", () => {
    st.perms = ["employee_performance.view_all", "employee_performance.export"];
    render(<Performance />);
    expect(screen.getByTestId("performance-disabled").textContent).toContain("غير مفعّل بعد");
    expect(screen.queryByText("تصدير CSV")).toBeNull();
  });
  it("مقارنة الفريق: عنوان النسبة الدقيق، الترتيب لمن ≥ 20، وشارة العينة للأقل", () => {
    st.enabled = true; st.perms = ["employee_performance.view_all"];
    st.team = [row({}), row({ employeeId: 2, employeeName: "منى", decisionEligibleOrders: 5, confirmationRate: 100, rankable: false, rank: null })];
    render(<Performance />);
    expect(screen.getAllByText(PERFORMANCE_RATE_LABEL).length).toBeGreaterThan(0);
    expect(PERFORMANCE_RATE_LABEL).toBe("نسبة التأكيد من القرارات المسجلة");
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText("عينة أقل من 20")).toBeTruthy();
    expect(screen.queryByText("تصدير CSV")).toBeNull(); // بلا صلاحية التصدير
  });
  it("التصدير يظهر فقط بصلاحيته", () => {
    st.enabled = true; st.perms = ["employee_performance.view_all", "employee_performance.export"];
    render(<Performance />);
    expect(screen.getByText("تصدير CSV")).toBeTruthy();
  });
  it("view_self فقط: «أدائي» بلا جدول مقارنة ولا ترتيب", () => {
    st.enabled = true; st.perms = ["employee_performance.view_self"]; st.mine = [row({ rank: null })];
    render(<Performance />);
    expect(screen.getByTestId("performance-self")).toBeTruthy();
    expect(screen.queryByTestId("performance-team")).toBeNull();
    expect(screen.queryByText(/#\d/)).toBeNull();
  });
});

describe("👤 أدائي (البوابة)", () => {
  it("العلم معطل: «غير مفعّل بعد»", () => {
    render(<MyPerformance />);
    expect(screen.getByText("«أدائي» غير مفعّل بعد")).toBeTruthy();
  });
  it("مفعّل: أرقامه هو، بعنوان النسبة الدقيق، و<main> واحد", () => {
    st.enabled = true; st.mine = [row({ rank: null })];
    const { container } = render(<MyPerformance />);
    expect(screen.getByText(PERFORMANCE_RATE_LABEL)).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
    expect(container.querySelectorAll("main").length).toBe(1);
  });
});
