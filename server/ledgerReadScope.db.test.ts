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

/**
 * حراسة قراءة دفتر V3 على السيرفر: المحاسب (قراءة افتراضية) يرى حسابات وحركات **نشاطه فقط** — بلا فلتر، وبفلتر،
 * وبالمعرّف؛ والمطابقة على مستوى الشركة له مرفوضة. مدير الحسابات والمالك يرون الشركة كلها. شركة أخرى لا ترى شيئًا.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
let seq = 0;
const op = () => `rs${Date.now().toString(36)}${++seq}xx`;

describe.runIf(CAN)("🔎 حراسة قراءة دفتر V3", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  const acc: Record<string, number> = {};
  let A2 = 0, tx1 = 0, tx2 = 0, a2Only = 0, opening = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_rs");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("rs-a"); B = await createCoreTestFixture("rs-b");
    A2 = insId(await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'النشاط الثاني', ?)", [A.tenantId, `rs2-${tmp.name}`.slice(0, 50)]));
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-rs`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("accountantA", "accountant", A); await mk("amA", "accounts_manager", A); await mk("ownerB", "super_admin", B);
    const r = await activateLedgerV3({
      tenantId: A.tenantId, goLiveDate: "2026-10-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "1000" }, businessIds: [A.businessId, A2],
      safeGrants: { OFFICE_CASH: [A.businessId, A2], BANK_MAIN: [A.businessId, A2], COD_BOSTA: [A.businessId, A2] },
    } as any);
    Object.assign(acc, r.accounts); opening = r.openingTransactionId!;
    const owner = await call(e.ownerA);
    a2Only = (await owner.account.create({ code: "A2_PETTY", name: "عهدة النشاط الثاني", kind: "cash", normalSide: "debit" })).id;
    await owner.account.grantBusiness({ accountId: a2Only, businessId: A2 });
    const post = (biz: number, amount: string) => owner.post({ sourceBusinessId: biz, kind: "expense", idempotencyKey: op(), effectiveDate: "2026-10-05", description: `مصروف ${biz}`,
      entries: [{ accountId: acc.EXPENSE, side: "debit", amount, businessId: biz }, { accountId: acc.OFFICE_CASH, side: "credit", amount, businessId: biz }] });
    tx1 = (await post(A.businessId, "10")).transactionId;
    tx2 = (await post(A2, "20")).transactionId;
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("المحاسب يقرأ افتراضيًا داخل نشاطه فقط: حسابات بأنشطته، حركات نشاطه (بلا فلتر أيضًا)، ولا ترحيل افتراضي", async () => {
    const accnt = await call(e.accountantA);
    expect((await accnt.status()).enabled).toBe(true);
    const accounts = await accnt.accounts.list();
    expect(accounts.some((a: any) => a.id === a2Only)).toBe(false);
    expect(accounts.find((a: any) => a.id === acc.OFFICE_CASH)?.businesses.map((b: any) => b.businessId)).toEqual([A.businessId]);
    const ids = (await accnt.transactions.list()).rows.map((x: any) => x.id);
    expect(ids).toContain(tx1);
    expect(ids).not.toContain(tx2);
    expect(ids).not.toContain(opening); // قيد افتتاحي على مستوى الشركة — خارج نطاق نشاط واحد
    expect(await code(() => accnt.transactions.list({ businessId: A2 }))).toBe("FORBIDDEN");
    expect(await code(() => accnt.transaction.get({ transactionId: tx2 }))).toBe("NOT_FOUND");
    expect(await code(() => accnt.transaction.get({ transactionId: opening }))).toBe("NOT_FOUND");
    expect((await accnt.transaction.get({ transactionId: tx1 })).id).toBe(tx1);
    expect(await code(() => accnt.reconciliation())).toBe("FORBIDDEN");
    expect(await code(() => accnt.post({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: op(), effectiveDate: "2026-10-05", description: "x",
      entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "1" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1" }] }))).toBe("FORBIDDEN");
  });

  it("مدير الحسابات والمالك: الشركة كلها (كل الحسابات والحركات والمطابقة)", async () => {
    for (const id of [e.amA, e.ownerA]) {
      const l = await call(id);
      const ids = (await l.transactions.list()).rows.map((x: any) => x.id);
      expect(ids).toEqual(expect.arrayContaining([tx1, tx2, opening]));
      expect((await l.accounts.list()).some((a: any) => a.id === a2Only)).toBe(true);
      expect((await l.transaction.get({ transactionId: tx2 })).id).toBe(tx2);
      expect(await code(() => l.reconciliation())).toBe("ok");
    }
  });

  it("شركة أخرى: لا حركة ولا حساب من A", async () => {
    const b = await call(e.ownerB);
    expect(await code(() => b.transaction.get({ transactionId: tx1 }))).toBe("NOT_FOUND");
    expect(await code(() => b.transactions.list({ businessId: A.businessId }))).toBe("FORBIDDEN");
  });

  it("محاسب بلا نشاط: صفر حسابات وحركات (fail-closed)", async () => {
    const lonely = insId(await createEmployee({ name: "محاسب بلا نشاط", role: "accountant", isActive: true, tenantId: A.tenantId, businessId: null, username: `lonely_${tmp.name}`.slice(0, 50) } as any));
    const l = await call(lonely);
    expect(await l.accounts.list()).toEqual([]);
    expect((await l.transactions.list()).rows).toEqual([]);
  });
});
