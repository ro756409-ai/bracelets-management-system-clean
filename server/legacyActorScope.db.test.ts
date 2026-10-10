import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { and, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee, getDb } from "./db";
import { broadcastMessages, tasks } from "../drizzle/schema";
import { broadcastScopeCondition, taskScopeCondition, type TeamScope } from "./teamScope";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { COOKIE_NAME } from "@shared/const";

/**
 * عقد الفاعل في الصفوف القديمة (businessId = NULL) للمهام والرسائل الجماعية — على MySQL حقيقي:
 *   السالب = employees.id فقط؛ الموجب = users.id فقط (يُثبت بـemployees.userId في شركة واحدة)؛ الصفر/NULL = لا أحد؛
 *   الاسم ليس دليلًا؛ غير المثبت مخفي عن كل الشركات؛ النشاط (businessId) يبقى المصدر الأساسي.
 * تصادم مقصود: users.id موجب في B يساوي employees.id في A (بنفس الاسم وباسم مختلف) ⇒ لا تسريب لـA.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

describe.runIf(CAN)("🔏 عقد الفاعل للصفوف القديمة (مهام + رسائل جماعية)", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  const tag = `lgc${Date.now().toString(36)}`;
  const base = 800_000_000 + Math.floor(Math.random() * 1_000_000);
  // أرقام تصادم مقصودة (employees.id صريح في A، وusers.id بنفس الرقم مربوط بموظف في B)
  const N = base + 1, M = base + 2, P = base + 3, Q = base + 4, R = base + 5;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const emp = async (o: { id?: number; name: string; role: string; f: CoreTestFixture | null; userId?: number | null; tenantNull?: boolean }) =>
    o.id != null || o.userId != null || o.tenantNull
      ? insId(await q("INSERT INTO employees (" + (o.id != null ? "id, " : "") + "name, role, isActive, tenantId, businessId, username, userId) VALUES (" + (o.id != null ? "?, " : "") + "?, ?, 1, ?, ?, ?, ?)",
          [...(o.id != null ? [o.id] : []), o.name, o.role, o.tenantNull ? null : o.f!.tenantId, o.tenantNull ? null : o.f!.businessId, `${o.name}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 50), o.userId ?? null]))
      : insId(await createEmployee({ name: o.name, role: o.role, isActive: true, tenantId: o.f!.tenantId, businessId: o.f!.businessId, username: `${o.name}_${tag}`.slice(0, 50) } as any));
  const task = async (title: string, createdBy: number | null, createdByName: string, businessId: number | null = null) =>
    insId(await q("INSERT INTO tasks (businessId, title, assignedTo, createdBy, createdByName) VALUES (?, ?, NULL, ?, ?)", [businessId, `${tag} ${title}`, createdBy, createdByName]));
  const msg = async (text: string, sentBy: number | null, sentByName: string, businessId: number | null = null) =>
    insId(await q("INSERT INTO broadcast_messages (businessId, message, sentBy, sentByName, isActive) VALUES (?, ?, ?, ?, 1)", [businessId, `${tag} ${text}`, sentBy, sentByName]));
  const ids: Record<string, number> = {};
  const scopeA = (): TeamScope => ({ tenantId: A.tenantId, businessIds: [A.businessId] });
  const scopeB = (): TeamScope => ({ tenantId: B.tenantId, businessIds: [B.businessId] });
  const visibleTasks = async (scope: TeamScope) => (await (await getDb())!.select({ id: tasks.id }).from(tasks).where(and(like(tasks.title, `${tag}%`), taskScopeCondition(scope)))).map(r => r.id).sort();
  const visibleMsgs = async (scope: TeamScope) => (await (await getDb())!.select({ id: broadcastMessages.id }).from(broadcastMessages).where(and(like(broadcastMessages.message, `${tag}%`), broadcastScopeCondition(scope)))).map(r => r.id).sort();

  beforeAll(async () => {
    tmp = await createTempSchema("legacy_actor");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("lg-a"); B = await createCoreTestFixture("lg-b");
    // المعرّفات الصريحة أولًا (الإدراج الصريح يرفع AUTO_INCREMENT بعده):
    // N: موظف A رقمه N، ومستخدم N مربوط بموظف في B — **نفس الاسم**؛ M: نفس التصادم بأسماء مختلفة؛
    // P: موظف A رقمه P ولا يوجد أي ربط userId = P (الحالة التي كانت تُنسب لـA بالاسم)
    await emp({ id: N, name: "سارة المشتركة", role: "agent", f: A });
    await emp({ id: M, name: "منى", role: "agent", f: A });
    await emp({ id: P, name: "بلا ربط", role: "agent", f: A });
    await emp({ name: "سارة المشتركة", role: "agent", f: B, userId: N });
    await emp({ name: "مها", role: "agent", f: B, userId: M });
    e.ownerA = await emp({ name: "مالك أ", role: "super_admin", f: A });
    e.agentA = await emp({ name: "موظف أ", role: "agent", f: A });
    e.ownerB = await emp({ name: "مالك ب", role: "super_admin", f: B });
    e.agentB = await emp({ name: "موظف ب", role: "agent", f: B });
    // Q: مستخدم مربوط بموظفين في الشركتين ⇒ غير قاطع
    await emp({ name: "مزدوج أ", role: "agent", f: A, userId: Q });
    await emp({ name: "مزدوج ب", role: "agent", f: B, userId: Q });
    // R: مستخدم مربوط بموظف في A وبموظف بلا شركة ⇒ غير قاطع
    await emp({ name: "ربط أ", role: "agent", f: A, userId: R });
    await emp({ name: "ربط بلا شركة", role: "agent", f: null, userId: R, tenantNull: true });
    // الصفر وNULL: الأعمدة NOT NULL في المخطط — نسمح بـNULL في هذه القاعدة المؤقتة فقط لمحاكاة صف قديم شاذ
    await q("ALTER TABLE tasks MODIFY createdBy int NULL");
    await q("ALTER TABLE broadcast_messages MODIFY sentBy int NULL");

    for (const [k, by, name] of [
      ["posSameName", N, "سارة المشتركة"], ["posDiffName", M, "منى"], ["posDiffName2", M, "مها"], ["posNoLink", P, "بلا ربط"],
      ["posAmbiguous", Q, "مزدوج أ"], ["posTenantNull", R, "ربط أ"],
      ["negA", -e.agentA, "اسم لا يطابق"], ["negB", -e.agentB, "موظف ب"], ["negMissing", -(base + 99), "غير موجود"],
      ["zero", 0, "موظف أ"], ["nul", null, "موظف أ"],
    ] as const) { ids[`t_${k}`] = await task(k, by as any, name); ids[`m_${k}`] = await msg(k, by as any, name); }
    // businessId موجود: المصدر الأساسي حتى لو الفاعل من الشركة الأخرى
    ids.t_bizA = await task("bizA", -e.agentB, "موظف ب", A.businessId);
    ids.m_bizB = await msg("bizB", -e.agentA, "موظف أ", B.businessId);
  }, 240_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("المهام: السالب موظف فقط، الموجب مستخدم مثبت بربط شركة واحدة فقط، الصفر/NULL لا أحد، والنشاط هو الأساس", async () => {
    expect(await visibleTasks(scopeA())).toEqual([ids.t_negA, ids.t_bizA].sort());
    expect(await visibleTasks(scopeB())).toEqual([ids.t_posSameName, ids.t_posDiffName, ids.t_posDiffName2, ids.t_negB].sort());
  });

  it("الرسائل الجماعية: نفس العقد بالضبط", async () => {
    expect(await visibleMsgs(scopeA())).toEqual([ids.m_negA].sort());
    expect(await visibleMsgs(scopeB())).toEqual([ids.m_posSameName, ids.m_posDiffName, ids.m_posDiffName2, ids.m_negB, ids.m_bizB].sort());
  });

  it("تصادم users.id في B = employees.id في A (بنفس الاسم وباسم مختلف): لا تسريب لـA، ولا يُفسَّر الموجب موظفًا", async () => {
    for (const k of ["posSameName", "posDiffName", "posDiffName2", "posNoLink"]) {
      expect(await visibleTasks(scopeA()), k).not.toContain(ids[`t_${k}`]);
      expect(await visibleMsgs(scopeA()), k).not.toContain(ids[`m_${k}`]);
    }
  });

  it("صفوف غير مثبتة قطعيًا (بلا ربط، ربط مزدوج، ربط بلا شركة، سالب لموظف غير موجود، صفر، NULL) مخفية عن الجميع", async () => {
    const hidden = ["posNoLink", "posAmbiguous", "posTenantNull", "negMissing", "zero", "nul"];
    for (const s of [scopeA(), scopeB(), { tenantId: A.tenantId, businessIds: [] }]) for (const k of hidden) {
      expect(await visibleTasks(s), k).not.toContain(ids[`t_${k}`]);
      expect(await visibleMsgs(s), k).not.toContain(ids[`m_${k}`]);
    }
  });

  it("عبر المسارات الفعلية: مالك A وموظف A ومالك B لا يرون أي صف غير مثبت، وكل منهم يرى المثبت لشركته فقط", async () => {
    const titles = (rows: any[]) => rows.map(r => String(r.title)).filter(t => t.startsWith(tag)).map(t => t.slice(tag.length + 1)).sort();
    expect(titles(await (await web(e.ownerA)).tasks.list({}))).toEqual(["bizA", "negA"]);
    expect(titles(await (await portal(e.agentA)).employeePortal.tasks.listMine({}))).toEqual(["bizA", "negA"]);
    expect(titles(await (await web(e.ownerB)).tasks.list({}))).toEqual(["negB", "posDiffName", "posDiffName2", "posSameName"]);
    // الرسالة النشطة: نُبقي صفًا قديمًا واحدًا نشطًا في كل مرة ونتحقق من ظهوره لمن يثبت له فقط
    const only = async (k: string) => { await q("UPDATE broadcast_messages SET isActive = 0 WHERE message LIKE ?", [`${tag}%`]); await q("UPDATE broadcast_messages SET isActive = 1 WHERE id = ?", [ids[`m_${k}`]]); };
    const active = async (id: number, viaPortal: boolean) => ((viaPortal ? (await portal(id)).employeePortal.activeBroadcast() : (await web(id)).broadcast.getActive()) as Promise<any>).then(m => m?.message ?? null);
    await only("posSameName");
    expect(await active(e.ownerA, false)).toBeNull(); expect(await active(e.agentA, true)).toBeNull();
    expect(await active(e.ownerB, false)).toBe(`${tag} posSameName`);
    for (const k of ["posNoLink", "zero", "nul", "posAmbiguous"]) {
      await only(k);
      for (const [id, viaPortal] of [[e.ownerA, false], [e.agentA, true], [e.ownerB, false], [e.agentB, true]] as const) expect(await active(id, viaPortal), k).toBeNull();
    }
    await only("negA");
    expect(await active(e.agentA, true)).toBe(`${tag} negA`);
    expect(await active(e.ownerB, false)).toBeNull();
  });

  it("الصفوف غير المثبتة لا تُعدَّل من أي شركة (الإلغاء/الحالة)، والقراءة لا تكتب", async () => {
    const before = JSON.stringify(await q("SELECT id, isActive FROM broadcast_messages WHERE message LIKE ? ORDER BY id", [`${tag}%`]));
    await q("UPDATE broadcast_messages SET isActive = 1 WHERE message LIKE ?", [`${tag}%`]);
    await (await web(e.ownerA)).broadcast.clear();
    const after = await q("SELECT id, isActive FROM broadcast_messages WHERE message LIKE ? ORDER BY id", [`${tag}%`]);
    const stillActive = new Set(after.filter((r: any) => Number(r.isActive) === 1).map((r: any) => Number(r.id)));
    for (const k of ["posSameName", "posNoLink", "zero", "nul", "negB", "bizB"]) expect(stillActive.has(ids[`m_${k}`]), k).toBe(true);
    for (const k of ["negA"]) expect(stillActive.has(ids[`m_${k}`]), k).toBe(false);
    expect(before).not.toBe(""); // لقطة موجودة
    const ownerA = await web(e.ownerA);
    for (const k of ["posSameName", "posNoLink", "zero", "nul", "negB"])
      await expect(ownerA.tasks.updateStatus({ taskId: ids[`t_${k}`], status: "done" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await q("SELECT COUNT(*) n FROM tasks WHERE title LIKE ? AND taskStatus <> 'new'", [`${tag}%`]))[0].n).toBe(0);
  });
});
