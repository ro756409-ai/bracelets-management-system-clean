import { describe, it, expect } from "vitest";
import { ALL_PERMISSIONS, hasPermission, MANAGER_GRANT_ONLY_PERMISSIONS, TEAM_LEADER_PERMISSIONS } from "./permissions";
import { PERMISSION_LABELS } from "../shared/permissionLabels";
import { eventCountsForTeam } from "../shared/teamsSpec";

/** مصفوفة صلاحيات الفرق الافتراضية (قرار المالك 2026-10-10) — قبل أي منح لكل شركة. */
const OWNER_ONLY = ["teams.view_all", "teams.manage"] as const;
const LEADER = ["teams.view_own", "team_performance.view", "team_attendance.view", "team_tasks.manage", "team_orders.view", "team_orders.assign"] as const;
const OTHERS = ["warehouse", "agent", "order_confirmation", "shipping", "scanner", "data_entry", "facebook_entry", "accountant", "viewer"];

describe("👥 صلاحيات الفرق — الافتراضي", () => {
  it("الثماني مسجّلة ولها أسماء عربية، بلا Role جديد", () => {
    for (const p of [...OWNER_ONLY, ...LEADER]) { expect(ALL_PERMISSIONS, p).toContain(p); expect(PERMISSION_LABELS[p], p).toBeTruthy(); }
    expect([...TEAM_LEADER_PERMISSIONS].sort()).toEqual([...LEADER].sort());
  });
  it("المالك والأدمن: كل شيء", () => {
    for (const p of [...OWNER_ONLY, ...LEADER]) { expect(hasPermission("super_admin", p), p).toBe(true); expect(hasPermission("admin", p), p).toBe(true); }
  });
  it("المدير: صلاحيات القائد افتراضيًا، وview_all/manage بالمنح فقط", () => {
    for (const p of LEADER) expect(hasPermission("manager", p), p).toBe(true);
    for (const p of OWNER_ONLY) { expect(hasPermission("manager", p), p).toBe(false); expect(MANAGER_GRANT_ONLY_PERMISSIONS, p).toContain(p); }
  });
  it("المشرف: صلاحيات القائد افتراضيًا (بلا أثر بدون قيادة فعّالة)، وبلا view_all/manage", () => {
    for (const p of LEADER) expect(hasPermission("moderator", p), p).toBe(true);
    for (const p of OWNER_ONLY) expect(hasPermission("moderator", p), p).toBe(false);
  });
  it("باقي الأدوار: لا شيء إلا بالمنح", () => {
    for (const r of OTHERS) for (const p of [...OWNER_ONLY, ...LEADER]) expect(hasPermission(r, p), `${r}:${p}`).toBe(false);
  });
});

describe("📊 نسب الحدث للفريق — الشروط الثلاثة بالـTimestamp", () => {
  const team = { tenantId: 1, businessId: 10 };
  const T = (iso: string) => Date.parse(iso);
  const spans = [
    { employeeId: 7, fromMs: T("2026-10-10T06:00:00Z"), toMs: T("2026-10-10T13:00:00Z") },
    { employeeId: 8, fromMs: T("2026-10-10T20:00:00Z"), toMs: null },
  ];
  const ev = (o: Partial<{ tenantId: number; businessId: number | null; employeeId: number | null; occurredAtMs: number }>) =>
    ({ tenantId: 1, businessId: 10, employeeId: 7, occurredAtMs: T("2026-10-10T09:00:00Z"), ...o });
  it("نفس tenant + نفس النشاط + فعّال لحظة الحدث ⇒ يُحسب", () => {
    expect(eventCountsForTeam(ev({}), team, spans)).toBe(true);
    expect(eventCountsForTeam(ev({ employeeId: 8, occurredAtMs: T("2026-10-10T09:00:00Z") }), team, spans)).toBe(false); // قبل بداية عضويته
  });
  it("شركة أخرى / نشاط آخر («فرحات» في تقرير «أفندي») / حدث بلا نشاط أو بلا موظف ⇒ لا يُحسب", () => {
    expect(eventCountsForTeam(ev({ tenantId: 2 }), team, spans)).toBe(false);
    expect(eventCountsForTeam(ev({ businessId: 11 }), team, spans)).toBe(false);
    expect(eventCountsForTeam(ev({ businessId: null }), team, spans)).toBe(false);
    expect(eventCountsForTeam(ev({ employeeId: null }), team, spans)).toBe(false);
  });
  it("خارج الفترة بالملّي ثانية: النهاية غير مشمولة، والبداية مشمولة؛ النقل لا ينقل التاريخ", () => {
    expect(eventCountsForTeam(ev({ occurredAtMs: T("2026-10-10T13:00:00Z") }), team, spans)).toBe(false);
    expect(eventCountsForTeam(ev({ occurredAtMs: T("2026-10-10T12:59:59.999Z") }), team, spans)).toBe(true);
    expect(eventCountsForTeam(ev({ occurredAtMs: T("2026-10-10T06:00:00Z") }), team, spans)).toBe(true);
    expect(eventCountsForTeam(ev({ occurredAtMs: T("2026-10-10T05:59:59.999Z") }), team, spans)).toBe(false);
  });
  it("وردية ليلية عبر منتصف الليل: 23:59 و00:01 بتوقيت القاهرة تُحسبان", () => {
    expect(eventCountsForTeam(ev({ employeeId: 8, occurredAtMs: T("2026-10-10T23:59:00+03:00") }), team, spans)).toBe(true);
    expect(eventCountsForTeam(ev({ employeeId: 8, occurredAtMs: T("2026-10-11T00:01:00+03:00") }), team, spans)).toBe(true);
    expect(eventCountsForTeam(ev({ employeeId: 8, occurredAtMs: T("2026-10-10T22:59:59.999+03:00") }), team, spans)).toBe(false);
  });
});
