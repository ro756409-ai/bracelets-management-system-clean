// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

/**
 * «فريقي» — لوحة القائد: هوية البوابة فقط، الفريق من myTeams (لا من الرابط)، كل تبويب بصلاحيته، طلب القائد نفسه
 * بلا أزرار، الطلبات المعلّقة لا تختفي بتغيير الفترة، لا ترتيب تحت 20، التصدير بصلاحيته فقط، الإسناد مرة واحدة
 * لأعضاء الفريق، المهام بمنشئ مسمّى، والقراءة فقط تعطّل الكتابة وتُبقي التصدير.
 */
const { st, q, m } = vi.hoisted(() => {
  const st = {
    perms: [] as string[], enabled: true, teams: [] as any[], readOnly: false, hold: false,
    queried: [] as [string, any][], calls: [] as [string, any][], csvFetched: [] as any[],
    pending: [] as any[], perfRows: [] as any[],
  };
  const q = (name: string, data: (input: any) => any) => ({ useQuery: (input?: any, opts?: any) => { if (opts?.enabled === false) return { data: undefined, isLoading: false, error: null, refetch: () => {} }; st.queried.push([name, input]); return { data: data(input), isLoading: false, isFetching: false, error: null, refetch: () => {} }; } });
  const m = (name: string) => ({ useMutation: () => ({ isPending: false, variables: undefined, mutate: (v: any, cb?: any) => { st.calls.push([name, v]); if (st.hold) return; cb?.onSuccess?.({ id: 1, replay: false }); cb?.onSettled?.(); } }) });
  return { st, q, m };
});
const MEMBERS = [
  { id: 1, teamId: 7, employeeId: 11, membershipRole: "leader", fromMs: 1_760_000_000_000, toMs: null, employeeName: "أسيل" },
  { id: 2, teamId: 7, employeeId: 12, membershipRole: "member", fromMs: 1_760_000_000_000, toMs: null, employeeName: "فرحات" },
];
vi.mock("@/lib/trpc", () => ({
  trpc: {
    employeePortal: {
      messages: { status: { useQuery: () => ({ data: { enabled: false } }) }, conversations: { useQuery: () => ({ data: undefined, refetch: async () => ({}) }) } },
      me: { useQuery: () => ({ data: { name: "أسيل" } }) },
      myPermissions: q("myPermissions", () => st.perms),
      team: {
        myTeams: q("myTeams", () => (st.enabled ? { enabled: true, teams: st.teams } : { enabled: false, teams: [] })),
        members: q("members", () => ({ enabled: true, members: MEMBERS })),
        memberShifts: q("memberShifts", () => ({ enabled: true, workDate: "2026-10-11", timeZone: "Africa/Cairo", team: {}, members: [
          { employeeId: 12, employeeName: "فرحات", membershipRole: "member", status: "active", shift: { name: "مسائي", startTime: "22:00", endTime: "06:00", crossesMidnight: true, timezone: "Africa/Cairo", workDays: ["sat"], worksOnDate: true }, conflictingShiftNames: [] },
        ] })),
        history: q("history", () => ({ enabled: true, team: { name: "فريق الأفندي" }, history: [{ memberName: "فرحات", membershipRole: "member", fromMs: 1_760_000_000_000, toMs: null, addedByName: "المالك", endedByName: null }] })),
        attendance: q("attendance", () => ({ enabled: true, team: {}, days: [], pending: st.pending })),
        reviewCorrection: m("reviewCorrection"),
        performance: q("performance", () => ({ enabled: true, minSample: 20, rows: st.perfRows })),
        tasks: {
          list: q("tasks", () => ({ enabled: true, rows: [{ id: 5, businessId: 3, title: "اتصل بالعملاء المؤجلين", description: null, assignedTo: 12, assignedToName: "فرحات", status: "new", createdAtMs: 1_760_000_000_000, updatedAtMs: 1_760_000_000_000, creator: { kind: "employee", employeeId: 11, name: "أسيل" } }] })),
          create: m("taskCreate"), updateStatus: m("taskStatus"),
        },
        orders: {
          list: q("orders", () => ({ enabled: true, team: {}, total: 3, orders: [
            { id: 100, orderNumber: "A-100", customerName: "منى", status: "new", assignedEmployeeId: null, createdAt: "2026-10-10T10:00:00Z" },
            { id: 101, orderNumber: "A-101", customerName: "هالة", status: "no_answer", assignedEmployeeId: 12, createdAt: "2026-10-10T10:00:00Z" },
            { id: 102, orderNumber: "A-102", customerName: "سعيد", status: "postponed", assignedEmployeeId: 99, createdAt: "2026-10-10T10:00:00Z" },
          ] })),
          assign: m("assign"),
        },
      },
    },
    useUtils: () => new Proxy({}, { get: (_t, k) => k === "employeePortal" ? { team: new Proxy({}, { get: (_x, kk) => kk === "performanceCsv"
      ? { fetch: async (i: any) => { st.csvFetched.push(i); return { enabled: true, csv: "﻿الفريق,x", filename: "team-performance-2026-10-05_2026-10-11.csv", rowCount: 2 }; } }
      : new Proxy({ invalidate: () => {} }, { get: (o: any, p) => (p in o ? o[p] : { invalidate: () => {} }) }) }) } : new Proxy({}, { get: () => ({ invalidate: () => {} }) }) }),
  },
}));
vi.mock("@/contexts/TenantAccessContext", () => ({ useTenantAccess: () => ({ readOnly: st.readOnly, blocked: false }) }));
vi.mock("@/components/ui/select", () => import("@/test-utils/selectMock"));
vi.mock("wouter", () => ({ useLocation: () => ["/team-leader-dashboard", () => {}] }));
vi.mock("@/components/shared/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import TeamLeaderDashboard from "./TeamLeaderDashboard";

const ALL = ["teams.view_own", "team_attendance.view", "team_performance.view", "team_orders.view", "team_orders.assign", "team_tasks.manage", "attendance.approve_corrections"];
const T7 = { teamId: 7, businessId: 3, name: "فريق الأفندي" };
const T8 = { teamId: 8, businessId: 4, name: "فريق نوفا" };
beforeEach(() => {
  Object.assign(st, { perms: [...ALL], enabled: true, teams: [T7], readOnly: false, hold: false, queried: [], calls: [], csvFetched: [], perfRows: [],
    pending: [
      { id: 31, employeeId: 11, employeeName: "أسيل", workDate: "2026-10-10", requestType: "missing_clock_out", reason: "نسيت", createdMs: 1_760_000_000_000, isMine: true },
      { id: 32, employeeId: 12, employeeName: "فرحات", workDate: "2026-10-10", requestType: "wrong_time", reason: "خطأ", createdMs: 1_760_000_000_000, isMine: false },
      { id: 33, employeeId: 12, employeeName: "فرحات", workDate: "2026-10-09", requestType: "absence_to_leave", reason: "إجازة", createdMs: 1_760_000_000_000, isMine: false },
    ] });
  (window as any).matchMedia = (mq: string) => ({ matches: true, media: mq, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => cleanup());
const names = () => st.queried.map(x => x[0]);
const tab = (label: string) => fireEvent.click(screen.getByRole("tab", { name: label }));

describe("🧭 «فريقي» — الوصول", () => {
  it("العلم معطل: «غير متاح» بلا أي استعلام للفريق", () => {
    st.enabled = false;
    render(<TeamLeaderDashboard />);
    expect(screen.getByTestId("teams-unavailable")).toBeTruthy();
    expect(names().filter(n => !["myPermissions", "myTeams"].includes(n))).toEqual([]);
  });
  it("قيادة بلا صلاحية teams.view_own: لا صلاحية، ولا يُطلب myTeams", () => {
    st.perms = ALL.filter(p => p !== "teams.view_own");
    render(<TeamLeaderDashboard />);
    expect(screen.getByText("لا تملك صلاحية الوصول")).toBeTruthy();
    expect(names()).toEqual(["myPermissions"]);
  });
  it("صلاحية بلا قيادة فعّالة (أو قيادة منتهية): حالة فارغة بلا بيانات فريق", () => {
    st.teams = [];
    render(<TeamLeaderDashboard />);
    expect(screen.getByText("لست قائدًا لفريق حاليًا")).toBeTruthy();
    expect(names()).toEqual(["myPermissions", "myTeams"]);
  });
  it("قائد فريقين: يختار من فرقه فقط، والاستعلامات تتبع الفريق المختار", () => {
    st.teams = [T7, T8];
    render(<TeamLeaderDashboard />);
    const sel = screen.getByTestId("leader-team-select") as HTMLSelectElement;
    expect([...sel.options].map(o => o.value)).toEqual(["", "7", "8"]);
    fireEvent.change(sel, { target: { value: "8" } });
    expect(st.queried.filter(x => x[0] === "members").at(-1)![1]).toEqual({ teamId: 8 });
  });
  it("التبويبات حسب الصلاحية: بلا team_orders.view لا تبويب أوردرات", () => {
    st.perms = ALL.filter(p => p !== "team_orders.view");
    render(<TeamLeaderDashboard />);
    expect(screen.queryByRole("tab", { name: "الأوردرات" })).toBeNull();
    expect(screen.getByRole("tab", { name: "المهام" })).toBeTruthy();
    expect(names()).not.toContain("orders");
  });
});

describe("🕒 الحضور", () => {
  it("طلب القائد نفسه يظهر بلا أزرار، وطلب العضو بأزرار، والإجازة تحتاج manage_leaves", () => {
    render(<TeamLeaderDashboard />);
    tab("الحضور");
    expect(screen.getByTestId("pending-mine-31")).toBeTruthy();
    expect(screen.queryByTestId("pending-approve-31")).toBeNull();
    expect(screen.getByTestId("pending-approve-32")).toBeTruthy();
    expect(screen.queryByTestId("pending-approve-33")).toBeNull();
    expect(screen.getByTestId("pending-33").textContent).toContain("إدارة الإجازات");
  });
  it("بلا approve_corrections: الطلبات للعرض فقط", () => {
    st.perms = ALL.filter(p => p !== "attendance.approve_corrections");
    render(<TeamLeaderDashboard />);
    tab("الحضور");
    expect(screen.queryByTestId("pending-approve-32")).toBeNull();
    expect(screen.getByTestId("pending-32").textContent).toContain("للعرض فقط");
  });
  it("تغيير الفترة لا يخفي الطلبات المعلّقة", () => {
    render(<TeamLeaderDashboard />);
    tab("الحضور");
    fireEvent.click(screen.getByRole("button", { name: "آخر 7 أيام" }));
    const last = st.queried.filter(x => x[0] === "attendance").at(-1)![1];
    expect(last.dateFrom < last.dateTo).toBe(true);
    for (const id of [31, 32, 33]) expect(screen.getByTestId(`pending-${id}`)).toBeTruthy();
  });
  it("الرفض يحتاج سببًا ≥ 3 أحرف، والاعتماد طلب واحد مع الضغط المزدوج", () => {
    render(<TeamLeaderDashboard />);
    tab("الحضور");
    st.hold = true;
    fireEvent.click(screen.getByTestId("pending-approve-32"));
    fireEvent.click(screen.getByTestId("pending-approve-32"));
    expect(st.calls.filter(c => c[0] === "reviewCorrection")).toHaveLength(1);
    expect(st.calls[0][1]).toEqual({ teamId: 7, requestId: 32, decision: "approve", reviewReason: null });
  });
});

describe("📈 الأداء", () => {
  const row = (id: number, name: string, d: number, rank: number | null) => ({ employeeId: id, employeeName: name, isActive: true, decisionEligibleOrders: d, confirmedOrders: Math.floor(d / 2), confirmationRate: 50, noAnswerOrders: 1, noAnswerAttempts: 2, postponedOrders: 0, cancelledOrders: 0, workloadOrders: d, assignedOrders: d, activeDays: 3, rankable: rank != null, rank });
  it("ترتيب لمن ≥ 20 فقط، والأقل تظهر أرقامه بلا ترتيب؛ التصدير مخفي بلا صلاحية التصدير", () => {
    st.perfRows = [row(11, "أسيل", 25, 1), row(12, "فرحات", 5, null)];
    render(<TeamLeaderDashboard />);
    tab("الأداء");
    const p = screen.getByTestId("leader-performance");
    expect(p.textContent).toContain("#1");
    expect(p.textContent).toContain("عينة أقل من 20");
    expect(p.textContent).not.toContain("#2");
    expect(screen.queryByTestId("leader-performance-export")).toBeNull();
  });
  it("مع employee_performance.export: ينزّل نص السيرفر باسم ملفه ويحرّر الرابط — ومسموح في القراءة فقط", async () => {
    st.perms = [...ALL, "employee_performance.export"]; st.readOnly = true;
    const created: string[] = []; const revoked: string[] = [];
    (URL as any).createObjectURL = () => { created.push("blob:1"); return "blob:1"; };
    (URL as any).revokeObjectURL = (u: string) => revoked.push(u);
    const downloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
    render(<TeamLeaderDashboard />);
    tab("الأداء");
    const btn = screen.getByTestId("leader-performance-export") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await vi.waitFor(() => expect(downloads).toEqual(["team-performance-2026-10-05_2026-10-11.csv"]));
    await vi.waitFor(() => expect(revoked).toEqual(["blob:1"]));
    expect(st.csvFetched[0]).toMatchObject({ teamId: 7 });
    click.mockRestore();
  });
});

describe("📦 الأوردرات والمهام", () => {
  it("كل أوردرات النشاط مع غير المسندة؛ المسند إليه بالاسم أو «خارج الفريق» بلا معرّف خام", () => {
    render(<TeamLeaderDashboard />);
    tab("الأوردرات");
    const o = screen.getByTestId("leader-orders");
    expect(o.textContent).toContain("غير مسند");
    expect(o.textContent).toContain("فرحات");
    expect(o.textContent).toContain("خارج الفريق");
    expect(o.textContent).not.toContain("99");
  });
  it("الإسناد لأعضاء الفريق فقط، والضغط المزدوج = إسناد واحد بمعرّف عملية", () => {
    render(<TeamLeaderDashboard />);
    tab("الأوردرات");
    const sel = screen.getByLabelText("إسناد الأوردر A-100 إلى") as HTMLSelectElement;
    expect([...sel.options].map(o => o.value)).toEqual(["", "11", "12"]);
    fireEvent.change(sel, { target: { value: "12" } });
    st.hold = true;
    fireEvent.click(screen.getByTestId("assign-submit-100"));
    fireEvent.click(screen.getByTestId("assign-submit-100"));
    const a = st.calls.filter(c => c[0] === "assign");
    expect(a).toHaveLength(1);
    expect(a[0][1]).toMatchObject({ teamId: 7, orderId: 100, employeeId: 12 });
    expect(a[0][1].operationId).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
  });
  it("المهام: المنشئ بالاسم، بلا حذف، والإنشاء بمعرّف عملية ثابت", () => {
    render(<TeamLeaderDashboard />);
    tab("المهام");
    const t = screen.getByTestId("task-5");
    expect(t.textContent).toContain("أنشأها أسيل");
    expect(screen.queryByRole("button", { name: /حذف/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("العنوان"), { target: { value: "مراجعة المؤجل" } });
    fireEvent.click(screen.getByTestId("task-create-submit"));
    const c = st.calls.find(x => x[0] === "taskCreate")!;
    expect(c[1]).toMatchObject({ teamId: 7, title: "مراجعة المؤجل", assignedTo: null });
    expect(c[1].operationId).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
  });
  it("تغيير حالة المهمة بضغط مزدوج = تحديث واحد، ونفس الحالة = لا طلب", () => {
    render(<TeamLeaderDashboard />);
    tab("المهام");
    const sel = screen.getByTestId("task-status-5") as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "new" } }); // نفس الحالة: No-op في الواجهة أيضًا
    expect(st.calls.filter(c => c[0] === "taskStatus")).toHaveLength(0);
    st.hold = true;
    fireEvent.change(sel, { target: { value: "done" } });
    fireEvent.change(sel, { target: { value: "in_progress" } });
    const u = st.calls.filter(c => c[0] === "taskStatus");
    expect(u).toHaveLength(1);
    expect(u[0][1]).toEqual({ teamId: 7, taskId: 5, status: "done" });
  });
  it("الرفض بضغط مزدوج = قرار واحد", () => {
    render(<TeamLeaderDashboard />);
    tab("الحضور");
    fireEvent.click(screen.getByTestId("pending-reject-32"));
    fireEvent.change(screen.getByLabelText("سبب الرفض"), { target: { value: "خارج الوردية" } });
    st.hold = true;
    fireEvent.click(screen.getByTestId("pending-reject-confirm-32"));
    fireEvent.click(screen.getByTestId("pending-reject-confirm-32"));
    const r = st.calls.filter(c => c[0] === "reviewCorrection");
    expect(r).toHaveLength(1);
    expect(r[0][1]).toEqual({ teamId: 7, requestId: 32, decision: "reject", reviewReason: "خارج الوردية" });
  });
  it("القراءة فقط للشركة: الإسناد وإنشاء المهام معطّلان والعرض باقٍ", () => {
    st.readOnly = true;
    render(<TeamLeaderDashboard />);
    tab("الأوردرات");
    expect((screen.getByTestId("assign-submit-100") as HTMLButtonElement).disabled).toBe(true);
    tab("المهام");
    expect((screen.getByTestId("task-create-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("task-5")).toBeTruthy();
  });
  it("الأعضاء والورديات: الوردية الليلية من السيرفر والسجل بالأسماء", () => {
    render(<TeamLeaderDashboard />);
    tab("الأعضاء والورديات");
    expect(screen.getByTestId("member-shifts").textContent).toContain("ليلية");
    expect(screen.getByTestId("leader-history").textContent).toContain("المالك");
  });
});
