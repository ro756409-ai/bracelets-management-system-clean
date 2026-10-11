import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";

import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { getDb, createEmployee, __setDbForTests } from "./db";
import { drizzle } from "drizzle-orm/mysql2";
import { tenantRolePermissions } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";
import { activateLedgerV3 } from "./ledgerV3.service";

/**
 * المرحلة 0 — إصلاحات الأمان العاجلة (بلا Schema/Migration)، على قاعدة مؤقتة كاملة + 0040:
 *  1) لا ترحيل/تحويل/عكس من خزنة خارج نطاق الجلسة — حتى بقيد businessId=null.
 *  2) لا قيد بتاريخ قبل goLiveDate.
 *  3) لا قفل لشهر مستقبلي (بتوقيت أنشطة الشركة، الوقت من قاعدة البيانات).
 *  4) لا ربح لمن لا يملك reports.view_profit (ملخص الخزنة + الإقفالات).
 *  5) المدير العام لا يرى ملخص/إعدادات المرتبات بلا صلاحية مالية صريحة.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const statements = splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"));
const stripLedgerIndexes = (ddl: string) => ddl.split("\n").filter(l => !/`(businesses|employees)_tenant_id`/.test(l)).join("\n").replace(/,\n\)/, "\n)");

describe.runIf(CAN)("🛡️ المرحلة 0 — أمان الدفتر والربح والمرتبات", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  let A2 = 0;
  let raw: mysql.Connection; let admin: mysql.Connection; let tempDb: ReturnType<typeof drizzle> | null = null;
  const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const baseUrl = process.env.TEST_DATABASE_URL ?? "";
  const tempName = `acc0_${tag}`;
  const tempUrlOf = () => { const u = new URL(baseUrl); u.pathname = `/${tempName}`; return u.toString(); };
  let ownerA = 0, accountantA = 0, managerA = 0;
  let acc: Record<string, number> = {};
  let closingId = 0;

  const sessionCtx = async (employeeId: number) => createContext({
    req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId }, process.env.JWT_SECRET as string) } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as any);
  const api = async (employeeId: number) => appRouter.createCaller(await sessionCtx(employeeId)) as any;
  const code = async (fn: () => Promise<unknown>) => { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } };
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  let seq = 0;
  const key = (s: string) => `p0-${tag}-${s}-${++seq}`;
  const transfer = (from: number, to: number, amount = "1", effectiveDate = "2026-10-05") => ({
    kind: "transfer", idempotencyKey: key("tr"), effectiveDate, description: "تحويل اختبار", sourceBusinessId: null,
    entries: [{ accountId: to, side: "debit", amount, businessId: null }, { accountId: from, side: "credit", amount, businessId: null }],
  });

  beforeAll(async () => {
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
    A = await createCoreTestFixture("p0-a"); B = await createCoreTestFixture("p0-b");
    A2 = insId(await raw.query("INSERT INTO businesses (tenantId, name, slug) VALUES (?, ?, ?)", [A.tenantId, "نشاط ثانٍ", `p0-a2-${tag}`.slice(0, 50)]));
    const mk = async (name: string, role: string, fx: CoreTestFixture) => insId(await createEmployee({ name, role, isActive: true, tenantId: fx.tenantId, businessId: fx.businessId, username: `${name}-${tag}`.slice(0, 50) } as any));
    ownerA = await mk("p0-owner-a", "super_admin", A); accountantA = await mk("p0-acc-a", "accountant", A); managerA = await mk("p0-mgr-a", "manager", A);
    await mk("p0-owner-b", "super_admin", B);
    const d = (await getDb())!;
    for (const permission of ["ledger.view", "ledger.post", "ledger.reverse"]) await d.insert(tenantRolePermissions).values({ tenantId: A.tenantId, role: "accountant", permission, isAllowed: true, updatedBy: ownerA });
    const r = await activateLedgerV3({
      tenantId: A.tenantId, goLiveDate: "2026-10-01", currency: "EGP", actor: { type: "employee", employeeId: ownerA },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: ownerA, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "1000", BANK_MAIN: "5000", VF_CASH: "700" }, businessIds: [A.businessId, A2],
      // خزنة فودافون كاش ممنوحة للنشاط الثاني فقط — خارج نطاق محاسب النشاط الأول
      safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId], VF_CASH: [A2] },
    });
    acc = r.accounts;
    // إقفال V2 (قراءة فقط هنا) بإجماليات فيها ربح — لاختبار الحجب
    closingId = insId(await raw.query(
      "INSERT INTO accounting_closings (businessId, sequenceNumber, periodType, periodFrom, periodTo, currencyCode, status, totalsJson, createdBy, createdByName) VALUES (?, 1, 'monthly', '2026-09-01', '2026-09-30', 'EGP', 'draft', ?, ?, 'owner')",
      [A.businessId, JSON.stringify({ revenue: "1000.0000", grossProfit: "400.0000", netProfit: "250.0000", operatingExpense: "150.0000" }), ownerA]));
  }, 180_000);

  afterAll(async () => {
    __setDbForTests(null);
    await (tempDb as any)?.$client?.end?.();
    await raw?.end();
    await admin?.query(`DROP DATABASE IF EXISTS \`${tempName}\``);
    await admin?.end();
  }, 120_000);

  describe("1) نطاق الخزن", () => {
    it("محاسب النشاط الأول لا يحوّل من خزنة ممنوحة لنشاط آخر حتى مع businessId=null", async () => {
      const a = await api(accountantA);
      expect(await code(() => a.ledger.post(transfer(acc.VF_CASH, acc.OFFICE_CASH)))).toBe("FORBIDDEN");
      // ولا إليها
      expect(await code(() => a.ledger.post(transfer(acc.OFFICE_CASH, acc.VF_CASH)))).toBe("FORBIDDEN");
      // ولا بقيد يذكر النشاط الآخر صراحةً
      expect(await code(() => a.ledger.post({ ...transfer(acc.VF_CASH, acc.OFFICE_CASH), entries: [
        { accountId: acc.OFFICE_CASH, side: "debit", amount: "1", businessId: A.businessId }, { accountId: acc.VF_CASH, side: "credit", amount: "1", businessId: A2 },
      ] }))).toBe("FORBIDDEN");
      const [[vf]] = await raw.query("SELECT currentBalance FROM ledger_accounts WHERE id = ?", [acc.VF_CASH]) as any;
      expect(Number(vf.currentBalance)).toBe(700);
    });
    it("التحويل بين خزنتين داخل نطاقه يظل يعمل (businessId=null)، والمالك يحوّل من أي خزنة", async () => {
      const a = await api(accountantA);
      expect((await a.ledger.post(transfer(acc.OFFICE_CASH, acc.BANK_MAIN, "10"))).replay).toBe(false);
      expect((await (await api(ownerA)).ledger.post(transfer(acc.VF_CASH, acc.BANK_MAIN, "5"))).replay).toBe(false);
    });
    it("لا عكس لحركة خزنة خارج النطاق", async () => {
      const own = await (await api(ownerA)).ledger.post(transfer(acc.VF_CASH, acc.BANK_MAIN, "3"));
      expect(await code(async () => (await api(accountantA)).ledger.reverse({ transactionId: own.transactionId, idempotencyKey: key("rv"), effectiveDate: "2026-10-06", reason: "عكس خارج النطاق" }))).toBe("FORBIDDEN");
    });
  });

  describe("2) ما قبل Go-live", () => {
    it("قيد بتاريخ قبل goLiveDate مرفوض (حتى للمالك) ولا يُنشئ فترة", async () => {
      expect(await code(async () => (await api(ownerA)).ledger.post(transfer(acc.OFFICE_CASH, acc.BANK_MAIN, "1", "2026-09-15")))).toBe("BAD_REQUEST");
      const [[p]] = await raw.query("SELECT COUNT(*) n FROM ledger_periods WHERE tenantId = ? AND period = '2026-09'", [A.tenantId]) as any;
      expect(Number(p.n)).toBe(0);
    });
    it("عكس بتاريخ قبل goLiveDate مرفوض", async () => {
      const t = await (await api(ownerA)).ledger.post(transfer(acc.OFFICE_CASH, acc.BANK_MAIN, "2"));
      expect(await code(async () => (await api(ownerA)).ledger.reverse({ transactionId: t.transactionId, idempotencyKey: key("rv"), effectiveDate: "2026-09-20", reason: "قبل البداية" }))).toBe("BAD_REQUEST");
    });
  });

  describe("3) قفل شهر مستقبلي", () => {
    it("قفل شهر بعد الشهر الحالي مرفوض، والشهر الحالي/السابق مسموح", async () => {
      const o = await api(ownerA);
      expect(await code(() => o.ledger.period.lock({ period: "2099-01" }))).toBe("BAD_REQUEST");
      const [[f]] = await raw.query("SELECT COUNT(*) n FROM ledger_periods WHERE tenantId = ? AND period = '2099-01'", [A.tenantId]) as any;
      expect(Number(f.n)).toBe(0);
      expect((await o.ledger.period.lock({ period: "2026-10" })).status).toBe("locked");
    });
  });

  describe("4) الربح خلف reports.view_profit", () => {
    it("المحاسب (accounting.view بلا view_profit) لا يرى ربح الشهر في ملخص الخزنة؛ المالك يراه", async () => {
      const s = await (await api(accountantA)).accounting.treasurySummary({});
      expect(s.monthProfit).toBeNull();
      expect(s.profitHidden).toBe(true);
      const so = await (await api(ownerA)).accounting.treasurySummary({});
      expect(typeof so.monthProfit).toBe("number");
    });
    it("المحاسب (closing.view) لا يرى الربح في قائمة وتفاصيل الإقفال؛ باقي الأرقام تبقى؛ المالك يراه", async () => {
      const a = await api(accountantA);
      const list = await a.accountingV2.closingList({ businessId: A.businessId });
      const row = list.find((c: any) => c.id === closingId);
      expect(row).toBeTruthy();
      expect(JSON.stringify(row)).not.toMatch(/netProfit|grossProfit/);
      expect(JSON.parse(row.totalsJson).revenue).toBe("1000.0000");
      const detail = await a.accountingV2.closingDetail({ businessId: A.businessId, closingId });
      expect(JSON.stringify(detail)).not.toMatch(/netProfit|grossProfit|adjustedNetProfit/);
      const od = await (await api(ownerA)).accountingV2.closingDetail({ businessId: A.businessId, closingId });
      expect(JSON.stringify(od)).toMatch(/netProfit/);
    });
  });

  describe("5) المرتبات للمدير العام", () => {
    it("المدير لا يرى ملخص أو إعدادات المرتبات؛ المالك والمحاسب (payroll.view) يريانها", async () => {
      const m = await api(managerA);
      expect(await code(() => m.payroll.summary({}))).toBe("FORBIDDEN");
      expect(await code(() => m.payroll.settingsGet({ businessId: A.businessId }))).toBe("FORBIDDEN");
      expect(await code(async () => (await api(ownerA)).payroll.summary({}))).toBe("ok");
      expect(await code(async () => (await api(accountantA)).payroll.settingsGet({ businessId: A.businessId }))).toBe("ok");
    });
  });
});
