// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const st = vi.hoisted(() => ({ perms: [] as string[], enabled: false, days: [] as any[], pending: [] as any[], shifts: [] as any[], open: null as any, clockPending: false, clockCalls: [] as any[] }));
const q = (data: any) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });
const m = (extra: any = {}) => ({ mutate: vi.fn(), isPending: false, variables: undefined, ...extra });
vi.mock("@/lib/trpc", () => ({
  trpc: {
    attendance: {
      status: { useQuery: () => q({ enabled: st.enabled }) },
      team: { useQuery: (_i: any, o: any) => q(o?.enabled ? { enabled: true, days: st.days, pending: st.pending } : undefined) },
      shifts: { useQuery: (_i: any, o: any) => q(o?.enabled ? { enabled: true, rows: st.shifts } : undefined) },
      assignments: { useQuery: (_i: any, o: any) => q(o?.enabled ? { enabled: true, rows: [] } : undefined) },
      review: { useMutation: () => m() }, createShift: { useMutation: () => m() }, updateShift: { useMutation: () => m() }, setShiftActive: { useMutation: () => m() },
      assign: { useMutation: () => m() }, endAssignment: { useMutation: () => m() }, adminCorrect: { useMutation: () => m() },
    },
    employees: { activeList: { useQuery: () => q([]) } },
    employeePortal: { /* مدخل الرسائل في القشرة: العلم معطل (الافتراضي) */ messages: { status: { useQuery: () => ({ data: { enabled: false } }) }, conversations: { useQuery: () => ({ data: undefined, refetch: async () => ({}) }) } }, 
      attendanceMine: { useQuery: () => q(st.enabled ? { enabled: true, days: st.days, requests: [], open: st.open } : { enabled: false }) },
      attendanceMyDayEvents: { useQuery: () => q(undefined) },
      attendanceClock: { useMutation: () => m({ isPending: st.clockPending, mutate: (v: any) => st.clockCalls.push(v) }) },
      attendanceRequestCorrection: { useMutation: () => m() },
      attendanceCancelRequest: { useMutation: () => m() },
      me: { useQuery: () => q({ name: "سارة" }) },
    },
    useUtils: () => ({ attendance: { exportCsv: { fetch: vi.fn() }, team: { invalidate: vi.fn() }, shifts: { invalidate: vi.fn() }, assignments: { invalidate: vi.fn() } }, employeePortal: { attendanceMine: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/hooks/usePermission", () => ({ usePermissions: () => ({ permissions: st.perms, isLoading: false, has: (p: string) => st.perms.includes(p) }) }));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ({ currentBusinessIds: [1], businesses: [{ id: 1, name: "النشاط أ" }] }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/x", () => {}] }));

import Attendance from "./Attendance";
import MyAttendance from "./MyAttendance";
import { __pendingOperationScopes } from "@/lib/operationId";

const day = (p: any = {}) => ({ id: 1, employeeId: 7, employeeName: "سارة", workDate: "2026-10-08", status: "closed", workedMinutes: 420, breakMinutes: 60, excessBreakMinutes: 0, lateMinutes: 15, earlyLeaveMinutes: 0, overtimeMinutes: 0, requiresReview: 0, reviewReason: null, firstInMs: Date.parse("2026-10-08T08:15:00Z"), lastOutMs: Date.parse("2026-10-08T15:15:00Z"), timezone: "Africa/Cairo", ...p });
beforeEach(() => {
  st.perms = []; st.enabled = false; st.days = []; st.pending = []; st.shifts = []; st.open = null; st.clockPending = false; st.clockCalls = [];
  (window as any).matchMedia = (mq: string) => ({ matches: mq.includes("min-width"), media: mq, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => cleanup());

describe("🕘 الحضور — لوحة المالك", () => {
  it("بلا صلاحية: رفض واضح", () => {
    render(<Attendance />);
    expect(screen.getByText(/إدارة الحضور تحتاج صلاحية/)).toBeTruthy();
  });
  it("العلم معطل: «غير مفعّل بعد» بلا جداول ولا تصدير", () => {
    st.perms = ["attendance.view_all", "attendance.export", "attendance.manage_shifts"];
    render(<Attendance />);
    expect(screen.getByTestId("attendance-disabled").textContent).toContain("غير مفعّل بعد");
    expect(screen.queryByText("تصدير CSV")).toBeNull();
  });
  it("view_all فقط: لوحة بلا تبويبات الورديات ولا التصحيح ولا التصدير", () => {
    st.enabled = true; st.perms = ["attendance.view_all"]; st.days = [day()];
    render(<Attendance />);
    expect(screen.getByTestId("attendance-board")).toBeTruthy();
    expect(screen.queryByText("الورديات")).toBeNull();
    expect(screen.queryByText("تصحيح")).toBeNull();
    expect(screen.queryByText("تصدير CSV")).toBeNull();
    expect(screen.getAllByText("11:15").length).toBeGreaterThan(0); // بتوقيت القاهرة
  });
  it("manage_shifts فقط: الورديات بلا أي وردية جاهزة، والنموذج بلا أيام عمل محددة والدقائق اقتراح", () => {
    st.enabled = true; st.perms = ["attendance.manage_shifts"];
    render(<Attendance />);
    expect(screen.queryByTestId("attendance-board")).toBeNull();
    expect(screen.getByText("لا ورديات بعد")).toBeTruthy();
    fireEvent.click(screen.getByTestId("shift-new"));
    const form = screen.getByTestId("shift-form");
    expect(form.querySelectorAll('[data-state="checked"]').length).toBe(0);
    expect((screen.getByLabelText(/سماح التأخير/) as HTMLInputElement).value).toBe("10");
    expect(screen.getByText("اكتب اسم الوردية")).toBeTruthy();
    expect((screen.getByTestId("shift-save") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("🕘 حضوري — البوابة", () => {
  it("العلم معطل: «غير مفعّل بعد» بلا أزرار", () => {
    render(<MyAttendance />);
    expect(screen.getByTestId("my-attendance-disabled")).toBeTruthy();
    expect(screen.queryByTestId("clock-clock_in")).toBeNull();
  });
  it("الضغط المزدوج: نفس operationId، والأزرار معطلة أثناء التنفيذ", () => {
    st.enabled = true;
    const { unmount } = render(<MyAttendance />);
    fireEvent.click(screen.getByTestId("clock-clock_in"));
    fireEvent.click(screen.getByTestId("clock-clock_in"));
    expect(st.clockCalls.length).toBe(2);
    expect(st.clockCalls[0].operationId).toBe(st.clockCalls[1].operationId);
    expect(st.clockCalls[0]).not.toHaveProperty("employeeId");
    expect(__pendingOperationScopes()).toContain("attendance:clock_in:new:0");
    unmount();
    st.clockPending = true; st.open = day({ id: 3, status: "open", version: 1, lastOutMs: null });
    render(<MyAttendance />);
    expect((screen.getByTestId("clock-clock_out") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("clock-break_start") as HTMLButtonElement).disabled).toBe(true);
  });
});
