import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { and, eq } from "drizzle-orm";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";
import { LedgerError } from "../shared/ledgerV3Core";
import {
  activateLedgerV3, disableLedgerV3, lockLedgerPeriod, postLedgerTransaction, reconcileLedgerV3, reopenLedgerPeriod, reverseLedgerTransaction,
  type LedgerDb,
} from "./ledgerV3.service";
import { ledgerAccounts, ledgerAccountBusinesses, ledgerEntries, ledgerPeriodEvents, ledgerPeriods, ledgerTenantFlags, ledgerTransactions } from "../drizzle/ledgerV3.schema";

/**
 * خدمة Ledger V3 على **قاعدتين كاملتين مؤقتتين** (نسخة المخطط الحقيقي + تطبيق 0040 داخلهما فقط):
 * العلم، التوازن والدقة، عزل الـtenant بلا كتابة جزئية، الصلاحيات، منع السالب، 10 طلبات متزامنة
 * بنفس المفتاح، التعارض، حركتان متزامنتان بلا lost update، الفترة المقفولة والـaudit، العكس مرة
 * واحدة، التفعيل الذرّي، المطابقة = صفر فروق، وصفر كتابة في جداول V2.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL);
const statements = splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"));
const V2_TABLES = ["treasury_transactions", "financial_transactions", "financial_transaction_entries", "financial_accounts", "business_events"];

describe.runIf(CAN)("📒 Ledger V3 service — قاعدتان كاملتان مؤقتتان", () => {
  const baseUrl = process.env.TEST_DATABASE_URL as string;
  const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const dbNames = [`ledgersvc_a_${tag}`, `ledgersvc_b_${tag}`];
  let admin: mysql.Connection;
  const urlFor = (db: string) => { const u = new URL(baseUrl); u.pathname = `/${db}`; return u.toString(); };
  const code = async (fn: () => Promise<unknown>) => { try { await fn(); return "ok"; } catch (e) { return e instanceof LedgerError ? e.code : (e as Error).message; } };

  beforeAll(async () => {
    admin = await mysql.createConnection(baseUrl);
    const [tables] = await admin.query("SHOW TABLES") as any;
    const names: string[] = tables.map((r: any) => Object.values(r)[0] as string).filter((n: string) => !n.startsWith("ledger_"));
    const ddl: string[] = [];
    for (const n of names) { const [r] = await admin.query(`SHOW CREATE TABLE \`${n}\``) as any; ddl.push(r[0]["Create Table"]); }
    for (const name of dbNames) {
      await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      const c = await mysql.createConnection(urlFor(name));
      await c.query("SET foreign_key_checks = 0");
      for (const stmt of ddl) await c.query(stmt);
      await c.query("SET foreign_key_checks = 1");
      for (const stmt of statements) await c.query(stmt); // 0040 داخل القاعدة المؤقتة فقط
      await c.end();
    }
  }, 180_000);
  afterAll(async () => {
    for (const name of dbNames) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  });

  for (const [i, name] of dbNames.entries()) {
    describe(`قاعدة ${i + 1}`, () => {
      let db: LedgerDb; let raw: mysql.Connection;
      let tenantA = 0, tenantB = 0, bizA1 = 0, bizA2 = 0, bizB = 0, ownerA = 0, accountantA = 0, inactiveA = 0, ownerB = 0;
      let acc: Record<string, number> = {};
      const v2Counts = async () => {
        const out: Record<string, number> = {};
        for (const t of V2_TABLES) out[t] = Number((await raw.query(`SELECT COUNT(*) n FROM \`${t}\``) as any)[0][0].n);
        return out;
      };
      let v2Before: Record<string, number> = {};
      const count = async (t: string) => Number((await raw.query(`SELECT COUNT(*) n FROM \`${t}\``) as any)[0][0].n);
      const balance = async (accountId: number) => (await db.select({ b: ledgerAccounts.currentBalance }).from(ledgerAccounts).where(eq(ledgerAccounts.id, accountId)))[0].b;
      const emp = (id: number) => ({ type: "employee" as const, employeeId: id });
      const sys = { type: "system" as const };

      beforeAll(async () => {
        db = drizzle(urlFor(name)) as unknown as LedgerDb;
        raw = await mysql.createConnection(urlFor(name));
        const ins = async (sql: string, p: unknown[]) => Number(((await raw.query(sql, p)) as any)[0].insertId);
        tenantA = await ins("INSERT INTO tenants (name, slug, status) VALUES (?, ?, 'active')", [`T-A ${tag}`, `ta-${tag}`]);
        tenantB = await ins("INSERT INTO tenants (name, slug, status) VALUES (?, ?, 'active')", [`T-B ${tag}`, `tb-${tag}`]);
        bizA1 = await ins("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'Brand A1', ?)", [tenantA, `a1-${tag}`]);
        bizA2 = await ins("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'Brand A2', ?)", [tenantA, `a2-${tag}`]);
        bizB = await ins("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'Brand B', ?)", [tenantB, `b-${tag}`]);
        ownerA = await ins("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('owner A', 'super_admin', 1, ?, ?, ?)", [tenantA, bizA1, `oa-${tag}`]);
        accountantA = await ins("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('acc A', 'accountant', 1, ?, ?, ?)", [tenantA, bizA1, `aa-${tag}`]);
        inactiveA = await ins("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('old A', 'accountant', 0, ?, ?, ?)", [tenantA, bizA1, `ia-${tag}`]);
        ownerB = await ins("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('owner B', 'super_admin', 1, ?, ?, ?)", [tenantB, bizB, `ob-${tag}`]);
        v2Before = await v2Counts();
      });
      afterAll(async () => { await raw.end(); await (db as any).$client?.end?.(); });

      it("🚫 Feature disabled → أي ترحيل مرفوض بلا كتابة (ولا فترة ولا حركة)", async () => {
        const r = await code(() => postLedgerTransaction({
          tenantId: tenantA, kind: "expense", idempotencyKey: `k-${tag}-disabled`, effectiveDate: "2026-10-07", currency: "EGP", actor: sys,
          entries: [{ accountId: 1, side: "debit", amount: "10" }, { accountId: 2, side: "credit", amount: "10" }], description: "x",
        }, db));
        expect(r).toBe("disabled");
        expect(await count("ledger_transactions")).toBe(0); expect(await count("ledger_periods")).toBe(0);
      });

      it("✅ التفعيل ذرّي: حسابات أساسية + ربط + قيد افتتاحي واحد + العلم في transaction واحدة؛ الفشل يرجع كل شيء ويبقى disabled", async () => {
        const base = {
          tenantId: tenantA, goLiveDate: "2026-10-01", currency: "EGP", actor: emp(ownerA),
          reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: ownerA, approvedAt: "2026-09-30T21:00:00Z" },
          businessIds: [bizA1, bizA2],
          safeGrants: { OFFICE_CASH: [bizA1, bizA2], BANK_MAIN: [bizA1, bizA2], COD_BOSTA: [bizA1], VF_CASH: [bizA1], INSTAPAY: [bizA2] },
        };
        // فشل متعمّد: نشاط من tenant آخر داخل القائمة → لا حسابات ولا علم
        expect(await code(() => activateLedgerV3({ ...base, businessIds: [bizA1, bizB], openingBalances: { OFFICE_CASH: "100" } }, db))).toBe("business");
        expect(await count("ledger_accounts")).toBe(0); expect(await count("ledger_tenant_flags")).toBe(0);
        // فشل متعمّد: اعتماد بموظف ليس مالكًا
        expect(await code(() => activateLedgerV3({ ...base, reconciliation: { ...base.reconciliation, approvedByEmployeeId: accountantA }, openingBalances: {} }, db))).toBe("activationInput");
        expect(await count("ledger_accounts")).toBe(0);
        // فشل متعمّد: رصيد افتتاحي بسالب
        expect(await code(() => activateLedgerV3({ ...base, openingBalances: { BANK_MAIN: "-1" } }, db))).toBe("amount");
        expect(await count("ledger_accounts")).toBe(0); expect(await count("ledger_transactions")).toBe(0);
        // التفعيل الصحيح
        const r = await activateLedgerV3({ ...base, openingBalances: { OFFICE_CASH: "2000", BANK_MAIN: "10000.5", COD_BOSTA: "0" } }, db);
        expect(r.replay).toBe(false); expect(r.openingTransactionId).toBeTruthy();
        acc = r.accounts;
        expect(Object.keys(acc).sort()).toEqual(["BANK_MAIN", "COD_BOSTA", "EXPENSE", "INSTAPAY", "OFFICE_CASH", "OPENING_EQUITY", "REVENUE", "SUSPENSE", "VF_CASH"]);
        expect(await balance(acc.OFFICE_CASH)).toBe("2000.0000"); expect(await balance(acc.BANK_MAIN)).toBe("10000.5000");
        expect(await balance(acc.OPENING_EQUITY)).toBe("12000.5000"); expect(await balance(acc.COD_BOSTA)).toBe("0.0000");
        const [flag] = await db.select().from(ledgerTenantFlags).where(eq(ledgerTenantFlags.tenantId, tenantA));
        expect(flag.ledgerV3Enabled).toBe(1); expect(flag.openingTransactionId).toBe(r.openingTransactionId); expect(flag.goLiveDate).toBe("2026-10-01");
        // إعادة التفعيل بنفس المفتاح (نفس تاريخ البدء) = replay بلا تكرار حسابات أو رصيد
        const again = await activateLedgerV3({ ...base, openingBalances: { OFFICE_CASH: "2000", BANK_MAIN: "10000.5" } }, db);
        expect(again.replay).toBe(true); expect(await count("ledger_accounts")).toBe(9); expect(await count("ledger_transactions")).toBe(1);
        expect(await balance(acc.OFFICE_CASH)).toBe("2000.0000");
        expect(await code(() => activateLedgerV3({ ...base, goLiveDate: "2026-11-01", openingBalances: {} }, db))).toBe("alreadyEnabled");
      });

      it("✅ قيد متوازن (إيراد COD) ينجح ويحدّث الأرصدة حسب normalSide؛ replay بعد الالتزام يعيد نفس الحركة بلا كتابة", async () => {
        const post = () => postLedgerTransaction({
          tenantId: tenantA, sourceBusinessId: bizA1, kind: "revenue_cod", idempotencyKey: `bosta:${tag}:45`, effectiveDate: "2026-10-07", currency: "EGP",
          actor: { type: "webhook" }, entries: [{ accountId: acc.COD_BOSTA, side: "debit", amount: "750" }, { accountId: acc.REVENUE, side: "credit", amount: "750" }],
          description: "تسليم بوسطة 45", sourceType: "shipment", sourceReference: "SHP-1",
        }, db);
        const r1 = await post();
        expect(r1.replay).toBe(false); expect(r1.postingPeriod).toBe("2026-10");
        expect(r1.entries.map(e => e.balanceAfter)).toEqual(["750.0000", "750.0000"]);
        expect(await balance(acc.COD_BOSTA)).toBe("750.0000"); expect(await balance(acc.REVENUE)).toBe("750.0000");
        const before = await count("ledger_entries");
        const r2 = await post();
        expect(r2).toMatchObject({ transactionId: r1.transactionId, replay: true });
        expect(await count("ledger_entries")).toBe(before);
      });

      it("🚫 غير المتوازن/الصفر/السالب/خلط العملات/حسابان غير مختلفين/نوع حر — مرفوضة بلا كتابة", async () => {
        const before = await count("ledger_transactions");
        const base = { tenantId: tenantA, sourceBusinessId: bizA1, kind: "expense" as const, effectiveDate: "2026-10-07", currency: "EGP", actor: emp(accountantA), description: "x" };
        const e = (d: string, c: string) => [{ accountId: acc.EXPENSE, side: "debit" as const, amount: d }, { accountId: acc.OFFICE_CASH, side: "credit" as const, amount: c }];
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-u1`, entries: e("100", "99.99") }, db))).toBe("unbalanced");
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-u2`, entries: e("0", "0") }, db))).toBe("amount");
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-u3`, entries: e("-5", "-5") }, db))).toBe("amount");
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-u4`, currency: "USD", entries: e("5", "5") }, db))).toBe("currency");
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-u5`, entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "5" }, { accountId: acc.EXPENSE, side: "credit", amount: "5" }] }, db))).toBe("entriesMin");
        expect(await code(() => postLedgerTransaction({ ...base, kind: "free_text" as any, idempotencyKey: `k-${tag}-u6`, entries: e("5", "5") }, db))).toBe("kind");
        expect(await code(() => postLedgerTransaction({ ...base, kind: "reversal" as any, idempotencyKey: `k-${tag}-u7`, entries: e("5", "5") }, db))).toBe("kind");
        expect(await count("ledger_transactions")).toBe(before);
      });

      it("🔒 النشاط/الحساب/الموظف من Tenant آخر، canPost=0، حساب موقوف، فاعل بلا تطابق — مرفوض بلا كتابة جزئية", async () => {
        const before = { tx: await count("ledger_transactions"), en: await count("ledger_entries") };
        const okEntries = [{ accountId: acc.EXPENSE, side: "debit" as const, amount: "5" }, { accountId: acc.OFFICE_CASH, side: "credit" as const, amount: "5" }];
        const base = { tenantId: tenantA, kind: "expense" as const, effectiveDate: "2026-10-07", currency: "EGP", description: "x" };
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-i1`, sourceBusinessId: bizB, actor: sys, entries: okEntries }, db))).toBe("business");
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-i2`, sourceBusinessId: bizA1, actor: sys, entries: [{ ...okEntries[0], businessId: bizB }, okEntries[1]] }, db))).toBe("business");
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-i3`, sourceBusinessId: bizA1, actor: emp(ownerB), entries: okEntries }, db))).toBe("actorEmployee");
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-i4`, sourceBusinessId: bizA1, actor: emp(inactiveA), entries: okEntries }, db))).toBe("actorEmployee");
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-i5`, sourceBusinessId: bizA1, actor: { type: "system", employeeId: ownerA as any }, entries: okEntries }, db))).toBe("actorSystem");
        // حساب tenant B (يُنشأ مباشرة) داخل قيد A → مرفوض
        const [bAcc] = await raw.query("INSERT INTO ledger_accounts (tenantId, code, name, kind, normalSide, actorType) VALUES (?, 'OFFICE_CASH', 'B cash', 'cash', 'debit', 'system')", [tenantB]) as any;
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-i6`, sourceBusinessId: bizA1, actor: sys, entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "5" }, { accountId: Number(bAcc.insertId), side: "credit", amount: "5" }] }, db))).toBe("account");
        // canPost=0: نشاط A2 ليس له صلاحية على COD_BOSTA (لم يُمنح) → grant
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-i7`, sourceBusinessId: bizA2, actor: sys, entries: [{ accountId: acc.COD_BOSTA, side: "debit", amount: "5" }, { accountId: acc.REVENUE, side: "credit", amount: "5" }] }, db))).toBe("grant");
        await db.update(ledgerAccountBusinesses).set({ canPost: 0 }).where(and(eq(ledgerAccountBusinesses.accountId, acc.INSTAPAY), eq(ledgerAccountBusinesses.businessId, bizA2)));
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-i8`, sourceBusinessId: bizA2, actor: sys, entries: [{ accountId: acc.INSTAPAY, side: "debit", amount: "5" }, { accountId: acc.REVENUE, side: "credit", amount: "5" }] }, db))).toBe("grant");
        // حساب موقوف
        await db.update(ledgerAccounts).set({ isActive: 0 }).where(eq(ledgerAccounts.id, acc.SUSPENSE));
        expect(await code(() => postLedgerTransaction({ ...base, idempotencyKey: `k-${tag}-i9`, sourceBusinessId: bizA1, actor: sys, entries: [{ accountId: acc.SUSPENSE, side: "debit", amount: "5" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "5" }] }, db))).toBe("accountInactive");
        await db.update(ledgerAccounts).set({ isActive: 1 }).where(eq(ledgerAccounts.id, acc.SUSPENSE));
        expect({ tx: await count("ledger_transactions"), en: await count("ledger_entries") }).toEqual(before);
      });

      it("🚫 منع الرصيد السالب (allowNegative=0) — ويُسمح عند allowNegative=1", async () => {
        const base = { tenantId: tenantA, sourceBusinessId: bizA1, kind: "expense" as const, effectiveDate: "2026-10-07", currency: "EGP", actor: emp(accountantA), description: "x" };
        const draw = (k: string) => postLedgerTransaction({ ...base, idempotencyKey: k, entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "3000" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "3000" }] }, db);
        expect(await code(() => draw(`k-${tag}-n1`))).toBe("negative"); // المكتب 2000 فقط
        expect(await balance(acc.OFFICE_CASH)).toBe("2000.0000");
        await db.update(ledgerAccounts).set({ allowNegative: 1 }).where(eq(ledgerAccounts.id, acc.OFFICE_CASH));
        expect((await draw(`k-${tag}-n2`)).replay).toBe(false);
        expect(await balance(acc.OFFICE_CASH)).toBe("-1000.0000");
        // إرجاع: عكس هذه الحركة ثم إعادة المنع
        await reverseLedgerTransaction({ tenantId: tenantA, transactionId: (await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, `k-${tag}-n2`)))[0].id, idempotencyKey: `rev-${tag}-n2`, effectiveDate: "2026-10-07", actor: emp(ownerA), reason: "اختبار" }, db);
        await db.update(ledgerAccounts).set({ allowNegative: 0 }).where(eq(ledgerAccounts.id, acc.OFFICE_CASH));
        expect(await balance(acc.OFFICE_CASH)).toBe("2000.0000");
      });

      it("🔁 10 طلبات متزامنة بنفس المفتاح = حركة واحدة وقيدان؛ نفس المفتاح بحمولة مختلفة = CONFLICT", async () => {
        const key = `k-${tag}-conc`;
        const post = (amount: string) => postLedgerTransaction({
          tenantId: tenantA, sourceBusinessId: bizA1, kind: "expense", idempotencyKey: key, effectiveDate: "2026-10-07", currency: "EGP", actor: emp(accountantA),
          entries: [{ accountId: acc.EXPENSE, side: "debit", amount }, { accountId: acc.OFFICE_CASH, side: "credit", amount }], description: "مصروف",
        }, db);
        const cashBefore = await balance(acc.OFFICE_CASH);
        const results = await Promise.all(Array.from({ length: 10 }, () => post("300")));
        const ids = new Set(results.map(r => r.transactionId));
        expect(ids.size).toBe(1);
        expect(results.filter(r => !r.replay)).toHaveLength(1);
        expect((await db.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, [...ids][0]))).length).toBe(2);
        expect(await balance(acc.OFFICE_CASH)).toBe((Number(cashBefore) - 300).toFixed(4));
        expect(await code(() => post("300.01"))).toBe("conflict");
        expect((await post("300")).replay).toBe(true);
      });

      it("🔁 حركتان متزامنتان مختلفتان على نفس الحساب → رصيد صحيح بلا lost update (×20)", async () => {
        const cashBefore = BigInt(Math.round(Number(await balance(acc.OFFICE_CASH)) * 10000));
        const n = 20;
        await Promise.all(Array.from({ length: n }, (_, i) => postLedgerTransaction({
          tenantId: tenantA, sourceBusinessId: bizA1, kind: i % 2 ? "expense" : "owner_contribution", idempotencyKey: `k-${tag}-par-${i}`, effectiveDate: "2026-10-07", currency: "EGP", actor: sys,
          entries: i % 2
            ? [{ accountId: acc.EXPENSE, side: "debit", amount: "7.25" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "7.25" }]
            : [{ accountId: acc.OFFICE_CASH, side: "debit", amount: "11.5" }, { accountId: acc.OPENING_EQUITY, side: "credit", amount: "11.5" }],
          description: "متوازٍ",
        }, db)));
        const expected = cashBefore + 10n * 115000n - 10n * 72500n;
        expect(await balance(acc.OFFICE_CASH)).toBe((Number(expected) / 10000).toFixed(4));
        const recon = await reconcileLedgerV3(tenantA, db);
        expect(recon.ok).toBe(true);
      });

      it("🔒 الفترة المقفولة ترفض الحركة ولا تعيد تأريخها؛ lock/reopen يسجلان audit كاملًا؛ إعادة الفتح تتطلب سببًا ودورًا", async () => {
        const lock = await lockLedgerPeriod({ tenantId: tenantA, period: "2026-09", actor: emp(ownerA), reason: "إقفال سبتمبر" }, db);
        expect(lock.status).toBe("locked"); expect(lock.replay).toBe(false);
        expect((await lockLedgerPeriod({ tenantId: tenantA, period: "2026-09", actor: emp(ownerA) }, db)).replay).toBe(true);
        const before = await count("ledger_transactions");
        expect(await code(() => postLedgerTransaction({
          tenantId: tenantA, sourceBusinessId: bizA1, kind: "expense", idempotencyKey: `k-${tag}-locked`, effectiveDate: "2026-09-15", currency: "EGP", actor: sys,
          entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "1" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1" }], description: "x",
        }, db))).toBe("periodLocked");
        expect(await count("ledger_transactions")).toBe(before);
        expect(await code(() => reopenLedgerPeriod({ tenantId: tenantA, period: "2026-09", actor: emp(ownerA), reason: "  " }, db))).toBe("reason");
        expect(await code(() => reopenLedgerPeriod({ tenantId: tenantA, period: "2026-09", actor: emp(accountantA), reason: "تصحيح" }, db))).toBe("reopenRole");
        expect(await code(() => reopenLedgerPeriod({ tenantId: tenantA, period: "2026-09", actor: sys, reason: "تصحيح" }, db))).toBe("reopenRole");
        expect(await code(() => reopenLedgerPeriod({ tenantId: tenantB, period: "2026-09", actor: emp(ownerB), reason: "x" }, db))).toBe("disabled");
        const reopen = await reopenLedgerPeriod({ tenantId: tenantA, period: "2026-09", actor: emp(ownerA), reason: "فاتورة متأخرة" }, db);
        expect(reopen.status).toBe("open");
        const events = await db.select().from(ledgerPeriodEvents).where(eq(ledgerPeriodEvents.periodId, lock.periodId)).orderBy(ledgerPeriodEvents.id);
        expect(events.map(e => [e.action, e.actorType, e.actorEmployeeId, e.reason])).toEqual([["lock", "employee", ownerA, "إقفال سبتمبر"], ["reopen", "employee", ownerA, "فاتورة متأخرة"]]);
        const [p] = await db.select().from(ledgerPeriods).where(eq(ledgerPeriods.id, lock.periodId));
        expect(p.status).toBe("open");
        await lockLedgerPeriod({ tenantId: tenantA, period: "2026-09", actor: emp(ownerA), reason: "إقفال نهائي" }, db);
      });

      it("↩️ العكس: حركة جديدة بقيود معكوسة، الأصل لا يُمس، retry replay، الثاني بمفتاح آخر مرفوض، وTenant آخر لا يعكس", async () => {
        const original = await postLedgerTransaction({
          tenantId: tenantA, sourceBusinessId: bizA1, kind: "expense", idempotencyKey: `k-${tag}-rev-src`, effectiveDate: "2026-10-07", currency: "EGP", actor: emp(accountantA),
          entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "300" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "300" }], description: "نظافة",
        }, db);
        const cashAfterExpense = await balance(acc.OFFICE_CASH);
        const [origRow] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, original.transactionId));
        // عكس في فترة مقفولة (2026-09) → مرفوض؛ في فترة مفتوحة → يمر
        expect(await code(() => reverseLedgerTransaction({ tenantId: tenantA, transactionId: original.transactionId, idempotencyKey: `rev-${tag}-1`, effectiveDate: "2026-09-20", actor: emp(ownerA), reason: "خطأ" }, db))).toBe("periodLocked");
        const rev = await reverseLedgerTransaction({ tenantId: tenantA, transactionId: original.transactionId, idempotencyKey: `rev-${tag}-1`, effectiveDate: "2026-10-09", actor: emp(ownerA), reason: "خطأ إدخال" }, db);
        expect(rev.replay).toBe(false);
        expect(rev.entries.map(e => [e.side, e.amount])).toEqual([["credit", "300.0000"], ["debit", "300.0000"]]);
        expect(await balance(acc.OFFICE_CASH)).toBe((Number(cashAfterExpense) + 300).toFixed(4));
        const [revRow] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, rev.transactionId));
        expect(revRow.kind).toBe("reversal"); expect(revRow.reversalOfTransactionId).toBe(original.transactionId); expect(revRow.postingPeriod).toBe("2026-10");
        expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, original.transactionId)).then(r => r[0])).toEqual(origRow); // الأصل لم يُمس
        expect((await reverseLedgerTransaction({ tenantId: tenantA, transactionId: original.transactionId, idempotencyKey: `rev-${tag}-1`, effectiveDate: "2026-10-09", actor: emp(ownerA), reason: "خطأ إدخال" }, db)).replay).toBe(true);
        expect(await code(() => reverseLedgerTransaction({ tenantId: tenantA, transactionId: original.transactionId, idempotencyKey: `rev-${tag}-2`, effectiveDate: "2026-10-10", actor: emp(ownerA), reason: "ثانية" }, db))).toBe("reversedAlready");
        expect(await code(() => reverseLedgerTransaction({ tenantId: tenantB, transactionId: original.transactionId, idempotencyKey: `rev-${tag}-3`, effectiveDate: "2026-10-10", actor: emp(ownerB), reason: "تسلل" }, db))).toBe("transaction");
        expect(await code(() => reverseLedgerTransaction({ tenantId: tenantA, transactionId: original.transactionId, idempotencyKey: `rev-${tag}-4`, effectiveDate: "2026-10-10", actor: emp(ownerA), reason: "" }, db))).toBe("reason");
      });

      it("🔄 تحويل من البنك إلى خزنة المكتب (على مستوى الشركة، بلا نشاط) + مطابقة = صفر فروق لكل الحسابات", async () => {
        const r = await postLedgerTransaction({
          tenantId: tenantA, sourceBusinessId: null, kind: "transfer", idempotencyKey: `k-${tag}-transfer`, effectiveDate: "2026-10-08", currency: "EGP", actor: emp(ownerA),
          entries: [{ accountId: acc.OFFICE_CASH, side: "debit", amount: "5000" }, { accountId: acc.BANK_MAIN, side: "credit", amount: "5000" }], description: "تغذية خزنة",
        }, db);
        expect(r.replay).toBe(false);
        expect(await balance(acc.BANK_MAIN)).toBe("5000.5000");
        const recon = await reconcileLedgerV3(tenantA, db);
        expect(recon.ok).toBe(true);
        expect(recon.lines.every(l => l.difference === "0.0000")).toBe(true);
        expect(recon.lines.find(l => l.code === "COD_BOSTA")).toMatchObject({ stored: "750.0000", computed: "750.0000", entries: 1 });
        // العبث المباشر يُكتشف
        await db.update(ledgerAccounts).set({ currentBalance: "1.0000" }).where(eq(ledgerAccounts.id, acc.REVENUE));
        expect((await reconcileLedgerV3(tenantA, db)).ok).toBe(false);
        await db.update(ledgerAccounts).set({ currentBalance: "750.0000" }).where(eq(ledgerAccounts.id, acc.REVENUE));
      });

      it("🔒 صفر كتابة في جداول V2 خلال كل السيناريوهات؛ التعطيل الآمن يرفض الترحيل ويبقي السجل", async () => {
        expect(await v2Counts()).toEqual(v2Before);
        await disableLedgerV3({ tenantId: tenantA, actor: emp(ownerA), reason: "إيقاف مؤقت" }, db);
        expect(await code(() => postLedgerTransaction({
          tenantId: tenantA, sourceBusinessId: bizA1, kind: "expense", idempotencyKey: `k-${tag}-after-disable`, effectiveDate: "2026-10-07", currency: "EGP", actor: sys,
          entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "1" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1" }], description: "x",
        }, db))).toBe("disabled");
        expect(await count("ledger_transactions")).toBeGreaterThan(0);
        expect(await count("ledger_accounts")).toBe(10); // 9 لـA + حساب B المباشر من اختبار العزل
      });
    });
  }

  it("🚫 غياب جداول V3 (قاعدة الاختبار الرئيسية بلا 0040) → خطأ واضح، لا سقوط على V2", async () => {
    const main = drizzle(baseUrl) as unknown as LedgerDb;
    try {
      expect(await (async () => { try { await reconcileLedgerV3(1, main); return "ok"; } catch (e) { return e instanceof LedgerError ? e.code : "ERR"; } })()).toBe("unavailable");
    } finally { await (main as any).$client?.end?.(); }
  });
});
