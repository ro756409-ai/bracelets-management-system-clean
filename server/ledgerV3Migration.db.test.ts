import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import mysql from "mysql2/promise";
import { LEDGER_V3_DROP_ORDER, LEDGER_V3_TABLES, splitMigrationStatements } from "../shared/ledgerV3Spec";
import { openReadOnlyExecutor, type ReadOnlyExecutor } from "./balanceReconciliation.service";
import { ledgerV3Preflight, verifyLedgerV3OnDatabase } from "./ledgerV3Verify.service";

/**
 * Migration 0040 على **نسختين كاملتين من مخطط المشروع الحقيقي** (كل جداول قاعدة الاختبار المبنية من
 * schema.ts تُنسخ بـSHOW CREATE TABLE — نفس الأنواع والـcollation) في قاعدتين منفصلتين، ثم:
 * preflight → تطبيق 9 عبارات → تحقق مطابق → إعادة تشغيل تفشل بأمان بلا تغيير جزئي → الحالات الدقيقة
 * لعزل الـtenant (كل رفض بلا صف جزئي) → rollback كامل → المخطط القديم وبياناته كما كانا بالضبط.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL);
const statements = splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"));
const ROLLBACK = [
  ...LEDGER_V3_DROP_ORDER.map(t => `DROP TABLE \`${t}\``),
  "ALTER TABLE `employees` DROP INDEX `employees_tenant_id`",
  "ALTER TABLE `businesses` DROP INDEX `businesses_tenant_id`",
];

describe.runIf(CAN)("🏗️ Migration 0040 — نسختان كاملتان من المخطط الحقيقي: تطبيق → تحقق → عزل tenant → rollback", () => {
  const baseUrl = process.env.TEST_DATABASE_URL as string;
  const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const dbNames = [`ledgerv3_a_${tag}`, `ledgerv3_b_${tag}`];
  let admin: mysql.Connection;
  const urlFor = (db: string) => { const u = new URL(baseUrl); u.pathname = `/${db}`; return u.toString(); };

  /** لقطة المخطط القديم كاملًا + checksum بيانات الجدولين المعنيين — للمقارنة بعد الـrollback. */
  const oldSchemaSnapshot = async (c: mysql.Connection) => {
    const [tables] = await c.query("SHOW TABLES") as any;
    const names: string[] = tables.map((r: any) => Object.values(r)[0] as string).filter((n: string) => !n.startsWith("ledger_")).sort();
    const ddl: Record<string, string> = {};
    for (const n of names) { const [r] = await c.query(`SHOW CREATE TABLE \`${n}\``) as any; ddl[n] = r[0]["Create Table"]; }
    const [sums] = await c.query("CHECKSUM TABLE `tenants`, `businesses`, `employees`") as any;
    return { names, ddl, sums: sums.map((r: any) => [r.Table, Number(r.Checksum)]) };
  };

  // نسخ ≥80 جدولًا إلى قاعدتين يأخذ وقتًا تحت حمل باقي الـsuite المتوازية — مهلة أطول من الافتراضي.
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
      await c.end();
    }
  }, 120_000);
  afterAll(async () => {
    for (const name of dbNames) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  });

  for (const [i, name] of dbNames.entries()) {
    it(`نسخة ${i + 1}: preflight → تطبيق → تحقق → إعادة تشغيل آمنة → الحالات الدقيقة → rollback → المخطط القديم كما كان`, async () => {
      const url = urlFor(name);
      const c = await mysql.createConnection(url);
      let ro: ReadOnlyExecutor = await openReadOnlyExecutor(url);
      const reopen = async () => { await ro.close(); ro = await openReadOnlyExecutor(url); };
      try {
        // المخطط الحقيقي كاملًا (≥ 80 جدولًا) — وبيانات أساس قبل التطبيق
        const [[{ n: tableCount }]] = await c.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()") as any;
        expect(Number(tableCount)).toBeGreaterThanOrEqual(80);
        const [ta] = await c.query("INSERT INTO tenants (name, slug, status) VALUES (?, ?, 'active')", [`T-A ${tag}`, `ta-${tag}`]);
        const [tb] = await c.query("INSERT INTO tenants (name, slug, status) VALUES (?, ?, 'active')", [`T-B ${tag}`, `tb-${tag}`]);
        const tenantA = (ta as any).insertId, tenantB = (tb as any).insertId;
        const [ba] = await c.query("INSERT INTO businesses (tenantId, name, slug) VALUES (?, ?, ?)", [tenantA, "Brand A", `brand-a-${tag}`]);
        const [bb] = await c.query("INSERT INTO businesses (tenantId, name, slug) VALUES (?, ?, ?)", [tenantB, "Brand B", `brand-b-${tag}`]);
        const bizA = (ba as any).insertId, bizB = (bb as any).insertId;
        const [ea] = await c.query("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('emp A', 'accountant', 1, ?, ?, ?)", [tenantA, bizA, `empa-${tag}`]);
        const [eb] = await c.query("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES ('emp B', 'accountant', 1, ?, ?, ?)", [tenantB, bizB, `empb-${tag}`]);
        const empA = (ea as any).insertId, empB = (eb as any).insertId;
        const before = await oldSchemaSnapshot(c);

        // Preflight: كل الشروط متحققة على مخطط حقيقي ببيانات سليمة
        const pre = await ledgerV3Preflight(ro);
        expect(pre.filter(r => !r.ok)).toEqual([]);
        expect((await verifyLedgerV3OnDatabase(ro)).state).toBe("not_applied");

        // التطبيق — 9 عبارات كما ستُنفَّذ يدويًا
        for (const stmt of statements) await c.query(stmt);
        await reopen();
        const verified = await verifyLedgerV3OnDatabase(ro);
        expect(verified.issues).toEqual([]);
        expect(verified.state).toBe("applied");
        expect(verified.present).toEqual([...LEDGER_V3_TABLES].sort());

        // إعادة التشغيل بالخطأ: تفشل على **أول** عبارة (الفهرس موجود) ولا تغيّر شيئًا — الحالة تبقى applied لا partial
        await expect(c.query(statements[0])).rejects.toThrow(/Duplicate key name/i);
        await reopen();
        expect(await verifyLedgerV3OnDatabase(ro)).toMatchObject({ issues: [], state: "applied" });

        // ── الحالات الدقيقة لعزل الـtenant (كل رفض يُقاس بعدد الصفوف قبل/بعد) ──
        const count = async (t: string) => Number((await c.query(`SELECT COUNT(*) n FROM \`${t}\``) as any)[0][0].n);
        const [acA] = await c.query("INSERT INTO ledger_accounts (tenantId, code, name, kind, normalSide, actorType, actorEmployeeId) VALUES (?, 'OFFICE_CASH', 'خزنة المكتب', 'cash', 'debit', 'employee', ?)", [tenantA, empA]);
        const accA = (acA as any).insertId;
        await c.query("INSERT INTO ledger_periods (tenantId, period) VALUES (?, '2026-10')", [tenantA]);
        const [t1] = await c.query("INSERT INTO ledger_transactions (tenantId, sourceBusinessId, kind, idempotencyKey, payloadHash, effectiveDate, postingPeriod, description, actorType) VALUES (?, ?, 'revenue_cod', ?, ?, '2026-10-07', '2026-10', 'حركة A', 'webhook')", [tenantA, bizA, `k-${tag}-1`, "a".repeat(64)]);
        const txA = (t1 as any).insertId;

        // (1) tenantId=A + accountA + businessB في ledger_account_businesses → مرفوض
        let n = await count("ledger_account_businesses");
        await expect(c.query("INSERT INTO ledger_account_businesses (tenantId, accountId, businessId, actorType) VALUES (?, ?, ?, 'system')", [tenantA, accA, bizB])).rejects.toThrow(/foreign key/i);
        expect(await count("ledger_account_businesses")).toBe(n);
        // (2) tenantId=A + transactionA + accountA + businessB في ledger_entries → مرفوض
        n = await count("ledger_entries");
        await expect(c.query("INSERT INTO ledger_entries (tenantId, transactionId, accountId, businessId, side, amount, balanceAfter) VALUES (?, ?, ?, ?, 'debit', 100, 100)", [tenantA, txA, accA, bizB])).rejects.toThrow(/foreign key/i);
        expect(await count("ledger_entries")).toBe(n);
        // (3) tenantId=A + sourceBusinessId=B في ledger_transactions → مرفوض
        n = await count("ledger_transactions");
        await expect(c.query("INSERT INTO ledger_transactions (tenantId, sourceBusinessId, kind, idempotencyKey, payloadHash, effectiveDate, postingPeriod, description, actorType) VALUES (?, ?, 'expense', ?, ?, '2026-10-07', '2026-10', 'x', 'system')", [tenantA, bizB, `k-${tag}-2`, "b".repeat(64)])).rejects.toThrow(/foreign key/i);
        expect(await count("ledger_transactions")).toBe(n);
        // (4) tenantId=A + actorEmployeeId لموظف B → مرفوض (في الحساب، والربط، والحركة، وحدث الفترة)
        n = await count("ledger_accounts");
        await expect(c.query("INSERT INTO ledger_accounts (tenantId, code, name, kind, normalSide, actorType, actorEmployeeId) VALUES (?, 'BANK', 'بنك', 'bank', 'debit', 'employee', ?)", [tenantA, empB])).rejects.toThrow(/foreign key/i);
        expect(await count("ledger_accounts")).toBe(n);
        n = await count("ledger_account_businesses");
        await expect(c.query("INSERT INTO ledger_account_businesses (tenantId, accountId, businessId, actorType, actorEmployeeId) VALUES (?, ?, ?, 'employee', ?)", [tenantA, accA, bizA, empB])).rejects.toThrow(/foreign key/i);
        expect(await count("ledger_account_businesses")).toBe(n);
        n = await count("ledger_transactions");
        await expect(c.query("INSERT INTO ledger_transactions (tenantId, sourceBusinessId, kind, idempotencyKey, payloadHash, effectiveDate, postingPeriod, description, actorType, actorEmployeeId) VALUES (?, ?, 'expense', ?, ?, '2026-10-07', '2026-10', 'x', 'employee', ?)", [tenantA, bizA, `k-${tag}-3`, "c".repeat(64), empB])).rejects.toThrow(/foreign key/i);
        expect(await count("ledger_transactions")).toBe(n);
        const [[period]] = await c.query("SELECT id FROM ledger_periods WHERE tenantId = ? AND period = '2026-10'", [tenantA]) as any;
        n = await count("ledger_period_events");
        await expect(c.query("INSERT INTO ledger_period_events (tenantId, periodId, action, actorType, actorEmployeeId, reason) VALUES (?, ?, 'lock', 'employee', ?, 'x')", [tenantA, period.id, empB])).rejects.toThrow(/foreign key/i);
        expect(await count("ledger_period_events")).toBe(n);
        // (5) الحساب والنشاط والموظف داخل Tenant A → يمر
        await c.query("INSERT INTO ledger_account_businesses (tenantId, accountId, businessId, actorType, actorEmployeeId) VALUES (?, ?, ?, 'employee', ?)", [tenantA, accA, bizA, empA]);
        await c.query("INSERT INTO ledger_entries (tenantId, transactionId, accountId, businessId, side, amount, balanceAfter) VALUES (?, ?, ?, ?, 'debit', 100, 100)", [tenantA, txA, accA, bizA]);
        await c.query("INSERT INTO ledger_period_events (tenantId, periodId, action, actorType, actorEmployeeId, reason) VALUES (?, ?, 'lock', 'employee', ?, 'إقفال شهر')", [tenantA, period.id, empA]);
        // حركة على مستوى الشركة (sourceBusinessId NULL) مسموحة
        await c.query("INSERT INTO ledger_transactions (tenantId, sourceBusinessId, kind, idempotencyKey, payloadHash, effectiveDate, postingPeriod, description, actorType) VALUES (?, NULL, 'transfer', ?, ?, '2026-10-07', '2026-10', 'تحويل', 'system')", [tenantA, `k-${tag}-4`, "d".repeat(64)]);
        // الضمانات الأخرى تبقى: idempotency، CHECK، العكس مرة واحدة، عكس حركة tenant آخر
        await expect(c.query("INSERT INTO ledger_transactions (tenantId, sourceBusinessId, kind, idempotencyKey, payloadHash, effectiveDate, postingPeriod, description, actorType) VALUES (?, ?, 'revenue_cod', ?, ?, '2026-10-07', '2026-10', 'x', 'webhook')", [tenantA, bizA, `k-${tag}-1`, "z".repeat(64)])).rejects.toThrow(/Duplicate/);
        await expect(c.query("INSERT INTO ledger_entries (tenantId, transactionId, accountId, side, amount, balanceAfter) VALUES (?, ?, ?, 'credit', 0, 0)", [tenantA, txA, accA])).rejects.toThrow(/check constraint/i);
        const revSql = "INSERT INTO ledger_transactions (tenantId, sourceBusinessId, kind, idempotencyKey, payloadHash, effectiveDate, postingPeriod, reversalOfTransactionId, description, actorType) VALUES (?, ?, 'reversal', ?, ?, '2026-10-08', '2026-10', ?, 'عكس', 'system')";
        await c.query(revSql, [tenantA, bizA, `rev-${tag}-1`, "e".repeat(64), txA]);
        await expect(c.query(revSql, [tenantA, bizA, `rev-${tag}-2`, "f".repeat(64), txA])).rejects.toThrow(/Duplicate/);
        await c.query("INSERT INTO ledger_periods (tenantId, period) VALUES (?, '2026-10')", [tenantB]);
        const [t2] = await c.query("INSERT INTO ledger_transactions (tenantId, sourceBusinessId, kind, idempotencyKey, payloadHash, effectiveDate, postingPeriod, description, actorType) VALUES (?, ?, 'expense', ?, ?, '2026-10-07', '2026-10', 'y', 'system')", [tenantA, bizA, `k-${tag}-5`, "g".repeat(64)]);
        await expect(c.query(revSql, [tenantB, bizB, `rev-${tag}-3`, "h".repeat(64), (t2 as any).insertId])).rejects.toThrow(/foreign key/i);

        // ── Rollback كامل: الجداول السبعة ثم الفهرسان ──
        for (const stmt of ROLLBACK) await c.query(stmt);
        await reopen();
        const after = await verifyLedgerV3OnDatabase(ro);
        expect(after.present).toEqual([]);
        expect(after.state).toBe("not_applied");
        // المخطط القديم (كل الجداول، DDL بالحرف) وبيانات tenants/businesses/employees كما كانت بالضبط
        expect(await oldSchemaSnapshot(c)).toEqual(before);
        // وإعادة التطبيق بعد الـrollback ممكنة (ثم rollback مرة ثانية) — الدورة قابلة للتكرار
        for (const stmt of statements) await c.query(stmt);
        for (const stmt of ROLLBACK) await c.query(stmt);
        expect(await oldSchemaSnapshot(c)).toEqual(before);
      } finally {
        await ro.close(); await c.end();
      }
    }, 60_000);
  }
});
