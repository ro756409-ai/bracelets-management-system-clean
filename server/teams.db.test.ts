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
import { COOKIE_NAME } from "@shared/const";
import { intervalsOverlap } from "@shared/teamsSpec";
import * as svc from "./teams.service";

/**
 * خدمات الفرق (0044) على MySQL حقيقي: CRUD، العضوية والقيادة المؤرخة، Replay/CONFLICT لكل كتابة بلا تغيير
 * للتاريخ عند Replay، منع التداخل التاريخي بقفل الفريق، الإيقاف يغلق كل المفتوح في نفس اللحظة، عزل الشركات،
 * نطاق القائد الفعّال، الحراس (صلاحية + قيادة)، وتزامن حقيقي باتصالات متوازية.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
let seq = 0;
const op = () => `tm${Date.now().toString(36)}${++seq}xx`;

describe.runIf(CAN)("👥 خدمات الفرق", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const emp: Record<string, number> = {};
  let bizA2 = 0, bizA3 = 0, bizA4 = 0;
  const saved = process.env.TEAMS_ENABLED;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const actor = (k: string, tenantId = A.tenantId): svc.TeamsActor => ({ tenantId, employeeId: emp[k], role: null });
  const allowedA = () => [A.businessId, bizA2, bizA3, bizA4];
  const rowsOf = async (teamId: number) => (await q(
    "SELECT id, employeeId, membershipRole AS role, UNIX_TIMESTAMP(effectiveFromAt) * 1000 AS fromMs, UNIX_TIMESTAMP(effectiveToAt) * 1000 AS toMs, endIdempotencyKey FROM team_memberships WHERE teamId = ? ORDER BY id", [teamId]))
    .map((r: any) => ({ id: Number(r.id), employeeId: Number(r.employeeId), role: r.role as string, fromMs: Number(r.fromMs), toMs: r.toMs == null ? null : Number(r.toMs), endKey: r.endIdempotencyKey as string | null }));
  /** لا تداخل لنفس الموظف، ولا قيادتين متداخلتين، في كل تاريخ الفريق. */
  const assertNoOverlap = async (teamId: number) => {
    const all = await rowsOf(teamId);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.employeeId === b.employeeId) expect(intervalsOverlap(a, b), `employee ${a.employeeId}: ${a.id}/${b.id}`).toBe(false);
      if (a.role === "leader" && b.role === "leader") expect(intervalsOverlap(a, b), `leaders ${a.id}/${b.id}`).toBe(false);
    }
    return all;
  };
  const openLeader = async (teamId: number) => (await rowsOf(teamId)).filter(r => r.role === "leader" && r.toMs === null);

  beforeAll(async () => {
    tmp = await createTempSchema("teams_s");
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [TEAMS_MIGRATION, "drizzle/0044_teams.sql", "0044"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
    await tmp.raw.query("SET time_zone = '+00:00'");
    __setDbForTests(drizzle(tmp.url));
    process.env.TEAMS_ENABLED = "true";
    A = await createCoreTestFixture("tm-a"); B = await createCoreTestFixture("tm-b");
    const biz = async (n: string) => insId(await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, ?, ?)", [A.tenantId, n, `${n}-${tmp.name}`.slice(0, 50)]));
    bizA2 = await biz("farhat"); bizA3 = await biz("race"); bizA4 = await biz("deact");
    const mk = async (k: string, role: string, f: CoreTestFixture, isActive = true) => { emp[k] = insId(await createEmployee({ name: `${k}-tm`, role, isActive, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("owner", "super_admin", A); await mk("manager", "manager", A); await mk("agent", "agent", A);
    for (let i = 1; i <= 12; i++) await mk(`mod${i}`, "moderator", A);
    await mk("inactive", "moderator", A, false);
    await mk("ownerB", "super_admin", B); await mk("modB", "moderator", B);
  }, 240_000);
  afterAll(async () => {
    if (saved == null) delete process.env.TEAMS_ENABLED; else process.env.TEAMS_ENABLED = saved;
    __setDbForTests(null); await tmp?.drop();
  }, 120_000);

  let team = 0;

  it("العلم معطل: الخدمة PRECONDITION_FAILED والمسارات «غير مفعّل» بلا بيانات", async () => {
    process.env.TEAMS_ENABLED = "false";
    try {
      expect(await code(() => svc.createTeam(actor("owner"), { businessId: A.businessId, name: "x", operationId: op() }, allowedA()))).toBe("PRECONDITION_FAILED");
      expect(await (await web(emp.owner)).teams.list()).toEqual({ enabled: false, rows: [] });
      expect(await (await portal(emp.mod1)).employeePortal.team.myTeams()).toEqual({ enabled: false, teams: [] });
    } finally { process.env.TEAMS_ENABLED = "true"; }
  });

  it("إنشاء فريق: Replay بنفس المفتاح والبصمة، CONFLICT لبصمة مختلفة، فريق نشط واحد لكل نشاط، عزل الشركة والفاعل", async () => {
    const o = op();
    const r = await svc.createTeam(actor("owner"), { businessId: A.businessId, name: "فريق أفندي", operationId: o }, allowedA());
    expect(r.replay).toBe(false); team = r.id;
    expect(await svc.createTeam(actor("owner"), { businessId: A.businessId, name: "فريق أفندي", operationId: o }, allowedA())).toEqual({ id: team, replay: true });
    expect(await code(() => svc.createTeam(actor("owner"), { businessId: A.businessId, name: "اسم آخر", operationId: o }, allowedA()))).toBe("CONFLICT");
    expect(await code(() => svc.createTeam(actor("owner"), { businessId: A.businessId, name: "ثانٍ", operationId: op() }, allowedA()))).toBe("CONFLICT");
    expect(Number((await q("SELECT COUNT(*) n FROM teams WHERE tenantId = ?", [A.tenantId]))[0].n)).toBe(1);
    // نشاط شركة أخرى: خارج النطاق = FORBIDDEN، وحتى لو مُرّر في النطاق خطأً = غير موجود
    expect(await code(() => svc.createTeam(actor("owner"), { businessId: B.businessId, name: "x", operationId: op() }, allowedA()))).toBe("FORBIDDEN");
    expect(await code(() => svc.createTeam(actor("owner"), { businessId: B.businessId, name: "x", operationId: op() }, [B.businessId]))).toBe("NOT_FOUND");
    // الفاعل: معرّف سالب/صفر، موظف شركة أخرى، موظف غير نشط
    for (const employeeId of [-1, 0]) expect(await code(() => svc.createTeam({ tenantId: A.tenantId, employeeId, role: "super_admin" }, { businessId: bizA2, name: "x", operationId: op() }, allowedA()))).toBe("FORBIDDEN");
    expect(await code(() => svc.createTeam({ tenantId: A.tenantId, employeeId: emp.ownerB, role: "super_admin" }, { businessId: bizA2, name: "x", operationId: op() }, allowedA()))).toBe("FORBIDDEN");
    expect(await code(() => svc.createTeam(actor("inactive"), { businessId: bizA2, name: "x", operationId: op() }, allowedA()))).toBe("FORBIDDEN");
    // operationId فارغ/قصير مرفوض قبل أي شيء
    await expect(svc.createTeam(actor("owner"), { businessId: bizA2, name: "x", operationId: "" }, allowedA())).rejects.toThrow();
    await expect(svc.createTeam(actor("owner"), { businessId: bizA2, name: "   ", operationId: op() }, allowedA())).rejects.toThrow();
  });

  it("إعادة التسمية: نفس الاسم = بلا تغيير، نسخة قديمة = CONFLICT", async () => {
    const r = await svc.renameTeam(actor("owner"), { teamId: team, name: "فريق أفندي الرئيسي", expectedVersion: 1, operationId: op() });
    expect(r).toMatchObject({ version: 2, replay: false });
    expect(await svc.renameTeam(actor("owner"), { teamId: team, name: "فريق أفندي الرئيسي", expectedVersion: 1, operationId: op() })).toMatchObject({ version: 2, replay: true });
    expect(await code(() => svc.renameTeam(actor("owner"), { teamId: team, name: "ثالث", expectedVersion: 1, operationId: op() }))).toBe("CONFLICT");
    expect(await code(() => svc.renameTeam(actor("ownerB", B.tenantId), { teamId: team, name: "اختراق", expectedVersion: 2, operationId: op() }))).toBe("NOT_FOUND");
  });

  it("العضوية: Replay بلا صف جديد، CONFLICT لبصمة مختلفة/عضو قائم، موظف شركة أخرى أو غير نشط مرفوض", async () => {
    const o = op();
    const m1 = await svc.addMember(actor("owner"), { teamId: team, employeeId: emp.mod1, operationId: o });
    const before = (await rowsOf(team)).length;
    expect(await svc.addMember(actor("owner"), { teamId: team, employeeId: emp.mod1, operationId: o })).toEqual({ membershipId: m1.membershipId, replay: true });
    expect((await rowsOf(team)).length).toBe(before);
    expect(await code(() => svc.addMember(actor("owner"), { teamId: team, employeeId: emp.mod2, operationId: o }))).toBe("CONFLICT");
    expect(await code(() => svc.addMember(actor("owner"), { teamId: team, employeeId: emp.mod1, operationId: op() }))).toBe("CONFLICT");
    expect(await code(() => svc.addMember(actor("owner"), { teamId: team, employeeId: emp.modB, operationId: op() }))).toBe("NOT_FOUND");
    expect(await code(() => svc.addMember(actor("owner"), { teamId: team, employeeId: emp.inactive, operationId: op() }))).toBe("BAD_REQUEST");
    expect(await code(() => svc.addMember(actor("ownerB", B.tenantId), { teamId: team, employeeId: emp.modB, operationId: op() }))).toBe("NOT_FOUND");
    for (const k of ["mod2", "mod3"]) await svc.addMember(actor("owner"), { teamId: team, employeeId: emp[k], operationId: op() });
  });

  it("القيادة المؤرخة: القائد عضو فعّال، التسليم في نفس اللحظة، القديم يعود عضوًا، Replay لا يغيّر التاريخ", async () => {
    expect(await code(() => svc.setLeader(actor("owner"), { teamId: team, employeeId: emp.mod4, operationId: op() }))).toBe("BAD_REQUEST");
    const o1 = op();
    const l1 = await svc.setLeader(actor("owner"), { teamId: team, employeeId: emp.mod1, operationId: o1 });
    expect(l1).toMatchObject({ changed: true, replay: false, previousLeaderEmployeeId: null });
    const snap = await rowsOf(team);
    expect(await svc.setLeader(actor("owner"), { teamId: team, employeeId: emp.mod1, operationId: o1 })).toMatchObject({ membershipId: l1.membershipId, replay: true });
    expect(await rowsOf(team)).toEqual(snap); // Replay: لا إغلاق ولا تاريخ جديد
    expect(await code(() => svc.setLeader(actor("owner"), { teamId: team, employeeId: emp.mod2, operationId: o1 }))).toBe("CONFLICT");
    expect(await rowsOf(team)).toEqual(snap);
    // القائد الحالي نفسه = بلا تغيير
    expect(await svc.setLeader(actor("owner"), { teamId: team, employeeId: emp.mod1, operationId: op() })).toMatchObject({ changed: false });
    // تسليم لـmod2: كل الانتقالات في نفس اللحظة T
    const l2 = await svc.setLeader(actor("owner"), { teamId: team, employeeId: emp.mod2, operationId: op() });
    expect(l2.previousLeaderEmployeeId).toBe(emp.mod1);
    const all = await assertNoOverlap(team);
    const T = l2.fromMs!;
    const oldLeader = all.find(r => r.id === l1.membershipId)!;
    expect(oldLeader.toMs).toBe(T);
    expect(all.find(r => r.employeeId === emp.mod1 && r.role === "member" && r.toMs === null)?.fromMs).toBe(T);
    expect(all.find(r => r.employeeId === emp.mod2 && r.role === "member")?.toMs).toBe(T);
    expect(await openLeader(team)).toEqual([expect.objectContaining({ employeeId: emp.mod2, fromMs: T })]);
    const atT = await svc.teamMembersAt(A.tenantId, team, T);
    expect(atT.filter(m => m.membershipRole === "leader").map(m => m.employeeId)).toEqual([emp.mod2]);
    const before = await svc.teamMembersAt(A.tenantId, team, T - 1);
    expect(before.filter(m => m.membershipRole === "leader").map(m => m.employeeId)).toEqual([emp.mod1]);
    // إنهاء القيادة بلا بديل: يعود عضوًا من نفس اللحظة، وReplay بلا تغيير
    const o2 = op();
    const e1 = await svc.endLeadership(actor("owner"), { teamId: team, operationId: o2 });
    const snap2 = await rowsOf(team);
    expect(await svc.endLeadership(actor("owner"), { teamId: team, operationId: o2 })).toMatchObject({ replay: true });
    expect(await rowsOf(team)).toEqual(snap2);
    expect(await openLeader(team)).toEqual([]);
    expect(snap2.find(r => r.employeeId === emp.mod2 && r.role === "member" && r.toMs === null)?.fromMs).toBe(e1.toMs);
    expect(await code(() => svc.endLeadership(actor("owner"), { teamId: team, operationId: op() }))).toBe("CONFLICT");
    await svc.setLeader(actor("owner"), { teamId: team, employeeId: emp.mod1, operationId: op() });
    await assertNoOverlap(team);
  });

  it("إنهاء عضوية: Replay لا يغيّر effectiveToAt، CONFLICT لبصمة مختلفة أو عضوية منتهية، وإعادة الإضافة بلا تداخل", async () => {
    const m3 = (await rowsOf(team)).find(r => r.employeeId === emp.mod3 && r.toMs === null)!;
    const o = op();
    const r = await svc.endMembership(actor("owner"), { membershipId: m3.id, operationId: o });
    expect(r.replay).toBe(false);
    await new Promise(res => setTimeout(res, 15));
    expect(await svc.endMembership(actor("owner"), { membershipId: m3.id, operationId: o })).toEqual({ membershipId: m3.id, toMs: r.toMs, replay: true });
    expect((await rowsOf(team)).find(x => x.id === m3.id)!.toMs).toBe(r.toMs);
    const m2 = (await rowsOf(team)).find(x => x.employeeId === emp.mod2 && x.toMs === null)!;
    expect(await code(() => svc.endMembership(actor("owner"), { membershipId: m2.id, operationId: o }))).toBe("CONFLICT");
    expect(await code(() => svc.endMembership(actor("owner"), { membershipId: m3.id, operationId: op() }))).toBe("CONFLICT");
    expect(await code(() => svc.endMembership(actor("ownerB", B.tenantId), { membershipId: m2.id, operationId: op() }))).toBe("NOT_FOUND");
    const again = await svc.addMember(actor("owner"), { teamId: team, employeeId: emp.mod3, operationId: op() });
    expect(again.fromMs!).toBeGreaterThanOrEqual(r.toMs!);
    await assertNoOverlap(team);
  });

  it("التداخل التاريخي تمنعه الخدمة (لا القاعدة): فترة مغلقة تنتهي في المستقبل ⇒ CONFLICT بلا أي تغيير", async () => {
    const t2 = (await svc.createTeam(actor("owner"), { businessId: bizA2, name: "فريق فرحات", operationId: op() }, allowedA())).id;
    const H = "c".repeat(64);
    const future = "DATE_ADD(NOW(3), INTERVAL 1 HOUR)";
    const raw = (employeeId: number, role: string, k: string) => q(`INSERT INTO team_memberships (tenantId, teamId, employeeId, membershipRole, effectiveFromAt, effectiveToAt, assignedByEmployeeId, idempotencyKey, payloadHash, endedAt, endedByEmployeeId, endIdempotencyKey, endPayloadHash)
      VALUES (?, ?, ?, ?, DATE_SUB(NOW(3), INTERVAL 1 HOUR), ${future}, ?, ?, ?, NOW(3), ?, ?, ?)`, [A.tenantId, t2, employeeId, role, emp.owner, `raw:${k}${seq++}`, H, emp.owner, `rawend:${k}${seq++}`, H]);
    await raw(emp.mod5, "member", "m5");
    const n = (await rowsOf(t2)).length;
    expect(await code(() => svc.addMember(actor("owner"), { teamId: t2, employeeId: emp.mod5, operationId: op() }))).toBe("CONFLICT");
    expect((await rowsOf(t2)).length).toBe(n);
    // قيادة سابقة (مغلقة) تنتهي في المستقبل ⇒ لا قائد جديد متداخل
    await raw(emp.mod6, "leader", "l6");
    await svc.addMember(actor("owner"), { teamId: t2, employeeId: emp.mod7, operationId: op() });
    const n2 = (await rowsOf(t2)).length;
    expect(await code(() => svc.setLeader(actor("owner"), { teamId: t2, employeeId: emp.mod7, operationId: op() }))).toBe("CONFLICT");
    expect((await rowsOf(t2)).length).toBe(n2);
    expect(await openLeader(t2)).toEqual([]);
  });

  it("🏁 تزامن حقيقي على مستوى الخدمة (اتصالات متوازية)", async () => {
    const settle = async (fns: (() => Promise<any>)[]) => {
      const r = await Promise.allSettled(fns.map(f => f()));
      return { ok: r.filter(x => x.status === "fulfilled").map(x => (x as PromiseFulfilledResult<any>).value), codes: r.filter(x => x.status === "rejected").map(x => (x as PromiseRejectedResult).reason?.code) };
    };
    // (1) إنشاء متوازٍ لنفس النشاط ⇒ فريق واحد
    const c = await settle(Array.from({ length: 6 }, (_, i) => () => svc.createTeam(actor("owner"), { businessId: bizA3, name: `سباق ${i}`, operationId: op() }, allowedA())));
    expect(c.ok).toHaveLength(1); expect(new Set(c.codes)).toEqual(new Set(["CONFLICT"]));
    const rt = c.ok[0].id as number;
    // (2) إضافة نفس الموظف بالتوازي بعمليات مختلفة ⇒ عضوية واحدة
    const a = await settle(Array.from({ length: 5 }, () => () => svc.addMember(actor("owner"), { teamId: rt, employeeId: emp.mod8, operationId: op() })));
    expect(a.ok).toHaveLength(1); expect(new Set(a.codes)).toEqual(new Set(["CONFLICT"]));
    for (const k of ["mod9", "mod10", "mod11", "mod12"]) await svc.addMember(actor("owner"), { teamId: rt, employeeId: emp[k], operationId: op() });
    // (3) ضغط مزدوج (نفس operationId) على setLeader ⇒ صف قيادة واحد ونفس النتيجة للجميع
    const same = op();
    const d = await settle(Array.from({ length: 4 }, () => () => svc.setLeader(actor("owner"), { teamId: rt, employeeId: emp.mod8, operationId: same })));
    expect(d.codes).toEqual([]);
    expect(new Set(d.ok.map(x => x.membershipId)).size).toBe(1);
    expect(d.ok.filter(x => !x.replay)).toHaveLength(1);
    expect((await rowsOf(rt)).filter(r => r.role === "leader")).toHaveLength(1);
    // (4) setLeader متوازٍ لأربعة أعضاء ⇒ تتسلسل بقفل الفريق: قائد مفتوح واحد وتاريخ بلا تداخل
    const s = await settle(["mod9", "mod10", "mod11", "mod12"].map(k => () => svc.setLeader(actor("owner"), { teamId: rt, employeeId: emp[k], operationId: op() })));
    expect(s.codes).toEqual([]);
    expect(await openLeader(rt)).toHaveLength(1);
    const hist = await assertNoOverlap(rt);
    expect(hist.filter(r => r.role === "leader")).toHaveLength(5);
    // (5) إيقاف متوازٍ بعمليات مختلفة ⇒ مرة واحدة
    const x = await settle(Array.from({ length: 4 }, () => () => svc.deactivateTeam(actor("owner"), { teamId: rt, operationId: op() })));
    expect(x.ok).toHaveLength(1); expect(new Set(x.codes)).toEqual(new Set(["CONFLICT"]));
  }, 120_000);

  it("الإيقاف: يغلق كل العضويات والقيادة المفتوحة بنفس اللحظة، بلا حذف، Replay بلا تغيير، وكل كتابة لاحقة مرفوضة", async () => {
    const t4 = (await svc.createTeam(actor("owner"), { businessId: bizA4, name: "فريق للإيقاف", operationId: op() }, allowedA())).id;
    for (const k of ["mod1", "mod2", "mod3"]) await svc.addMember(actor("owner"), { teamId: t4, employeeId: emp[k], operationId: op() });
    await svc.setLeader(actor("owner"), { teamId: t4, employeeId: emp.mod1, operationId: op() });
    const before = await rowsOf(t4);
    const o = op();
    const d = await svc.deactivateTeam(actor("owner"), { teamId: t4, operationId: o });
    expect(d).toMatchObject({ closedMemberships: 3, replay: false });
    const after = await rowsOf(t4);
    expect(after.map(r => r.id)).toEqual(before.map(r => r.id)); // لا حذف
    expect(after.filter(r => r.toMs === null)).toEqual([]);
    expect(new Set(after.filter(r => before.find(b => b.id === r.id)!.toMs === null).map(r => r.toMs))).toEqual(new Set([d.deactivatedAtMs]));
    const [t] = await q("SELECT isActive, UNIX_TIMESTAMP(deactivatedAt) * 1000 AS ms, activeBusinessId FROM teams WHERE id = ?", [t4]);
    expect([Number(t.isActive), Number(t.ms), t.activeBusinessId]).toEqual([0, d.deactivatedAtMs, null]);
    await new Promise(r => setTimeout(r, 15));
    expect(await svc.deactivateTeam(actor("owner"), { teamId: t4, operationId: o })).toEqual({ id: t4, deactivatedAtMs: d.deactivatedAtMs, closedMemberships: 3, replay: true });
    expect(await rowsOf(t4)).toEqual(after);
    expect(await code(() => svc.deactivateTeam(actor("owner"), { teamId: team, operationId: o }))).toBe("CONFLICT"); // نفس المفتاح لفريق آخر
    // كل كتابة لاحقة على الموقوف مرفوضة
    const m = after[0].id;
    for (const f of [
      () => svc.addMember(actor("owner"), { teamId: t4, employeeId: emp.mod4, operationId: op() }),
      () => svc.setLeader(actor("owner"), { teamId: t4, employeeId: emp.mod2, operationId: op() }),
      () => svc.endLeadership(actor("owner"), { teamId: t4, operationId: op() }),
      () => svc.endMembership(actor("owner"), { membershipId: m, operationId: op() }),
      () => svc.renameTeam(actor("owner"), { teamId: t4, name: "جديد", expectedVersion: 2, operationId: op() }),
      () => svc.deactivateTeam(actor("owner"), { teamId: t4, operationId: op() }),
    ]) expect(await code(f)).toBe("CONFLICT");
    expect(await rowsOf(t4)).toEqual(after);
    // النشاط يقبل فريقًا جديدًا بعد الإيقاف، والقديم باقٍ
    await svc.createTeam(actor("owner"), { businessId: bizA4, name: "فريق جديد", operationId: op() }, allowedA());
    expect(Number((await q("SELECT COUNT(*) n FROM teams WHERE businessId = ?", [bizA4]))[0].n)).toBe(2);
  });

  it("نطاق القائد الفعّال: القائد فقط، فريق نشط، نفس الشركة؛ غير القائد = []", async () => {
    expect((await svc.leaderTeams(actor("mod1"))).map(t => t.teamId)).toEqual([team]);
    expect(await svc.leaderTeams(actor("mod3"))).toEqual([]); // عضو لا قائد
    expect(await svc.leaderTeams(actor("manager"))).toEqual([]); // صلاحيات بلا قيادة
    expect(await svc.leaderTeams({ tenantId: B.tenantId, employeeId: emp.mod1, role: "moderator" })).toEqual([]);
    expect(await svc.leaderTeams({ tenantId: A.tenantId, employeeId: -5, role: "super_admin" })).toEqual([]);
    expect(await code(() => svc.requireLeaderOf(actor("mod3"), team))).toBe("FORBIDDEN");
    await expect(svc.assertAssignableTeamMember(A.tenantId, team, emp.mod2)).resolves.toBeUndefined();
    expect(await code(() => svc.assertAssignableTeamMember(A.tenantId, team, emp.mod5))).toBe("FORBIDDEN");
    expect(await code(() => svc.assertAssignableTeamMember(A.tenantId, team, emp.modB))).toBe("FORBIDDEN");
    const scope = await svc.teamAttributionScope(A.tenantId, team, 0, Date.now() + 3_600_000);
    expect(scope.team).toEqual({ tenantId: A.tenantId, businessId: A.businessId });
    expect(scope.intervals.some(i => i.employeeId === emp.mod1)).toBe(true);
    expect(await code(() => svc.teamAttributionScope(B.tenantId, team, 0, Date.now()))).toBe("NOT_FOUND");
  });

  it("الحراس — البوابة: الصلاحية وحدها لا تكفي؛ القائد يرى فريقه فقط؛ السحب لشركة يمنع فورًا", async () => {
    expect((await (await portal(emp.mod1)).employeePortal.team.myTeams()).teams.map(t => t.teamId)).toEqual([team]);
    expect(await (await portal(emp.mod3)).employeePortal.team.myTeams()).toEqual({ enabled: true, teams: [] });
    expect(await code(async () => (await portal(emp.agent)).employeePortal.team.myTeams())).toBe("FORBIDDEN");
    const m = await (await portal(emp.mod1)).employeePortal.team.members({ teamId: team });
    expect(m.members.map((x: any) => x.employeeId).sort()).toEqual([emp.mod1, emp.mod2, emp.mod3].sort());
    expect(await code(async () => (await portal(emp.mod3)).employeePortal.team.members({ teamId: team }))).toBe("FORBIDDEN");
    const farhat = Number((await q("SELECT id FROM teams WHERE businessId = ? AND isActive = 1", [bizA2]))[0].id);
    expect(await code(async () => (await portal(emp.mod1)).employeePortal.team.members({ teamId: farhat }))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(emp.modB)).employeePortal.team.members({ teamId: team }))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(emp.mod1)).employeePortal.team.members({ teamId: team, tenantId: B.tenantId } as any))).toBe("BAD_REQUEST");
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'moderator', 'teams.view_own', 0, ?)", [A.tenantId, emp.owner]);
    try { expect(await code(async () => (await portal(emp.mod1)).employeePortal.team.myTeams())).toBe("FORBIDDEN"); }
    finally { await q("DELETE FROM tenant_role_permissions WHERE tenantId = ? AND role = 'moderator' AND permission = 'teams.view_own'", [A.tenantId]); }
  });

  it("الحراس — الويب: المالك فقط افتراضيًا، المدير بالمنح، strict بلا هوية من العميل، وعزل الشركة", async () => {
    const owner = await web(emp.owner);
    const list = await owner.teams.list({ includeInactive: true });
    expect(list.enabled && list.rows.every((r: any) => [A.businessId, bizA2, bizA3, bizA4].includes(r.businessId))).toBe(true);
    expect(list.enabled && list.rows.find((r: any) => r.id === team)).toMatchObject({ leaderEmployeeId: emp.mod1, activeMembers: 3 });
    const h = await owner.teams.history({ teamId: team });
    expect(h.enabled && h.history.length).toBeGreaterThan(5);
    expect(await code(() => (web(emp.ownerB) as any).then((c: any) => c.teams.get({ teamId: team })))).toBe("NOT_FOUND");
    expect(await code(async () => (await web(emp.manager)).teams.list())).toBe("FORBIDDEN");
    expect(await code(async () => (await web(emp.manager)).teams.create({ businessId: bizA2, name: "x", operationId: op() }))).toBe("FORBIDDEN");
    // المشرف على الويب: جلسة غير إدارية مرفوضة أصلًا (UNAUTHORIZED) أو بالصلاحية (FORBIDDEN) — لا وصول في الحالتين
    expect(await code(async () => (await web(emp.mod1)).teams.list())).toMatch(/^(FORBIDDEN|UNAUTHORIZED)$/);
    expect(await code(async () => (await web(emp.mod1)).teams.addMember({ teamId: team, employeeId: emp.mod4, operationId: op() }))).toMatch(/^(FORBIDDEN|UNAUTHORIZED)$/);
    expect(await code(() => owner.teams.addMember({ teamId: team, employeeId: emp.mod4, operationId: op(), tenantId: B.tenantId } as any))).toBe("BAD_REQUEST");
    expect(await code(() => owner.teams.create({ businessId: bizA2, name: "x", operationId: "" }))).toBe("BAD_REQUEST");
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'manager', 'teams.view_all', 1, ?)", [A.tenantId, emp.owner]);
    try { expect((await (await web(emp.manager)).teams.list()).enabled).toBe(true); }
    finally { await q("DELETE FROM tenant_role_permissions WHERE tenantId = ? AND role = 'manager' AND permission = 'teams.view_all'", [A.tenantId]); }
    // لا تعديل على orders/tasks: الخدمة لا تكتب خارج جدولي الفرق
    const src = fs.readFileSync("server/teams.service.ts", "utf-8");
    expect(src).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+(?!teams\b|team_memberships\b)\w+/);
  });
});
