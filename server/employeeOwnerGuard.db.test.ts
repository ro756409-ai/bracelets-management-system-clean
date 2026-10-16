import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { COOKIE_NAME } from "@shared/const";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee, writeEmployeeKeepingAnOwner } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * SEC-2 على MySQL حقيقي، عبر المسارين — لوحة الإدارة (employees.*) وبوابة المدير (employeePortal.*) — وبنوعي الجلسة:
 * /login (كوكي المالك/الأدمن) و/employee-login (employee_token):
 *  • المالك وحده يدير حساب المالك؛ والبوابة لا تلمس حساب المالك إطلاقًا.
 *  • لا أحد يدير حسابًا أعلى منه أو يمنح دورًا أعلى منه؛ ولا ترقية ذاتية للمالك حتى لو صفر ملاك (لا bootstrap).
 *  • آخر مالك نشط لا يُسحب/يُعطَّل/يُحذف؛ والهدف غير الموجود = NOT_FOUND قبل أي كتابة.
 *  • لا تراجع في العمليات المشروعة.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const SESSIONS = [COOKIE_NAME, "employee_token"] as const; // /login ، /employee-login
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const callAs = async (cookieName: string, id: number) =>
  appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [cookieName]: sign(id) } }, res } as any));
const portal = (id: number) => callAs("employee_token", id); // البوابة بهوية كوكي الموظف فقط
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const MISSING = 987_654_321;

describe.runIf(CAN)("🛡️ SEC-2 — حماية حساب المالك وتدرّج الأدوار", () => {
  let tmp: TempSchema; let A: CoreTestFixture; let C: CoreTestFixture;
  const e: Record<string, number> = {};
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const row = async (id: number) => (await q("SELECT username, passwordHash, role, isActive FROM employees WHERE id = ?", [id]))[0];

  beforeAll(async () => {
    tmp = await createTempSchema("owner_guard");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("og-a"); // شركة فيها مالك
    C = await createCoreTestFixture("og-c"); // شركة بلا أي مالك نشط
    const mk = async (k: string, role: string, f: CoreTestFixture) => {
      e[k] = insId(await createEmployee({ name: `${k}-og`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId,
        username: `${k}_${tmp.name}`.slice(0, 50), passwordHash: `hash-${k}` } as any));
    };
    await mk("owner", "super_admin", A); await mk("admin", "admin", A); await mk("manager", "manager", A); await mk("agent", "agent", A);
    await mk("adminC", "admin", C); await mk("managerC", "manager", C); await mk("agentC", "agent", C);
  }, 120_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("المدير والأدمن لا يغيّرون كلمة سر المالك ولا بيانات دخوله — بالجلستين وبالمسارين", async () => {
    for (const s of SESSIONS) for (const actor of ["manager", "admin"]) {
      const c = await callAs(s, e[actor]);
      expect(await code(() => c.employees.changePassword({ id: e.owner, newPassword: "hacked123" })), `${s}/${actor}`).toBe("FORBIDDEN");
      expect(await code(() => c.employees.setCredentials({ id: e.owner, username: `x1_${actor}`, password: "hacked123" })), `${s}/${actor}`).toBe("FORBIDDEN");
    }
    for (const actor of ["manager", "admin"]) {
      const p = await portal(e[actor]);
      expect(await code(() => p.employeePortal.changeEmployeePassword({ id: e.owner, newPassword: "hacked123" })), actor).toBe("FORBIDDEN");
      expect(await code(() => p.employeePortal.setEmployeeCredentials({ id: e.owner, username: `x2_${actor}`, password: "hacked123" })), actor).toBe("FORBIDDEN");
    }
    const owner = await row(e.owner);
    expect(owner.passwordHash).toBe("hash-owner");
    expect(owner.username.startsWith("owner_")).toBe(true);
  });

  it("لا تعطيل ولا تخفيض ولا حذف للمالك من غير المالك — بالجلستين وبالمسارين؛ والبوابة ترفض حتى للمالك نفسه", async () => {
    for (const s of SESSIONS) for (const actor of ["manager", "admin"]) {
      const c = await callAs(s, e[actor]);
      expect(await code(() => c.employees.update({ id: e.owner, isActive: false })), `${s}/${actor}`).toBe("FORBIDDEN");
      expect(await code(() => c.employees.update({ id: e.owner, role: "manager" })), `${s}/${actor}`).toBe("FORBIDDEN");
      expect(await code(() => c.employees.delete({ id: e.owner })), `${s}/${actor}`).toBe("FORBIDDEN");
    }
    for (const actor of ["manager", "admin", "owner"]) {
      const p = await portal(e[actor]);
      expect(await code(() => p.employeePortal.updateEmployee({ id: e.owner, isActive: false })), actor).toBe("FORBIDDEN");
      expect(await code(() => p.employeePortal.updateEmployee({ id: e.owner, role: "manager" })), actor).toBe("FORBIDDEN");
      expect(await code(() => p.employeePortal.deleteEmployee({ id: e.owner })), actor).toBe("FORBIDDEN");
    }
    const owner = await row(e.owner);
    expect(owner.role).toBe("super_admin");
    expect(Boolean(owner.isActive)).toBe(true);
  });

  it("المدير لا يرقّي نفسه لـadmin أو مالك، ولا يرقّي غيره، ولا يدير حساب أدمن", async () => {
    for (const s of SESSIONS) {
      const m = await callAs(s, e.manager);
      expect(await code(() => m.employees.update({ id: e.manager, role: "admin" })), s).toBe("FORBIDDEN");
      expect(await code(() => m.employees.update({ id: e.manager, role: "super_admin" })), s).toBe("FORBIDDEN");
      expect(await code(() => m.employees.update({ id: e.agent, role: "admin" })), s).toBe("FORBIDDEN");
      expect(await code(() => m.employees.create({ name: "new-admin", role: "admin" })), s).toBe("FORBIDDEN");
      expect(await code(() => m.employees.changePassword({ id: e.admin, newPassword: "hacked123" })), s).toBe("FORBIDDEN");
    }
    const p = await portal(e.manager);
    expect(await code(() => p.employeePortal.changeEmployeePassword({ id: e.admin, newPassword: "hacked123" }))).toBe("FORBIDDEN");
    expect(await code(() => p.employeePortal.updateEmployee({ id: e.admin, isActive: false }))).toBe("FORBIDDEN");
    // الـenum بتاع البوابة نفسه لا يقبل admin/super_admin — رفض مدخلات قبل أي كتابة
    expect(await code(() => p.employeePortal.updateEmployee({ id: e.manager, role: "super_admin" as any }))).not.toBe("ok");
    expect((await row(e.manager)).role).toBe("manager");
    expect((await row(e.admin)).passwordHash).toBe("hash-admin");
  });

  it("شركة بلا مالك نشط: لا أدمن ولا مدير يرقّي نفسه أو غيره مالكًا (لا bootstrap داخل التطبيق)", async () => {
    expect(await q("SELECT COUNT(*) AS n FROM employees WHERE tenantId = ? AND role = 'super_admin' AND isActive = 1", [C.tenantId])).toEqual([{ n: 0 }]);
    for (const s of SESSIONS) {
      for (const actor of ["adminC", "managerC"]) {
        const c = await callAs(s, e[actor]);
        expect(await code(() => c.employees.update({ id: e[actor], role: "super_admin" })), `${s}/${actor}`).toBe("FORBIDDEN");
        expect(await code(() => c.employees.update({ id: e.agentC, role: "super_admin" })), `${s}/${actor}`).toBe("FORBIDDEN");
        expect(await code(() => c.employees.create({ name: `owner-by-${actor}`, role: "super_admin" })), `${s}/${actor}`).toBe("FORBIDDEN");
      }
    }
    expect(await q("SELECT COUNT(*) AS n FROM employees WHERE tenantId = ? AND role = 'super_admin'", [C.tenantId])).toEqual([{ n: 0 }]);
  });

  it("الهدف غير الموجود = NOT_FOUND قبل أي كتابة — بالمسارين", async () => {
    for (const s of SESSIONS) {
      const c = await callAs(s, e.owner);
      expect(await code(() => c.employees.changePassword({ id: MISSING, newPassword: "x1234567" })), s).toBe("NOT_FOUND");
      expect(await code(() => c.employees.setCredentials({ id: MISSING, username: "ghost_user", password: "x1234567" })), s).toBe("NOT_FOUND");
      expect(await code(() => c.employees.update({ id: MISSING, isActive: false })), s).toBe("NOT_FOUND");
      expect(await code(() => c.employees.delete({ id: MISSING })), s).toBe("NOT_FOUND");
    }
    const p = await portal(e.manager);
    expect(await code(() => p.employeePortal.changeEmployeePassword({ id: MISSING, newPassword: "x1234567" }))).toBe("NOT_FOUND");
    expect(await code(() => p.employeePortal.setEmployeeCredentials({ id: MISSING, username: "ghost_user2", password: "x1234567" }))).toBe("NOT_FOUND");
    expect(await code(() => p.employeePortal.updateEmployee({ id: MISSING, isActive: false }))).toBe("NOT_FOUND");
    expect(await code(() => p.employeePortal.deleteEmployee({ id: MISSING }))).toBe("NOT_FOUND");
    expect(await q("SELECT COUNT(*) AS n FROM employees WHERE username LIKE 'ghost_user%'")).toEqual([{ n: 0 }]);
  });

  it("آخر مالك نشط لا يُسحب منه الدور ولا يُحذف؛ ومع مالك ثانٍ يصح", async () => {
    const o = await callAs(COOKIE_NAME, e.owner);
    expect(await code(() => o.employees.update({ id: e.owner, role: "admin" }))).toBe("FORBIDDEN");
    expect((await row(e.owner)).role).toBe("super_admin");
    expect(await code(() => o.employees.create({ name: "owner2-og", role: "super_admin" }))).toBe("ok");
    const [{ id: owner2 }] = await q("SELECT id FROM employees WHERE name = 'owner2-og' AND tenantId = ?", [A.tenantId]);
    expect(await code(() => o.employees.update({ id: owner2, role: "admin" }))).toBe("ok");
    expect((await row(owner2)).role).toBe("admin");
  });

  it("تزامن فعلي: مالكان يعطّلان/يخفّضان/يحذفان بعض في نفس اللحظة — يفضل مالك نشط واحد على الأقل دائمًا", async () => {
    const D = await createCoreTestFixture("og-d"); // شركة مستقلة للسباق
    const ops = {
      deactivate: (c: any, id: number) => c.employees.update({ id, isActive: false }),
      demote: (c: any, id: number) => c.employees.update({ id, role: "admin" }),
      delete: (c: any, id: number) => c.employees.delete({ id }),
    } as const;
    for (const [op, run] of Object.entries(ops)) {
      for (let round = 0; round < 8; round++) {
        await q("UPDATE employees SET isActive = 0 WHERE tenantId = ?", [D.tenantId]);
        const mkOwner = async (k: string) => insId(await createEmployee({ name: k, role: "super_admin", isActive: true,
          tenantId: D.tenantId, businessId: D.businessId, username: `${k}_${tmp.name}`.slice(0, 50), passwordHash: "h" } as any));
        const d1 = await mkOwner(`d1${op}${round}`); const d2 = await mkOwner(`d2${op}${round}`);
        const [c1, c2] = [await callAs(SESSIONS[round % 2], d1), await callAs(SESSIONS[(round + 1) % 2], d2)];
        const results = await Promise.all([code(() => run(c1, d2)), code(() => run(c2, d1))]);
        const [{ n }] = await q("SELECT COUNT(*) AS n FROM employees WHERE tenantId = ? AND role = 'super_admin' AND isActive = 1", [D.tenantId]);
        expect(Number(n), `${op}#${round} ${results}`).toBe(1);
        expect([...results].sort(), `${op}#${round}`).toEqual(["FORBIDDEN", "ok"]);
      }
    }
  }, 120_000);

  it("writeEmployeeKeepingAnOwner مباشرة: موظف من شركة أخرى أو شركة غير موجودة = رفض بلا أي تغيير", async () => {
    const before = await row(e.owner);
    // مالك الشركة A يُمرَّر مع tenantId الشركة C — تعديل وحذف
    expect(await writeEmployeeKeepingAnOwner(C.tenantId, e.owner, { kind: "update", data: { isActive: false, name: "hijacked" } })).toBe("not_found");
    expect(await writeEmployeeKeepingAnOwner(C.tenantId, e.owner, { kind: "delete" })).toBe("not_found");
    // موظف عادي من A عبر C
    expect(await writeEmployeeKeepingAnOwner(C.tenantId, e.agent, { kind: "update", data: { role: "admin" } })).toBe("not_found");
    // شركة غير موجودة
    expect(await writeEmployeeKeepingAnOwner(MISSING, e.owner, { kind: "delete" })).toBe("no_tenant");
    expect(await row(e.owner)).toEqual(before);
    expect((await row(e.agent)).role).not.toBe("admin");
    // نفس الشركة يشتغل عادي (تغيير لا يمس بقاء المالك)
    expect(await writeEmployeeKeepingAnOwner(A.tenantId, e.agent, { kind: "update", data: { name: "agent-renamed-og" } })).toBe("ok");
  });

  it("لا تراجع: المالك يدير الكل، والأدمن يدير المدير، والمدير يدير الموظف العادي — بالجلستين وبالمسارين", async () => {
    for (const s of SESSIONS) {
      expect(await code(async () => (await callAs(s, e.owner)).employees.changePassword({ id: e.admin, newPassword: `owner-${s}` })), s).toBe("ok");
      expect(await code(async () => (await callAs(s, e.owner)).employees.update({ id: e.manager, name: `mgr-renamed-${s}` })), s).toBe("ok");
      expect(await code(async () => (await callAs(s, e.admin)).employees.changePassword({ id: e.manager, newPassword: `admin-${s}` })), s).toBe("ok");
      expect(await code(async () => (await callAs(s, e.admin)).employees.update({ id: e.agent, role: "manager" })), s).toBe("ok");
      expect(await code(async () => (await callAs(s, e.admin)).employees.update({ id: e.agent, role: "agent" })), s).toBe("ok");
      expect(await code(async () => (await callAs(s, e.manager)).employees.changePassword({ id: e.agent, newPassword: `mgr-${s}` })), s).toBe("ok");
    }
    const p = await portal(e.manager);
    expect(await code(() => p.employeePortal.changeEmployeePassword({ id: e.agent, newPassword: "mgr-portal" }))).toBe("ok");
    expect(await code(() => p.employeePortal.updateEmployee({ id: e.agent, role: "warehouse" }))).toBe("ok");
    expect((await row(e.agent)).role).toBe("warehouse");
  });
});
