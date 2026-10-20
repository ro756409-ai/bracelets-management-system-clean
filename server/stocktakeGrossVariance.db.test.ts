import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { confirmPhrase, runHandMigration } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { LEDGER_CARRIER_MIGRATION } from "./ledgerPhaseMigrations";
import { activateLedgerV3, postLedgerTransaction } from "./ledgerV3.service";
import { ensureDailyAccounts } from "./ledgerDaily.service";
import { postInventoryOpeningFromStocktake, postStocktakeVariance } from "./ledgerInventory.service";
import { makeInventoryKey } from "./inventoryV2.service";
import { approveStocktake, createStocktake, getStocktake, submitStocktake, updateStocktakeLine } from "./stocktake.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * BUG-89A — فروق الجرد إجماليًا من حركات V2 الفعلية على قاعدة حقيقية مؤقتة: زيادة فقط (بلا رصيد سابق في «فروقات الجرد»)،
 * عجز فقط (بالمتوسط وقت الاعتماد لا بتكلفة اللقطة)، جرد مختلط، صفر فروق، منع التكرار (إعادة + تزامن)، قيد تاريخي صافٍ يبقى
 * كما هو، حساب الربح الناقص = مراجعة، الأرصدة = تغيّر قيمة V2، «إيرادات أخرى» في قائمة الدخل، عزل الشركات، والإقفال.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const caller = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const PERIOD = "2026-10";

describe.runIf(CAN)("📦 BUG-89A — فروق الجرد إجمالية من حركات V2", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  let P2 = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const lines = async (key: string) => (await q("SELECT a.code, e.side, e.amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.accountId JOIN ledger_transactions t ON t.id = e.transactionId WHERE t.idempotencyKey = ? ORDER BY a.code", [key])).map((r: any) => [r.code, r.side, r.amount]);
  const txCount = async (key: string) => Number((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE idempotencyKey = ?", [key]))[0].n);
  const balance = async (codeName: string, tenantId = A.tenantId) => String((await q("SELECT currentBalance b FROM ledger_accounts WHERE tenantId = ? AND code = ?", [tenantId, codeName]))[0]?.b ?? "none");
  const v2Value = async (st: number) => {
    const [h] = await q("SELECT businessEventId ev FROM stocktakes WHERE id = ?", [st]);
    const rows = await q("SELECT transactionType t, valueDelta v FROM inventory_transactions WHERE businessEventId = ? AND sourceType = 'stocktake_line'", [h.ev]);
    let gain = 0, loss = 0;
    for (const r of rows) { if (r.t === "stocktake_gain") gain += Number(r.v); else loss += -Number(r.v); }
    return { gain: gain.toFixed(4), loss: loss.toFixed(4), net: (gain - loss).toFixed(4) };
  };
  /** جرد حقيقي على V2: إنشاء (لقطة الأرصدة) ← عدّ ← إرسال ← اعتماد (يكتب حركة V2 لكل بند بفرق). */
  const realStocktake = async (biz: CoreTestFixture, counts: Record<number, number>, beforeApprove?: () => Promise<void>) => {
    const maker = { id: biz === A ? e.amA : e.ownerB, name: "عادّ" };
    const { stocktakeId } = await createStocktake({ businessId: biz.businessId, warehouseId: biz.warehouseId, actor: maker } as any);
    const snap = (await getStocktake({ businessId: biz.businessId, stocktakeId }))!;
    for (const [productId, counted] of Object.entries(counts)) {
      const line = snap.lines.find((l: any) => l.productId === Number(productId))!;
      await updateStocktakeLine({ businessId: biz.businessId, stocktakeId, lineId: line.id, countedQuantity: counted, actor: maker } as any);
    }
    await submitStocktake({ businessId: biz.businessId, stocktakeId });
    if (beforeApprove) await beforeApprove();
    await approveStocktake({ businessId: biz.businessId, stocktakeId, actor: { id: biz === A ? e.ownerA : e.ownerB, name: "مالك" }, allowSelfApproval: biz !== A }); // B: المالك عدّ واعتمد (مسموح للمالك)
    return stocktakeId;
  };
  const post = (st: number, biz = A) => postStocktakeVariance({ businessId: biz.businessId, stocktakeId: st, actor: { type: "employee", employeeId: biz === A ? e.ownerA : e.ownerB } });
  const seedBalance = (f: CoreTestFixture, productId: number, qty: number, cost: string) =>
    q("INSERT INTO inventory_balances (businessId, warehouseId, productId, inventoryKey, onHandQuantity, inventoryValue, movingAverageCost) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [f.businessId, f.warehouseId, productId, makeInventoryKey(productId), qty, (qty * Number(cost)).toFixed(4), cost]);

  beforeAll(async () => {
    tmp = await createTempSchema("st_gross");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    expect((await runHandMigration(LEDGER_CARRIER_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync("drizzle/0047_ledger_carrier.sql", "utf-8"), deployEnv: "test", confirm: confirmPhrase("0047", "apply", tmp.name) } as any)).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("sg-a"); B = await createCoreTestFixture("sg-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-sg`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("amA", "accounts_manager", A); await mk("ownerB", "super_admin", B);
    P2 = insId(await q("INSERT INTO products (businessId, name, sku, price) VALUES (?, 'سلسلة', ?, '100.00')", [A.businessId, `SG2-${tmp.name}`.slice(0, 50)]));
    await q("UPDATE businesses SET accountingGoLiveAt = ? WHERE id = ?", [new Date("2026-09-30T21:00:00Z"), A.businessId]);
    await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: "2026-10-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "1000" }, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId] } } as any);
    await ensureDailyAccounts({ tenantId: A.tenantId, businessIds: [A.businessId], actor: { type: "employee", employeeId: e.ownerA } });
    // V2: المنتج الأول 10 × 40، الثاني 5 × 20 (= 500)؛ وافتتاحي V3 موثّق بنفس القيمة من جرد يوم Go-live
    await seedBalance(A, A.productId, 10, "40.0000"); await seedBalance(A, P2, 5, "20.0000");
    const opening = insId(await q("INSERT INTO stocktakes (businessId, warehouseId, status, createdBy, createdByName, approvedAt) VALUES (?, ?, 'approved', ?, 'مالك', ?)", [A.businessId, A.warehouseId, e.ownerA, new Date("2026-10-01T09:00:00Z")]));
    await q("INSERT INTO stocktake_lines (stocktakeId, businessId, warehouseId, productId, inventoryKey, systemQuantity, countedQuantity, differenceQuantity, unitCostSnapshot, differenceValue) VALUES (?, ?, ?, ?, ?, 10, 10, 0, '40.0000', '0.0000'), (?, ?, ?, ?, ?, 5, 5, 0, '20.0000', '0.0000')",
      [opening, A.businessId, A.warehouseId, A.productId, `${makeInventoryKey(A.productId)}-o`, opening, A.businessId, A.warehouseId, P2, `${makeInventoryKey(P2)}-o`]);
    await postInventoryOpeningFromStocktake({ tenantId: A.tenantId, stocktakeId: opening, actor: { type: "employee", employeeId: e.ownerA } });
    await seedBalance(B, B.productId, 4, "30.0000");
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("حساب INV_GAIN جاهز كإيراد دائن نظامي؛ و«فروقات الجرد» بلا رصيد", async () => {
    expect((await q("SELECT kind, normalSide, allowNegative, isActive FROM ledger_accounts WHERE tenantId = ? AND code = 'INV_GAIN'", [A.tenantId]))[0]).toMatchObject({ kind: "revenue", normalSide: "credit", isActive: 1 });
    expect(await balance("INV_VARIANCE")).toBe("0.0000");
    expect(await balance("INV_GOODS")).toBe("500.0000");
  });

  it("زيادة فقط: ربح على INV_GAIN بلا رصيد سابق في «فروقات الجرد»، والقيمة = حركة V2", async () => {
    const st = await realStocktake(A, { [P2]: 7 }); // +2 × 20
    const r = await post(st);
    expect(r.status).toBe("posted");
    expect(await v2Value(st)).toEqual({ gain: "40.0000", loss: "0.0000", net: "40.0000" });
    expect(await lines(`stocktake:${st}:variance`)).toEqual([["INV_GAIN", "credit", "40.0000"], ["INV_GOODS", "debit", "40.0000"]]);
    expect(await balance("INV_VARIANCE")).toBe("0.0000");
  });

  it("عجز فقط: القيمة من V2 بالمتوسط وقت الاعتماد، لا من تكلفة لقطة الجرد", async () => {
    // المتوسط يتغيّر بعد اللقطة وقبل الاعتماد (40 → 50) — سطر الجرد يحمل 40، وحركة V2 الفعلية 50
    const st = await realStocktake(A, { [A.productId]: 9 }, async () => {
      await q("UPDATE inventory_balances SET inventoryValue = '500.0000', movingAverageCost = '50.0000' WHERE businessId = ? AND inventoryKey = ?", [A.businessId, makeInventoryKey(A.productId)]);
    });
    expect((await q("SELECT differenceValue d FROM stocktake_lines WHERE stocktakeId = ? AND differenceQuantity <> 0", [st]))[0].d).toBe("-40.0000");
    expect((await post(st)).status).toBe("posted");
    expect(await v2Value(st)).toEqual({ gain: "0.0000", loss: "50.0000", net: "-50.0000" });
    expect(await lines(`stocktake:${st}:variance`)).toEqual([["INV_GOODS", "credit", "50.0000"], ["INV_VARIANCE", "debit", "50.0000"]]);
  });

  it("جرد مختلط: العجز خسارة والزيادة ربح في قيد متوازن واحد، والمخزون بصافي حركة V2", async () => {
    const st = await realStocktake(A, { [A.productId]: 7, [P2]: 8 }); // −2 × 50 = 100، +1 × 20 = 20
    expect((await post(st)).status).toBe("posted");
    expect(await v2Value(st)).toEqual({ gain: "20.0000", loss: "100.0000", net: "-80.0000" });
    expect(await lines(`stocktake:${st}:variance`)).toEqual([["INV_GAIN", "credit", "20.0000"], ["INV_GOODS", "credit", "80.0000"], ["INV_VARIANCE", "debit", "100.0000"]]);
    expect(await txCount(`stocktake:${st}:variance`)).toBe(1);
  });

  it("صفر فروق: لا قيد", async () => {
    const st = await realStocktake(A, {});
    expect((await post(st)).status).toBe("skipped");
    expect(await txCount(`stocktake:${st}:variance`)).toBe(0);
  });

  it("منع التكرار: إعادة الترحيل replay بنفس القيد، وترحيلان متزامنان = قيد واحد", async () => {
    const st = await realStocktake(A, { [P2]: 9 }); // +1 × 20
    const [a, b] = await Promise.all([post(st), post(st)]);
    expect([a.status, b.status].sort()).toEqual(["posted", "replay"]);
    expect((a as any).transactionId).toBe((b as any).transactionId);
    const again = await post(st);
    expect([again.status, (again as any).transactionId]).toEqual(["replay", (a as any).transactionId]);
    expect(await txCount(`stocktake:${st}:variance`)).toBe(1);
  });

  it("لا أثر رجعي: قيد تاريخي صافٍ بنفس المفتاح يبقى كما هو بلا إعادة حساب ولا قيد ثانٍ", async () => {
    const st = await realStocktake(A, { [A.productId]: 6, [P2]: 10 }); // −1 × 50، +1 × 20
    const ids = Object.fromEntries((await q("SELECT code, id FROM ledger_accounts WHERE tenantId = ? AND code IN ('INV_VARIANCE','INV_GOODS')", [A.tenantId])).map((r: any) => [r.code, r.id]));
    // الصيغة القديمة (صافي 30 على «فروقات الجرد») مسجّلة قبل التحديث
    const old = await postLedgerTransaction({ tenantId: A.tenantId, sourceBusinessId: A.businessId, kind: "adjustment", idempotencyKey: `stocktake:${st}:variance`, effectiveDate: "2026-10-15", currency: "EGP",
      actor: { type: "employee", employeeId: e.ownerA }, description: "قيد تاريخي صافٍ", sourceType: "stocktake", sourceReference: String(st),
      entries: [{ accountId: ids.INV_VARIANCE, side: "debit", amount: "30.0000", businessId: A.businessId }, { accountId: ids.INV_GOODS, side: "credit", amount: "30.0000", businessId: A.businessId }] } as any);
    const r = await post(st);
    expect([r.status, (r as any).transactionId]).toEqual(["replay", old.transactionId]);
    expect(await lines(`stocktake:${st}:variance`)).toEqual([["INV_GOODS", "credit", "30.0000"], ["INV_VARIANCE", "debit", "30.0000"]]);
    expect(await txCount(`stocktake:${st}:variance`)).toBe(1);
  });

  it("حساب الربح موقوف: الاعتماد ينجح والقيد مراجعة بسبب واضح، وقائمة الإقفال تكشفه وترفض الإقفال", async () => {
    await new Promise(r => setTimeout(r, 1100)); // حارس الحركة أثناء العدّ يعدّ حركة نفس الثانية حركة (تصميم مقصود)
    await q("UPDATE ledger_accounts SET isActive = 0 WHERE tenantId = ? AND code = 'INV_GAIN'", [A.tenantId]);
    try {
    const maker = { id: e.amA, name: "عادّ" };
    const { stocktakeId: st } = await createStocktake({ businessId: A.businessId, warehouseId: A.warehouseId, actor: maker } as any);
    const line = (await getStocktake({ businessId: A.businessId, stocktakeId: st }))!.lines.find((l: any) => l.productId === P2)!;
    await updateStocktakeLine({ businessId: A.businessId, stocktakeId: st, lineId: line.id, countedQuantity: line.systemQuantity + 1, actor: maker } as any);
    await submitStocktake({ businessId: A.businessId, stocktakeId: st });
    const r: any = await (await caller(e.ownerA)).accountingV2.stocktakeApprove({ businessId: A.businessId, stocktakeId: st });
    expect(r.ledger.status).toBe("review");
    expect(r.ledger.reason).toContain("INV_GAIN");
    expect((await q("SELECT status FROM stocktakes WHERE id = ?", [st]))[0].status).toBe("approved");
    const c = await (await caller(e.amA)).ledger.period.checklist({ period: PERIOD });
    expect(c.checks.find((x: any) => x.key === "stocktake_variances")).toMatchObject({ ok: false });
    expect(await code(async () => (await caller(e.ownerA)).ledger.period.lock({ period: PERIOD, reason: "مراجعة الشهر" }))).toBe("CONFLICT");
    await q("UPDATE ledger_accounts SET isActive = 1 WHERE tenantId = ? AND code = 'INV_GAIN'", [A.tenantId]);
    expect((await post(st)).status).toBe("posted");
    } finally { await q("UPDATE ledger_accounts SET isActive = 1 WHERE tenantId = ? AND code = 'INV_GAIN'", [A.tenantId]); }
  });

  it("الأرصدة: INV_GOODS = الافتتاحي + صافي حركات V2 المرحّلة، وINV_GAIN/INV_VARIANCE = مجموع الربح/الخسارة", async () => {
    const posted = await q("SELECT CAST(sourceReference AS UNSIGNED) st FROM ledger_transactions WHERE tenantId = ? AND idempotencyKey LIKE 'stocktake:%:variance' AND description NOT LIKE 'قيد تاريخي%'", [A.tenantId]);
    let gain = 0, loss = 0;
    for (const p of posted) { const v = await v2Value(Number(p.st)); gain += Number(v.gain); loss += Number(v.loss); }
    // + القيد التاريخي الصافي (عجز 30) الذي بقي كما هو
    expect(await balance("INV_GAIN")).toBe(gain.toFixed(4));
    expect(await balance("INV_VARIANCE")).toBe((loss + 30).toFixed(4));
    expect(await balance("INV_GOODS")).toBe((500 + gain - loss - 30).toFixed(4));
  });

  it("قائمة الدخل: أرباح الجرد في «إيرادات أخرى» لا في إيراد المبيعات ولا مجمل الربح، وداخل صافي الربح", async () => {
    const s: any = await (await caller(e.ownerA)).ledger.reports.incomeStatement({ from: "2026-10-01", to: "2026-10-31" });
    expect(s.revenue.lines.some((l: any) => l.code === "INV_GAIN")).toBe(false);
    expect(s.otherIncome.lines.map((l: any) => l.code)).toEqual(["INV_GAIN"]);
    expect(s.otherIncome.total).toBe(await balance("INV_GAIN"));
    const net = Number(s.revenue.total) - Number(s.cogs) - Number(s.expenses.total) + Number(s.otherIncome.total);
    expect(s.netProfit).toBe(net.toFixed(4));
    expect(s.grossProfit).toBe((Number(s.revenue.total) - Number(s.cogs)).toFixed(4));
  });

  it("عزل الشركات: جرد شركة B بلا دفتر = skipped بلا حسابات ولا قيود، ولا يؤثر على A", async () => {
    const before = await balance("INV_GOODS");
    const st = await realStocktake(B, { [B.productId]: 2 });
    expect((await post(st, B)).status).toBe("skipped");
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_accounts WHERE tenantId = ?", [B.tenantId]))[0].n)).toBe(0);
    expect(await balance("INV_GOODS")).toBe(before);
    expect((await post(st, A)).status).toBe("skipped"); // جرد B من نشاط A = غير موجود في نطاقه
    expect(await txCount(`stocktake:${st}:variance`)).toBe(0);
  });

  it("الإقفال: جرد مختلط صافيه صفر مطلوب (إجمالي)، يرفض الإقفال حتى يُرحَّل، ثم الإقفال السليم ينجح", async () => {
    // −1 × 50 = 50 عجز، +... بقيمة 50 زيادة: P2 بتكلفة 20 لا تعطي 50 — نضبط قيمة اللقطة عبر تكلفة V2 للمنتج الثاني = 25
    await q("UPDATE inventory_balances SET inventoryValue = onHandQuantity * 25, movingAverageCost = '25.0000' WHERE businessId = ? AND inventoryKey = ?", [A.businessId, makeInventoryKey(P2)]);
    const p1 = Number((await q("SELECT onHandQuantity h FROM inventory_balances WHERE businessId = ? AND inventoryKey = ?", [A.businessId, makeInventoryKey(A.productId)]))[0].h);
    const p2 = Number((await q("SELECT onHandQuantity h FROM inventory_balances WHERE businessId = ? AND inventoryKey = ?", [A.businessId, makeInventoryKey(P2)]))[0].h);
    const st = await realStocktake(A, { [A.productId]: p1 - 1, [P2]: p2 + 2 }); // عجز 50، زيادة 2 × 25 = 50
    expect(await v2Value(st)).toEqual({ gain: "50.0000", loss: "50.0000", net: "0.0000" });
    const checks = async () => Object.fromEntries((await (await caller(e.amA)).ledger.period.checklist({ period: PERIOD })).checks.map((c: any) => [c.key, c.ok]));
    expect((await checks()).stocktake_variances).toBe(false);
    expect(await code(async () => (await caller(e.ownerA)).ledger.period.lock({ period: PERIOD, reason: "مراجعة الشهر" }))).toBe("CONFLICT");
    expect((await post(st)).status).toBe("posted");
    expect(await lines(`stocktake:${st}:variance`)).toEqual([["INV_GAIN", "credit", "50.0000"], ["INV_VARIANCE", "debit", "50.0000"]]);
    const all = await checks();
    expect(Object.entries(all).filter(([, ok]) => !ok)).toEqual([]);
    expect((await (await caller(e.ownerA)).ledger.period.lock({ period: PERIOD, reason: "مراجعة الشهر وطابقت الخزنة" })).status).toBe("locked");
  });
});
