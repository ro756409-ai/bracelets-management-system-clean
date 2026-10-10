// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

/**
 * صفحة «الفرق» للمالك: العلم معطل بلا استعلامات، العرض بـteams.view_all، والكتابة بـteams.manage فقط،
 * القراءة فقط للشركة تعطّل الكتابة، الإيقاف بتأكيد مكتوب، الضغط المزدوج = عملية واحدة بمعرّف ثابت، وأسباب الرفض بالعربي.
 */
const { st, q, m } = vi.hoisted(() => {
  const st = {
    enabled: true, perms: [] as string[], readOnly: false, queried: [] as string[], calls: [] as [string, any][],
    rows: [] as any[], fail: null as any, hold: false,
  };
  const q = (name: string, data: () => any) => ({ useQuery: (_i?: any, opts?: any) => { if (opts?.enabled !== false) st.queried.push(name); return { data: opts?.enabled === false ? undefined : data(), isLoading: false, error: null, refetch: () => {} }; } });
  const m = (name: string) => ({ useMutation: () => ({ isPending: false, mutate: (v: any, cb?: any) => { st.calls.push([name, v]); if (st.hold) return; if (st.fail) cb?.onError?.(st.fail); else cb?.onSuccess?.({ id: 9, replay: false, closedMemberships: 2 }); cb?.onSettled?.(); } }) });
  return { st, q, m };
});
vi.mock("@/lib/trpc", () => ({
  trpc: {
    teams: {
      status: { useQuery: () => ({ data: { enabled: st.enabled }, isLoading: false }) },
      list: q("list", () => ({ enabled: true, rows: st.rows })),
      get: q("get", () => ({ enabled: true, team: { id: 7, tenantId: 1, businessId: 3, name: "فريق الأفندي", isActive: true, version: 2, activatedMs: 1_760_000_000_000, deactivatedMs: null }, members: [
        { id: 70, teamId: 7, employeeId: 11, membershipRole: "leader", fromMs: 1_760_000_000_000, toMs: null, employeeName: "أسيل" },
        { id: 71, teamId: 7, employeeId: 12, membershipRole: "member", fromMs: 1_760_000_000_000, toMs: null, employeeName: "فرحات" },
      ] })),
      history: q("history", () => ({ enabled: true, team: {}, history: [{ id: 70, employeeName: "أسيل", membershipRole: "leader", fromMs: 1_760_000_000_000, toMs: null, assignedByName: "المالك", endedByName: null }] })),
      memberShifts: q("memberShifts", () => ({ enabled: true, workDate: "2026-10-11", timeZone: "Africa/Cairo", team: {}, members: [
        { employeeId: 11, employeeName: "أسيل", membershipRole: "leader", status: "conflict", shift: { name: "صباحي", startTime: "09:00", endTime: "17:00", crossesMidnight: false, timezone: "Africa/Cairo", workDays: ["sat", "sun"], worksOnDate: true }, conflictingShiftNames: ["صباحي", "مسائي"] },
        { employeeId: 12, employeeName: "فرحات", membershipRole: "member", status: "none", shift: null, conflictingShiftNames: [] },
      ] })),
      create: m("create"), rename: m("rename"), deactivate: m("deactivate"), addMember: m("addMember"),
      endMembership: m("endMembership"), setLeader: m("setLeader"), endLeadership: m("endLeadership"),
    },
    businesses: { activeList: q("businesses", () => [{ id: 3, name: "الأفندي" }, { id: 4, name: "نوفا" }]) },
    employees: { activeList: q("employees", () => [{ id: 11, name: "أسيل" }, { id: 12, name: "فرحات" }, { id: 13, name: "نوفا" }]) },
    useUtils: () => new Proxy({}, { get: () => new Proxy({}, { get: () => ({ invalidate: vi.fn(async () => {}) }) }) }),
  },
}));
vi.mock("@/hooks/usePermission", () => ({ usePermissions: () => ({ permissions: st.perms, isLoading: false, has: (p: string) => st.perms.includes(p) }) }));
vi.mock("@/contexts/TenantAccessContext", () => ({ useTenantAccess: () => ({ readOnly: st.readOnly, blocked: false }) }));
vi.mock("@/components/ui/select", () => import("@/test-utils/selectMock"));
vi.mock("@/components/shared/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import Teams from "./Teams";

const ROW = { id: 7, businessId: 3, businessName: "الأفندي", name: "فريق الأفندي", isActive: true, version: 2, activatedMs: 1_760_000_000_000, deactivatedMs: null, leaderEmployeeId: 11, leaderName: "أسيل", activeMembers: 2 };
const OLD = { ...ROW, id: 5, name: "فريق قديم", isActive: false, deactivatedMs: 1_760_100_000_000, leaderEmployeeId: null, leaderName: null, activeMembers: 0 };
beforeEach(() => {
  Object.assign(st, { hold: false, enabled: true, perms: ["teams.view_all", "teams.manage"], readOnly: false, queried: [], calls: [], rows: [ROW, OLD], fail: null });
  (window as any).matchMedia = (mq: string) => ({ matches: true, media: mq, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => cleanup());
const open = () => fireEvent.click(screen.getAllByRole("button", { name: "عرض" })[0]);

describe("👥 /teams — المالك", () => {
  it("العلم معطل: «غير متاح» ولا أي استعلام قائمة/فريق", () => {
    st.enabled = false;
    render(<Teams />);
    expect(screen.getByTestId("teams-unavailable").textContent).toContain("غير متاح");
    expect(st.queried).toEqual([]);
  });

  it("بلا teams.view_all: لا صلاحية ولا استعلامات", () => {
    st.perms = ["teams.manage"];
    render(<Teams />);
    expect(screen.getByText("لا تملك صلاحية الوصول")).toBeTruthy();
    expect(st.queried).toEqual([]);
  });

  it("الفرق الحالية والقديمة بالاسم والنشاط والقائد والعدد والحالة", () => {
    render(<Teams />);
    const page = screen.getByTestId("teams-page");
    for (const t of ["فريق الأفندي", "الأفندي", "أسيل", "فريق قديم", "بلا قائد", "نشط", "موقوف"]) expect(page.textContent).toContain(t);
  });

  it("المالك للعرض فقط: لا أزرار كتابة في الصفحة ولا في نافذة الفريق، والقراءة تعمل", () => {
    st.perms = ["teams.view_all"];
    render(<Teams />);
    expect(screen.queryByTestId("team-create-open")).toBeNull();
    open();
    expect(screen.getByTestId("team-members").textContent).toContain("فرحات");
    for (const id of ["team-rename-open", "team-deactivate-open", "team-endlead", "team-add", "team-lead-12", "team-end-71"]) expect(screen.queryByTestId(id)).toBeNull();
    expect(st.queried).not.toContain("businesses");
    expect(st.queried).not.toContain("employees");
  });

  it("الإنشاء لنشاط بلا فريق نشط فقط، والضغط المزدوج = طلب واحد بمعرّف عملية صالح", () => {
    render(<Teams />);
    fireEvent.click(screen.getByTestId("team-create-open"));
    const sel = screen.getByTestId("team-business") as HTMLSelectElement;
    expect([...sel.options].map(o => o.value)).toEqual(["", "4"]); // الأفندي له فريق نشط
    fireEvent.change(screen.getByTestId("team-name"), { target: { value: "فريق نوفا" } });
    st.calls = []; st.hold = true; // الطلب الأول ما زال معلّقًا
    const btn = screen.getByTestId("team-create");
    fireEvent.click(btn); fireEvent.click(btn);
    const creates = st.calls.filter(c => c[0] === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0][1]).toMatchObject({ businessId: 4, name: "فريق نوفا" });
    expect(creates[0][1].operationId).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
  });

  it("رفض السيرفر يظهر بالعربي ولا يُفترض النجاح", async () => {
    const { TRPCClientError } = await import("@trpc/client");
    st.fail = new TRPCClientError("يوجد فريق نشط لهذا النشاط — أوقفه أولًا", { result: { error: { data: { code: "CONFLICT" } } } } as any);
    render(<Teams />);
    fireEvent.click(screen.getByTestId("team-create-open"));
    fireEvent.change(screen.getByTestId("team-name"), { target: { value: "فريق نوفا" } });
    fireEvent.click(screen.getByTestId("team-create"));
    expect(screen.getByTestId("team-error").textContent).toContain("يوجد فريق نشط لهذا النشاط");
    expect(screen.getByTestId("team-create")).toBeTruthy(); // الحوار باقٍ
  });

  it("نافذة الفريق: إضافة عضو (مرشحون غير أعضاء فقط)، تعيين/إنهاء، وكلها بمعرّف عملية", () => {
    render(<Teams />);
    open();
    const add = screen.getByTestId("team-add-select") as HTMLSelectElement;
    expect([...add.options].map(o => o.value)).toEqual(["", "13"]);
    fireEvent.change(add, { target: { value: "13" } });
    fireEvent.click(screen.getByTestId("team-add"));
    fireEvent.click(screen.getByTestId("team-lead-12"));
    fireEvent.click(screen.getByTestId("team-end-71"));
    fireEvent.click(screen.getByTestId("team-endlead"));
    const names = st.calls.map(c => c[0]);
    expect(names).toEqual(["addMember", "setLeader", "endMembership", "endLeadership"]);
    for (const [, v] of st.calls) expect(v.operationId).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
    expect(st.calls[0][1]).toEqual(expect.objectContaining({ teamId: 7, employeeId: 13 }));
    expect(JSON.stringify(st.calls)).not.toMatch(/effectiveFrom|effectiveTo|tenantId/);
  });

  it("الإيقاف النهائي يحتاج كتابة اسم الفريق قبل التنفيذ", () => {
    render(<Teams />);
    open();
    fireEvent.click(screen.getByTestId("team-deactivate-open"));
    const dialog = screen.getByRole("dialog", { name: /إيقاف الفريق نهائيًا/ });
    const confirm = within(dialog).getByRole("button", { name: "إيقاف نهائي" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "فريق الأفندي" } });
    expect(confirm.disabled).toBe(false);
  });

  it("ورديات الأعضاء من السيرفر: تعارض بالأسماء المتعادلة، وبلا وردية كتحذير", () => {
    render(<Teams />);
    open();
    const s = screen.getByTestId("member-shifts");
    expect(s.textContent).toContain("تعارض ورديات");
    expect(s.textContent).toContain("صباحي، مسائي");
    expect(s.textContent).toContain("بلا وردية");
    expect(s.textContent).toContain("تحذيرات: 2");
  });

  it("القراءة فقط للشركة: الكتابة معطّلة والقراءة باقية", () => {
    st.readOnly = true;
    render(<Teams />);
    expect((screen.getByTestId("team-create-open") as HTMLButtonElement).disabled).toBe(true);
    open();
    expect(screen.getByTestId("team-members").textContent).toContain("فرحات");
    for (const id of ["team-rename-open", "team-deactivate-open", "team-endlead", "team-lead-12", "team-end-71"]) expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
  });
});
