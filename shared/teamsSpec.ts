import type { TableSpec } from "./schemaSpec";

/**
 * مواصفة 0044 (الفرق التشغيلية والقيادة المؤرخة) كبيانات + قواعد الفترات المشتركة بين الخدمة والتقارير.
 * القرارات المعتمدة من المالك (2026-10-10):
 *   • فريق تشغيلي نشط واحد لكل Business؛ الإيقاف نهائي ولا حذف لأي سجل.
 *   • القيادة صف عضوية بدور 'leader' مؤرخ (لا Role جديد، لا cache للقائد في teams).
 *   • الفترات Timestamp(3) UTC نصف مفتوحة [from, to): المتلامسة مسموحة، والتداخل ولو بملّي ثانية مرفوض.
 *   • نسب الحدث للفريق: نفس tenantId + businessId الحدث = businessId الفريق + عضوية فعّالة لحظة occurredAt.
 */
export const TEAMS_TABLES = ["teams", "team_memberships"] as const;
export type TeamsTable = (typeof TEAMS_TABLES)[number];

export const TEAM_MEMBERSHIP_ROLES = ["member", "leader"] as const;
export type TeamMembershipRole = (typeof TEAM_MEMBERSHIP_ROLES)[number];

export const TEAMS_LIMITS = { nameMaxChars: 120 } as const;

/** الأحرف المسموحة في مفاتيح العمليات المخزّنة (نفس CHECK chk_tm_keys / chk_tmb_keys). */
export const TEAM_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_:#-]{8,191}$/;

/** فترة عضوية/قيادة بالـepoch ms. toMs = null ⇒ مفتوحة. */
export type MembershipInterval = { fromMs: number; toMs: number | null };

/** فعّالة لحظة atMs؟ نصف مفتوحة: from <= at < to. */
export const isActiveAt = (iv: MembershipInterval, atMs: number) =>
  iv.fromMs <= atMs && (iv.toMs === null || atMs < iv.toMs);

/** تتداخل فترتان؟ المتلامستان (نهاية = بداية) لا تتداخلان. */
export const intervalsOverlap = (a: MembershipInterval, b: MembershipInterval) =>
  a.fromMs < (b.toMs ?? Number.POSITIVE_INFINITY) && b.fromMs < (a.toMs ?? Number.POSITIVE_INFINITY);

export type TeamEvent = { tenantId: number; businessId: number | null; employeeId: number | null; occurredAtMs: number };
export type TeamMembershipSpan = MembershipInterval & { employeeId: number };

/**
 * هل يُحسب الحدث لهذا الفريق؟ (قرار المالك) الشروط الثلاثة معًا: نفس tenantId، businessId الحدث = نشاط الفريق،
 * والموظف عضو/قائد فعّال لحظة occurredAt بالضبط — لا businessDateKey ولا يوم كامل. إعادة الإسناد لا تنقل التاريخ.
 * spans = فترات هذا الفريق فقط.
 */
export function eventCountsForTeam(e: TeamEvent, team: { tenantId: number; businessId: number }, spans: TeamMembershipSpan[]): boolean {
  if (e.tenantId !== team.tenantId || e.businessId == null || e.businessId !== team.businessId || e.employeeId == null) return false;
  return spans.some(s => s.employeeId === e.employeeId && isActiveAt(s, e.occurredAtMs));
}

/** نفس التعبير الذي يُكتب في الملف (يُقارن بعد التطبيع مع information_schema). */
export const TEAMS_GENERATED = {
  activeBusinessId: "CASE WHEN `isActive` = 1 THEN `businessId` END",
  openMemberTeamId: "CASE WHEN `effectiveToAt` IS NULL THEN `teamId` END",
  openLeaderTeamId: "CASE WHEN `effectiveToAt` IS NULL AND `membershipRole` = 'leader' THEN `teamId` END",
} as const;

const ts = (name: string, nullable = false) => ({ name, type: "timestamp(3)", nullable });
const int = (name: string, nullable = false) => ({ name, type: "int", nullable });
const gen = (name: keyof typeof TEAMS_GENERATED) => ({ name, type: "int", nullable: true, generated: TEAMS_GENERATED[name] });
const key = (name: string, nullable = false) => ({ name, type: "varchar(191)", nullable });
const hash = (name: string, nullable = false) => ({ name, type: "char(64)", nullable });
const fk = (name: string, columns: string[], refTable: string, refColumns: string[]) => ({ name, columns, refTable, refColumns });
const empFk = (name: string, col: string) => fk(name, ["tenantId", col], "employees", ["tenantId", "id"]);

export const TEAMS_SPEC: Record<TeamsTable, TableSpec> = {
  teams: {
    columns: [
      int("id"), int("tenantId"), int("businessId"), { name: "name", type: "varchar(120)", nullable: false },
      { name: "isActive", type: "tinyint(1)", nullable: false }, gen("activeBusinessId"),
      ts("activatedAt"), ts("deactivatedAt", true), int("deactivatedByEmployeeId", true), int("createdByEmployeeId"),
      key("idempotencyKey"), hash("payloadHash"), key("deactivationIdempotencyKey", true), hash("deactivationPayloadHash", true),
      { name: "version", type: "int unsigned", nullable: false }, ts("createdAt"), ts("updatedAt"),
    ],
    uniques: [
      { name: "PRIMARY", columns: ["id"] },
      { name: "tm_tenant_id_unique", columns: ["tenantId", "id"] },
      { name: "tm_tenant_active_business_unique", columns: ["tenantId", "activeBusinessId"] },
      { name: "tm_tenant_idem_unique", columns: ["tenantId", "idempotencyKey"] },
      { name: "tm_tenant_deact_idem_unique", columns: ["tenantId", "deactivationIdempotencyKey"] },
    ],
    indexes: [{ name: "tm_tenant_business_activated", columns: ["tenantId", "businessId", "activatedAt"] }],
    foreignKeys: [
      fk("fk_tm_tenant", ["tenantId"], "tenants", ["id"]),
      fk("fk_tm_tenant_business", ["tenantId", "businessId"], "businesses", ["tenantId", "id"]),
      empFk("fk_tm_tenant_creator", "createdByEmployeeId"),
      empFk("fk_tm_tenant_deactivator", "deactivatedByEmployeeId"),
    ],
    checks: ["chk_tm_name", "chk_tm_active_flag", "chk_tm_state", "chk_tm_deact_time", "chk_tm_actor_ids", "chk_tm_keys", "chk_tm_hash"],
  },
  team_memberships: {
    columns: [
      int("id"), int("tenantId"), int("teamId"), int("employeeId"), { name: "membershipRole", type: "enum", nullable: false },
      ts("effectiveFromAt"), ts("effectiveToAt", true), gen("openMemberTeamId"), gen("openLeaderTeamId"),
      int("assignedByEmployeeId"), key("idempotencyKey"), hash("payloadHash"),
      int("endedByEmployeeId", true), ts("endedAt", true), key("endIdempotencyKey", true), hash("endPayloadHash", true),
      ts("createdAt"), ts("updatedAt"),
    ],
    uniques: [
      { name: "PRIMARY", columns: ["id"] },
      { name: "tmb_tenant_id_unique", columns: ["tenantId", "id"] },
      { name: "tmb_tenant_idem_unique", columns: ["tenantId", "idempotencyKey"] },
      { name: "tmb_tenant_end_idem_unique", columns: ["tenantId", "endIdempotencyKey"] },
      { name: "tmb_tenant_employee_open_unique", columns: ["tenantId", "employeeId", "openMemberTeamId"] },
      { name: "tmb_tenant_open_leader_unique", columns: ["tenantId", "openLeaderTeamId"] },
    ],
    indexes: [
      { name: "tmb_tenant_team_from", columns: ["tenantId", "teamId", "effectiveFromAt"] },
      { name: "tmb_tenant_employee_from", columns: ["tenantId", "employeeId", "effectiveFromAt"] },
      { name: "tmb_tenant_team_role_from", columns: ["tenantId", "teamId", "membershipRole", "effectiveFromAt"] },
    ],
    foreignKeys: [
      fk("fk_tmb_tenant", ["tenantId"], "tenants", ["id"]),
      fk("fk_tmb_tenant_team", ["tenantId", "teamId"], "teams", ["tenantId", "id"]),
      empFk("fk_tmb_tenant_employee", "employeeId"),
      empFk("fk_tmb_tenant_assigner", "assignedByEmployeeId"),
      empFk("fk_tmb_tenant_ender", "endedByEmployeeId"),
    ],
    checks: ["chk_tmb_range", "chk_tmb_end", "chk_tmb_ids", "chk_tmb_keys", "chk_tmb_hash"],
  },
};
