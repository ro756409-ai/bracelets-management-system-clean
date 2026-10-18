import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { COOKIE_NAME } from "@shared/const";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * Hotfix V2 على MySQL حقيقي:
 *  • H1 — المدير (ممنوع من أي صلاحية مالية) لا يمنح دورًا ماليًا (المحاسب افتراضيًا، أو أي دور منحته الشركة صلاحية مالية)
 *    ولا يدير حساب موظف بدور مالي (بيانات دخول/كلمة سر/تعديل/حذف) — بالمسارين والجلستين. المالك والأدمن بلا تراجع.
 *  • TOCTOU — الفحص على دور الهدف والكتابة منفصلين: ترقية الهدف (لمالك أو لمحاسب) في معاملة لسه مفتوحة وقافلة الصف
 *    أثناء طلب المدير — بعد الالتزام، كتابة المدير لازم ماتقعش على الحساب المرقّى (CONFLICT بلا أي تغيير).
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const SESSIONS = [COOKIE_NAME, "employee_token"] as const;
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const callAs = async (cookieName: string, id: number) =>
  appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [cookieName]: sign(id) } }, res } as any));
const portal = (id: number) => callAs("employee_token", id);
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

describe.runIf(CAN)("🛡️ Hotfix V2 — H1 (أدوار مالية) وTOCTOU", { timeout: 60_000 }, () => {
  const RUN = `es${Date.now().toString(36)}`;
  // قاعدة مؤقتة معزولة (نفس أسلوب اختبارات القاعدة في identity-v2) + pool منفصل عشان معاملة السباق تبقى على اتصالها الخاص
  let tmp: TempSchema; let raw: mysql.Pool; let A: CoreTestFixture; let B: CoreTestFixture;
  const e: Record<string, number> = {};
  let seq = 0;
  const q = async (s: string, p: unknown[] = []) => ((await raw.query(s, p)) as any)[0];
  const row = async (id: number) => (await q("SELECT username, passwordHash, role, isActive FROM employees WHERE id = ?", [id]))[0];
  const mk = async (role: string, f: CoreTestFixture, key?: string) => {
    const k = key ?? `${role}${++seq}`;
    e[k] = insId(await createEmployee({ name: `${k}-es`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId,
      username: `${k}_${RUN}`.slice(0, 50), passwordHash: `hash-${k}` } as any));
    return e[k];
  };

  beforeAll(async () => {
    tmp = await createTempSchema("escalation");
    __setDbForTests(drizzle(tmp.url));
    raw = mysql.createPool(tmp.url);
    A = await createCoreTestFixture("es-a");
    B = await createCoreTestFixture("es-b");
    await mk("super_admin", A, "owner"); await mk("admin", A, "admin"); await mk("manager", A, "manager");
    await mk("super_admin", B, "ownerB"); await mk("manager", B, "managerB");
    // الشركة A منحت دور viewer صلاحية مالية — فبقى دورًا ماليًا عندها هي بس (B بلا تجاوز)
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'viewer', 'accounting.view', 1, ?)", [A.tenantId, e.owner]);
  }, 120_000);
  afterAll(async () => { await raw?.end(); __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("H1 · المدير لا ينشئ ولا يرقّي لدور مالي (المحاسب، أو viewer اللي الشركة منحته صلاحية مالية) — بالجلستين", async () => {
    const agent = await mk("agent", A);
    for (const s of SESSIONS) {
      const c = await callAs(s, e.manager);
      for (const role of ["accountant", "viewer"] as const) {
        const before = await q("SELECT COUNT(*) n FROM employees WHERE tenantId = ?", [A.tenantId]);
        expect(await code(() => c.employees.create({ name: `new-${role}`, role, businessId: A.businessId } as any)), `${s}/create ${role}`).toBe("FORBIDDEN");
        expect((await q("SELECT COUNT(*) n FROM employees WHERE tenantId = ?", [A.tenantId]))[0].n).toBe(before[0].n);
        expect(await code(() => c.employees.update({ id: agent, role } as any)), `${s}/update→${role}`).toBe("FORBIDDEN");
        expect((await row(agent)).role).toBe("agent");
      }
    }
  });

  it("H1 · المدير لا يدير حساب موظف بدور مالي (كلمة سر/بيانات دخول/تعديل/تعطيل/حذف) — لوحة الإدارة والبوابة", async () => {
    for (const role of ["accountant", "viewer"]) {
      const target = await mk(role, A);
      const before = JSON.stringify(await row(target));
      for (const s of SESSIONS) {
        const c = await callAs(s, e.manager);
        expect(await code(() => c.employees.changePassword({ id: target, newPassword: "takeover1" })), `${s}/${role}`).toBe("FORBIDDEN");
        expect(await code(() => c.employees.setCredentials({ id: target, username: `tk_${seq}_${RUN}`.slice(0, 50), password: "takeover1" })), `${s}/${role}`).toBe("FORBIDDEN");
        expect(await code(() => c.employees.update({ id: target, isActive: false } as any)), `${s}/${role}`).toBe("FORBIDDEN");
        expect(await code(() => c.employees.update({ id: target, role: "agent" } as any)), `${s}/${role}`).toBe("FORBIDDEN");
        expect(await code(() => c.employees.delete({ id: target })), `${s}/${role}`).toBe("FORBIDDEN");
      }
      const p = await portal(e.manager);
      expect(await code(() => p.employeePortal.changeEmployeePassword({ id: target, newPassword: "takeover1" })), role).toBe("FORBIDDEN");
      expect(await code(() => p.employeePortal.setEmployeeCredentials({ id: target, username: `tp_${seq}_${RUN}`.slice(0, 50), password: "takeover1" })), role).toBe("FORBIDDEN");
      expect(await code(() => p.employeePortal.updateEmployee({ id: target, isActive: false })), role).toBe("FORBIDDEN");
      expect(await code(() => p.employeePortal.deleteEmployee({ id: target })), role).toBe("FORBIDDEN");
      expect(JSON.stringify(await row(target))).toBe(before);
    }
  });

  it("H1 · لا تراجع: المالك والأدمن يديروا المحاسب؛ والمدير يدير الأدوار التشغيلية؛ وviewer عادي في شركة بلا تجاوز", async () => {
    for (const actor of ["owner", "admin"]) {
      const c = await callAs(COOKIE_NAME, e[actor]);
      expect(await code(() => c.employees.create({ name: `acc-by-${actor}`, role: "accountant", businessId: A.businessId } as any)), actor).toBe("ok");
      const acc = await mk("accountant", A);
      expect(await code(() => c.employees.changePassword({ id: acc, newPassword: "legit1234" })), actor).toBe("ok");
      expect(await code(() => c.employees.setCredentials({ id: acc, username: `ok_${actor}_${RUN}`.slice(0, 50), password: "legit1234" })), actor).toBe("ok");
      expect(await code(() => c.employees.update({ id: acc, isActive: false } as any)), actor).toBe("ok");
      expect(await code(() => c.employees.delete({ id: acc })), actor).toBe("ok");
    }
    for (const s of SESSIONS) {
      const c = await callAs(s, e.manager);
      expect(await code(() => c.employees.create({ name: `ag-${s}`, role: "agent", businessId: A.businessId } as any)), s).toBe("ok");
      const ag = await mk("agent", A);
      expect(await code(() => c.employees.update({ id: ag, role: "warehouse" } as any)), s).toBe("ok");
      expect(await code(() => c.employees.changePassword({ id: ag, newPassword: "legit1234" })), s).toBe("ok");
      expect(await code(() => c.employees.setCredentials({ id: ag, username: `okm_${seq}_${RUN}`.slice(0, 50), password: "legit1234" })), s).toBe("ok");
      expect(await code(() => c.employees.delete({ id: ag })), s).toBe("ok");
    }
    const p = await portal(e.manager);
    const ag2 = await mk("agent", A);
    expect(await code(() => p.employeePortal.changeEmployeePassword({ id: ag2, newPassword: "legit1234" }))).toBe("ok");
    expect(await code(() => p.employeePortal.updateEmployee({ id: ag2, role: "scanner" }))).toBe("ok");
    expect(await code(() => p.employeePortal.deleteEmployee({ id: ag2 }))).toBe("ok");
    // viewer في B (بلا تجاوز مالي) دور تشغيلي عادي لمديرها
    const cB = await callAs(COOKIE_NAME, e.managerB);
    expect(await code(() => cB.employees.create({ name: "viewer-b", role: "viewer", businessId: B.businessId } as any))).toBe("ok");
    const vB = await mk("viewer", B);
    expect(await code(() => cB.employees.changePassword({ id: vB, newPassword: "legit1234" }))).toBe("ok");
  });

  it("TOCTOU · لا CONFLICT كاذب: تعديل من غير أي تغيير فعلي (نفس القيم) بينجح — لوحة الإدارة والبوابة", async () => {
    const ag = await mk("agent", A);
    const c = await callAs(COOKIE_NAME, e.manager);
    expect(await code(() => c.employees.update({ id: ag, isActive: true } as any))).toBe("ok");
    expect(await code(() => (callAs(COOKIE_NAME, e.owner)).then(o => o.employees.update({ id: ag, role: "agent" } as any)))).toBe("ok");
    expect(await code(async () => (await portal(e.manager)).employeePortal.updateEmployee({ id: ag, isActive: true }))).toBe("ok");
    expect((await row(ag)).role).toBe("agent");
  });

  /**
   * سباق حتمي: معاملة خام بترقّي الهدف (لم تلتزم بعد، وقافلة الصف). طلب المدير بيقرأ الدور الملتزم القديم (agent) فيعدّي
   * الفحص، ثم كتابته بتستنى القفل. بعد الالتزام: لازم الكتابة ماتقعش على الحساب المرقّى.
   */
  async function race(targetId: number, promoteTo: string, attack: () => Promise<unknown>) {
    const conn = await raw.getConnection();
    await conn.query("START TRANSACTION");
    await conn.query("UPDATE employees SET role = ? WHERE id = ?", [promoteTo, targetId]);
    const outcome = attack().then(() => "ok", (err: any) => err?.code ?? "ERR");
    let waited = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 20_000) {
      // انتظار قفل صف فعلي على جدول employees في نفس القاعدة (performance_schema — أدق من trx_query)
      const [w] = (await raw.query(
        `SELECT COUNT(*) n FROM performance_schema.data_lock_waits w
           JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
          WHERE l.OBJECT_SCHEMA = DATABASE() AND l.OBJECT_NAME = 'employees'`
      )) as any;
      if (Number(w[0].n) > 0) { waited = true; break; }
      if (await Promise.race([outcome.then(() => true), new Promise(r => setTimeout(() => r(false), 20))])) break;
    }
    await conn.query("COMMIT");
    conn.release();
    return { result: await outcome, waited };
  }

  const attacks: Array<[string, (id: number) => Promise<unknown>]> = [
    ["employees.changePassword", async id => (await callAs(COOKIE_NAME, e.manager)).employees.changePassword({ id, newPassword: "raced1234" })],
    ["employees.setCredentials", async id => (await callAs(COOKIE_NAME, e.manager)).employees.setCredentials({ id, username: `rc_${id}_${RUN}`.slice(0, 50), password: "raced1234" })],
    ["employees.update(isActive=false)", async id => (await callAs(COOKIE_NAME, e.manager)).employees.update({ id, isActive: false } as any)],
    ["employees.delete", async id => (await callAs(COOKIE_NAME, e.manager)).employees.delete({ id })],
    ["employeePortal.changeEmployeePassword", async id => (await portal(e.manager)).employeePortal.changeEmployeePassword({ id, newPassword: "raced1234" })],
    ["employeePortal.setEmployeeCredentials", async id => (await portal(e.manager)).employeePortal.setEmployeeCredentials({ id, username: `rp_${id}_${RUN}`.slice(0, 50), password: "raced1234" })],
    ["employeePortal.updateEmployee(isActive=false)", async id => (await portal(e.manager)).employeePortal.updateEmployee({ id, isActive: false })],
    ["employeePortal.deleteEmployee", async id => (await portal(e.manager)).employeePortal.deleteEmployee({ id })],
  ];

  for (const promoteTo of ["super_admin", "accountant"]) {
    it(`TOCTOU · ترقية الهدف لـ${promoteTo} أثناء طلب المدير: الكتابة لا تقع على الحساب المرقّى (8 مسارات)`, async () => {
      for (const [name, attack] of attacks) {
        const target = await mk("agent", A);
        const before = await row(target);
        const { result, waited } = await race(target, promoteTo, () => attack(target));
        const after = await row(target);
        expect.soft(waited, `${name}: لازم الطلب يوصل للكتابة ويستنى القفل (السباق اتحقق فعلًا)`).toBe(true);
        expect.soft(result, name).toBe("CONFLICT");
        expect.soft(after, name).toEqual({ ...before, role: promoteTo });
      }
    });
  }
});
