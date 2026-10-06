import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import mysql from "mysql2/promise";
import { LEDGER_V3_DROP_ORDER, LEDGER_V3_TABLES, splitMigrationStatements } from "../shared/ledgerV3Spec";
import { openReadOnlyExecutor, type ReadOnlyExecutor } from "./balanceReconciliation.service";
import { ledgerV3Preflight, verifyLedgerV3OnDatabase } from "./ledgerV3Verify.service";

/**
 * تطبيق `0040_ledger_v3.sql` على **قاعدتين فارغتين منفصلتين** (تحملان فقط الجداول المرجعية
 * tenants/businesses/employees بتعريفها الحقيقي من قاعدة الاختبار)، ثم تحقق المطابقة، ثم إثبات
 * القيود على مستوى DB (idempotency، عكس مرة واحدة، FK مركّب بين tenant، CHECK)، ثم rollback كامل.
 * القاعدتان تُحذفان في النهاية. لا يُلمس أي جدول قديم.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL);
const sqlText = fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8");
const statements = splitMigrationStatements(sqlText);

describe.runIf(CAN)("🏗️ Migration 0040 — قاعدتان فارغتان منفصلتان: تطبيق → تحقق → قيود → rollback", () => {
  const baseUrl = process.env.TEST_DATABASE_URL as string;
  const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const dbNames = [`ledgerv3_a_${tag}`, `ledgerv3_b_${tag}`];
  let admin: mysql.Connection;
  const urlFor = (db: string) => { const u = new URL(baseUrl); u.pathname = `/${db}`; return u.toString(); };

  beforeAll(async () => {
    admin = await mysql.createConnection(baseUrl);
    // الجداول المرجعية بتعريفها الحقيقي (SHOW CREATE TABLE من قاعدة الاختبار المبنية من schema.ts)
    const ddl: string[] = [];
    for (const t of ["tenants", "businesses", "employees"]) {
      const [rows] = await admin.query(`SHOW CREATE TABLE \`${t}\``);
      ddl.push((rows as any)[0]["Create Table"]);
    }
    for (const name of dbNames) {
      await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      const c = await mysql.createConnection(urlFor(name));
      for (const stmt of ddl) await c.query(stmt);
      await c.end();
    }
  });
  afterAll(async () => {
    for (const name of dbNames) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  });

  for (const [i, name] of dbNames.entries()) {
    it(`قاعدة ${i + 1}: preflight → تطبيق 7 عبارات → تحقق مطابق → قيود DB → rollback كامل → الجداول القديمة سليمة`, async () => {
      const url = urlFor(name);
      const c = await mysql.createConnection(url);
      let ro: ReadOnlyExecutor = await openReadOnlyExecutor(url);
      try {
        // Preflight على قاعدة تحمل الجداول المرجعية فقط
        const pre = await ledgerV3Preflight(ro);
        expect(pre.find(r => r.label.startsWith("جداول ledger_*"))!.actual).toBe("0");
        expect(pre.find(r => r.label.startsWith("الجداول المرجعية"))!.actual).toBe("3");
        expect(pre.every(r => r.ok)).toBe(true);
        // قبل التطبيق: التحقق يبلّغ عن 7 جداول ناقصة
        expect((await verifyLedgerV3OnDatabase(ro)).issues.filter(x => x.kind === "table")).toHaveLength(7);

        // التطبيق — كل عبارة على حدة كما سيُنفَّذ يدويًا
        for (const stmt of statements) await c.query(stmt);
        await ro.close(); ro = await openReadOnlyExecutor(url);
        const verified = await verifyLedgerV3OnDatabase(ro);
        expect(verified.issues).toEqual([]);
        expect(verified.present).toEqual([...LEDGER_V3_TABLES].sort());
        // تطبيق ثانٍ بالخطأ → يفشل على أول عبارة (الجدول موجود) ولا يغيّر شيئًا
        await expect(c.query(statements[0])).rejects.toThrow(/already exists/i);

        // ── قيود على مستوى DB ──
        const [ta] = await c.query("INSERT INTO tenants (name, slug, status) VALUES (?, ?, 'active')", [`T-A ${tag}`, `ta-${tag}`]);
        const [tb] = await c.query("INSERT INTO tenants (name, slug, status) VALUES (?, ?, 'active')", [`T-B ${tag}`, `tb-${tag}`]);
        const tenantA = (ta as any).insertId, tenantB = (tb as any).insertId;
        const [ba] = await c.query("INSERT INTO businesses (tenantId, name, slug) VALUES (?, ?, ?)", [tenantA, "Brand A", `brand-a-${tag}`]);
        const [bb] = await c.query("INSERT INTO businesses (tenantId, name, slug) VALUES (?, ?, ?)", [tenantB, "Brand B", `brand-b-${tag}`]);
        const bizA = (ba as any).insertId, bizB = (bb as any).insertId;
        const [acA] = await c.query("INSERT INTO ledger_accounts (tenantId, code, name, kind, normalSide, actorType) VALUES (?, 'OFFICE_CASH', 'خزنة المكتب', 'cash', 'debit', 'system')", [tenantA]);
        const [acB] = await c.query("INSERT INTO ledger_accounts (tenantId, code, name, kind, normalSide, actorType) VALUES (?, 'OFFICE_CASH', 'خزنة المكتب', 'cash', 'debit', 'system')", [tenantB]);
        const accA = (acA as any).insertId, accB = (acB as any).insertId;
        // نفس الكود لتينانت واحد → مرفوض؛ لتينانتين → مسموح (حدث أعلاه)
        await expect(c.query("INSERT INTO ledger_accounts (tenantId, code, name, kind, normalSide, actorType) VALUES (?, 'OFFICE_CASH', 'x', 'cash', 'debit', 'system')", [tenantA])).rejects.toThrow(/Duplicate/);
        // ربط حساب Tenant A بنشاط Tenant B بصف يدّعي tenantId=B → FK المركّب يرفض (الحساب ليس لـB)
        await expect(c.query("INSERT INTO ledger_account_businesses (tenantId, accountId, businessId, actorType) VALUES (?, ?, ?, 'system')", [tenantB, accA, bizB])).rejects.toThrow(/foreign key/i);
        // الربط الصحيح يمر
        await c.query("INSERT INTO ledger_account_businesses (tenantId, accountId, businessId, actorType) VALUES (?, ?, ?, 'system')", [tenantA, accA, bizA]);
        // حركة بلا فترة مفتوحة → FK الفترة يرفض؛ ثم إنشاء الفترة فتمر
        const txSql = "INSERT INTO ledger_transactions (tenantId, sourceBusinessId, kind, idempotencyKey, payloadHash, effectiveDate, postingPeriod, description, actorType) VALUES (?, ?, 'revenue_cod', ?, ?, '2026-10-07', '2026-10', 'اختبار', 'webhook')";
        await expect(c.query(txSql, [tenantA, bizA, `k-${tag}-1`, "a".repeat(64)])).rejects.toThrow(/foreign key/i);
        await c.query("INSERT INTO ledger_periods (tenantId, period) VALUES (?, '2026-10')", [tenantA]);
        const [t1] = await c.query(txSql, [tenantA, bizA, `k-${tag}-1`, "a".repeat(64)]);
        const tx1 = (t1 as any).insertId;
        // idempotency ذرّية: نفس tenant + نفس المفتاح → Duplicate مهما اختلف الهاش
        await expect(c.query(txSql, [tenantA, bizA, `k-${tag}-1`, "b".repeat(64)])).rejects.toThrow(/Duplicate/);
        // قيد بحساب Tenant B داخل حركة Tenant A → FK المركّب يرفض
        await expect(c.query("INSERT INTO ledger_entries (tenantId, transactionId, accountId, side, amount, balanceAfter) VALUES (?, ?, ?, 'debit', 100, 100)", [tenantA, tx1, accB])).rejects.toThrow(/foreign key/i);
        // مبلغ صفر/سالب → CHECK يرفض
        await expect(c.query("INSERT INTO ledger_entries (tenantId, transactionId, accountId, side, amount, balanceAfter) VALUES (?, ?, ?, 'debit', 0, 0)", [tenantA, tx1, accA])).rejects.toThrow(/check constraint/i);
        await expect(c.query("INSERT INTO ledger_entries (tenantId, transactionId, accountId, side, amount, balanceAfter) VALUES (?, ?, ?, 'credit', -5, 0)", [tenantA, tx1, accA])).rejects.toThrow(/check constraint/i);
        await c.query("INSERT INTO ledger_entries (tenantId, transactionId, accountId, side, amount, balanceAfter) VALUES (?, ?, ?, 'debit', 100, 100)", [tenantA, tx1, accA]);
        // العكس مرة واحدة فقط: حركتان تعكسان نفس الأصل → الثانية Duplicate
        const revSql = "INSERT INTO ledger_transactions (tenantId, sourceBusinessId, kind, idempotencyKey, payloadHash, effectiveDate, postingPeriod, reversalOfTransactionId, description, actorType) VALUES (?, ?, 'reversal', ?, ?, '2026-10-08', '2026-10', ?, 'عكس', 'employee')";
        await c.query(revSql, [tenantA, bizA, `rev-${tag}-1`, "c".repeat(64), tx1]);
        await expect(c.query(revSql, [tenantA, bizA, `rev-${tag}-2`, "d".repeat(64), tx1])).rejects.toThrow(/Duplicate/);
        // عكس حركة من tenant آخر (حركة A لم تُعكس بعد) → FK المركّب (tenantId, reversalOfTransactionId) يرفض
        const [t2] = await c.query(txSql, [tenantA, bizA, `k-${tag}-2`, "f".repeat(64)]);
        const tx2 = (t2 as any).insertId;
        await c.query("INSERT INTO ledger_periods (tenantId, period) VALUES (?, '2026-10')", [tenantB]);
        await expect(c.query(revSql, [tenantB, bizB, `rev-${tag}-3`, "e".repeat(64), tx2])).rejects.toThrow(/foreign key/i);
        // ونفس العكس من tenant A نفسه يمر — فالرفض أعلاه كان بسبب التينانت لا بسبب شيء آخر
        await c.query(revSql, [tenantA, bizA, `rev-${tag}-4`, "g".repeat(64), tx2]);
        // الحركة الأصلية بلا status: الكشف عن كونها معكوسة = وجود حركة reversal تشير إليها
        const [reversed] = await c.query("SELECT COUNT(*) n FROM ledger_transactions WHERE reversalOfTransactionId = ?", [tx1]);
        expect(Number((reversed as any)[0].n)).toBe(1);
        // فتح/قفل الفترة: السجل يتطلب سببًا وفاعلًا
        const [[period]] = await c.query("SELECT id FROM ledger_periods WHERE tenantId = ? AND period = '2026-10'", [tenantA]) as any;
        await expect(c.query("INSERT INTO ledger_period_events (tenantId, periodId, action, actorType) VALUES (?, ?, 'lock', 'employee')", [tenantA, period.id])).rejects.toThrow();
        await c.query("INSERT INTO ledger_period_events (tenantId, periodId, action, actorType, reason) VALUES (?, ?, 'lock', 'employee', 'إقفال شهر')", [tenantA, period.id]);

        // ── Rollback كامل بالترتيب العكسي ──
        for (const t of LEDGER_V3_DROP_ORDER) await c.query(`DROP TABLE \`${t}\``);
        await ro.close(); ro = await openReadOnlyExecutor(url);
        const after = await verifyLedgerV3OnDatabase(ro);
        expect(after.present).toEqual([]);
        expect(after.issues.filter(x => x.kind === "table")).toHaveLength(7);
        // الجداول القديمة سليمة ببياناتها
        const [[counts]] = await c.query("SELECT (SELECT COUNT(*) FROM tenants) t, (SELECT COUNT(*) FROM businesses) b") as any;
        expect(Number(counts.t)).toBe(2); expect(Number(counts.b)).toBe(2);
      } finally {
        await ro.close(); await c.end();
      }
    });
  }
});
