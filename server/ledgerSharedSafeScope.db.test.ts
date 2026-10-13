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
 * خزنة مشتركة بين نشاطين (قاعدة حقيقية): اشتراك الخزنة لا يمنح المحاسب أرقام النشاط الآخر.
 *  • الرصيد الواحد للخزنة المشتركة (أو حساب عليه قيود الشركة كالقيد الافتتاحي) محجوب عن المحاسب — لا رصيد مخترع.
 *  • الحركات/التفاصيل/مراجعة الشهر: حركات كل قيودها داخل نطاقه فقط؛ الحركة المختلطة محجوبة كلها.
 *  • «الرصيد بعد الحركة» في نتيجة الترحيل محجوب عن النطاق المحدود.
 *  • المالك ومدير الحسابات يرون الشركة كلها. وشركة أخرى لا ترى شيئًا من الأولى.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
let seq = 0;
const op = () => `ss${Date.now().toString(36)}${++seq}xx`;
// مبالغ مميزة لا تتكرر صدفةً: أي ظهور لها في مخرجات المحاسب = تسريب
const A2_AMOUNT = "23.4500", MIXED_AMOUNT = "7.7700", OPENING = "1234.5600", OPENING_B = "4321.8700", B_AMOUNT = "61.1900";

describe.runIf(CAN)("🏦 خزنة مشتركة بين نشاطين — نطاق المحاسب", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  const acc: Record<string, number> = {}, accB: Record<string, number> = {};
  let A2 = 0, txA1 = 0, txA1Bank = 0, txA2 = 0, txMixed = 0, openingA = 0, txB = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_ss");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("ss-a"); B = await createCoreTestFixture("ss-b");
    A2 = insId(await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'النشاط الثاني', ?)", [A.tenantId, `ss2-${tmp.name}`.slice(0, 50)]));
    const mk = async (k: string, role: string, tenantId: number, businessId: number) => { e[k] = insId(await createEmployee({ name: `${k}-ss`, role, isActive: true, tenantId, businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A.tenantId, A.businessId); await mk("amA", "accounts_manager", A.tenantId, A.businessId);
    await mk("accA1", "accountant", A.tenantId, A.businessId); await mk("accA2", "accountant", A.tenantId, A2);
    await mk("ownerB", "super_admin", B.tenantId, B.businessId); await mk("accB", "accountant", B.tenantId, B.businessId);
    // المحاسب يملك الترحيل هنا لإثبات حجب «الرصيد بعد الحركة»
    for (const t of [A.tenantId, B.tenantId]) await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accountant', 'ledger.post', 1, ?)", [t, e.ownerA]);

    const activate = (f: CoreTestFixture, owner: number, businessIds: number[], grants: Record<string, number[]>, opening = OPENING) => activateLedgerV3({
      tenantId: f.tenantId, goLiveDate: "2026-09-01", currency: "EGP", actor: { type: "employee", employeeId: owner },
      reconciliation: { reportGeneratedAt: "2026-08-31T20:00:00Z", approvedByEmployeeId: owner, approvedAt: "2026-08-31T21:00:00Z" },
      openingBalances: { OFFICE_CASH: opening }, businessIds, safeGrants: grants,
    } as any);
    const ra = await activate(A, e.ownerA, [A.businessId, A2], { OFFICE_CASH: [A.businessId, A2], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId, A2] });
    Object.assign(acc, ra.accounts); openingA = ra.openingTransactionId!;
    Object.assign(accB, (await activate(B, e.ownerB, [B.businessId], { OFFICE_CASH: [B.businessId], BANK_MAIN: [B.businessId], COD_BOSTA: [B.businessId] }, OPENING_B)).accounts);

    const owner = await call(e.ownerA);
    // عهدة خاصة بالنشاط الأول فقط: رصيدها كله من قيوده → يظهر لمحاسبه
    acc.A1_PETTY = (await owner.account.create({ code: "A1_PETTY", name: "عهدة النشاط الأول", kind: "cash", normalSide: "debit", allowNegative: true })).id;
    await owner.account.grantBusiness({ accountId: acc.A1_PETTY, businessId: A.businessId });
    const expense = (biz: number, from: number, amount: string, date = "2026-09-10") => owner.post({ sourceBusinessId: biz, kind: "expense", idempotencyKey: op(), effectiveDate: date, description: `مصروف ${amount}`,
      entries: [{ accountId: acc.EXPENSE, side: "debit", amount, businessId: biz }, { accountId: from, side: "credit", amount, businessId: biz }] });
    txA1 = (await expense(A.businessId, acc.OFFICE_CASH, "10")).transactionId;
    txA1Bank = (await expense(A.businessId, acc.A1_PETTY, "3")).transactionId;
    txA2 = (await expense(A2, acc.OFFICE_CASH, A2_AMOUNT)).transactionId;
    // حركة مختلطة: مصروف للنشاط الأول مدفوع من الخزنة على حساب النشاط الثاني
    txMixed = (await owner.post({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: op(), effectiveDate: "2026-09-11", description: "مختلطة",
      entries: [{ accountId: acc.EXPENSE, side: "debit", amount: MIXED_AMOUNT, businessId: A.businessId }, { accountId: acc.OFFICE_CASH, side: "credit", amount: MIXED_AMOUNT, businessId: A2 }] })).transactionId;
    txB = (await (await call(e.ownerB)).post({ sourceBusinessId: B.businessId, kind: "expense", idempotencyKey: op(), effectiveDate: "2026-09-10", description: "مصروف B",
      entries: [{ accountId: accB.EXPENSE, side: "debit", amount: B_AMOUNT }, { accountId: accB.OFFICE_CASH, side: "credit", amount: B_AMOUNT }] })).transactionId;
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  // المبلغ بصيغتيه (4 خانات من القاعدة، وخانتان كما يُدخل) — بلا الصيغة المقصوصة التي تطابق معرّفات/تواريخ صدفةً
  // الطوابع الزمنية تُحذف قبل البحث: القاعدة تخزّن ثواني صحيحة فتظهر «…:10.000Z» وتطابق «10.00» صدفةً حين يُنشأ الحساب في
  // الثانية 10 — إنذار كاذب متقطع (≈1/60) لا تسريب. البحث عن المبالغ نفسه بنفس الصرامة.
  const leaks = (v: unknown, amounts: string[]) => {
    const s = JSON.stringify(v).replace(/"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z"/g, '"<ts>"');
    return amounts.filter(a => s.includes(a) || s.includes(a.slice(0, -2)));
  };
  it("أداة كشف التسريب: تلتقط المبلغ بصيغتيه وتتجاهل طابعًا زمنيًا في الثانية 10", () => {
    expect(leaks([{ amount: "10.0000" }], ["10.0000"])).toEqual(["10.0000"]);
    expect(leaks([{ amount: "10.00" }], ["10.0000"])).toEqual(["10.0000"]);
    expect(leaks([{ createdAt: "2026-10-13T13:45:10.000Z" }], ["10.0000"])).toEqual([]);
  });

  it("المحاسب (النشاط الأول): رصيد الخزنة المشتركة والإجماليات محجوبة؛ رصيد العهدة الخاصة ظاهر؛ لا أرقام النشاط الثاني", async () => {
    const l = await call(e.accA1);
    const accounts = await l.accounts.list();
    const cash = accounts.find((a: any) => a.code === "OFFICE_CASH");
    expect(cash).toMatchObject({ currentBalance: null, balanceHidden: true });
    expect(cash.businesses.map((b: any) => b.businessId)).toEqual([A.businessId]);
    expect(accounts.find((a: any) => a.code === "EXPENSE")).toMatchObject({ currentBalance: null, balanceHidden: true }); // عليه قيود النشاط الثاني
    expect(accounts.find((a: any) => a.code === "A1_PETTY")).toMatchObject({ currentBalance: "-3.0000", balanceHidden: false });
    expect(leaks(accounts, [A2_AMOUNT, MIXED_AMOUNT, OPENING])).toEqual([]);
  });

  it("المحاسب: سجل الحركات وتفاصيلها ومراجعة الشهر = حركات نشاطه فقط؛ المختلطة والافتتاحية ونشاط آخر محجوبة", async () => {
    const l = await call(e.accA1);
    const list = await l.transactions.list();
    expect(list.rows.map((r: any) => r.id).sort()).toEqual([txA1, txA1Bank].sort());
    expect(list.total).toBe(2);
    for (const id of [txA2, txMixed, openingA, txB]) expect(await code(() => l.transaction.get({ transactionId: id }))).toBe("NOT_FOUND");
    expect((await l.transaction.get({ transactionId: txA1 })).id).toBe(txA1);
    expect(await code(() => l.transactions.list({ businessId: A2 }))).toBe("FORBIDDEN");
    const review = await l.period.review({ period: "2026-09" });
    expect(review.transactionsCount).toBe(2);
    expect(review.accounts.find((a: any) => a.code === "OFFICE_CASH")).toMatchObject({ debit: "0.0000", credit: "10.0000" });
    expect(review.accounts.find((a: any) => a.code === "EXPENSE")).toMatchObject({ debit: "13.0000", credit: "0.0000" });
    expect(review.businesses.map((b: any) => b.businessId)).toEqual([A.businessId]);
    expect(leaks([list, review], [A2_AMOUNT, MIXED_AMOUNT, OPENING])).toEqual([]);
    // المحاسب الثاني: حركته فقط
    const l2 = await call(e.accA2);
    expect((await l2.transactions.list()).rows.map((r: any) => r.id)).toEqual([txA2]);
    expect(leaks([await l2.accounts.list(), await l2.period.review({ period: "2026-09" })], ["10.0000", MIXED_AMOUNT, OPENING])).toEqual([]);
  });

  it("الترحيل من المحاسب: «الرصيد بعد الحركة» محجوب؛ المالك يراه", async () => {
    const r = await (await call(e.accA1)).post({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: op(), effectiveDate: "2026-09-12", description: "مصروف المحاسب",
      entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "1" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1" }] });
    expect(r.entries.every((x: any) => x.balanceAfter === null)).toBe(true);
    const o = await (await call(e.ownerA)).post({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: op(), effectiveDate: "2026-09-12", description: "مصروف المالك",
      entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "1" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1" }] });
    expect(o.entries.every((x: any) => typeof x.balanceAfter === "string")).toBe(true);
  });

  it("المالك ومدير الحسابات: الشركة كلها — الأرصدة ظاهرة والحركات المختلطة والافتتاحية ضمن السجل والمراجعة", async () => {
    for (const id of [e.ownerA, e.amA]) {
      const l = await call(id);
      const accounts = await l.accounts.list();
      expect(accounts.every((a: any) => a.balanceHidden === false && typeof a.currentBalance === "string")).toBe(true);
      const ids = (await l.transactions.list({ limit: 100 })).rows.map((r: any) => r.id);
      expect(ids).toEqual(expect.arrayContaining([txA1, txA1Bank, txA2, txMixed, openingA]));
      expect(ids).not.toContain(txB);
      const review = await l.period.review({ period: "2026-09" });
      // الشركة كلها: الافتتاحي + 4 مصروفات + ترحيلا الاختبار السابق؛ المصروف = 10 + 3 + 23.45 + 7.77 + 1 + 1
      expect(review.transactionsCount).toBe(7);
      expect(review.accounts.find((a: any) => a.code === "EXPENSE")).toMatchObject({ debit: "46.2200" });
      expect(review.businesses.map((b: any) => b.businessId)).toEqual(expect.arrayContaining([A.businessId, A2]));
      expect(leaks(review, [B_AMOUNT, OPENING_B])).toEqual([]);
    }
  });

  it("عزل الشركتين: محاسب ومالك الشركة B لا يريان شيئًا من A (حسابات/حركات/تفاصيل/مراجعة/أنشطة)", async () => {
    for (const id of [e.accB, e.ownerB]) {
      const l = await call(id);
      const accIds = new Set((await l.accounts.list()).map((a: any) => a.id));
      for (const id2 of Object.values(acc)) expect(accIds.has(id2)).toBe(false);
      const ids = (await l.transactions.list({ limit: 100 })).rows.map((r: any) => r.id);
      for (const t of [txA1, txA1Bank, txA2, txMixed, openingA]) { expect(ids).not.toContain(t); expect(await code(() => l.transaction.get({ transactionId: t }))).toBe("NOT_FOUND"); }
      expect(await code(() => l.transactions.list({ businessId: A.businessId }))).toBe("FORBIDDEN");
      const review = await l.period.review({ period: "2026-09" });
      expect(leaks(review, ["10.0000", A2_AMOUNT, MIXED_AMOUNT, OPENING])).toEqual([]);
      expect((await l.businesses.list()).map((b: any) => b.id)).toEqual([B.businessId]);
    }
    // محاسب B يرى حركته (الخزنة غير مشتركة لكنها تحمل القيد الافتتاحي على مستوى الشركة → رصيدها محجوب)
    const lb = await call(e.accB);
    expect((await lb.transactions.list()).rows.map((r: any) => r.id)).toEqual([txB]);
    expect((await lb.accounts.list()).find((a: any) => a.code === "OFFICE_CASH")).toMatchObject({ currentBalance: null, balanceHidden: true });
  });
});
