import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee, createExpense, addTreasuryTransactionInTransaction, getDb } from "./db";
import { confirmPhrase, runHandMigration } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { LEDGER_SNAPSHOTS_MIGRATION } from "./ledgerPhaseMigrations";
import { activateLedgerV3, disableLedgerV3, postLedgerTransaction } from "./ledgerV3.service";
import { ensureDailyAccounts } from "./ledgerDaily.service";
import { figuresHash } from "./ledgerClose.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * المرحلة 7 على قاعدة حقيقية مؤقتة: الإقفال بقائمة فحص مكتملة وترتيب الشهور؛ الصورة الثابتة (بعد 0050) داخل transaction القفل
 * ببصمة sha256 وإصدارات بعد إعادة الفتح (للمالك فقط بسبب) بلا حذف؛ كشف التلاعب؛ إقفال متزامن = صورة واحدة؛ والأرشيف: V1/V2
 * مرفوضة لشركة فعّلت V3 ومسموحة لغيرها، وأي كتابة قديمة بعد التفعيل تُظهرها قائمة الفحص.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

describe.runIf(CAN)("🔒 المرحلة 7 — الإقفال والصورة الثابتة والأرشيف", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  const acc: Record<string, number> = {};
  let seq = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const expense = (date: string, amount: string) => postLedgerTransaction({ tenantId: A.tenantId, sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: `cl-exp-${++seq}-${tmp.name.slice(-4)}`, effectiveDate: date, currency: "EGP",
    actor: { type: "employee", employeeId: e.ownerA }, description: "إيجار", sourceType: null, sourceReference: null,
    entries: [{ accountId: acc.EXP_RENT, side: "debit", amount, businessId: A.businessId }, { accountId: acc.OFFICE_CASH, side: "credit", amount, businessId: A.businessId }] } as any);

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_close");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("cl-a"); B = await createCoreTestFixture("cl-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-cl`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("amA", "accounts_manager", A); await mk("ownerB", "super_admin", B);
    await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: "2026-09-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-08-31T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-08-31T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "5000" }, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId] } } as any);
    await ensureDailyAccounts({ tenantId: A.tenantId, businessIds: [A.businessId], actor: { type: "employee", employeeId: e.ownerA } });
    for (const r of await q("SELECT id, code FROM ledger_accounts WHERE tenantId = ?", [A.tenantId])) acc[r.code] = r.id;
    await expense("2026-09-10", "300");
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("الأرشيف: V1/V2 المالية مرفوضة لشركة فعّلت V3 قبل أي كتابة، ومسموحة لشركة لم تفعّل", async () => {
    const before = Number((await q("SELECT COUNT(*) n FROM expenses"))[0].n);
    await expect(createExpense({ businessId: A.businessId, amount: "10", description: "قديم", expenseDate: new Date(), createdBy: e.ownerA, createdByName: "مالك" } as any)).rejects.toThrow(/أرشيف للقراءة فقط/);
    const db = await getDb();
    await expect(db!.transaction(tx => addTreasuryTransactionInTransaction(tx, { businessId: A.businessId, type: "expense", direction: "out", amount: "10", description: "قديم", performedBy: e.ownerA, performedByName: "مالك" } as any))).rejects.toThrow(/أرشيف للقراءة فقط/);
    expect(Number((await q("SELECT COUNT(*) n FROM expenses"))[0].n)).toBe(before);
    expect(Number((await q("SELECT COUNT(*) n FROM treasury_transactions WHERE businessId = ?", [A.businessId]))[0].n)).toBe(0);
    await createExpense({ businessId: B.businessId, amount: "10", description: "شركة لم تفعّل", expenseDate: new Date(), createdBy: e.ownerB, createdByName: "مالك" } as any);
    expect(Number((await q("SELECT COUNT(*) n FROM expenses WHERE businessId = ?", [B.businessId]))[0].n)).toBe(1);
  });

  it("الإقفال قبل 0050: بقائمة فحص مكتملة وترتيب الشهور؛ مراجعة دفتر مفتوحة تمنع؛ بلا صورة (غير متاحة) بلا خطأ", async () => {
    const am = await call(e.amA);
    expect(await code(() => am.period.lock({ period: "2026-10", reason: "إقفال أكتوبر" }))).toBe("CONFLICT"); // سبتمبر مفتوح
    const o = insId(await q(`INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, totalAmount, status, source, needsReview, reviewReason)
      VALUES (?, ?, 'ع', '01000000000', 'ع', 'القاهرة', 'أسورة', '100', 'delivered', 'manual', 1, 'دفتر: اختبار')`, [A.businessId, `CL-${tmp.name.slice(-4)}`]));
    const err = await am.period.lock({ period: "2026-09", reason: "إقفال سبتمبر" }).then(() => null, (x: any) => x);
    expect(err?.code).toBe("CONFLICT"); expect(err?.message).toMatch(/مراجعة دفتر مفتوحة/);
    await q("UPDATE orders SET needsReview = 0, reviewReason = NULL WHERE id = ?", [o]);
    const r = await am.period.lock({ period: "2026-09", reason: "إقفال سبتمبر" });
    expect([r.status, r.snapshot, r.snapshotsAvailable]).toEqual(["locked", null, false]);
    expect((await am.period.snapshots({ period: "2026-09" })).available).toBe(false);
    expect(await code(() => am.period.reopen({ period: "2026-09", reason: "تصحيح" }))).toBe("FORBIDDEN"); // المالك فقط
    await (await call(e.ownerA)).period.reopen({ period: "2026-09", reason: "تطبيق 0050 وإعادة الإقفال" });
  });

  it("بعد 0050: صورة ثابتة داخل القفل ببصمة صحيحة؛ إقفال متزامن = صورة واحدة؛ إعادة فتح + تعديل = إصدار جديد والقديم يُعلَّم «تغيّر» بلا حذف؛ التلاعب يُكشف", async () => {
    expect((await runHandMigration(LEDGER_SNAPSHOTS_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync("drizzle/0050_ledger_period_snapshots.sql", "utf-8"), deployEnv: "test", confirm: confirmPhrase("0050", "apply", tmp.name) } as any)).ok).toBe(true);
    const am = await call(e.amA);
    const runs = await Promise.allSettled([1, 2, 3].map(() => am.period.lock({ period: "2026-09", reason: "إقفال سبتمبر" })));
    expect(runs.filter(r => r.status === "fulfilled")).toHaveLength(3);
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_period_snapshots WHERE tenantId = ? AND period = '2026-09'", [A.tenantId]))[0].n)).toBe(1);
    const [s1] = await q("SELECT figuresJson f, figuresHash h, version v FROM ledger_period_snapshots WHERE tenantId = ? AND period = '2026-09'", [A.tenantId]);
    const f1 = typeof s1.f === "string" ? JSON.parse(s1.f) : s1.f;
    expect([s1.v, f1.income.netProfit, f1.balances.find((b: any) => b.code === "OFFICE_CASH").balance, figuresHash(f1) === s1.h]).toEqual([1, "-300.0000", "4700.0000", true]);
    // إعادة فتح (المالك) + قيد جديد في سبتمبر ⇒ الإقفال التالي إصدار 2؛ الإصدار 1 يبقى ويُعلَّم أن الأرقام تغيّرت
    await (await call(e.ownerA)).period.reopen({ period: "2026-09", reason: "مصروف منسي" });
    await expense("2026-09-28", "50");
    await am.period.lock({ period: "2026-09", reason: "إعادة إقفال سبتمبر" });
    const list = (await am.period.snapshots({ period: "2026-09" })).snapshots;
    expect(list.map((x: any) => [x.version, x.netProfit, x.hashOk, x.changedSince])).toEqual([[1, "-300.0000", true, true], [2, "-350.0000", true, false]]);
    // تلاعب مباشر بأرقام الصورة يُكشف
    await q("UPDATE ledger_period_snapshots SET figuresJson = JSON_SET(figuresJson, '$.income.netProfit', '0.0000') WHERE tenantId = ? AND period = '2026-09' AND version = 1", [A.tenantId]);
    expect((await am.period.snapshots({ period: "2026-09" })).snapshots[0].hashOk).toBe(false);
    expect((await (await call(e.ownerB)).period.snapshots({ period: "2026-09" })).snapshots).toEqual([]); // B يرى صوره هو فقط (لا شيء)
  });

  it("قائمة الفحص تكشف أي كتابة مالية قديمة بعد التفعيل (لو أُدخلت خارج الحاجز)", async () => {
    await q("INSERT INTO treasury_transactions (businessId, type, direction, amount, balanceAfter, description, performedBy, performedByName) VALUES (?, 'expense', 'out', '5', '0', 'خارج الحاجز', ?, 'س')", [A.businessId, e.ownerA]);
    const month = (await q("SELECT DATE_FORMAT(NOW(), '%Y-%m') m"))[0].m;
    const c = await (await call(e.amA)).period.checklist({ period: month });
    expect(c.checks.find((x: any) => x.key === "legacy_writes")).toMatchObject({ ok: false, label: expect.stringMatching(/حركات خزنة قديمة 1/) });
  });

  it("الحظر مفصول عن علم V3: إطفاء V3 لا يرفعه؛ لا مسار لرفعه للمحاسب ولا مدير الحسابات (ولا عبر الإعدادات)؛ الشركة غير المفعّلة لم يتغير سلوكها", async () => {
    const accA = insId(await createEmployee({ name: "acc-cl", role: "accountant", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `accA_${tmp.name}`.slice(0, 50) } as any));
    await disableLedgerV3({ tenantId: A.tenantId, actor: { type: "employee", employeeId: e.ownerA }, reason: "اختبار: إطفاء لا يرفع الحظر" });
    expect((await q("SELECT ledgerV3Enabled v, enabledAt IS NOT NULL a FROM ledger_tenant_flags WHERE tenantId = ?", [A.tenantId]))[0]).toMatchObject({ v: 0, a: 1 });
    await expect(createExpense({ businessId: A.businessId, amount: "10", description: "بعد الإطفاء", expenseDate: new Date(), createdBy: e.ownerA, createdByName: "مالك" } as any)).rejects.toThrow(/أرشيف للقراءة فقط/);
    const db = await getDb();
    await expect(db!.transaction(tx => addTreasuryTransactionInTransaction(tx, { businessId: A.businessId, type: "expense", direction: "out", amount: "10", description: "بعد الإطفاء", performedBy: e.ownerA, performedByName: "مالك" } as any))).rejects.toThrow(/أرشيف للقراءة فقط/);
    // لا إجراء tRPC يرفع الحظر أصلًا (رفعه سيكون إجراءً منفصلًا للمالك بعد 0051) — ولا يمكن رفعه بإعداد عام
    const paths = Object.keys((appRouter as any)._def.procedures);
    expect(paths.filter(k => /legacy|unarchive/i.test(k) || /^ledger\..*archiv/i.test(k))).toEqual([]); // («أرشفة تصنيف مصروف» القديمة مسار مختلف)
    for (const who of [e.amA, accA])
      expect(await code(async () => (await call(who)).settings.set({ key: "legacy.archived", scopeBusinessId: 0, value: 0 } as any))).not.toBe("ok");
    // الشركة B (لم تُفعَّل قط): السلوك القديم كما هو
    await createExpense({ businessId: B.businessId, amount: "5", description: "شركة لم تفعّل", expenseDate: new Date(), createdBy: e.ownerB, createdByName: "مالك" } as any);
    await db!.transaction(tx => addTreasuryTransactionInTransaction(tx, { businessId: B.businessId, type: "expense", direction: "out", amount: "5", description: "شركة لم تفعّل", performedBy: e.ownerB, performedByName: "مالك" } as any));
    expect(Number((await q("SELECT COUNT(*) n FROM treasury_transactions WHERE businessId = ?", [B.businessId]))[0].n)).toBe(1);
  });
});
