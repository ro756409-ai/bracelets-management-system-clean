import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { TEAMS_MIGRATION } from "./teamsMigration";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import * as teams from "./teams.service";

/**
 * employeePortal.team.myTeams يرجع businessName من علاقة الفريق ← النشاط الموثوقة (نفس الشركة) — حقل مضاف فقط:
 * نص غير فارغ لكل فريق يقوده الموظف الآن، اسم نشاط فريقه هو لا غيره (قائد لفريقين)، عزل Tenant A/B، ونشاط الفريق
 * لا يمكن حذفه ما دام الفريق موجودًا (FK RESTRICT) فلا توجد حالة «نشاط مفقود».
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
let seq = 0;
const op = () => `bn${Date.now().toString(36)}${++seq}xx`;

describe.runIf(CAN)("🏷️ myTeams.businessName", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  let A2 = 0, T1 = 0, T2 = 0, TB = 0;
  let savedFlag: string | undefined;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const owner = (tenantId: number, id: number): teams.TeamsActor => ({ tenantId, employeeId: id, role: "super_admin" });
  const lead = async (tenantId: number, ownerId: number, teamId: number, employeeId: number) => {
    await teams.addMember(owner(tenantId, ownerId), { teamId, employeeId, operationId: op() });
    await teams.setLeader(owner(tenantId, ownerId), { teamId, employeeId, operationId: op() });
  };
  const nameOf = async (businessId: number) => String((await q("SELECT name FROM businesses WHERE id = ?", [businessId]))[0].name);

  beforeAll(async () => {
    tmp = await createTempSchema("team_bizname");
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [TEAMS_MIGRATION, "drizzle/0044_teams.sql", "0044"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    savedFlag = process.env.TEAMS_ENABLED; process.env.TEAMS_ENABLED = "true";
    A = await createCoreTestFixture("bn-a"); B = await createCoreTestFixture("bn-b");
    A2 = insId(await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, ?, ?)", [A.tenantId, "نشاط فرحات", `farhat-${tmp.name}`.slice(0, 50)]));
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-bn`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("owner", "super_admin", A); await mk("L", "moderator", A); await mk("solo", "moderator", A); await mk("member", "moderator", A); // صلاحية view_own بلا قيادة (عضو فقط)
    await mk("ownerB", "super_admin", B); await mk("LB", "moderator", B);
    T1 = (await teams.createTeam(owner(A.tenantId, e.owner), { businessId: A.businessId, name: "فريق أفندي", operationId: op() }, [A.businessId, A2])).id;
    T2 = (await teams.createTeam(owner(A.tenantId, e.owner), { businessId: A2, name: "فريق فرحات", operationId: op() }, [A.businessId, A2])).id;
    TB = (await teams.createTeam(owner(B.tenantId, e.ownerB), { businessId: B.businessId, name: "فريق B", operationId: op() }, [B.businessId])).id;
    await lead(A.tenantId, e.owner, T1, e.L); await lead(A.tenantId, e.owner, T2, e.L); // قائد لفريقين
    await teams.addMember(owner(A.tenantId, e.owner), { teamId: T1, employeeId: e.member, operationId: op() });
    await lead(B.tenantId, e.ownerB, TB, e.LB);
  }, 300_000);
  afterAll(async () => {
    if (savedFlag == null) delete process.env.TEAMS_ENABLED; else process.env.TEAMS_ENABLED = savedFlag;
    __setDbForTests(null); await tmp?.drop();
  }, 120_000);

  it("قائد لفريقين: لكل فريق اسم نشاطه الحقيقي (نص غير فارغ) — الحقل مضاف والباقي كما هو", async () => {
    const r = await (await portal(e.L)).employeePortal.team.myTeams();
    expect(r.enabled).toBe(true);
    expect(r.teams).toEqual([
      { teamId: T1, businessId: A.businessId, name: "فريق أفندي", businessName: await nameOf(A.businessId) },
      { teamId: T2, businessId: A2, name: "فريق فرحات", businessName: "نشاط فرحات" },
    ]);
    for (const t of r.teams) expect(t.businessName.trim().length).toBeGreaterThan(0);
  });

  it("Tenant A/B: قائد B يرى نشاط شركته فقط، ولا يظهر له أي اسم من A؛ العضو/غير القائد = لا فرق", async () => {
    const rb = await (await portal(e.LB)).employeePortal.team.myTeams();
    expect(rb.teams).toEqual([{ teamId: TB, businessId: B.businessId, name: "فريق B", businessName: await nameOf(B.businessId) }]);
    const aNames = [await nameOf(A.businessId), "نشاط فرحات"];
    expect(rb.teams.some(t => aNames.includes(t.businessName))).toBe(false);
    expect((await (await portal(e.member)).employeePortal.team.myTeams()).teams).toEqual([]);
    expect((await (await portal(e.solo)).employeePortal.team.myTeams()).teams).toEqual([]);
  });

  it("الاسم يأتي من صف النشاط الحالي (إعادة التسمية تنعكس) — لا من العميل ولا من نسخة مخزّنة", async () => {
    await q("UPDATE businesses SET name = ? WHERE id = ?", ["فرحات الجديد", A2]);
    const r = await (await portal(e.L)).employeePortal.team.myTeams();
    expect(r.teams.find(t => t.teamId === T2)?.businessName).toBe("فرحات الجديد");
    // الإدخال صارم: لا مدخلات أصلًا لـmyTeams، فلا مسار لتمرير اسم من العميل
    await expect((await portal(e.L)).employeePortal.team.myTeams({ businessName: "مزيف" } as any)).resolves.toMatchObject({ enabled: true });
    expect((await (await portal(e.L)).employeePortal.team.myTeams()).teams.map(t => t.businessName)).not.toContain("مزيف");
  });

  it("نشاط فريق قائم لا يُحذف (FK RESTRICT) ⇒ لا حالة «نشاط مفقود»، والصف باقٍ", async () => {
    let err: any = null;
    try { await q("DELETE FROM businesses WHERE id = ?", [A2]); } catch (x) { err = x; }
    expect(err).not.toBeNull();
    expect(String(err?.code ?? "")).toMatch(/ER_ROW_IS_REFERENCED/);
    expect((await q("SELECT COUNT(*) AS n FROM businesses WHERE id = ?", [A2]))[0].n).toBe(1);
    expect((await (await portal(e.L)).employeePortal.team.myTeams()).teams.map(t => t.teamId)).toEqual([T1, T2]);
  });
});
