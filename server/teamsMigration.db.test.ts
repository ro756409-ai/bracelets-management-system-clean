import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import mysql from "mysql2/promise";
import { runHandMigration, confirmPhrase, describeStatements } from "./handMigration.service";
import { TEAMS_MIGRATION } from "./teamsMigration";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { TEAMS_TABLES } from "../shared/teamsSpec";

/**
 * Migration 0044 على قواعد Docker محلية مؤقتة (MySQL حقيقي، لا اختبارات نصية):
 *   يشترط الفهرسين → apply بعد 0041 → verify يقرأ تعبير الأعمدة المولّدة فعلًا (ويكشف التلاعب) → replay →
 *   فريق نشط واحد لكل نشاط / عضوية مفتوحة واحدة / قائد مفتوح واحد (أعمدة مولّدة + UNIQUE) مع بقاء التاريخ →
 *   الفترات المتلامسة وتسليم القيادة في نفس اللحظة ومنتصف الليل وتخزين UTC بدقة ملّي ثانية →
 *   كل FK مركّب يمنع شركة أخرى → كل CHECK (بما فيها المعرّفات السالبة مع تعطيل FK) →
 *   تزامن حقيقي باتصالات متوازية → rollback قبل الاستخدام فقط.
 */
const SQL44 = fs.readFileSync("drizzle/0044_teams.sql", "utf-8");
const SQL41 = fs.readFileSync("drizzle/0041_order_activity_events.sql", "utf-8");
const CAN = Boolean(process.env.TEST_DATABASE_URL);
const H = "a".repeat(64), H2 = "b".repeat(64);
const run = (db: TempSchema, mode: "check" | "apply" | "rollback", extra: Record<string, unknown> = {}) =>
  runHandMigration(TEAMS_MIGRATION, { databaseUrl: db.url, mode, sqlText: SQL44, deployEnv: "test", confirm: mode === "check" ? null : confirmPhrase("0044", mode, db.name), ...extra });
/** ISO (Z) ⇒ نص timestamp(3) لجلسة time_zone='+00:00' */
const u = (iso: string) => new Date(iso).toISOString().replace("T", " ").replace("Z", "");
const errCode = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e: any) { return String(e?.code ?? "ERR"); } };

describe("0044 — نص الملف", () => {
  it("ثلاثة جداول بالترتيب، بلا فهارس مركّبة ولا FK لاحق", () => {
    expect(describeStatements(SQL44).map(s => `${s.kind}:${s.name}`)).toEqual(TEAMS_TABLES.map(t => `table:${t}`));
  });
});

describe.runIf(CAN)("🏗️ 0044 على قواعد مؤقتة", () => {
  let db: TempSchema;
  const q = async (s: string, p: unknown[] = []) => ((await db.raw.query(s, p)) as any)[0];
  const id = async (s: string, p: unknown[] = []) => (await q(s, p)).insertId as number;
  const count = async (t: string, where = "1=1", p: unknown[] = []) => Number((await q(`SELECT COUNT(*) n FROM ${t} WHERE ${where}`, p))[0].n);
  const rejected = async (t: string, s: string, p: unknown[], re: RegExp) => { const n = await count(t); await expect(db.raw.query(s, p)).rejects.toThrow(re); expect(await count(t)).toBe(n); };
  let seq = 0;
  const k = (p: string) => `${p}:k${Date.now().toString(36)}${++seq}`;
  const ins = (table: string, cols: Record<string, unknown>) => { const c = Object.keys(cols); return [`INSERT INTO ${table} (${c.map(x => `\`${x}\``).join(",")}) VALUES (${c.map(() => "?").join(",")})`, c.map(x => cols[x])] as const; };
  let ta = 0, tb = 0, ba1 = 0, ba2 = 0, ba3 = 0, bb = 0;
  const e: number[] = []; let eb = 0;
  const teamCols = (o: Record<string, unknown> = {}) => ({ tenantId: ta, businessId: ba1, name: "فريق اختبار", activatedAt: u("2026-10-10T06:00:00Z"), createdByEmployeeId: e[0], idempotencyKey: k("team_create"), payloadHash: H, ...o });
  const deact = (at = "2026-10-10T12:00:00Z") => ({ isActive: 0, deactivatedAt: u(at), deactivatedByEmployeeId: e[0], deactivationIdempotencyKey: k("team_deact"), deactivationPayloadHash: H2 });
  const memCols = (teamId: number, employeeId: number, o: Record<string, unknown> = {}) => ({ tenantId: ta, teamId, employeeId, membershipRole: "member", effectiveFromAt: u("2026-10-10T10:00:00Z"), assignedByEmployeeId: e[0], idempotencyKey: k("team_member"), payloadHash: H, ...o });
  const endCols = (at: string) => ({ effectiveToAt: u(at), endedAt: u(at), endedByEmployeeId: e[0], endIdempotencyKey: k("team_end"), endPayloadHash: H2 });
  const set = (cols: Record<string, unknown>) => [Object.keys(cols).map(c => `\`${c}\` = ?`).join(", "), Object.values(cols)] as const;
  const close = async (membershipId: number, at: string) => { const [s, p] = set(endCols(at)); await q(`UPDATE team_memberships SET ${s} WHERE id = ?`, [...p, membershipId]); };
  const leaderAt = async (teamId: number, iso: string) => ((await q(
    "SELECT employeeId FROM team_memberships WHERE tenantId = ? AND teamId = ? AND membershipRole = 'leader' AND effectiveFromAt <= ? AND (effectiveToAt IS NULL OR ? < effectiveToAt) ORDER BY id",
    [ta, teamId, u(iso), u(iso)])) as any[]).map(r => Number(r.employeeId));

  beforeAll(async () => {
    db = await createTempSchema("teams_m");
    await db.raw.query("SET time_zone = '+00:00'");
  }, 180_000);
  afterAll(async () => { await db?.drop(); }, 180_000);

  it("بدون الفهرسين: رفض بلا DDL؛ بعد 0041: apply → verify (تعبير التوليد فعليًا) → replay", async () => {
    expect((await run(db, "check")).state).toBe("not_applied");
    const refused = await run(db, "apply");
    expect(refused.refused).toBe("preflight"); expect(refused.applied).toBe(0);
    expect(await count("information_schema.TABLES", "TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('teams','team_memberships')")).toBe(0);

    expect((await runHandMigration(ORDER_EVENTS_MIGRATION, { databaseUrl: db.url, mode: "apply", sqlText: SQL41, deployEnv: "test", confirm: confirmPhrase("0041", "apply", db.name) })).ok).toBe(true);
    expect((await run(db, "apply", { confirm: "APPLY 0044 TO x" })).refused).toMatch(/عبارة التأكيد/);
    expect((await run(db, "apply", { deployEnv: "production" })).refused).toMatch(/DEPLOY_ENV/);
    const ap = await run(db, "apply");
    expect(ap.ok).toBe(true); expect(ap.applied).toBe(3); expect(ap.issues).toEqual([]);
    expect((await run(db, "apply")).replay).toBe(true);
    expect((await run(db, "check")).state).toBe("applied");

    // الأعمدة المولّدة STORED فعلًا (وcreatedAt = DEFAULT_GENERATED ليس مولّدًا)
    const gen = await q("SELECT TABLE_NAME t, COLUMN_NAME c, EXTRA x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('teams','team_memberships') AND EXTRA LIKE '%STORED GENERATED%' ORDER BY t, c");
    expect(gen.map((r: any) => `${r.t}.${r.c}`)).toEqual(["team_memberships.openLeaderTeamId", "team_memberships.openMemberTeamId", "teams.activeBusinessId"]);

    // verify يكشف تعبيرًا مختلفًا (لا يكتفي بالاسم والنوع) ثم يعود مطابقًا
    await q("ALTER TABLE teams MODIFY `activeBusinessId` int GENERATED ALWAYS AS (CASE WHEN `isActive` = 0 THEN `businessId` END) STORED");
    const drift = await run(db, "check");
    expect(drift.state).toBe("partial");
    expect(drift.issues.map(i => i.detail).join("\n")).toMatch(/activeBusinessId: تعبير التوليد/);
    await q("ALTER TABLE teams MODIFY `activeBusinessId` int GENERATED ALWAYS AS (CASE WHEN `isActive` = 1 THEN `businessId` END) STORED");
    expect((await run(db, "check")).state).toBe("applied");

    // بيانات الاختبار: شركتان، ثلاثة أنشطة لـA، موظفون
    ta = await id("INSERT INTO tenants (name, slug, status) VALUES ('A', ?, 'active')", [`a-${db.name}`.slice(0, 60)]);
    tb = await id("INSERT INTO tenants (name, slug, status) VALUES ('B', ?, 'active')", [`b-${db.name}`.slice(0, 60)]);
    const biz = (t: number, n: string) => id("INSERT INTO businesses (tenantId, name, slug) VALUES (?, ?, ?)", [t, n, `${n}-${db.name}`.slice(0, 50)]);
    ba1 = await biz(ta, "afandy"); ba2 = await biz(ta, "farhat"); ba3 = await biz(ta, "third"); bb = await biz(tb, "bbiz");
    const emp = (t: number, b: number, n: string) => id("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES (?, 'moderator', 1, ?, ?, ?)", [n, t, b, `${n}-${db.name}`.slice(0, 50)]);
    for (let i = 0; i < 14; i++) e.push(await emp(ta, ba1, `ea${i}`));
    eb = await emp(tb, bb, "eb");
  }, 240_000);

  it("teams: فريق نشط واحد لكل Business؛ الإيقاف يحرر الخانة ويبقى السجل", async () => {
    const t1 = await id(...ins("teams", teamCols()));
    expect(Number((await q("SELECT activeBusinessId a FROM teams WHERE id = ?", [t1]))[0].a)).toBe(ba1);
    await rejected("teams", ...ins("teams", teamCols()), /Duplicate entry .* for key 'teams\.tm_tenant_active_business_unique'/);
    await id(...ins("teams", teamCols({ businessId: ba2 }))); // نشاط آخر = مسموح
    const [s, p] = set(deact());
    await q(`UPDATE teams SET ${s} WHERE id = ?`, [...p, t1]);
    expect((await q("SELECT activeBusinessId a FROM teams WHERE id = ?", [t1]))[0].a).toBeNull();
    const t3 = await id(...ins("teams", teamCols({ name: "فريق أفندي الجديد" })));
    const [s3, p3] = set(deact("2026-10-10T13:00:00Z"));
    await q(`UPDATE teams SET ${s3} WHERE id = ?`, [...p3, t3]);
    await id(...ins("teams", teamCols({ name: "فريق ثالث" })));
    expect(await count("teams", "tenantId = ? AND businessId = ?", [ta, ba1])).toBe(3); // التاريخ محفوظ
    expect(await count("teams", "tenantId = ? AND businessId = ? AND isActive = 1", [ta, ba1])).toBe(1);
    // FK مركّب: نشاط شركة أخرى / منشئ من شركة أخرى / منشئ غير موجود
    await rejected("teams", ...ins("teams", teamCols({ businessId: bb })), /fk_tm_tenant_business/);
    await rejected("teams", ...ins("teams", teamCols({ businessId: ba3, createdByEmployeeId: eb })), /fk_tm_tenant_creator/);
    await rejected("teams", ...ins("teams", teamCols({ businessId: ba3, createdByEmployeeId: 99_999_999 })), /fk_tm_tenant_creator/);
    await rejected("teams", ...ins("teams", teamCols({ businessId: ba3, ...deact(), deactivatedByEmployeeId: eb })), /fk_tm_tenant_deactivator/);
    // كتابة العمود المولّد مباشرةً مرفوضة
    expect(await errCode(db.raw.query(...ins("teams", teamCols({ businessId: ba3, activeBusinessId: ba3 }))))).toBe("ER_NON_DEFAULT_VALUE_FOR_GENERATED_COLUMN");
  });

  it("teams: CHECK — الاسم بعد TRIM، الحالة بلا منطق NULL، الوقت، المفاتيح والبصمات، المعرّفات الموجبة", async () => {
    const T = (o: Record<string, unknown>) => ins("teams", teamCols({ businessId: ba3, ...o }));
    for (const name of ["", "   ", "\t", " \n "]) await rejected("teams", ...T({ name }), /chk_tm_name/);
    await rejected("teams", ...T({ isActive: 2 }), /chk_tm_active_flag|chk_tm_state/);
    await rejected("teams", ...T({ isActive: 0 }), /chk_tm_state/);
    await rejected("teams", ...T({ deactivatedAt: u("2026-10-10T12:00:00Z") }), /chk_tm_state/);
    await rejected("teams", ...T({ ...deact(), deactivatedByEmployeeId: null }), /chk_tm_state/);
    await rejected("teams", ...T({ ...deact(), deactivationIdempotencyKey: null }), /chk_tm_state/);
    await rejected("teams", ...T({ ...deact(), deactivationPayloadHash: null }), /chk_tm_state/);
    await rejected("teams", ...T({ ...deact("2026-10-10T05:59:59.999Z") }), /chk_tm_deact_time/);
    expect(await errCode(db.raw.query(...T({ idempotencyKey: null })))).toBe("ER_BAD_NULL_ERROR");
    expect(await errCode(db.raw.query(...T({ payloadHash: null })))).toBe("ER_BAD_NULL_ERROR");
    for (const key of ["", "short", "has space key 1", "مفتاح-عربي-طويل"]) await rejected("teams", ...T({ idempotencyKey: key }), /chk_tm_keys/);
    await rejected("teams", ...T({ payloadHash: "A".repeat(64) }), /chk_tm_hash/);
    await rejected("teams", ...T({ payloadHash: "abc" }), /chk_tm_hash/);
    await rejected("teams", ...T({ ...deact(), deactivationPayloadHash: "Z".repeat(64) }), /chk_tm_hash/);
    // نفس المفتاح في نفس الشركة مرفوض، وفي شركة أخرى مسموح
    const key = k("team_create");
    await id(...T({ idempotencyKey: key, ...deact() })); // موقوف حتى لا يشغل خانة النشاط
    await rejected("teams", ...T({ idempotencyKey: key, ...deact() }), /tm_tenant_idem_unique/);
    const ebTeam = await id(...ins("teams", { ...teamCols(), tenantId: tb, businessId: bb, createdByEmployeeId: eb, idempotencyKey: key }));
    expect(ebTeam).toBeGreaterThan(0);
    // المعرّفات السالبة/الصفرية: الـCHECK نفسه يرفضها حتى مع تعطيل FK (لا الهوية السالبة لجلسة الإدارة)
    await q("SET foreign_key_checks = 0");
    try {
      for (const v of [-1, 0]) {
        await rejected("teams", ...T({ createdByEmployeeId: v }), /chk_tm_actor_ids/);
        await rejected("teams", ...T({ ...deact(), deactivatedByEmployeeId: v }), /chk_tm_actor_ids/);
      }
    } finally { await q("SET foreign_key_checks = 1"); }
  });

  it("memberships: عضوية مفتوحة واحدة، قائد مفتوح واحد، فترات متلامسة، تسليم في نفس اللحظة، والتاريخ باقٍ", async () => {
    const team = await id(...ins("teams", teamCols({ businessId: ba3, name: "فريق العضويات" })));
    const m1 = await id(...ins("team_memberships", memCols(team, e[1], { effectiveFromAt: u("2026-10-10T13:00:00Z") })));
    const gen = async (mid: number) => (await q("SELECT openMemberTeamId m, openLeaderTeamId l FROM team_memberships WHERE id = ?", [mid]))[0];
    expect(await gen(m1)).toEqual({ m: team, l: null });
    // نفس الموظف مرتين مفتوحتين في نفس الفريق (حتى بدور قائد) مرفوض
    await rejected("team_memberships", ...ins("team_memberships", memCols(team, e[1])), /tmb_tenant_employee_open_unique/);
    await rejected("team_memberships", ...ins("team_memberships", memCols(team, e[1], { membershipRole: "leader" })), /tmb_tenant_employee_open_unique/);
    // متلامسة: نهاية 16:00 وبداية 16:00 مسموحة، والصف القديم باقٍ
    await close(m1, "2026-10-10T16:00:00.000Z");
    expect(await gen(m1)).toEqual({ m: null, l: null });
    const m1b = await id(...ins("team_memberships", memCols(team, e[1], { effectiveFromAt: u("2026-10-10T16:00:00.000Z") })));
    expect(await count("team_memberships", "teamId = ? AND employeeId = ?", [team, e[1]])).toBe(2);
    expect(m1b).toBeGreaterThan(m1);
    // قائد مفتوح واحد لكل فريق
    const l1 = await id(...ins("team_memberships", memCols(team, e[2], { membershipRole: "leader", effectiveFromAt: u("2026-10-01T06:00:00Z") })));
    expect(await gen(l1)).toEqual({ m: team, l: team });
    await rejected("team_memberships", ...ins("team_memberships", memCols(team, e[3], { membershipRole: "leader" })), /tmb_tenant_open_leader_unique/);
    // تسليم القيادة في نفس اللحظة داخل معاملة واحدة: إغلاق القديم ثم فتح الجديد من نفس الـtimestamp
    const T0 = "2026-10-10T09:30:00.000Z";
    await db.raw.beginTransaction();
    try {
      await close(l1, T0);
      await id(...ins("team_memberships", memCols(team, e[3], { membershipRole: "leader", effectiveFromAt: u(T0) })));
      await db.raw.commit();
    } catch (err) { await db.raw.rollback(); throw err; }
    expect(await leaderAt(team, T0)).toEqual([e[3]]);
    expect(await leaderAt(team, "2026-10-10T09:29:59.999Z")).toEqual([e[2]]);
    expect(await count("team_memberships", "teamId = ? AND membershipRole = 'leader'", [team])).toBe(2);
    // موظف في فريقين لنشاطين مختلفين في نفس الوقت = مسموح (الأداء يُنسب بنشاط الحدث)
    const other = (await q("SELECT id FROM teams WHERE tenantId = ? AND businessId = ? AND isActive = 1", [ta, ba2]))[0].id;
    await id(...ins("team_memberships", memCols(other, e[1])));
    // FK مركّب: موظف/فريق/مُسنِد/مُنهي من شركة أخرى
    await rejected("team_memberships", ...ins("team_memberships", memCols(team, eb)), /fk_tmb_tenant_employee/);
    await rejected("team_memberships", ...ins("team_memberships", { ...memCols(team, eb), tenantId: tb, assignedByEmployeeId: eb }), /fk_tmb_tenant_team/);
    await rejected("team_memberships", ...ins("team_memberships", memCols(team, e[4], { assignedByEmployeeId: eb })), /fk_tmb_tenant_assigner/);
    await rejected("team_memberships", ...ins("team_memberships", memCols(team, e[4], { ...endCols("2026-10-10T11:00:00Z"), endedByEmployeeId: eb })), /fk_tmb_tenant_ender/);
  });

  it("memberships: CHECK — المدى نصف المفتوح، الإغلاق كاملًا أو لا شيء، المفاتيح، المعرّفات الموجبة", async () => {
    const team = (await q("SELECT id FROM teams WHERE tenantId = ? AND businessId = ? AND isActive = 1", [ta, ba3]))[0].id;
    const M = (o: Record<string, unknown>) => ins("team_memberships", memCols(team, e[5], o));
    await rejected("team_memberships", ...M({ ...endCols("2026-10-10T10:00:00.000Z") }), /chk_tmb_range/); // from = to
    await rejected("team_memberships", ...M({ ...endCols("2026-10-10T09:59:59.999Z") }), /chk_tmb_range/);
    await rejected("team_memberships", ...M({ effectiveToAt: u("2026-10-10T11:00:00Z") }), /chk_tmb_end/);
    await rejected("team_memberships", ...M({ ...endCols("2026-10-10T11:00:00Z"), endedByEmployeeId: null }), /chk_tmb_end/);
    await rejected("team_memberships", ...M({ ...endCols("2026-10-10T11:00:00Z"), endIdempotencyKey: null }), /chk_tmb_end/);
    await rejected("team_memberships", ...M({ endedAt: u("2026-10-10T11:00:00Z") }), /chk_tmb_end/);
    expect(await errCode(db.raw.query(...M({ idempotencyKey: null })))).toBe("ER_BAD_NULL_ERROR");
    expect(await errCode(db.raw.query(...M({ payloadHash: null })))).toBe("ER_BAD_NULL_ERROR");
    expect(await errCode(db.raw.query(...M({ membershipRole: "boss" })))).toMatch(/ER_TRUNCATED_WRONG_VALUE_FOR_FIELD|WARN_DATA_TRUNCATED|ER_DATA_TOO_LONG/);
    for (const key of ["", "  spaced key  "]) await rejected("team_memberships", ...M({ idempotencyKey: key }), /chk_tmb_keys/);
    await rejected("team_memberships", ...M({ ...endCols("2026-10-10T11:00:00Z"), endIdempotencyKey: "x" }), /chk_tmb_keys/);
    await rejected("team_memberships", ...M({ payloadHash: "F".repeat(64) }), /chk_tmb_hash/);
    await rejected("team_memberships", ...M({ ...endCols("2026-10-10T11:00:00Z"), endPayloadHash: "nothex" }), /chk_tmb_hash/);
    expect(await errCode(db.raw.query(...M({ openLeaderTeamId: team })))).toBe("ER_NON_DEFAULT_VALUE_FOR_GENERATED_COLUMN");
    await q("SET foreign_key_checks = 0");
    try {
      for (const v of [-1, 0]) {
        await rejected("team_memberships", ...M({ assignedByEmployeeId: v }), /chk_tmb_ids/);
        await rejected("team_memberships", ...ins("team_memberships", memCols(team, v)), /chk_tmb_ids/);
        await rejected("team_memberships", ...M({ ...endCols("2026-10-10T11:00:00Z"), endedByEmployeeId: v }), /chk_tmb_ids/);
      }
    } finally { await q("SET foreign_key_checks = 1"); }
  });

  it("الوقت: UTC بدقة ملّي ثانية، ووردية/عضوية تمر عبر منتصف الليل (القاهرة)", async () => {
    const team = (await q("SELECT id FROM teams WHERE tenantId = ? AND businessId = ? AND isActive = 1", [ta, ba3]))[0].id;
    // 23:00 القاهرة (20:00Z) → 08:00 اليوم التالي (05:00Z)
    const night = await id(...ins("team_memberships", memCols(team, e[6], { effectiveFromAt: u("2026-10-10T20:00:00.000Z"), ...endCols("2026-10-11T05:00:00.000Z") })));
    const activeAt = async (iso: string) => count("team_memberships", "id = ? AND effectiveFromAt <= ? AND (effectiveToAt IS NULL OR ? < effectiveToAt)", [night, u(iso), u(iso)]);
    expect(await activeAt("2026-10-10T23:59:00+03:00")).toBe(1);
    expect(await activeAt("2026-10-11T00:01:00+03:00")).toBe(1);
    expect(await activeAt("2026-10-11T08:00:00+03:00")).toBe(0); // النهاية خارج الفترة
    expect(await activeAt("2026-10-10T22:59:59.999+03:00")).toBe(0);
    // التخزين لحظة UTC: نفس الـepoch مهما كان time_zone للجلسة، والعرض المحلي 23:00
    const c2 = await mysql.createConnection(db.url);
    try {
      await c2.query("SET time_zone = '+03:00'");
      const [[r]] = (await c2.query("SELECT UNIX_TIMESTAMP(effectiveFromAt) * 1000 AS ms, DATE_FORMAT(effectiveFromAt, '%H:%i') AS local FROM team_memberships WHERE id = ?", [night])) as any;
      expect(Number(r.ms)).toBe(Date.parse("2026-10-10T20:00:00.000Z"));
      expect(r.local).toBe("23:00");
    } finally { await c2.end(); }
    // دقة الملّي ثانية محفوظة
    const ms = await id(...ins("team_memberships", memCols(team, e[7], { effectiveFromAt: u("2026-10-10T16:00:00.001Z") })));
    const [row] = await q("SELECT UNIX_TIMESTAMP(effectiveFromAt) * 1000 AS ms FROM team_memberships WHERE id = ?", [ms]);
    expect(Number(row.ms)).toBe(Date.parse("2026-10-10T16:00:00.001Z"));
  });

  it("حدود طبقة القاعدة: التداخل التاريخي بين فترتين مغلقتين لا تمنعه القاعدة — مسؤولية الخدمة (FOR UPDATE) في مرحلتها", async () => {
    const team = (await q("SELECT id FROM teams WHERE tenantId = ? AND businessId = ? AND isActive = 1", [ta, ba3]))[0].id;
    await id(...ins("team_memberships", memCols(team, e[8], { effectiveFromAt: u("2026-10-09T10:00:00Z"), ...endCols("2026-10-09T12:00:00Z") })));
    await id(...ins("team_memberships", memCols(team, e[8], { effectiveFromAt: u("2026-10-09T11:00:00Z"), ...endCols("2026-10-09T13:00:00Z") })));
    expect(await count("team_memberships", "employeeId = ? AND teamId = ?", [e[8], team])).toBe(2);
  });

  it("🏁 تزامن حقيقي (8 اتصالات متوازية لكل حالة): صف واحد فقط ينجح والباقي Duplicate", async () => {
    const N = 8;
    const race = async (build: (i: number) => readonly [string, unknown[]]) => {
      const conns = await Promise.all(Array.from({ length: N }, () => mysql.createConnection(db.url)));
      try {
        await Promise.all(conns.map(c => c.query("SET time_zone = '+00:00'")));
        const results = await Promise.allSettled(conns.map(async (c, i) => {
          await c.beginTransaction();
          try {
            await c.query(...build(i));
            await new Promise(r => setTimeout(r, 150)); // إبقاء القفل مفتوحًا حتى يصطدم الباقون
            await c.commit();
          } catch (err) { await c.rollback(); throw err; }
        }));
        return {
          ok: results.filter(r => r.status === "fulfilled").length,
          codes: [...new Set(results.filter(r => r.status === "rejected").map(r => String((r as PromiseRejectedResult).reason?.code)))],
        };
      } finally { await Promise.all(conns.map(c => c.end())); }
    };
    // (1) فريقان نشطان لنفس النشاط بالتوازي
    const biz = await id("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'race', ?)", [ta, `race-${db.name}`.slice(0, 50)]);
    const r1 = await race(() => ins("teams", teamCols({ businessId: biz, name: "سباق" })));
    expect(r1).toEqual({ ok: 1, codes: ["ER_DUP_ENTRY"] });
    expect(await count("teams", "businessId = ? AND isActive = 1", [biz])).toBe(1);
    const team = (await q("SELECT id FROM teams WHERE businessId = ? AND isActive = 1", [biz]))[0].id;
    // (2) setLeader متزامن لموظفين مختلفين ⇒ قائد مفتوح واحد
    const r2 = await race(i => ins("team_memberships", memCols(team, e[i], { membershipRole: "leader" })));
    expect(r2).toEqual({ ok: 1, codes: ["ER_DUP_ENTRY"] });
    expect(await count("team_memberships", "teamId = ? AND membershipRole = 'leader' AND effectiveToAt IS NULL", [team])).toBe(1);
    // (3) addMember متزامن لنفس الموظف ⇒ عضوية مفتوحة واحدة
    const r3 = await race(() => ins("team_memberships", memCols(team, e[12])));
    expect(r3).toEqual({ ok: 1, codes: ["ER_DUP_ENTRY"] });
    expect(await count("team_memberships", "teamId = ? AND employeeId = ? AND effectiveToAt IS NULL", [team, e[12]])).toBe(1);
    // (4) ضغط مزدوج بنفس مفتاح العملية (موظفون مختلفون) ⇒ تُنفَّذ مرة واحدة
    const key = k("team_member");
    const r4 = await race(i => ins("team_memberships", memCols(team, e[13], { idempotencyKey: key, effectiveFromAt: u(`2026-10-10T1${i}:00:00Z`), ...endCols(`2026-10-10T1${i}:30:00Z`) })));
    expect(r4.ok).toBe(1); expect(r4.codes).toEqual(["ER_DUP_ENTRY"]);
    expect(await count("team_memberships", "tenantId = ? AND idempotencyKey = ?", [ta, key])).toBe(1);
  }, 120_000);

  it("team_task_operations: عملية واحدة لكل (شركة، operationId)، فاعل موجب من نفس الشركة، وحذف المهمة لا يحذف سجل العملية (SET NULL)", async () => {
    const team = (await q("SELECT id FROM teams WHERE tenantId = ? AND businessId = ? AND isActive = 1", [ta, ba3]))[0].id;
    const task = async (title: string) => id("INSERT INTO tasks (businessId, title, createdBy, createdByName) VALUES (?, ?, ?, 'قائد')", [ba3, title, -e[1]]);
    const op = (o: Record<string, unknown>) => ins("team_task_operations", { tenantId: ta, teamId: team, operationId: `opk${Date.now().toString(36)}${++seq}`, payloadHash: H, actorEmployeeId: e[1], ...o });
    const t1 = await task("مهمة 1");
    const opId = "sameOperation01";
    await id(...op({ taskId: t1, operationId: opId }));
    await rejected("team_task_operations", ...op({ taskId: await task("مهمة 2"), operationId: opId }), /tto_tenant_op_idem_unique/);
    await rejected("team_task_operations", ...op({ taskId: t1 }), /tto_task_unique/); // مهمة واحدة لعملية واحدة
    // نفس operationId في شركة أخرى مسموح (فريق وفاعل تلك الشركة)
    const tbTeam = (await q("SELECT id FROM teams WHERE tenantId = ? LIMIT 1", [tb]))[0].id;
    await id(...ins("team_task_operations", { tenantId: tb, teamId: tbTeam, taskId: null, operationId: opId, payloadHash: H, actorEmployeeId: eb }));
    // FK مركّب: فريق/فاعل من شركة أخرى
    await rejected("team_task_operations", ...op({ teamId: tbTeam }), /fk_tto_tenant_team/);
    await rejected("team_task_operations", ...op({ actorEmployeeId: eb }), /fk_tto_tenant_actor/);
    await rejected("team_task_operations", ...op({ taskId: 99_999_999 }), /fk_tto_task/);
    // CHECK: operationId بنفس قاعدة الواجهة، بصمة صغيرة، فاعل موجب حتى مع تعطيل FK
    for (const operationId of ["", "short", "has space 12", "مفتاح-عربي-1234"]) await rejected("team_task_operations", ...op({ operationId }), /chk_tto_operation/);
    await rejected("team_task_operations", ...op({ payloadHash: "A".repeat(64) }), /chk_tto_hash/);
    expect(await errCode(db.raw.query(...op({ operationId: null })))).toBe("ER_BAD_NULL_ERROR");
    await q("SET foreign_key_checks = 0");
    try { for (const v of [-1, 0]) await rejected("team_task_operations", ...op({ actorEmployeeId: v }), /chk_tto_actor/); }
    finally { await q("SET foreign_key_checks = 1"); }
    // حذف المهمة من المسار القديم يبقى ناجحًا، والعملية تبقى بـtaskId = NULL
    await q("DELETE FROM tasks WHERE id = ?", [t1]);
    expect((await q("SELECT taskId FROM team_task_operations WHERE tenantId = ? AND operationId = ?", [ta, opId]))[0].taskId).toBeNull();
    // سباق نفس العملية (8 اتصالات) ⇒ صف واحد
    const conns = await Promise.all(Array.from({ length: 8 }, () => mysql.createConnection(db.url)));
    try {
      const raceOp = `race${Date.now().toString(36)}`;
      const r = await Promise.allSettled(conns.map(async c => {
        await c.beginTransaction();
        try { await c.query(...op({ operationId: raceOp })); await new Promise(res => setTimeout(res, 150)); await c.commit(); }
        catch (err) { await c.rollback(); throw err; }
      }));
      expect(r.filter(x => x.status === "fulfilled")).toHaveLength(1);
      expect(new Set(r.filter(x => x.status === "rejected").map(x => (x as PromiseRejectedResult).reason?.code))).toEqual(new Set(["ER_DUP_ENTRY"]));
    } finally { await Promise.all(conns.map(c => c.end())); }
    // verify يكشف تغيير قاعدة الحذف (CASCADE بدل SET NULL) ثم يعود مطابقًا
    await q("ALTER TABLE team_task_operations DROP FOREIGN KEY fk_tto_task");
    await q("ALTER TABLE team_task_operations ADD CONSTRAINT fk_tto_task FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE");
    const drift = await run(db, "check");
    expect(drift.state).toBe("partial");
    expect(drift.issues.map(i => i.detail).join("\n")).toMatch(/fk_tto_task: ON DELETE CASCADE ≠ SET NULL/);
    await q("ALTER TABLE team_task_operations DROP FOREIGN KEY fk_tto_task");
    await q("ALTER TABLE team_task_operations ADD CONSTRAINT fk_tto_task FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE SET NULL");
    expect((await run(db, "check")).state).toBe("applied");
  }, 120_000);

  it("rollback: يرفض مع بيانات؛ فارغة ⇒ يحذف الجداول الثلاثة فقط ويُبقي الفهرسين المركّبين", async () => {
    expect((await run(db, "rollback")).refused).toBe("not_empty");
    expect((await run(db, "check")).state).toBe("applied");
    await q("SET foreign_key_checks = 0");
    for (const t of [...TEAMS_TABLES].reverse()) await q(`DELETE FROM ${t}`); // قاعدة اختبار مؤقتة فقط
    await q("SET foreign_key_checks = 1");
    expect((await run(db, "rollback", { confirm: "ROLLBACK 0044 TO x" })).refused).toMatch(/عبارة التأكيد/);
    const rb = await run(db, "rollback");
    expect(rb.ok).toBe(true);
    expect((await run(db, "check")).state).toBe("not_applied");
    expect(await count("information_schema.STATISTICS", "TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN ('businesses_tenant_id','employees_tenant_id')")).toBeGreaterThan(0);
    expect(await count("information_schema.TABLES", "TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_activity_events'")).toBe(1);
    // وإعادة التطبيق بعد التراجع نظيفة
    expect((await run(db, "apply")).ok).toBe(true);
  }, 120_000);
});
