import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";

import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { getDb, createEmployee, __setDbForTests } from "./db";
import { drizzle } from "drizzle-orm/mysql2";
import { tenantRolePermissions } from "../drizzle/schema";
import { and, eq } from "drizzle-orm";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";
import { activateLedgerV3 } from "./ledgerV3.service";

/**
 * Routers دفتر V3 على **قاعدة مؤقتة كاملة** (نسخة مخطط المشروع الحقيقي + 0040) يُوجَّه إليها `getDb()`
 * بالكامل داخل هذا الملف (`__setDbForTests`) — فلا DDL على قاعدة الاختبار المشتركة ولا تداخل مع
 * الملفات المتوازية:
 * أربع جلسات حقيقية بالكوكي (مالك، admin، محاسب ممنوح، موظف بلا صلاحية) على Tenant A + مالك Tenant B.
 * كل مستخدم يرى شركته فقط؛ تزوير المعرّفات من شركة أخرى يُرفض؛ الصلاحيات حسب التوزيع؛ pagination
 * والفلاتر لا تسرب؛ post/reverse/retry/concurrency عبر الخدمة نفسها؛ صفر كتابة في V2.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const statements = splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"));
const V2_TABLES = ["treasury_transactions", "financial_transactions", "financial_transaction_entries", "financial_accounts", "business_events"];
const stripLedgerIndexes = (ddl: string) => ddl.split("\n").filter(l => !/`(businesses|employees)_tenant_id`/.test(l)).join("\n").replace(/,\n\)/, "\n)");

describe.runIf(CAN)("🛣️ Ledger V3 routers — صلاحيات وعزل على قاعدة حقيقية", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  let raw: mysql.Connection;
  const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  let ownerA = 0, adminA = 0, accountantA = 0, clerkA = 0, ownerB = 0, managerA = 0, inactiveA = 0;
  let acc: Record<string, number> = {};
  const empIds: number[] = [];
  // (كسول: جسم describe يُجمَّع حتى عند runIf(false) — لا new URL(undefined) هنا)
  const baseUrl = process.env.TEST_DATABASE_URL ?? "";
  const tempName = `ledgerrt_${tag}`;
  const tempUrlOf = () => { const u = new URL(baseUrl); u.pathname = `/${tempName}`; return u.toString(); };
  let admin: mysql.Connection; let tempDb: ReturnType<typeof drizzle> | null = null;

  const sessionCtx = async (employeeId: number) => createContext({
    req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId }, process.env.JWT_SECRET as string) } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as any);
  const caller = (employeeId: number) => new Proxy({}, {
    get: (_t, ns: string) => new Proxy({}, {
      get: (_t2, proc: string) => {
        const call = async (input: any) => ((await appRouter.createCaller(await sessionCtx(employeeId)) as any).ledger[ns][proc](input));
        // دعم مستويين: ledger.status (ns=status بلا proc) وledger.accounts.list
        return proc === "then" ? undefined : call;
      },
    }),
  }) as any;
  const top = (employeeId: number, proc: string) => async (input?: any) => ((await appRouter.createCaller(await sessionCtx(employeeId)) as any).ledger[proc](input));
  const code = async (fn: () => Promise<unknown>) => { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } };
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  // عدّ صفوف V2 **لأنشطة هذا الاختبار فقط** — القاعدة مشتركة مع ملفات اختبار أخرى تكتب في V2 بالتوازي
  const v2Counts = async () => { const out: Record<string, number> = {}; for (const t of V2_TABLES) out[t] = Number((await raw.query(`SELECT COUNT(*) n FROM \`${t}\` WHERE businessId IN (?, ?)`, [A.businessId, B.businessId]) as any)[0][0].n); return out; };
  let v2Before: Record<string, number> = {};

  beforeAll(async () => {
    // قاعدة مؤقتة كاملة: نسخة المخطط الحقيقي (بلا فهرسي 0040 إن وُجدا) + تطبيق 0040، ثم توجيه getDb إليها
    admin = await mysql.createConnection(baseUrl);
    const [tables] = await admin.query("SHOW TABLES") as any;
    const names: string[] = tables.map((r: any) => Object.values(r)[0] as string).filter((n: string) => !n.startsWith("ledger_") && !n.startsWith("_"));
    const ddl: string[] = [];
    for (const n of names) { try { const [r] = await admin.query(`SHOW CREATE TABLE \`${n}\``) as any; ddl.push(stripLedgerIndexes(r[0]["Create Table"])); } catch (e: any) { if (e?.code !== "ER_NO_SUCH_TABLE") throw e; } }
    await admin.query(`CREATE DATABASE \`${tempName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    raw = await mysql.createConnection(tempUrlOf());
    await raw.query("SET foreign_key_checks = 0");
    for (const stmt of ddl) await raw.query(stmt);
    await raw.query("SET foreign_key_checks = 1");
    for (const stmt of statements) await raw.query(stmt);
    tempDb = drizzle(tempUrlOf());
    __setDbForTests(tempDb);
    A = await createCoreTestFixture("lr-a"); B = await createCoreTestFixture("lr-b");
    const mk = async (name: string, role: string, fx: CoreTestFixture) => {
      const id = insId(await createEmployee({ name, role, isActive: true, tenantId: fx.tenantId, businessId: fx.businessId, username: `${name}-${tag}`.slice(0, 50) } as any));
      empIds.push(id); return id;
    };
    ownerA = await mk("lr-owner-a", "super_admin", A); adminA = await mk("lr-admin-a", "admin", A);
    accountantA = await mk("lr-acc-a", "accountant", A); clerkA = await mk("lr-clerk-a", "data_entry", A);
    ownerB = await mk("lr-owner-b", "super_admin", B);
    managerA = await mk("lr-mgr-a", "manager", A);
    inactiveA = insId(await createEmployee({ name: `lr-old-a`, role: "accountant", isActive: false, tenantId: A.tenantId, businessId: A.businessId, username: `lr-old-a-${tag}` } as any)); empIds.push(inactiveA);
    // المالك يمنح المحاسب view + post فقط (عبر tenant_role_permissions)
    const d = (await getDb())!;
    for (const permission of ["ledger.view", "ledger.post"]) await d.insert(tenantRolePermissions).values({ tenantId: A.tenantId, role: "accountant", permission, isAllowed: true, updatedBy: ownerA });
    v2Before = await v2Counts();
    const r = await activateLedgerV3({
      tenantId: A.tenantId, goLiveDate: "2026-10-01", currency: "EGP", actor: { type: "employee", employeeId: ownerA },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: ownerA, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "1000", BANK_MAIN: "5000" }, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId] },
    });
    acc = r.accounts;
  }, 120_000);

  afterAll(async () => {
    // القاعدة المؤقتة تُحذف بالكامل — ثم تُعاد getDb إلى قاعدة الاختبار المشتركة
    __setDbForTests(null);
    await (tempDb as any)?.$client?.end?.();
    await raw?.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${tempName}\``);
    await admin.end();
  }, 120_000);

  it("🔒 موظف بلا صلاحية: كل إجراءات الدفتر مرفوضة FORBIDDEN", async () => {
    expect(await code(() => top(clerkA, "status")())).toBe("FORBIDDEN");
    expect(await code(() => caller(clerkA).accounts.list())).toBe("FORBIDDEN");
    expect(await code(() => caller(clerkA).transactions.list({}))).toBe("FORBIDDEN");
    expect(await code(() => top(clerkA, "post")({ kind: "expense", idempotencyKey: `r-${tag}-clerk`, effectiveDate: "2026-10-07", description: "x", entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "1" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1" }] }))).toBe("FORBIDDEN");
    expect(await code(() => caller(clerkA).period.lock({ period: "2026-10" }))).toBe("FORBIDDEN");
  });

  it("🏷️ businesses.list: المالك يرى أنشطة شركته فقط، المحاسب نشاطه فقط، بلا صلاحية = FORBIDDEN، ولا تسرب بين الشركات", async () => {
    const ownerSees = await caller(ownerA).businesses.list();
    expect(ownerSees.map((b: any) => b.id)).toContain(A.businessId);
    expect(ownerSees.map((b: any) => b.id)).not.toContain(B.businessId);
    expect(ownerSees.every((b: any) => typeof b.name === "string" && Object.keys(b).sort().join() === "id,name")).toBe(true);
    const accSees = await caller(accountantA).businesses.list();
    expect(accSees.map((b: any) => b.id)).toEqual([A.businessId]);
    const ownerBSees = await caller(ownerB).businesses.list();
    expect(ownerBSees.map((b: any) => b.id)).toContain(B.businessId);
    expect(ownerBSees.map((b: any) => b.id)).not.toContain(A.businessId);
    expect(await code(() => caller(clerkA).businesses.list())).toBe("FORBIDDEN");
    expect(await code(() => caller(managerA).businesses.list())).toBe("FORBIDDEN");
  });

  it("👤 المحاسب الممنوح: يرى ويرحّل (عبر الخدمة)، لكنه لا يعكس ولا يقفل ولا يدير الحسابات", async () => {
    const s = await top(accountantA, "status")();
    expect(s).toMatchObject({ tablesPresent: true, enabled: true, goLiveDate: "2026-10-01" });
    const accounts = await caller(accountantA).accounts.list();
    expect(accounts.map((a: any) => a.code).sort()).toEqual(["BANK_MAIN", "COD_BOSTA", "EXPENSE", "INSTAPAY", "OFFICE_CASH", "OPENING_EQUITY", "REVENUE", "SUSPENSE", "VF_CASH"]);
    expect(accounts.find((a: any) => a.code === "OFFICE_CASH")).toMatchObject({ isSystem: true, currentBalance: "1000.0000", businesses: [{ businessId: A.businessId, canPost: true }] });
    const posted = await top(accountantA, "post")({
      sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: `r-${tag}-acc-1`, effectiveDate: "2026-10-07", description: "نظافة",
      entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "300" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "300" }],
    });
    expect(posted.replay).toBe(false); expect(posted.entries[1].balanceAfter).toBe("700.0000");
    const got = await caller(accountantA).transaction.get({ transactionId: posted.transactionId });
    expect(got.kind).toBe("expense"); expect(got.entries).toHaveLength(2); expect(got.actorEmployeeId).toBe(accountantA); expect(got.reversedByTransactionId).toBeNull();
    expect(await code(() => top(accountantA, "reverse")({ transactionId: posted.transactionId, idempotencyKey: `r-${tag}-acc-rev`, effectiveDate: "2026-10-08", reason: "خطأ" }))).toBe("FORBIDDEN");
    expect(await code(() => caller(accountantA).period.lock({ period: "2026-10" }))).toBe("FORBIDDEN");
    expect(await code(() => caller(accountantA).account.create({ code: "RENT", name: "إيجار", kind: "expense", normalSide: "debit" }))).toBe("FORBIDDEN");
    expect(await code(() => caller(accountantA).account.updateName({ accountId: acc.EXPENSE, name: "x" }))).toBe("FORBIDDEN");
    expect(await code(() => caller(accountantA).account.grantBusiness({ accountId: acc.VF_CASH, businessId: A.businessId }))).toBe("FORBIDDEN");
    expect((await top(accountantA, "reconciliation")()).ok).toBe(true);
  });

  it("🛠️ admin: يدير الحسابات ويقفل الفترة، لكنه لا يعيد الفتح؛ تصنيف مصروف = حساب إضافي kind=expense", async () => {
    const created = await caller(adminA).account.create({ code: "RENT", name: "الإيجار", kind: "expense", normalSide: "debit" });
    expect(created.replay).toBe(false);
    expect((await caller(adminA).account.create({ code: "RENT", name: "الإيجار", kind: "expense", normalSide: "debit" })).replay).toBe(true);
    expect(await code(() => caller(adminA).account.create({ code: "OFFICE_CASH", name: "x", kind: "cash", normalSide: "debit" }))).toBe("NOT_FOUND"); // كود محجوز لحساب النظام
    await caller(adminA).account.updateName({ accountId: created.id, name: "إيجار المقر" });
    await caller(adminA).account.grantBusiness({ accountId: created.id, businessId: A.businessId });
    const rent = (await caller(adminA).accounts.list()).find((a: any) => a.code === "RENT");
    expect(rent).toMatchObject({ name: "إيجار المقر", isSystem: false, businesses: [{ businessId: A.businessId, canPost: true }] });
    // ترحيل على الحساب الجديد ثم تعطيله: التاريخ والرصيد يبقيان، والقيود الجديدة تُمنع
    const p = await top(adminA, "post")({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: `r-${tag}-rent`, effectiveDate: "2026-10-09", description: "إيجار", entries: [{ accountId: created.id, side: "debit", amount: "2500" }, { accountId: acc.BANK_MAIN, side: "credit", amount: "2500" }] });
    expect(p.replay).toBe(false);
    await caller(adminA).account.setActive({ accountId: created.id, isActive: false });
    const rentAfter = (await caller(adminA).accounts.list()).find((a: any) => a.code === "RENT");
    expect(rentAfter).toMatchObject({ isActive: 0, currentBalance: "2500.0000" });
    expect(await code(() => top(adminA, "post")({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: `r-${tag}-rent2`, effectiveDate: "2026-10-09", description: "x", entries: [{ accountId: created.id, side: "debit", amount: "1" }, { accountId: acc.BANK_MAIN, side: "credit", amount: "1" }] }))).toBe("BAD_REQUEST");
    await caller(adminA).account.revokeBusiness({ accountId: created.id, businessId: A.businessId });
    expect((await caller(adminA).accounts.list()).find((a: any) => a.code === "RENT").businesses).toEqual([{ businessId: A.businessId, canPost: false }]);
    // القفل متاح للـadmin، إعادة الفتح للمالك فقط
    const lock = await caller(adminA).period.lock({ period: "2026-09", reason: "إقفال" });
    expect(lock.status).toBe("locked");
    expect(await code(() => caller(adminA).period.reopen({ period: "2026-09", reason: "تصحيح" }))).toBe("FORBIDDEN");
    const periods = await caller(adminA).periods.list();
    expect(periods.find((x: any) => x.period === "2026-09")).toMatchObject({ status: "locked" });
    expect(periods.find((x: any) => x.period === "2026-09").events.map((e: any) => [e.action, e.actorEmployeeId])).toEqual([["lock", adminA]]);
  });

  it("👑 المالك: كل الصلاحيات — يعكس ويعيد الفتح؛ العكس الثاني CONFLICT وretry بنفس المفتاح replay", async () => {
    const list = await caller(ownerA).transactions.list({ kind: "expense", businessId: A.businessId });
    const expense = list.rows.find((r: any) => r.description === "نظافة");
    expect(expense).toBeTruthy();
    const rev = await top(ownerA, "reverse")({ transactionId: expense.id, idempotencyKey: `r-${tag}-rev-1`, effectiveDate: "2026-10-10", reason: "تصحيح إدخال" });
    expect(rev.replay).toBe(false);
    expect((await top(ownerA, "reverse")({ transactionId: expense.id, idempotencyKey: `r-${tag}-rev-1`, effectiveDate: "2026-10-10", reason: "تصحيح إدخال" })).replay).toBe(true);
    expect(await code(() => top(ownerA, "reverse")({ transactionId: expense.id, idempotencyKey: `r-${tag}-rev-2`, effectiveDate: "2026-10-10", reason: "ثانية" }))).toBe("CONFLICT");
    expect((await caller(ownerA).transaction.get({ transactionId: expense.id })).reversedByTransactionId).toBe(rev.transactionId);
    const reopened = await caller(ownerA).period.reopen({ period: "2026-09", reason: "فاتورة متأخرة" });
    expect(reopened.status).toBe("open");
    expect(await code(() => caller(ownerA).period.reopen({ period: "2026-09", reason: "x" }))).toBe("BAD_REQUEST"); // سبب قصير (zod)
    const periods = await caller(ownerA).periods.list();
    expect(periods.find((x: any) => x.period === "2026-09").events.map((e: any) => e.action)).toEqual(["lock", "reopen"]);
    expect((await top(ownerA, "reconciliation")()).ok).toBe(true);
  });

  it("🔁 retry/concurrency عبر الـRouter تمر بالخدمة نفسها: 5 طلبات متزامنة بنفس المفتاح = حركة واحدة؛ حمولة مختلفة = CONFLICT", async () => {
    const post = (amount: string) => top(ownerA, "post")({ sourceBusinessId: A.businessId, kind: "owner_contribution", idempotencyKey: `r-${tag}-conc`, effectiveDate: "2026-10-11", description: "دعم", entries: [{ accountId: acc.OFFICE_CASH, side: "debit", amount }, { accountId: acc.OPENING_EQUITY, side: "credit", amount }] });
    const results = await Promise.all(Array.from({ length: 5 }, () => post("50")));
    expect(new Set(results.map((r: any) => r.transactionId)).size).toBe(1);
    expect(results.filter((r: any) => !r.replay)).toHaveLength(1);
    expect(await code(() => post("51"))).toBe("CONFLICT");
  });

  it("📄 pagination والفلاتر: حد 100، الصفحات لا تتداخل، فلتر الحساب، ونشاط من شركة أخرى FORBIDDEN", async () => {
    expect(await code(() => caller(ownerA).transactions.list({ limit: 101 }))).toBe("BAD_REQUEST");
    const p1 = await caller(ownerA).transactions.list({ page: 1, limit: 2 });
    const p2 = await caller(ownerA).transactions.list({ page: 2, limit: 2 });
    expect(p1.rows).toHaveLength(2); expect(p1.total).toBeGreaterThanOrEqual(4);
    expect(new Set([...p1.rows, ...p2.rows].map((r: any) => r.id)).size).toBe(p1.rows.length + p2.rows.length);
    const byAccount = await caller(ownerA).transactions.list({ accountId: acc.BANK_MAIN, limit: 50 });
    expect(byAccount.rows.length).toBeGreaterThanOrEqual(2); // الافتتاحي + الإيجار
    for (const r of byAccount.rows) expect((await caller(ownerA).transaction.get({ transactionId: r.id })).entries.some((e: any) => e.accountId === acc.BANK_MAIN)).toBe(true);
    expect(await code(() => caller(ownerA).transactions.list({ businessId: B.businessId }))).toBe("FORBIDDEN");
    expect((await caller(ownerA).transactions.list({ from: "2026-10-09", to: "2026-10-09" })).rows.every((r: any) => r.effectiveDate === "2026-10-09")).toBe(true);
  });

  it("🏢 Tenant B: يرى شركته فقط (غير مفعّلة)، وتزوير معرّفات A يُرفض بلا أي كتابة", async () => {
    expect(await top(ownerB, "status")()).toMatchObject({ tablesPresent: true, enabled: false });
    expect(await caller(ownerB).accounts.list()).toEqual([]);
    expect((await caller(ownerB).transactions.list({})).total).toBe(0);
    const before = Number((await raw.query("SELECT COUNT(*) n FROM ledger_transactions") as any)[0][0].n);
    expect(await code(() => caller(ownerB).transaction.get({ transactionId: 1 }))).toBe("NOT_FOUND");
    expect(await code(() => top(ownerB, "post")({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: `r-${tag}-b1`, effectiveDate: "2026-10-07", description: "x", entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "1" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1" }] }))).toBe("FORBIDDEN");
    expect(await code(() => top(ownerB, "post")({ sourceBusinessId: B.businessId, kind: "expense", idempotencyKey: `r-${tag}-b2`, effectiveDate: "2026-10-07", description: "x", entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "1" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1" }] }))).toBe("PRECONDITION_FAILED"); // B غير مفعّل
    const anyA = (await caller(ownerA).transactions.list({ limit: 1 })).rows[0];
    expect(await code(() => top(ownerB, "reverse")({ transactionId: anyA.id, idempotencyKey: `r-${tag}-b3`, effectiveDate: "2026-10-07", reason: "تسلل" }))).toBe("NOT_FOUND"); // حركة A غير مرئية لـB
    expect(await code(() => caller(ownerB).account.grantBusiness({ accountId: acc.OFFICE_CASH, businessId: A.businessId }))).toBe("FORBIDDEN");
    expect(await code(() => caller(ownerB).account.updateName({ accountId: acc.OFFICE_CASH, name: "x" }))).toBe("PRECONDITION_FAILED");
    expect(Number((await raw.query("SELECT COUNT(*) n FROM ledger_transactions") as any)[0][0].n)).toBe(before);
    expect((await caller(ownerA).accounts.list()).find((a: any) => a.code === "OFFICE_CASH").name).toBe("خزنة المكتب");
  });

  it("🧑‍💼 manager: بلا منح FORBIDDEN؛ بعد منح view/post/reverse/manage_accounts/period.lock تنجح كلها؛ إزالة المنح تسري فورًا", async () => {
    const d = (await getDb())!;
    const grant = async (role: string, perms: string[]) => { for (const permission of perms) await d.insert(tenantRolePermissions).values({ tenantId: A.tenantId, role, permission, isAllowed: true, updatedBy: ownerA }); };
    const revoke = async (role: string, perms: string[]) => { for (const permission of perms) await d.delete(tenantRolePermissions).where(and(eq(tenantRolePermissions.tenantId, A.tenantId), eq(tenantRolePermissions.role, role), eq(tenantRolePermissions.permission, permission))); };
    expect(await code(() => top(managerA, "status")())).toBe("FORBIDDEN");
    expect(await code(() => top(managerA, "post")({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: `r-${tag}-mgr-0`, effectiveDate: "2026-10-12", description: "x", entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "1" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1" }] }))).toBe("FORBIDDEN");
    const perms = ["ledger.view", "ledger.post", "ledger.reverse", "ledger.manage_accounts", "ledger.period.lock"];
    await grant("manager", perms);
    expect((await top(managerA, "status")()).enabled).toBe(true);
    const posted = await top(managerA, "post")({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: `r-${tag}-mgr-1`, effectiveDate: "2026-10-12", description: "مصروف المدير", entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "10" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "10" }] });
    expect(posted.replay).toBe(false);
    expect((await top(managerA, "reverse")({ transactionId: posted.transactionId, idempotencyKey: `r-${tag}-mgr-rev`, effectiveDate: "2026-10-12", reason: "تصحيح المدير" })).replay).toBe(false);
    const created = await caller(managerA).account.create({ code: "ADS", name: "إعلانات", kind: "expense", normalSide: "debit" });
    expect(created.replay).toBe(false);
    expect((await caller(managerA).period.lock({ period: "2026-08", reason: "إقفال" })).status).toBe("locked");
    // reopen/activate للمالك فقط حتى مع override
    await grant("manager", ["ledger.period.reopen", "ledger.activate"]);
    await grant("accountant", ["ledger.period.reopen", "ledger.activate"]);
    expect(await code(() => caller(managerA).period.reopen({ period: "2026-08", reason: "محاولة المدير" }))).toBe("FORBIDDEN");
    expect(await code(() => caller(accountantA).period.reopen({ period: "2026-08", reason: "محاولة المحاسب" }))).toBe("FORBIDDEN");
    expect(await code(() => caller(adminA).period.reopen({ period: "2026-08", reason: "محاولة الأدمن" }))).toBe("FORBIDDEN");
    expect((await caller(ownerA).period.reopen({ period: "2026-08", reason: "المالك يعيد الفتح" })).status).toBe("open");
    await revoke("manager", ["ledger.period.reopen", "ledger.activate"]); await revoke("accountant", ["ledger.period.reopen", "ledger.activate"]);
    // إزالة المنح تسري فورًا
    await revoke("manager", perms);
    expect(await code(() => top(managerA, "status")())).toBe("FORBIDDEN");
    expect(await code(() => caller(managerA).account.create({ code: "ADS2", name: "x", kind: "expense", normalSide: "debit" }))).toBe("FORBIDDEN");
  });

  it("🔒 موظف موقوف لا يملك جلسة أصلًا (fail-closed)، والمحاسب الممنوح view/post فقط لا يعكس ولا يدير", async () => {
    expect(await code(() => top(inactiveA, "status")())).toBe("UNAUTHORIZED");
    expect(await code(() => top(accountantA, "reverse")({ transactionId: 1, idempotencyKey: `r-${tag}-acc-rev2`, effectiveDate: "2026-10-12", reason: "x" }))).toBe("FORBIDDEN");
    expect(await code(() => caller(accountantA).account.setActive({ accountId: acc.EXPENSE, isActive: false }))).toBe("FORBIDDEN");
  });

  it("🏛️ حسابات النظام: لا تُعطَّل، والاسم فقط يتغير؛ الحساب الإضافي يُعطَّل مع بقاء رصيده وتاريخه في التقارير", async () => {
    for (const code of ["OFFICE_CASH", "BANK_MAIN", "COD_BOSTA", "VF_CASH", "INSTAPAY", "REVENUE", "EXPENSE", "OPENING_EQUITY", "SUSPENSE"])
      expect(await (async () => { try { await caller(ownerA).account.setActive({ accountId: acc[code], isActive: false }); return "ok"; } catch (e: any) { return e?.message?.includes("لا يُعطَّل") ? "refused" : e?.code; } })()).toBe("refused");
    await caller(ownerA).account.updateName({ accountId: acc.OFFICE_CASH, name: "الخزنة الرئيسية" });
    const cash = (await caller(ownerA).accounts.list()).find((a: any) => a.code === "OFFICE_CASH");
    expect(cash).toMatchObject({ name: "الخزنة الرئيسية", code: "OFFICE_CASH", kind: "cash", normalSide: "debit", currency: "EGP", isActive: 1, isSystem: true });
    await caller(ownerA).account.updateName({ accountId: acc.OFFICE_CASH, name: "خزنة المكتب" });
    // RENT (إضافي) معطَّل من اختبار سابق برصيد 2,500: يظهر في القائمة والمطابقة، ويرفض الترحيل الجديد
    const rent = (await caller(ownerA).accounts.list()).find((a: any) => a.code === "RENT");
    expect(rent).toMatchObject({ isActive: 0, currentBalance: "2500.0000", isSystem: false });
    const recon = await top(ownerA, "reconciliation")();
    expect(recon.lines.find((l: any) => l.code === "RENT")).toMatchObject({ stored: "2500.0000", ok: true });
    expect((await caller(ownerA).transactions.list({ accountId: rent.id })).total).toBeGreaterThanOrEqual(1);
    expect(await code(() => top(ownerA, "post")({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: `r-${tag}-rent3`, effectiveDate: "2026-10-12", description: "x", entries: [{ accountId: rent.id, side: "debit", amount: "1" }, { accountId: acc.BANK_MAIN, side: "credit", amount: "1" }] }))).toBe("BAD_REQUEST");
  });

  it("🔒 صفر كتابة في جداول V2 خلال كل السيناريوهات", async () => {
    expect(await v2Counts()).toEqual(v2Before);
  });
});
