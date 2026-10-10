// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

/**
 * وضع «القراءة فقط» على صفحات حقيقية (الحضور للمالك، «حضوري» للموظف، الأداء): لا زر كتابة قابل للتفاعل
 * (مُعلَّم aria-disabled ولا يصل الضغط إلى mutate) — والقراءة/التصفية/التبويبات/التصدير تعمل؛ والوصول الكامل
 * لا يتغيّر فيه شيء. التصنيف نفسه (مصدر واحد) في lib/tenantReadOnly.
 */
const st = vi.hoisted(() => ({ access: { enforced: true, level: "read_only", reason: "expired", message: "انتهى الاشتراك — الحساب للقراءة فقط", until: null } as any, calls: [] as string[], exportFetch: vi.fn(async () => ({ enabled: true, csv: "a" })) }));
const { q, m } = vi.hoisted(() => ({
  q: (data: any) => ({ data, isLoading: false, isError: false, error: null, refetch: () => {} }),
  m: (name: string) => ({ useMutation: () => ({ mutate: () => st.calls.push(name), mutateAsync: async () => st.calls.push(name), isPending: false, variables: undefined }) }),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    tenantAccess: { status: { useQuery: () => q(st.access) } },
    auth: { logout: m("auth.logout") },
    attendance: {
      status: { useQuery: () => q({ enabled: true }) },
      team: { useQuery: () => q({ enabled: true, days: [{ id: 1, employeeId: 7, employeeName: "سارة", workDate: "2026-10-08", status: "closed", workedMinutes: 420, breakMinutes: 0, excessBreakMinutes: 0, lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, requiresReview: 0, reviewReason: null, firstInMs: 1, lastOutMs: 2, timezone: "Africa/Cairo" }], pending: [{ id: 5, employeeName: "منى", workDate: "2026-10-08", requestType: "other", reason: "سبب" }] }) },
      shifts: { useQuery: () => q({ enabled: true, rows: [] }) }, assignments: { useQuery: () => q({ enabled: true, rows: [] }) },
      review: m("review"), createShift: m("createShift"), updateShift: m("updateShift"), setShiftActive: m("setShiftActive"), assign: m("assign"), endAssignment: m("endAssignment"), adminCorrect: m("adminCorrect"),
    },
    performance: { status: { useQuery: () => q({ enabled: true }) }, team: { useQuery: () => q({ enabled: true, rows: [] }) }, mine: { useQuery: () => q({ enabled: true, rows: [] }) } },
    employees: { activeList: { useQuery: () => q([]) } },
    employeePortal: {
      attendanceMine: { useQuery: () => q({ enabled: true, days: [], requests: [{ id: 9, workDate: "2026-10-08", requestType: "other", status: "pending", reason: "x" }], open: null }) },
      attendanceMyDayEvents: { useQuery: () => q(undefined) },
      attendanceClock: m("clock"), attendanceRequestCorrection: m("request"), attendanceCancelRequest: m("cancelRequest"),
      me: { useQuery: () => q({ name: "سارة" }) },
    },
    useUtils: () => ({ attendance: { exportCsv: { fetch: st.exportFetch }, team: { invalidate: vi.fn() }, shifts: { invalidate: vi.fn() }, assignments: { invalidate: vi.fn() } }, performance: { exportCsv: { fetch: st.exportFetch } }, employeePortal: { attendanceMine: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/hooks/usePermission", () => ({ usePermissions: () => ({ permissions: [], isLoading: false, has: () => true }) }));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ({ currentBusinessIds: [1], businesses: [{ id: 1, name: "أ" }] }) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => true }));
vi.mock("wouter", () => ({ useLocation: () => ["/x", () => {}] }));
vi.mock("@/components/shared/toast", () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));

import { TenantAccessProvider } from "@/contexts/TenantAccessContext";
import { TenantAccessNotice } from "@/components/TenantAccessNotice";
import { WRITE_CONTROL_SELECTOR, isReadSafeControl, setTenantAccessLevel } from "@/lib/tenantReadOnly";
import Attendance from "./Attendance";
import MyAttendance from "./MyAttendance";
import Performance from "./Performance";

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 80)); });
const mount = async (ui: React.ReactNode) => { const r = render(<TenantAccessProvider><TenantAccessNotice />{ui}</TenantAccessProvider>); await settle(); return r; };
/** كل عنصر تفاعل مفعّل: إما آمن للقراءة أو معلَّم معطّلًا — لا ثالث. */
const interactable = () => [...document.querySelectorAll(WRITE_CONTROL_SELECTOR)].filter(e => !(e as HTMLButtonElement).disabled && e.getAttribute("aria-disabled") !== "true");
const byText = (t: string) => screen.getAllByText(t).map(e => e.closest("button,[role=button],[role=menuitem]")!).find(Boolean)! as HTMLElement;

beforeEach(() => {
  st.calls = []; st.exportFetch.mockClear();
  st.access = { enforced: true, level: "read_only", reason: "expired", message: "انتهى الاشتراك — الحساب للقراءة فقط", until: null };
  (window as any).matchMedia = (mq: string) => ({ matches: mq.includes("min-width"), media: mq, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  URL.createObjectURL = vi.fn(() => "blob:x"); URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); setTenantAccessLevel("full"); });

describe("🔒 read_only على صفحات حقيقية", () => {
  it("الحضور (المالك): كل عنصر قابل للتفاعل قراءة فقط؛ الكتابة معطّلة ولا تصل لـmutate؛ التصدير والتبويبات تعمل", async () => {
    await mount(<Attendance />);
    expect(screen.getByTestId("tenant-access-readonly").textContent).toContain("وضع القراءة فقط");
    for (const el of interactable()) expect(isReadSafeControl(el), (el.textContent || el.getAttribute("aria-label") || "").trim()).toBe(true);
    const correct = byText("تصحيح");
    expect(correct.getAttribute("aria-disabled")).toBe("true");
    expect(correct.getAttribute("title")).toBe("الحساب في وضع القراءة فقط");
    fireEvent.click(correct); await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /طلبات التصحيح/ })); await settle();
    fireEvent.click(byText("اعتماد")); await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "الورديات" })); await settle();
    fireEvent.click(screen.getByTestId("shift-new")); await settle();
    expect(screen.queryByTestId("shift-form")).toBeNull();
    expect(st.calls).toEqual([]);
    fireEvent.click(screen.getByRole("tab", { name: "لوحة الحضور" })); await settle();
    const exp = byText("تصدير CSV");
    expect(exp.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(exp); await settle();
    expect(st.exportFetch).toHaveBeenCalled();
  });

  it("«حضوري» (الموظف): أزرار الحضور وإلغاء الطلب معطّلة ولا تصل لـmutate", async () => {
    await mount(<MyAttendance />);
    const clockIn = screen.getByTestId("clock-clock_in");
    expect(clockIn.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(clockIn); fireEvent.keyDown(clockIn, { key: "Enter" }); await settle();
    fireEvent.click(byText("إلغاء")); await settle();
    expect(st.calls).toEqual([]);
    for (const el of interactable()) expect(isReadSafeControl(el)).toBe(true);
  });

  it("الأداء: الفترات والتصدير تعمل في read_only", async () => {
    await mount(<Performance />);
    const week = byText("آخر 7 أيام");
    expect(week.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(byText("آخر 30 يومًا")); await settle();
    expect(byText("آخر 30 يومًا").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(byText("تصدير CSV")); await settle();
    expect(st.exportFetch).toHaveBeenCalled();
  });

  it("الوصول الكامل أو الإنفاذ معطّل: لا تعليم ولا منع — نفس السلوك القديم", async () => {
    st.access = { enforced: false };
    await mount(<MyAttendance />);
    expect(document.querySelectorAll("[data-readonly-blocked]").length).toBe(0);
    expect(document.documentElement.hasAttribute("data-tenant-readonly")).toBe(false);
    fireEvent.click(screen.getByTestId("clock-clock_in")); await settle();
    expect(st.calls).toEqual(["clock"]);
  });

  it("blocked: شاشة كاملة (لا حارس read_only)", async () => {
    st.access = { enforced: true, level: "blocked", reason: "suspended", message: "الحساب موقوف — تواصل مع الدعم", until: null };
    await mount(<MyAttendance />);
    expect(screen.getByTestId("tenant-access-blocked")).toBeTruthy();
    expect(document.documentElement.hasAttribute("data-tenant-readonly")).toBe(false);
  });
});
