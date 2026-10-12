import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { confirmPhrase } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { activateLedgerV3, createLedgerAccount } from "./ledgerV3.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";
import { LEDGER_DAILY_ACCOUNTS } from "../shared/ledgerDailyAccounts";

/**
 * المرحلة 2 — الاستخدام اليومي على قاعدة حقيقية:
 *  تجهيز الحسابات القياسية (idempotent/متزامن/تعارض لا يُلمس/صلاحية)، الشراء أصل لا مصروف (فحص بنية على السيرفر)،
 *  التقرير اليومي (التصنيفات، صافي العكس، المشتريات، النقدية حتى نهاية اليوم، الربح لمن يملك reports.view_profit فقط)،
 *  نطاق المحاسب (حجب المشترك والمختلط)، عزل الشركات، الشركة للقراءة فقط، الشهر المقفول، وما قبل Go-live.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
let seq = 0;
const op = () => `dl${Date.now().toString(36)}${++seq}xx`;
const DAY = "2026-10-05";

describe.runIf(CAN)("📒 المرحلة 2 — الاستخدام اليومي والمصروفات", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  const acc: Record<string, number> = {};
  let A2 = 0, adsTx = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_dl");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("dl-a"); B = await createCoreTestFixture("dl-b");
    A2 = insId(await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'براند الهدايا', ?)", [A.tenantId, `dl2-${tmp.name}`.slice(0, 50)]));
    const mk = async (k: string, role: string, f: CoreTestFixture, businessId = f.businessId) => { e[k] = insId(await createEmployee({ name: `${k}-dl`, role, isActive: true, tenantId: f.tenantId, businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("amA", "accounts_manager", A); await mk("accA", "accountant", A); await mk("ownerB", "super_admin", B); await mk("accB", "accountant", B);
    // المحاسب يرحّل هنا (منح صريح) لاختبار نطاقه
    for (const t of [A.tenantId, B.tenantId]) await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accountant', 'ledger.post', 1, ?)", [t, e.ownerA]);
    const activate = (f: CoreTestFixture, owner: number, bizIds: number[], opening: string) => activateLedgerV3({
      tenantId: f.tenantId, goLiveDate: "2026-10-01", currency: "EGP", actor: { type: "employee", employeeId: owner },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: owner, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: opening }, businessIds: bizIds, safeGrants: { OFFICE_CASH: bizIds, BANK_MAIN: bizIds, COD_BOSTA: bizIds },
    } as any);
    Object.assign(acc, (await activate(A, e.ownerA, [A.businessId, A2], "1000")).accounts);
    await activate(B, e.ownerB, [B.businessId], "7777");
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("تجهيز الحسابات القياسية: المالك فقط بصلاحية الإدارة، idempotent ومتزامن بلا تكرار، والتعارض لا يُلمس", async () => {
    expect(await code(async () => (await call(e.accA)).setup.ensureDailyAccounts())).toBe("FORBIDDEN");
    // حساب موجود بنفس الكود ونوع مختلف = تعارض يُترك كما هو
    await createLedgerAccount({ tenantId: A.tenantId, code: "EXP_RENT", name: "إيجار (إيراد خطأ)", kind: "revenue", normalSide: "credit", actor: { type: "employee", employeeId: e.ownerA } });
    const owner = await call(e.ownerA);
    expect((await owner.setup.dailyAccountsStatus()).missing.length).toBe(LEDGER_DAILY_ACCOUNTS.length - 1);
    const runs = await Promise.all([owner.setup.ensureDailyAccounts(), owner.setup.ensureDailyAccounts(), owner.setup.ensureDailyAccounts()]);
    expect(runs.every(r => r.conflicts.includes("EXP_RENT"))).toBe(true);
    expect(runs.flatMap(r => r.created).sort()).toEqual(LEDGER_DAILY_ACCOUNTS.map(a => a.code).filter(c => c !== "EXP_RENT").sort()); // كل حساب أُنشئ مرة واحدة فقط
    // عدد حسابات EXP_ من تعريف الحسابات القياسية نفسه (لا رقم ثابت يتقادم حين يُضاف تصنيف)
    expect((await q("SELECT COUNT(*) n FROM ledger_accounts WHERE tenantId = ? AND code LIKE 'EXP\\_%'", [A.tenantId]))[0].n).toBe(LEDGER_DAILY_ACCOUNTS.filter(a => a.code.startsWith("EXP_")).length);
    expect((await q("SELECT kind FROM ledger_accounts WHERE tenantId = ? AND code = 'EXP_RENT'", [A.tenantId]))[0].kind).toBe("revenue"); // لم يُعدَّل
    const again = await owner.setup.ensureDailyAccounts();
    expect(again.created).toEqual([]);
    expect(again.status.missing).toEqual([]);
    // الحسابات مربوطة بكل أنشطة الشركة (ترحيل مسموح)
    const accounts = await owner.accounts.list();
    for (const c of ["EXP_ADS", "INV_GOODS", "COGS"]) expect(accounts.find((a: any) => a.code === c)?.businesses.map((b: any) => b.businessId).sort()).toEqual([A.businessId, A2].sort());
    for (const a of accounts) acc[a.code] = a.id;
    // شركة أخرى لا ترى حسابات A
    expect((await (await call(e.ownerB)).setup.dailyAccountsStatus()).present).toEqual([]);
  });

  it("الشراء أصل مخزون لا مصروف — يُفرض على السيرفر؛ والضغط المزدوج بنفس المفتاح = حركة واحدة", async () => {
    const owner = await call(e.ownerA);
    const base = { sourceBusinessId: A.businessId, effectiveDate: DAY, currency: "EGP" };
    const key = op();
    const buy = () => owner.post({ ...base, kind: "inventory_purchase", idempotencyKey: key, description: "شراء أساور خام",
      entries: [{ accountId: acc.INV_GOODS, side: "debit", amount: "300" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "300" }] });
    const [p1, p2] = await Promise.all([buy(), buy()]);
    expect(p1.transactionId).toBe(p2.transactionId);
    expect([p1.replay, p2.replay].sort()).toEqual([false, true]);
    // مصروف على حساب مخزون، وشراء على حساب مصروف، وشراء دائن من إيراد = رفض بلا أي كتابة
    const before = (await q("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ?", [A.tenantId]))[0].n;
    expect(await code(() => owner.post({ ...base, kind: "expense", idempotencyKey: op(), description: "x", entries: [{ accountId: acc.INV_GOODS, side: "debit", amount: "5" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "5" }] }))).toBe("BAD_REQUEST");
    expect(await code(() => owner.post({ ...base, kind: "inventory_purchase", idempotencyKey: op(), description: "x", entries: [{ accountId: acc.EXP_ADS, side: "debit", amount: "5" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "5" }] }))).toBe("BAD_REQUEST");
    expect(await code(() => owner.post({ ...base, kind: "inventory_purchase", idempotencyKey: op(), description: "x", entries: [{ accountId: acc.INV_RAW, side: "debit", amount: "5" }, { accountId: acc.REVENUE, side: "credit", amount: "5" }] }))).toBe("BAD_REQUEST");
    expect((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ?", [A.tenantId]))[0].n).toBe(before);
  });

  it("التقرير اليومي (المالك): تصنيفات المصروف، إلغاء بقيد عكسي يصافي التصنيف، المشتريات منفصلة، النقدية حتى نهاية اليوم، والربح", async () => {
    const owner = await call(e.ownerA);
    const post = (kind: string, biz: number | null, debit: number, credit: number, amount: string, description: string) => owner.post({ sourceBusinessId: biz, kind, idempotencyKey: op(), effectiveDate: DAY, currency: "EGP", description,
      entries: [{ accountId: debit, side: "debit", amount }, { accountId: credit, side: "credit", amount }] });
    await post("revenue_prepaid", A.businessId, acc.OFFICE_CASH, acc.REVENUE, "500", "بيع نقدي");
    await post("expense", A.businessId, acc.EXP_OFFICE, acc.OFFICE_CASH, "100", "مستلزمات مكتب");
    adsTx = (await post("expense", A2, acc.EXP_ADS, acc.OFFICE_CASH, "40", "إعلان ممول")).transactionId;
    await post("transfer", null, acc.BANK_MAIN, acc.OFFICE_CASH, "50", "إيداع بنكي");
    // الإلغاء بقيد عكسي مع السبب والفاعل — بلا حذف؛ المحاسب لا يعكس (قرار المرحلة 1)
    expect(await code(async () => (await call(e.accA)).reverse({ transactionId: adsTx, idempotencyKey: op(), effectiveDate: DAY, reason: "إعلان مكرر" }))).toBe("FORBIDDEN");
    const rev = await (await call(e.amA)).reverse({ transactionId: adsTx, idempotencyKey: op(), effectiveDate: DAY, reason: "إعلان مكرر" });
    expect((await q("SELECT reversalOfTransactionId, actorEmployeeId, description FROM ledger_transactions WHERE id = ?", [rev.transactionId]))[0]).toMatchObject({ reversalOfTransactionId: adsTx, actorEmployeeId: e.amA });
    expect((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE id = ?", [adsTx]))[0].n).toBe(1); // الأصل باقٍ

    const r = await owner.reports.daily({ date: DAY });
    expect(r.revenue).toBe("500.0000");
    expect(r.expenses).toEqual({ total: "100.0000", byCategory: [expect.objectContaining({ code: "EXP_OFFICE", amount: "100.0000" })] }); // الإعلان صُفّي بالعكس
    expect(r.purchases).toBe("300.0000"); // الشراء ليس ضمن المصروفات
    expect(r.transfers).toBe("50.0000");
    // 1000 افتتاحي − 300 شراء + 500 إيراد − 100 − 40 + 40 (العكس)؛ التحويل داخلي بين الخزن
    expect(r.availableCash).toBe("1100.0000");
    expect(r.balances.find((b: any) => b.code === "BANK_MAIN")?.balance).toBe("50.0000");
    expect(r.profitHidden).toBe(false);
    expect(r.profit).toBe("400.0000"); // 500 − 100 − 0 (لا تكلفة مبيعات بعد)
    expect(r.beforeGoLive).toBe(false);
    expect(r.countsByKind).toEqual(expect.arrayContaining([{ kind: "reversal", count: 1 }, { kind: "inventory_purchase", count: 1 }]));
    // فلتر النشاط
    const a2 = await owner.reports.daily({ date: DAY, businessId: A2 });
    expect(a2.revenue).toBe("0.0000"); expect(a2.expenses.total).toBe("0.0000");
    expect(a2.transactions.rows.map((x: any) => x.id).sort()).toEqual([adsTx, rev.transactionId].sort());
    // يوم سابق: النقدية حتى نهايته = الافتتاحي فقط
    expect((await owner.reports.daily({ date: "2026-10-04" })).availableCash).toBe("1000.0000");
  });

  it("الربح لمن يملك reports.view_profit فقط: مدير الحسابات والمحاسب null افتراضيًا؛ بالمنح الصريح يظهر", async () => {
    for (const id of [e.amA, e.accA]) { const r = await (await call(id)).reports.daily({ date: DAY }); expect(r.profit).toBeNull(); expect(r.profitHidden).toBe(true); }
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accounts_manager', 'reports.view_profit', 1, ?)", [A.tenantId, e.ownerA]);
    try {
      const r = await (await call(e.amA)).reports.daily({ date: DAY });
      expect([r.profit, r.profitHidden]).toEqual(["400.0000", false]);
    } finally { await q("DELETE FROM tenant_role_permissions WHERE tenantId = ? AND role = 'accounts_manager'", [A.tenantId]); }
  });

  it("نطاق المحاسب: حركات نشاطه فقط؛ الخزنة المشتركة والنقدية المتاحة محجوبة (لا صفر ولا مجموع جزئي)؛ ونشاط آخر FORBIDDEN", async () => {
    const r = await (await call(e.accA)).reports.daily({ date: DAY });
    expect(r.revenue).toBe("500.0000");
    expect(r.expenses.byCategory.map((x: any) => x.code)).toEqual(["EXP_OFFICE"]);
    expect(r.transactions.rows.some((x: any) => x.id === adsTx)).toBe(false);
    expect(r.transfers).toBe("0.0000"); // التحويل على مستوى الشركة خارج نطاقه
    expect(r.availableCash).toBeNull();
    expect(r.balances.find((b: any) => b.code === "OFFICE_CASH")?.balance).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/"40\.0000"|"1100\.0000"|"1000\.0000"/);
    expect(await code(async () => (await call(e.accA)).reports.daily({ date: DAY, businessId: A2 }))).toBe("FORBIDDEN");
  });

  it("عزل الشركات: الشركة B لا ترى أي رقم من A؛ ومحاسب B لا يطلب نشاط A", async () => {
    const r = await (await call(e.ownerB)).reports.daily({ date: DAY });
    expect(r.revenue).toBe("0.0000"); expect(r.transactions.total).toBe(0);
    expect(r.availableCash).toBe("7777.0000");
    expect(JSON.stringify(r)).not.toMatch(/"500\.0000"|"1100\.0000"/);
    expect(await code(async () => (await call(e.accB)).reports.daily({ date: DAY, businessId: A.businessId }))).toBe("FORBIDDEN");
  });

  it("ما قبل Go-live: لا أرصدة ولا ربح (null) بدل صفر؛ والترحيل بتاريخ قبله مرفوض", async () => {
    const r = await (await call(e.ownerA)).reports.daily({ date: "2026-09-30" });
    expect([r.beforeGoLive, r.availableCash, r.profit]).toEqual([true, null, null]);
    expect(r.balances.every((b: any) => b.balance === null)).toBe(true);
    expect(await code(async () => (await call(e.ownerA)).post({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: op(), effectiveDate: "2026-09-30", currency: "EGP", description: "قبل البدء",
      entries: [{ accountId: acc.EXP_OFFICE, side: "debit", amount: "1" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1" }] }))).toBe("BAD_REQUEST");
  });

  it("الشهر المقفول: مصروف أو شراء بتاريخ داخله مرفوض بلا كتابة؛ وبعد إعادة الفتح بسبب يُقبل", async () => {
    const owner = await call(e.ownerA);
    await owner.period.lock({ period: "2026-10", reason: "اختبار إقفال الشهر" });
    const buy = () => owner.post({ sourceBusinessId: A.businessId, kind: "inventory_purchase", idempotencyKey: "locked-month-buy-1", effectiveDate: "2026-10-06", currency: "EGP", description: "شراء في شهر مقفول",
      entries: [{ accountId: acc.INV_RAW, side: "debit", amount: "9" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "9" }] });
    expect(await code(buy)).toBe("BAD_REQUEST");
    expect((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE idempotencyKey = 'locked-month-buy-1'"))[0].n).toBe(0);
    await owner.period.reopen({ period: "2026-10", reason: "تصحيح بعد الاختبار" });
    expect((await buy()).replay).toBe(false);
  });

  it("الشركة للقراءة فقط (إنفاذ الحالة): التقرير يعمل، والترحيل والتجهيز مرفوضان بلا كتابة", async () => {
    const saved = process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED;
    process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED = "true";
    await q("UPDATE tenants SET status = 'expired' WHERE id = ?", [A.tenantId]);
    try {
      const owner = await call(e.ownerA);
      expect(await code(() => owner.reports.daily({ date: DAY }))).toBe("ok");
      const before = (await q("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ?", [A.tenantId]))[0].n;
      expect(await code(() => owner.post({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: op(), effectiveDate: DAY, currency: "EGP", description: "x",
        entries: [{ accountId: acc.EXP_OFFICE, side: "debit", amount: "1" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1" }] }))).toBe("FORBIDDEN");
      expect(await code(() => owner.setup.ensureDailyAccounts())).toBe("FORBIDDEN");
      expect((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ?", [A.tenantId]))[0].n).toBe(before);
    } finally {
      await q("UPDATE tenants SET status = 'active' WHERE id = ?", [A.tenantId]);
      if (saved == null) delete process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED; else process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED = saved;
    }
  });

  it("سحب الصلاحية: المحاسب يفقد الترحيل فورًا عند سحب ledger.post", async () => {
    await q("UPDATE tenant_role_permissions SET isAllowed = 0 WHERE tenantId = ? AND role = 'accountant' AND permission = 'ledger.post'", [A.tenantId]);
    expect(await code(async () => (await call(e.accA)).post({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: op(), effectiveDate: DAY, currency: "EGP", description: "بعد السحب",
      entries: [{ accountId: acc.EXP_OFFICE, side: "debit", amount: "1" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1" }] }))).toBe("FORBIDDEN");
    expect(await code(async () => (await call(e.accA)).reports.daily({ date: DAY }))).toBe("ok"); // القراءة باقية
  });
});
