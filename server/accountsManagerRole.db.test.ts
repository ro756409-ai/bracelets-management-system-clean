import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { confirmPhrase } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { activateLedgerV3 } from "./ledgerV3.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";
import { EMPLOYEE_ROLE_ENUM_AFTER_0045 } from "../shared/employeeRoleEnumSpec";
import { ALL_PERMISSIONS, EMPLOYEE_ROLE_VALUES, hasPermission, hasTenantPermission } from "./permissions";

/**
 * دور مدير الحسابات (المرحلة 1 للحسابات) على MySQL حقيقي:
 *  • الصلاحيات الافتراضية: مدير الحسابات = الدفتر فقط (قراءة/ترحيل/عكس/إدارة الحسابات/إقفال)، لا فتح ولا تفعيل ولا أرباح
 *    ولا أوردرات ولا موظفين؛ المحاسب لا ترحيل افتراضيًا؛ العكس للمالك ومدير الحسابات فقط حتى مع أي تجاوز.
 *  • نطاق مدير الحسابات = كل أنشطة شركته **داخل الدفتر فقط**؛ لا شركة أخرى؛ ولا توسّع لنطاق جلسته خارج الدفتر.
 *  • تعيينه وإدارته للمالك فقط؛ وقبل 0045 رفض واضح بلا كتابة.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
let seq = 0;
const op = () => `am${Date.now().toString(36)}${++seq}xx`;

describe("👤 مدير الحسابات — الصلاحيات الافتراضية (بلا قاعدة)", () => {
  it("قائمة الأدوار = تعريف 0045 حرفيًا (القديم بترتيبه + الجديد في الآخر)", () => {
    expect([...EMPLOYEE_ROLE_VALUES]).toEqual([...EMPLOYEE_ROLE_ENUM_AFTER_0045]);
  });
  it("مدير الحسابات: الدفتر فقط — بلا فتح/تفعيل/أرباح/أوردرات/موظفين/V1", () => {
    for (const p of ["ledger.view", "ledger.post", "ledger.reverse", "ledger.manage_accounts", "ledger.period.lock"] as const) expect(hasPermission("accounts_manager", p), p).toBe(true);
    for (const p of ["ledger.period.reopen", "ledger.activate", "reports.view_profit", "orders.view", "employees.manage", "employees.view", "accounting.view", "payroll.view", "settings.manage", "messages.view_private"] as const)
      expect(hasPermission("accounts_manager", p), p).toBe(false);
    const ledger = ALL_PERMISSIONS.filter(p => p.startsWith("ledger.") && hasPermission("accounts_manager", p));
    expect(ledger.sort()).toEqual(["ledger.manage_accounts", "ledger.period.lock", "ledger.post", "ledger.reverse", "ledger.view"]);
  });
  it("المحاسب لا ترحيل ولا عكس افتراضيًا؛ العكس للمالك ومدير الحسابات فقط (لا الأدمن ولا المدير)", () => {
    expect(hasPermission("accountant", "ledger.post")).toBe(false);
    expect(hasPermission("accountant", "ledger.reverse")).toBe(false);
    expect(hasPermission("super_admin", "ledger.reverse")).toBe(true);
    for (const r of ["admin", "manager", "accountant", "moderator", "viewer"]) expect(hasPermission(r, "ledger.reverse"), r).toBe(false);
    expect(hasPermission("accountant", "reports.view_profit")).toBe(false);
  });
});

describe.runIf(CAN)("🏦 مدير الحسابات — قاعدة حقيقية", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  let A2 = 0, txId = 0;
  const acc: Record<string, number> = {};
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const grant = (tenantId: number, role: string, permission: string, isAllowed: boolean) =>
    q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE isAllowed = VALUES(isAllowed)", [tenantId, role, permission, isAllowed ? 1 : 0, e.ownerA]);

  beforeAll(async () => {
    tmp = await createTempSchema("acct_mgr");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("am-a"); B = await createCoreTestFixture("am-b");
    A2 = insId(await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'النشاط الثاني', ?)", [A.tenantId, `a2-${tmp.name}`.slice(0, 50)]));
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-am`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("adminA", "admin", A); await mk("managerA", "manager", A);
    await mk("accountantA", "accountant", A); await mk("amA", "accounts_manager", A);
    await mk("ownerB", "super_admin", B); await mk("amB", "accounts_manager", B);
    const r = await activateLedgerV3({
      tenantId: A.tenantId, goLiveDate: "2026-10-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "1000" }, businessIds: [A.businessId, A2],
      safeGrants: { OFFICE_CASH: [A.businessId, A2], BANK_MAIN: [A.businessId, A2], COD_BOSTA: [A.businessId, A2] },
    } as any);
    Object.assign(acc, r.accounts);
    const t = await (await call(e.ownerA)).ledger.post({ sourceBusinessId: A2, kind: "expense", idempotencyKey: op(), effectiveDate: "2026-10-05", description: "مصروف النشاط الثاني",
      entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "50", businessId: A2 }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "50", businessId: A2 }] });
    txId = t.transactionId;
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("نطاق الدفتر: مدير الحسابات = كل أنشطة شركته؛ لا شركة أخرى؛ المحاسب نشاطه فقط", async () => {
    const am = (await (await call(e.amA)).ledger.businesses.list()).map((b: any) => b.id).sort();
    expect(am).toEqual([A.businessId, A2].sort());
    expect(await code(async () => (await call(e.amA)).ledger.transactions.list({ businessId: B.businessId }))).toBe("FORBIDDEN");
    const list = await (await call(e.amA)).ledger.transactions.list({ businessId: A2 });
    expect(list.rows.some((x: any) => x.id === txId)).toBe(true);
    await grant(A.tenantId, "accountant", "ledger.view", true);
    try {
      expect((await (await call(e.accountantA)).ledger.businesses.list()).map((b: any) => b.id)).toEqual([A.businessId]);
      expect(await code(async () => (await call(e.accountantA)).ledger.transactions.list({ businessId: A2 }))).toBe("FORBIDDEN");
    } finally { await q("DELETE FROM tenant_role_permissions WHERE tenantId = ? AND role = 'accountant'", [A.tenantId]); }
    // B لا يرى شيئًا من A
    expect((await (await call(e.amB)).ledger.businesses.list()).map((b: any) => b.id)).toEqual([B.businessId]);
  });

  it("لا توسّع لنطاق الجلسة خارج الدفتر: مهام نشاط آخر في شركته لا تظهر لمدير الحسابات، والأوردرات والموظفون مرفوضة", async () => {
    const t = insId(await q("INSERT INTO tasks (businessId, title, createdBy, createdByName) VALUES (?, 'مهمة النشاط الثاني', ?, 'المالك')", [A2, -e.ownerA]));
    const mine = await (await call(e.amA)).employeePortal.tasks.listMine({});
    expect(mine.some((x: any) => x.id === t)).toBe(false);
    const portal = await call(e.amA);
    expect(await code(() => portal.employeePortal.myOrders({} as any))).not.toBe("ok");
    // قراءة الموظفين القائمة (لتبويب رواتب المحاسب) تبقى بنطاق جلسته المعتاد = نشاطه فقط، بلا توسّع لكل الشركة
    const emps = await portal.employees.list({});
    expect(emps.every((x: any) => x.businessId === A.businessId)).toBe(true);
    expect(await code(() => portal.employees.update({ id: e.accountantA, name: "تعديل" }))).not.toBe("ok");
    expect(await code(() => portal.employees.create({ name: "x x", role: "agent" }))).not.toBe("ok");
    expect(await code(() => portal.accountingV2.rolePermissionSave({ role: "accountant", permission: "ledger.post", isAllowed: true }))).not.toBe("ok");
  });

  it("العكس: المحاسب مرفوض حتى بمنح صريح (والمنح نفسه مرفوض)؛ مدير الحسابات والمالك يعكسان؛ الأدمن لا", async () => {
    await grant(A.tenantId, "accountant", "ledger.post", true);
    await grant(A.tenantId, "accountant", "ledger.view", true);
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accountant', 'ledger.reverse', 1, ?)", [A.tenantId, e.ownerA]);
    try {
      expect(await hasTenantPermission(A.tenantId, "accountant", "ledger.reverse")).toBe(false);
      expect(await hasTenantPermission(A.tenantId, "accountant", "ledger.post")).toBe(true); // منح صريح يعمل
      const rev = (id: number) => async () => (await call(id)).ledger.reverse({ transactionId: txId, idempotencyKey: op(), effectiveDate: "2026-10-06", reason: "تصحيح خطأ" });
      expect(await code(rev(e.accountantA))).toBe("FORBIDDEN");
      expect(await code(rev(e.adminA))).toBe("FORBIDDEN");
      expect(await code(rev(e.managerA))).toBe("FORBIDDEN");
      expect(await code(rev(e.amA))).toBe("ok");
      // المالك لا يستطيع منح العكس لغير مدير الحسابات، ولا فتح الشهر/التفعيل لغير المالك
      const owner = await call(e.ownerA);
      expect(await code(() => owner.accountingV2.rolePermissionSave({ role: "accountant", permission: "ledger.reverse", isAllowed: true }))).toBe("FORBIDDEN");
      expect(await code(() => owner.accountingV2.rolePermissionSave({ role: "admin", permission: "ledger.reverse", isAllowed: true }))).toBe("FORBIDDEN");
      expect(await code(() => owner.accountingV2.rolePermissionSave({ role: "accounts_manager", permission: "ledger.period.reopen", isAllowed: true }))).toBe("FORBIDDEN");
      expect(await code(() => owner.accountingV2.rolePermissionSave({ role: "accounts_manager", permission: "ledger.activate", isAllowed: true }))).toBe("FORBIDDEN");
      expect(await code(() => owner.accountingV2.rolePermissionSave({ role: "accountant", permission: "ledger.post", isAllowed: true }))).toBe("ok");
      expect(await code(() => owner.accountingV2.rolePermissionSave({ role: "accounts_manager", permission: "ledger.reverse", isAllowed: false }))).toBe("ok"); // السحب مسموح
      expect(await code(rev(e.amA))).toBe("FORBIDDEN"); // السحب يعمل من الطلب التالي
    } finally { await q("DELETE FROM tenant_role_permissions WHERE tenantId = ?", [A.tenantId]); }
  });

  it("الإقفال لمدير الحسابات؛ فتح الشهر للمالك الحقيقي فقط حتى مع منح مخزّن مباشرة", async () => {
    expect(await code(async () => (await call(e.amA)).ledger.period.lock({ period: "2026-10", reason: "مراجعة الشهر" }))).toBe("ok");
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accounts_manager', 'ledger.period.reopen', 1, ?), (?, 'admin', 'ledger.period.reopen', 1, ?)", [A.tenantId, e.ownerA, A.tenantId, e.ownerA]);
    try {
      expect(await code(async () => (await call(e.amA)).ledger.period.reopen({ period: "2026-10", reason: "تصحيح" }))).toBe("FORBIDDEN");
      expect(await code(async () => (await call(e.adminA)).ledger.period.reopen({ period: "2026-10", reason: "تصحيح" }))).toBe("FORBIDDEN");
      expect(await code(async () => (await call(e.ownerA)).ledger.period.reopen({ period: "2026-10", reason: "تصحيح قيد" }))).toBe("ok");
      const [ev] = await q("SELECT action, actorEmployeeId, reason FROM ledger_period_events WHERE tenantId = ? AND action = 'reopen' ORDER BY id DESC LIMIT 1", [A.tenantId]);
      expect(ev).toMatchObject({ action: "reopen", actorEmployeeId: e.ownerA, reason: "تصحيح قيد" });
    } finally { await q("DELETE FROM tenant_role_permissions WHERE tenantId = ?", [A.tenantId]); }
  });

  it("تعيين الدور وإدارته للمالك فقط", async () => {
    const admin = await call(e.adminA), owner = await call(e.ownerA);
    expect(await code(() => admin.employees.create({ name: "مدير حسابات ٢", role: "accounts_manager" }))).toBe("FORBIDDEN");
    expect(await code(() => admin.employees.update({ id: e.accountantA, role: "accounts_manager" }))).toBe("FORBIDDEN");
    expect(await code(() => admin.employees.update({ id: e.amA, name: "اسم جديد" }))).toBe("FORBIDDEN");
    expect(await code(() => admin.employees.changePassword({ id: e.amA, newPassword: "secret123" }))).toBe("FORBIDDEN");
    expect(await code(() => admin.employees.setCredentials({ id: e.amA, username: `am_${seq}x`, password: "secret123" }))).toBe("FORBIDDEN");
    expect(await code(() => admin.employees.delete({ id: e.amA }))).toBe("FORBIDDEN");
    expect(await admin.employees.roleSupport()).toEqual({ accountsManager: false });
    expect(await owner.employees.roleSupport()).toEqual({ accountsManager: true });
    expect(await code(() => owner.employees.create({ name: "مدير حسابات ٢", role: "accounts_manager", businessId: A.businessId }))).toBe("ok");
    expect(await code(() => owner.employees.update({ id: e.amA, name: "مدير الحسابات" }))).toBe("ok");
    expect((await q("SELECT COUNT(*) n FROM employees WHERE tenantId = ? AND role = 'accounts_manager'", [A.tenantId]))[0].n).toBe(2);
  });

  it("قبل 0045: تعيين الدور مرفوض برسالة واضحة بلا كتابة، والخيار غير متاح", async () => {
    // نعيد التعريف القديم في نفس القاعدة المؤقتة (بعد إزالة الدور من كل الصفوف)
    await q("UPDATE employees SET role = 'accountant' WHERE role = 'accounts_manager'");
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "rollback", deployEnv: "test", confirm: confirmPhrase("0045", "rollback", tmp.name) })).ok).toBe(true);
    const owner = await call(e.ownerA);
    const before = (await q("SELECT COUNT(*) n FROM employees"))[0].n;
    expect(await code(() => owner.employees.create({ name: "مدير حسابات ٣", role: "accounts_manager", businessId: A.businessId }))).toBe("PRECONDITION_FAILED");
    expect((await q("SELECT COUNT(*) n FROM employees"))[0].n).toBe(before);
    expect(await owner.employees.roleSupport()).toEqual({ accountsManager: false });
  });
});
