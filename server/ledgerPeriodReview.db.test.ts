import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { confirmPhrase } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { activateLedgerV3, lockLedgerPeriod } from "./ledgerV3.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * مراجعة الشهر وإقفاله: الإقفال يتطلب ملاحظة مراجعة إلزامية تُسجَّل مع الفاعل؛ المراجعة قراءة فقط داخل نطاق القراءة —
 * حركة كل حساب ونشاط بمبالغ عشرية من القاعدة، العكوس، وسجل الإقفال/الفتح بالأسماء؛ بلا علامة «معتمدة/لم تُراجع».
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
let seq = 0;
const op = () => `pr${Date.now().toString(36)}${++seq}xx`;

describe.runIf(CAN)("🗓️ مراجعة الشهر وإقفاله", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  const acc: Record<string, number> = {};
  let A2 = 0, txA2 = 0, revId = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_pr");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("pr-a"); B = await createCoreTestFixture("pr-b");
    A2 = insId(await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'فرحات', ?)", [A.tenantId, `pr2-${tmp.name}`.slice(0, 50)]));
    const mk = async (k: string, role: string, f: CoreTestFixture, name = `${k}-pr`) => { e[k] = insId(await createEmployee({ name, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A, "المالكة سارة"); await mk("amA", "accounts_manager", A, "مدير الحسابات كريم"); await mk("accountantA", "accountant", A); await mk("ownerB", "super_admin", B);
    const r = await activateLedgerV3({
      tenantId: A.tenantId, goLiveDate: "2026-09-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-08-31T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-08-31T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "5000" }, businessIds: [A.businessId, A2],
      safeGrants: { OFFICE_CASH: [A.businessId, A2], BANK_MAIN: [A.businessId, A2], COD_BOSTA: [A.businessId, A2] },
    } as any);
    Object.assign(acc, r.accounts);
    const owner = await call(e.ownerA);
    const post = (biz: number, amount: string, date: string) => owner.post({ sourceBusinessId: biz, kind: "expense", idempotencyKey: op(), effectiveDate: date, description: `مصروف ${biz} ${amount}`,
      entries: [{ accountId: acc.EXPENSE, side: "debit", amount, businessId: biz }, { accountId: acc.OFFICE_CASH, side: "credit", amount, businessId: biz }] });
    await post(A.businessId, "100.2500", "2026-09-10");
    await post(A.businessId, "0.7500", "2026-09-11");
    txA2 = (await post(A2, "40", "2026-09-12")).transactionId;
    await post(A.businessId, "999", "2026-10-02"); // شهر آخر — خارج مراجعة سبتمبر
    revId = (await (await call(e.amA)).reverse({ transactionId: txA2, idempotencyKey: op(), effectiveDate: "2026-09-15", reason: "مصروف مكرر" })).transactionId;
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("الإقفال يتطلب ملاحظة مراجعة إلزامية (الراوتر والخدمة)، وتُسجَّل مع الفاعل؛ إعادة الإقفال replay بلا ملاحظة", async () => {
    const am = await call(e.amA);
    expect(await code(() => am.period.lock({ period: "2026-09" } as any))).toBe("BAD_REQUEST");
    expect(await code(() => am.period.lock({ period: "2026-09", reason: "  " }))).toBe("BAD_REQUEST");
    expect(await code(() => am.period.lock({ period: "2026-09", reason: "ok" }))).toBe("BAD_REQUEST");
    await expect(lockLedgerPeriod({ tenantId: A.tenantId, period: "2026-09", actor: { type: "employee", employeeId: e.amA } })).rejects.toThrow();
    expect((await q("SELECT COUNT(*) n FROM ledger_period_events WHERE tenantId = ?", [A.tenantId]))[0].n).toBe(0);
    expect((await am.period.lock({ period: "2026-09", reason: "راجعت حركة سبتمبر وطابقت الخزنة" })).status).toBe("locked");
    expect((await lockLedgerPeriod({ tenantId: A.tenantId, period: "2026-09", actor: { type: "employee", employeeId: e.amA } })).replay).toBe(true);
    const [ev] = await q("SELECT action, actorEmployeeId, reason FROM ledger_period_events WHERE tenantId = ?", [A.tenantId]);
    expect(ev).toMatchObject({ action: "lock", actorEmployeeId: e.amA, reason: "راجعت حركة سبتمبر وطابقت الخزنة" });
  });

  it("المراجعة (نطاق الشركة): حركة كل حساب ونشاط بمبالغ عشرية دقيقة، العكس، والسجل بالأسماء — بلا علامة «معتمدة»", async () => {
    await (await call(e.ownerA)).period.reopen({ period: "2026-09", reason: "تصحيح بعد المراجعة" });
    const r = await (await call(e.amA)).period.review({ period: "2026-09" });
    expect(r.period).toBe("2026-09"); expect(r.status).toBe("open");
    expect(r.events.map((x: any) => [x.action, x.actorName, x.reason])).toEqual([["lock", "مدير الحسابات كريم", "راجعت حركة سبتمبر وطابقت الخزنة"], ["reopen", "المالكة سارة", "تصحيح بعد المراجعة"]]);
    const exp = r.accounts.find((a: any) => a.code === "EXPENSE");
    // 100.25 + 0.75 + 40 (مدين) ؛ والعكس دائن 40 — بلا أي حركة أكتوبر
    expect(exp).toMatchObject({ debit: "141.0000", credit: "40.0000" });
    // الخزنة: الرصيد الافتتاحي 5000 (قيد Go-live داخل سبتمبر) + عكس 40 مدين؛ 141 دائن
    expect(r.accounts.find((a: any) => a.code === "OFFICE_CASH")).toMatchObject({ debit: "5040.0000", credit: "141.0000" });
    expect(r.transactionsCount).toBe(5); // الافتتاحي + 3 مصروفات + العكس (أكتوبر خارجها)
    expect(r.reversals).toEqual([expect.objectContaining({ transactionId: revId, reversalOfTransactionId: txA2, actorName: "مدير الحسابات كريم", effectiveDate: "2026-09-15" })]);
    const biz = new Map(r.businesses.map((b: any) => [b.businessId, b]));
    expect(biz.get(A.businessId)).toMatchObject({ debit: "101.0000", credit: "101.0000" });
    expect(biz.get(A2)).toMatchObject({ name: "فرحات", debit: "80.0000", credit: "80.0000" });
    expect(Object.keys(r).sort()).toEqual(["accounts", "businesses", "events", "period", "reversals", "status", "transactionsCount"]);
    expect(JSON.stringify(r)).not.toMatch(/approved|unreviewed|معتمد/);
  });

  it("نطاق القراءة: المحاسب يرى مراجعة نشاطه فقط؛ شركة أخرى لا ترى شيئًا", async () => {
    const r = await (await call(e.accountantA)).period.review({ period: "2026-09" });
    expect(r.businesses.map((b: any) => b.businessId)).toEqual([A.businessId]);
    expect(r.accounts.find((a: any) => a.code === "EXPENSE")).toMatchObject({ debit: "101.0000", credit: "0.0000" });
    expect(r.reversals).toEqual([]);
    expect(r.transactionsCount).toBe(2);
    const b = await (await call(e.ownerB)).period.review({ period: "2026-09" });
    expect(b.accounts).toEqual([]); expect(b.businesses).toEqual([]); expect(b.events).toEqual([]);
    expect(await code(async () => (await call(e.amA)).period.review({ period: "2026-13" }))).toBe("BAD_REQUEST");
  });
});
