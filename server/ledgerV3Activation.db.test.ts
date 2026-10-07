import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";
import { confirmationPhrase, parseOpeningFile, type OpeningFile } from "../shared/ledgerV3Activation";
import { openReadOnlyExecutor, type ReadOnlyExecutor } from "./balanceReconciliation.service";
import { applyLedgerV3Activation, planLedgerV3Activation, renderActivationPlan, type ActivationPlan } from "./ledgerV3Activation.service";
import { verifyLedgerV3Runtime } from "./ledgerV3Runtime.service";
import { LEDGER_BASE_ACCOUNTS, type LedgerDb } from "./ledgerV3.service";
import { __setDbForTests } from "./db";

/**
 * تفعيل Ledger V3 (الخطة/التطبيق) والـruntime verify على **قاعدتين كاملتين مؤقتتين** (نسخة المخطط الحقيقي):
 *   القاعدة 1 تبدأ **بلا 0040**: dry-run = not_applied وapply مرفوض → تطبيق جزئي = مرفوض → تطبيق كامل →
 *   تفعيل صفري بلا قيد افتتاحي، تفعيل بأرصدة = قيد واحد متوازن، retry بلا تكرار، رفض بلا كتابة (ملف غير
 *   متوازن/float/حساب مجهول/نشاط أجنبي/تأكيد خاطئ/فاعل غير مالك/فروق V2 غير معتمدة/تاريخ مختلف)، شركة
 *   أخرى لا تتأثر، verify ناجح ثم يكتشف العبث بالرصيد، وصفر كتابة في V2.
 *   القاعدة 2 (0040 مطبقة مسبقًا): التفعيل الصفري والبأرصدة والـretry والـverify.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const statements = splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"));
const MONEY = LEDGER_BASE_ACCOUNTS.filter(a => a.money).map(a => a.code);
const LEDGER_TABLES = ["ledger_accounts", "ledger_account_businesses", "ledger_periods", "ledger_period_events", "ledger_transactions", "ledger_entries", "ledger_tenant_flags"];
const V2_TABLES = ["treasury_transactions", "financial_transactions", "financial_transaction_entries", "financial_accounts", "business_events"];
const stripLedgerIndexes = (ddl: string) => ddl.split("\n").filter(l => !/`(businesses|employees)_tenant_id`/.test(l)).join("\n").replace(/,\n\)/, "\n)");

type Tenant = { tenantId: number; biz1: number; biz2: number; ownerId: number; adminId: number; accountantId: number };

describe.runIf(CAN)("🚀 Ledger V3 activation + runtime verify — قاعدتان كاملتان مؤقتتان", () => {
  const baseUrl = process.env.TEST_DATABASE_URL as string;
  const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const dbNames = [`ledgeract_a_${tag}`, `ledgeract_b_${tag}`];
  const urlFor = (db: string) => { const u = new URL(baseUrl); u.pathname = `/${db}`; return u.toString(); };
  let admin: mysql.Connection;
  const msg = async (fn: () => Promise<unknown>) => { try { await fn(); return "ok"; } catch (e) { return (e as Error).message; } };

  beforeAll(async () => {
    admin = await mysql.createConnection(baseUrl);
    const [tables] = await admin.query("SHOW TABLES") as any;
    const names: string[] = tables.map((r: any) => Object.values(r)[0] as string).filter((n: string) => !n.startsWith("ledger_") && !n.startsWith("_"));
    const ddl: string[] = [];
    for (const n of names) { try { const [r] = await admin.query(`SHOW CREATE TABLE \`${n}\``) as any; ddl.push(stripLedgerIndexes(r[0]["Create Table"])); } catch (e: any) { if (e?.code !== "ER_NO_SUCH_TABLE") throw e; } }
    for (const [i, name] of dbNames.entries()) {
      await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      const c = await mysql.createConnection(urlFor(name));
      await c.query("SET foreign_key_checks = 0");
      for (const stmt of ddl) await c.query(stmt);
      await c.query("SET foreign_key_checks = 1");
      if (i === 1) for (const stmt of statements) await c.query(stmt); // القاعدة 2 فقط تبدأ بـ0040 مطبقة
      await c.end();
    }
  }, 180_000);
  afterAll(async () => {
    __setDbForTests(null);
    for (const name of dbNames) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
  });

  function suite(i: number, name: string) {
    let db: LedgerDb; let raw: mysql.Connection; let exec: ReadOnlyExecutor;
    let A: Tenant, B: Tenant, C: Tenant, D: Tenant;
    const ins = async (sql: string, p: unknown[]) => Number(((await raw.query(sql, p)) as any)[0].insertId);
    const n = async (sql: string, p: unknown[] = []) => { try { return Number(((await raw.query(sql, p)) as any)[0][0].n); } catch (e: any) { if (e?.code === "ER_NO_SUCH_TABLE") return -1; throw e; } };
    const seedTenant = async (label: string): Promise<Tenant> => {
      const tenantId = await ins("INSERT INTO tenants (name, slug, status) VALUES (?, ?, 'active')", [`T-${label} ${tag}`, `t${label.toLowerCase()}-${tag}`]);
      const biz1 = await ins("INSERT INTO businesses (tenantId, name, slug) VALUES (?, ?, ?)", [tenantId, `Brand ${label}1`, `${label.toLowerCase()}1-${tag}`]);
      const biz2 = await ins("INSERT INTO businesses (tenantId, name, slug) VALUES (?, ?, ?)", [tenantId, `Brand ${label}2`, `${label.toLowerCase()}2-${tag}`]);
      const emp = (nm: string, role: string) => ins("INSERT INTO employees (name, role, isActive, tenantId, businessId, username) VALUES (?, ?, 1, ?, ?, ?)", [nm, role, tenantId, biz1, `${nm}-${label}-${tag}`.slice(0, 50)]);
      const ownerId = await emp("owner", "super_admin"), adminId = await emp("admin", "admin"), accountantId = await emp("acc", "accountant");
      for (const permission of ["ledger.view", "ledger.post"]) await raw.query("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accountant', ?, 1, ?)", [tenantId, permission, ownerId]);
      return { tenantId, biz1, biz2, ownerId, adminId, accountantId };
    };
    const snapshot = async () => {
      const out: Record<string, number> = {};
      for (const t of [...LEDGER_TABLES, ...V2_TABLES]) out[t] = await n(`SELECT COUNT(*) n FROM \`${t}\``);
      return out;
    };
    const plan = (t: Tenant, o: { opening?: OpeningFile | null; goLiveDate?: string | null; actorEmployeeId?: number | null } = {}) =>
      planLedgerV3Activation({ tenantId: t.tenantId, db, exec, opening: o.opening ?? null, goLiveDate: o.goLiveDate ?? null, actorEmployeeId: o.actorEmployeeId === undefined ? t.ownerId : o.actorEmployeeId });
    const apply = (t: Tenant, p: ActivationPlan, confirm = p.confirmation ?? "", actor = t.ownerId) => applyLedgerV3Activation({ tenantId: t.tenantId, plan: p, db, exec, actorEmployeeId: actor, confirm });
    const file = (raw: unknown): OpeningFile => { const r = parseOpeningFile(raw, MONEY); if (!r.ok) throw new Error(r.errors.join(" | ")); return r.file; };
    const tenantCounts = async (t: Tenant) => ({
      accounts: await n("SELECT COUNT(*) n FROM ledger_accounts WHERE tenantId = ?", [t.tenantId]),
      grants: await n("SELECT COUNT(*) n FROM ledger_account_businesses WHERE tenantId = ?", [t.tenantId]),
      txs: await n("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ?", [t.tenantId]),
      entries: await n("SELECT COUNT(*) n FROM ledger_entries WHERE tenantId = ?", [t.tenantId]),
      flags: await n("SELECT COUNT(*) n FROM ledger_tenant_flags WHERE tenantId = ? AND ledgerV3Enabled = 1", [t.tenantId]),
    });
    const balance = async (t: Tenant, code: string) => ((await raw.query("SELECT currentBalance b FROM ledger_accounts WHERE tenantId = ? AND code = ?", [t.tenantId, code])) as any)[0][0]?.b;
    let v2Baseline: Record<string, number> = {};

    describe(`قاعدة ${i + 1} (${i === 0 ? "تبدأ بلا 0040" : "0040 مطبقة مسبقًا"})`, () => {
      beforeAll(async () => {
        db = drizzle(urlFor(name)) as unknown as LedgerDb;
        raw = await mysql.createConnection(urlFor(name));
        exec = await openReadOnlyExecutor(urlFor(name));
        __setDbForTests(db as any); // routers/createContext/hasTenantPermission داخل verify تقرأ هذه القاعدة
        A = await seedTenant("A"); B = await seedTenant("B"); C = await seedTenant("C"); D = await seedTenant("D");
        // فرق V2 حقيقي عند الشركة C: حساب برصيد مخزّن 100 بلا أي قيد (createdAt قديم حتى لا يقع في نافذة التفعيل)
        await raw.query("INSERT INTO financial_accounts (businessId, code, name, accountType, currencyCode, openingBalance, currentBalance, createdAt) VALUES (?, 'CASH', 'خزنة قديمة', 'cash', 'EGP', '0', '100', '2026-01-01 00:00:00')", [C.biz1]);
        v2Baseline = Object.fromEntries(await Promise.all(V2_TABLES.map(async t => [t, await n(`SELECT COUNT(*) n FROM \`${t}\``)])));
      }, 60_000);
      afterAll(async () => { await exec.close(); await raw.end(); await (db as any).$client?.end?.(); });

      if (i === 0) {
        it("🚫 بلا 0040: dry-run يوضح not_applied بمانع صريح، وapply يرفض بلا أي كتابة؛ verify يفشل بوضوح", async () => {
          const p = await plan(A, { goLiveDate: "2026-11-01" });
          expect(p.migration.state).toBe("not_applied");
          expect(p.flag).toBeNull();
          expect(p.accounts.every(a => !a.exists)).toBe(true);
          expect(p.blockers.join(" ")).toContain("غير مطبَّقة");
          expect(renderActivationPlan(p)).toContain("موانع التفعيل");
          const before = await snapshot();
          expect(await msg(() => apply(A, p))).toMatch(/موانع التفعيل/);
          expect(await snapshot()).toEqual(before);
          expect(before.ledger_accounts).toBe(-1);
          const v = await verifyLedgerV3Runtime({ tenantId: A.tenantId, db, exec });
          expect(v.ok).toBe(false);
          expect(v.checks[0]).toMatchObject({ label: "جداول 0040 موجودة", ok: false });
        });
        it("🚫 تطبيق جزئي (الفهرسان + جدول واحد): partial → مانع، وapply يرفض بلا كتابة", async () => {
          for (const stmt of statements.slice(0, 3)) await raw.query(stmt);
          const p = await plan(A, { goLiveDate: "2026-11-01" });
          expect(p.migration.state).toBe("partial");
          expect(p.blockers.join(" ")).toContain("جزئيًا");
          const before = await snapshot();
          expect(await msg(() => apply(A, p))).toMatch(/موانع التفعيل/);
          expect(await snapshot()).toEqual(before);
          for (const stmt of statements.slice(3)) await raw.query(stmt); // إكمال 0040 للخطوات التالية
          expect((await plan(A, { goLiveDate: "2026-11-01" })).migration).toMatchObject({ state: "applied", issues: 0 });
        });
      }

      it("0️⃣ شركة صفرية (بلا ملف): تتفعّل بلا قيد افتتاحي؛ 9 حسابات وربط كامل؛ retry = replay بلا تكرار", async () => {
        const p = await plan(A, { goLiveDate: "2026-11-01" });
        expect(p.blockers).toEqual([]);
        expect(p.openingEntry).toBeNull();
        expect(p.openingBalances.every(o => o.amount === "0.0000" && o.source === "zero")).toBe(true);
        expect(p.warnings.join(" ")).toContain("لا ملف أرصدة");
        expect(p.confirmation).toBe(confirmationPhrase(A.tenantId, "2026-11-01"));
        expect(renderActivationPlan(p)).toContain("لا موانع");
        const r = await apply(A, p);
        expect(r).toMatchObject({ replay: false, openingTransactionId: null, v2Changed: [] });
        expect(Object.keys(r.accounts).sort()).toEqual([...LEDGER_BASE_ACCOUNTS.map(a => a.code)].sort());
        const c1 = await tenantCounts(A);
        expect(c1).toEqual({ accounts: 9, grants: 9 * 2, txs: 0, entries: 0, flags: 1 });
        const p2 = await plan(A, { goLiveDate: "2026-11-01" });
        expect(p2.warnings.join(" ")).toContain("مفعّلة مسبقًا بنفس تاريخ");
        expect(p2.accounts.every(a => a.exists)).toBe(true);
        const r2 = await apply(A, p2);
        expect(r2.replay).toBe(true);
        expect(await tenantCounts(A)).toEqual(c1);
      });

      it("💰 شركة بأرصدة (ملف): قيد افتتاحي واحد متوازن، الأرصدة كما في الملف، ربط الخزن حسب safeGrants؛ retry بلا تكرار", async () => {
        const opening = file({ goLiveDate: "2026-11-01", openingBalances: { OFFICE_CASH: "1000.00", BANK_MAIN: "2500.5", COD_BOSTA: "0" }, openingEquity: "3500.5", businessIds: [D.biz1], safeGrants: { OFFICE_CASH: [D.biz1], BANK_MAIN: [D.biz1], VF_CASH: [], INSTAPAY: [] } });
        const p = await plan(D, { opening });
        expect(p.blockers).toEqual([]);
        expect(p.openingEntry).toEqual({ debits: [{ code: "OFFICE_CASH", amount: "1000.0000" }, { code: "BANK_MAIN", amount: "2500.5000" }], credit: { code: "OPENING_EQUITY", amount: "3500.5000" } });
        expect(p.accounts.find(a => a.code === "VF_CASH")!.businesses).toEqual([]);
        expect(p.accounts.find(a => a.code === "REVENUE")!.businesses).toEqual([D.biz1]);
        const r = await apply(D, p);
        expect(r.replay).toBe(false); expect(r.openingTransactionId).not.toBeNull(); expect(r.v2Changed).toEqual([]);
        const c1 = await tenantCounts(D);
        expect(c1).toEqual({ accounts: 9, grants: 3 + 4, txs: 1, entries: 3, flags: 1 }); // خزن 3 (OFFICE/BANK/COD) + غير نقدية 4 × نشاط واحد
        expect(await balance(D, "OFFICE_CASH")).toBe("1000.0000");
        expect(await balance(D, "BANK_MAIN")).toBe("2500.5000");
        expect(await balance(D, "OPENING_EQUITY")).toBe("3500.5000");
        expect(await n("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ? AND kind = 'opening_balance' AND id = ?", [D.tenantId, r.openingTransactionId])).toBe(1);
        const r2 = await apply(D, await plan(D, { opening }));
        expect(r2).toMatchObject({ replay: true, openingTransactionId: r.openingTransactionId });
        expect(await tenantCounts(D)).toEqual(c1);
      });

      if (i === 0) {
        it("🚫 رفض بلا كتابة: ملف غير متوازن/float/حساب مجهول، نشاط أجنبي، تأكيد خاطئ، فاعل/معتمِد غير مالك، فروق V2 غير معتمدة، تاريخ مختلف لشركة مفعّلة", async () => {
          const before = await snapshot();
          // الملف نفسه يُرفض قبل أي قاعدة
          expect(parseOpeningFile({ goLiveDate: "2026-11-01", openingBalances: { OFFICE_CASH: "10" }, openingEquity: "1" }, MONEY)).toMatchObject({ ok: false });
          expect(parseOpeningFile({ goLiveDate: "2026-11-01", openingBalances: { OFFICE_CASH: 10 } }, MONEY)).toMatchObject({ ok: false });
          expect(parseOpeningFile({ goLiveDate: "2026-11-01", openingBalances: { PETTY: "10" } }, MONEY)).toMatchObject({ ok: false });
          // نشاط من شركة أخرى
          const foreign = await plan(C, { opening: file({ goLiveDate: "2026-11-01", openingBalances: {}, businessIds: [D.biz1], reconciliation: { reportGeneratedAt: "r", approvedByEmployeeId: C.ownerId, approvedAt: "a", acknowledgedDifferences: true } }) });
          expect(foreign.blockers.join(" ")).toContain("ليس تابعًا لهذه الشركة");
          expect(await msg(() => apply(C, foreign))).toMatch(/موانع/);
          // فروق V2 غير معتمدة (الشركة C لديها حساب قديم برصيد 100 بلا قيود)
          const unack = await plan(C, { goLiveDate: "2026-11-01" });
          expect(unack.v2Reconciliation?.ok).toBe(false);
          expect(unack.blockers.join(" ")).toContain("فرق غير معتمد");
          // مع الإقرار + اعتماد المالك: لا مانع — لكن التأكيد الخاطئ/الفاعل غير المالك يُرفضان قبل أي كتابة
          const ackFile = file({ goLiveDate: "2026-11-01", openingBalances: { OFFICE_CASH: "50" }, reconciliation: { reportGeneratedAt: "2026-10-31T20:00:00Z", approvedByEmployeeId: C.ownerId, approvedAt: "2026-10-31T21:00:00Z", acknowledgedDifferences: true } });
          const ok = await plan(C, { opening: ackFile });
          expect(ok.blockers).toEqual([]);
          expect(await msg(() => apply(C, ok, "ACTIVATE LEDGER V3 TENANT 0 GO-LIVE 2026-11-01"))).toMatch(/عبارة التأكيد غير مطابقة/);
          expect(await msg(() => apply(C, ok, ok.confirmation!, C.accountantId))).toMatch(/الفاعل يختلف عن الخطة/);
          expect((await plan(C, { opening: ackFile, actorEmployeeId: C.accountantId })).blockers.join(" ")).toContain("ليس مالكًا");
          expect((await plan(C, { opening: ackFile, actorEmployeeId: C.adminId })).blockers.join(" ")).toContain("ليس مالكًا");
          const badApprover = file({ ...ackFile, reconciliation: { ...ackFile.reconciliation!, approvedByEmployeeId: C.accountantId } } as any);
          expect((await plan(C, { opening: badApprover })).blockers.join(" ")).toContain("المعتمِد");
          // شركة مفعّلة بتاريخ مختلف
          expect((await plan(A, { goLiveDate: "2026-12-01" })).blockers.join(" ")).toMatch(/مفعّلة مسبقًا بتاريخ/);
          expect(await snapshot()).toEqual(before);
          // ثم التفعيل الصحيح للشركة C بالإقرار يمر
          const r = await apply(C, ok);
          expect(r.replay).toBe(false); expect(r.openingTransactionId).not.toBeNull();
        });
      }

      it("🏢 شركة أخرى (B) لا تتأثر: لا علم ولا حسابات ولا ربط", async () => {
        expect(await tenantCounts(B)).toEqual({ accounts: 0, grants: 0, txs: 0, entries: 0, flags: 1 - 1 });
        expect(await n("SELECT COUNT(*) n FROM ledger_tenant_flags WHERE tenantId = ?", [B.tenantId])).toBe(0);
      });

      it("🔍 runtime verify ناجح للشركتين (المالك والمحاسب عبر routers حقيقية)، ويكتشف العبث بالرصيد، ثم يعود سليمًا", async () => {
        for (const t of [A, D]) {
          const v = await verifyLedgerV3Runtime({ tenantId: t.tenantId, db, exec });
          expect(v.checks.filter(c => !c.ok)).toEqual([]);
          expect(v.ok).toBe(true);
        }
        const vA = await verifyLedgerV3Runtime({ tenantId: A.tenantId, db, exec });
        expect(vA.checks.find(c => c.label.startsWith("المحاسب"))?.detail).toContain("ممنوحة");
        expect(vA.checks.find(c => c.label.startsWith("openingTransactionId = NULL"))?.ok).toBe(true);
        expect((await verifyLedgerV3Runtime({ tenantId: D.tenantId, db, exec })).checks.find(c => c.label.startsWith("openingTransactionId يشير"))?.ok).toBe(true);
        await raw.query("UPDATE ledger_accounts SET currentBalance = currentBalance + 1 WHERE tenantId = ? AND code = 'OFFICE_CASH'", [D.tenantId]);
        const tampered = await verifyLedgerV3Runtime({ tenantId: D.tenantId, db, exec });
        expect(tampered.ok).toBe(false);
        expect(tampered.checks.find(c => c.label.startsWith("مطابقة V3"))).toMatchObject({ ok: false });
        await raw.query("UPDATE ledger_accounts SET currentBalance = currentBalance - 1 WHERE tenantId = ? AND code = 'OFFICE_CASH'", [D.tenantId]);
        expect((await verifyLedgerV3Runtime({ tenantId: D.tenantId, db, exec })).ok).toBe(true);
      });

      it("🔒 صفر كتابة في جداول V2 خلال كل السيناريوهات", async () => {
        for (const t of V2_TABLES) expect(await n(`SELECT COUNT(*) n FROM \`${t}\``)).toBe(v2Baseline[t]);
      });
    });
  }

  for (const [i, name] of dbNames.entries()) suite(i, name);
});
