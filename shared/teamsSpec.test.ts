import { describe, it, expect } from "vitest";
import fs from "fs";
import { TEAMS_SPEC, TEAMS_TABLES, TEAMS_GENERATED, TEAM_IDEMPOTENCY_KEY_RE, isActiveAt, intervalsOverlap, type MembershipInterval } from "./teamsSpec";
import { normalizeGenerationExpression, splitStatements, verifyTable, type SchemaSnapshot } from "./schemaSpec";

/**
 * 0044 — قواعد الفترات النصف مفتوحة (بلا قاعدة) + تطابق ملف SQL مع المواصفة حرفيًا + مطابقة الأعمدة المولّدة.
 * إثبات الفهارس/CHECK/التزامن على MySQL حقيقي في server/teamsMigration.db.test.ts.
 */
const SQL = fs.readFileSync("drizzle/0044_teams.sql", "utf-8");
const T = (iso: string) => Date.parse(iso);
const iv = (from: string, to: string | null): MembershipInterval => ({ fromMs: T(from), toMs: to === null ? null : T(to) });

describe("⏱️ الفترات نصف المفتوحة [from, to)", () => {
  it("متلامسة بلا تداخل: نهاية 16:00 وبداية 16:00 مسموحة", () => {
    const a = iv("2026-10-10T13:00:00.000Z", "2026-10-10T16:00:00.000Z");
    const b = iv("2026-10-10T16:00:00.000Z", null);
    expect(intervalsOverlap(a, b)).toBe(false);
    expect(intervalsOverlap(b, a)).toBe(false);
  });
  it("متداخلة بملّي ثانية واحدة مرفوضة", () => {
    const a = iv("2026-10-10T13:00:00.000Z", "2026-10-10T16:00:00.001Z");
    const b = iv("2026-10-10T16:00:00.000Z", null);
    expect(intervalsOverlap(a, b)).toBe(true);
    expect(intervalsOverlap(iv("2026-10-10T16:00:00.000Z", "2026-10-10T17:00:00.000Z"), iv("2026-10-10T15:00:00.000Z", "2026-10-10T16:00:00.001Z"))).toBe(true);
  });
  it("قائد قديم ينتهي وقائد جديد يبدأ في نفس اللحظة: لحظة التسليم تخص الجديد وحده", () => {
    const old = iv("2026-10-01T06:00:00.000Z", "2026-10-10T09:30:00.000Z");
    const neu = iv("2026-10-10T09:30:00.000Z", null);
    expect(intervalsOverlap(old, neu)).toBe(false);
    const handover = T("2026-10-10T09:30:00.000Z");
    expect([isActiveAt(old, handover), isActiveAt(neu, handover)]).toEqual([false, true]);
    expect([isActiveAt(old, handover - 1), isActiveAt(neu, handover - 1)]).toEqual([true, false]);
  });
  it("عضوية تمر عبر منتصف الليل (القاهرة): 23:00 → 08:00 تشمل 23:59 و00:01 ولا تشمل 08:00", () => {
    // 2026-10-10 القاهرة UTC+3: 23:00 = 20:00Z، 08:00 اليوم التالي = 05:00Z
    const night = iv("2026-10-10T20:00:00.000Z", "2026-10-11T05:00:00.000Z");
    expect(isActiveAt(night, T("2026-10-10T23:59:00+03:00"))).toBe(true);
    expect(isActiveAt(night, T("2026-10-11T00:01:00+03:00"))).toBe(true);
    expect(isActiveAt(night, T("2026-10-11T08:00:00+03:00"))).toBe(false);
    expect(isActiveAt(night, T("2026-10-10T22:59:59.999+03:00"))).toBe(false);
    // نقل أثناء اليوم: فريق ليلي ثم فريق صباحي من نفس اللحظة — بلا فجوة ولا تداخل
    expect(intervalsOverlap(night, iv("2026-10-11T05:00:00.000Z", null))).toBe(false);
  });
  it("المفتوحة تتداخل مع أي فترة لاحقة لبدايتها", () => {
    expect(intervalsOverlap(iv("2026-10-01T00:00:00.000Z", null), iv("2030-01-01T00:00:00.000Z", "2030-01-02T00:00:00.000Z"))).toBe(true);
    expect(intervalsOverlap(iv("2026-10-01T00:00:00.000Z", null), iv("2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("📄 0044 — الملف مطابق للمواصفة", () => {
  const stmts = splitStatements(SQL);
  const code = SQL.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
  const body = (t: string) => stmts.find(s => s.startsWith(`CREATE TABLE \`${t}\``)) ?? "";
  const names = (t: string, re: RegExp) => [...body(t).matchAll(re)].map(m => m[1]);

  it("ثلاثة جداول بالترتيب، بلا ALTER/DROP/UPDATE/DELETE؛ orders لا تُذكر، وtasks مرجع FK فقط (بلا أي تعديل عليها)", () => {
    expect(stmts.map(s => s.match(/^CREATE TABLE `([^`]+)`/)?.[1])).toEqual([...TEAMS_TABLES]);
    expect(code).not.toMatch(/ALTER TABLE|DROP |DELETE FROM|^\s*UPDATE |INSERT INTO/im);
    expect(code).not.toMatch(/`orders`/);
    expect(code.match(/`tasks`/g)).toHaveLength(1);
    expect(code).toContain("CONSTRAINT `fk_tto_task` FOREIGN KEY (`taskId`) REFERENCES `tasks`(`id`) ON DELETE SET NULL");
  });

  for (const t of TEAMS_TABLES) {
    it(`${t}: الأعمدة والفهارس وFK وCHECK بنفس الأسماء`, () => {
      const spec = TEAMS_SPEC[t];
      expect(names(t, /^\s*`(\w+)`\s+(?:int|varchar|char|tinyint|timestamp|enum)/gm)).toEqual(spec.columns.map(c => c.name));
      expect(names(t, /CONSTRAINT `(\w+)` UNIQUE/g)).toEqual(spec.uniques.filter(u => u.name !== "PRIMARY").map(u => u.name));
      expect(names(t, /INDEX `(\w+)`/g)).toEqual(spec.indexes.map(i => i.name));
      expect(names(t, /CONSTRAINT `(\w+)` FOREIGN KEY/g)).toEqual(spec.foreignKeys.map(f => f.name));
      expect(names(t, /CONSTRAINT `(\w+)` CHECK/g)).toEqual(spec.checks);
      for (const c of spec.columns.filter(c => c.generated)) {
        const m = body(t).match(new RegExp("`" + c.name + "` int GENERATED ALWAYS AS \\((.+)\\) STORED,"));
        expect(m?.[1], c.name).toBe(c.generated);
      }
    });
  }

  it("مفاتيح idempotency والبصمات NOT NULL للإنشاء، ومفاتيح الإغلاق مرتبطة بحالته", () => {
    const col = (t: "teams" | "team_memberships" | "team_task_operations", n: string) => TEAMS_SPEC[t].columns.find(c => c.name === n)!;
    for (const t of ["teams", "team_memberships"] as const) { expect(col(t, "idempotencyKey").nullable).toBe(false); expect(col(t, "payloadHash").nullable).toBe(false); }
    const tto = (n: string) => TEAMS_SPEC.team_task_operations.columns.find(c => c.name === n)!;
    expect([tto("operationId").nullable, tto("payloadHash").nullable, tto("actorEmployeeId").nullable, tto("taskId").nullable]).toEqual([false, false, false, true]);
    expect(TEAM_IDEMPOTENCY_KEY_RE.test("team_create:Ab12_xy-9")).toBe(true);
    expect(TEAM_IDEMPOTENCY_KEY_RE.test("")).toBe(false);
    expect(TEAM_IDEMPOTENCY_KEY_RE.test("short")).toBe(false);
    expect(TEAM_IDEMPOTENCY_KEY_RE.test("has space key")).toBe(false);
  });
});

describe("🧬 مطابقة الأعمدة المولّدة", () => {
  // نصوص GENERATION_EXPRESSION كما أعادها MySQL 8.4.11 فعليًا (information_schema عبر mysql2)
  const ACTUAL = {
    activeBusinessId: "(case when (`isActive` = 1) then `businessId` end)",
    openMemberTeamId: "(case when (`effectiveToAt` is null) then `teamId` end)",
    openLeaderTeamId: "(case when ((`effectiveToAt` is null) and (`membershipRole` = _utf8mb4\\'leader\\')) then `teamId` end)",
  };
  it("تطبيع تعبير MySQL يطابق نص الملف", () => {
    for (const k of Object.keys(TEAMS_GENERATED) as (keyof typeof TEAMS_GENERATED)[])
      expect(normalizeGenerationExpression(ACTUAL[k]), k).toBe(normalizeGenerationExpression(TEAMS_GENERATED[k]));
    expect(normalizeGenerationExpression(ACTUAL.openLeaderTeamId)).not.toBe(normalizeGenerationExpression(TEAMS_GENERATED.openMemberTeamId));
  });

  const snap = (overrides: Record<string, string | null>): SchemaSnapshot => ({
    tables: new Set(["teams"]),
    columns: { teams: TEAMS_SPEC.teams.columns.map(c => ({ name: c.name, columnType: c.type === "enum" ? "enum('x')" : c.type, nullable: c.nullable, generated: c.name in overrides ? overrides[c.name] : c.generated ? `STORED|${c.generated}` : null })) },
    uniques: { teams: Object.fromEntries(TEAMS_SPEC.teams.uniques.map(u => [u.name, u.columns])) },
    indexes: { teams: Object.fromEntries(TEAMS_SPEC.teams.indexes.map(u => [u.name, u.columns])) },
    foreignKeys: { teams: Object.fromEntries(TEAMS_SPEC.teams.foreignKeys.map(f => [f.name, { columns: f.columns, refTable: f.refTable, refColumns: f.refColumns }])) },
    checks: { teams: new Set(TEAMS_SPEC.teams.checks) },
  });
  it("مطابق ⇒ بلا فروق؛ عمود عادي بدل المولّد/VIRTUAL/تعبير مختلف/مولّد غير موصوف ⇒ فرق", () => {
    expect(verifyTable("teams", TEAMS_SPEC.teams, snap({ activeBusinessId: `STORED|${ACTUAL.activeBusinessId}` }))).toEqual([]);
    expect(verifyTable("teams", TEAMS_SPEC.teams, snap({ activeBusinessId: null })).map(i => i.detail)).toEqual([expect.stringContaining("ليس عمودًا مولّدًا STORED")]);
    expect(verifyTable("teams", TEAMS_SPEC.teams, snap({ activeBusinessId: `VIRTUAL|${ACTUAL.activeBusinessId}` })).map(i => i.detail)).toEqual([expect.stringContaining("VIRTUAL")]);
    expect(verifyTable("teams", TEAMS_SPEC.teams, snap({ activeBusinessId: "STORED|(case when (`isActive` = 0) then `businessId` end)" })).map(i => i.detail)).toEqual([expect.stringContaining("تعبير التوليد")]);
    expect(verifyTable("teams", TEAMS_SPEC.teams, snap({ businessId: "STORED|(1)" })).map(i => i.detail)).toEqual([expect.stringContaining("عمود مولّد غير موصوف")]);
  });
});
