import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee, confirmOrder } from "./db";
import { confirmPhrase, runHandMigration } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { LEDGER_CARRIER_MIGRATION } from "./ledgerPhaseMigrations";
import { activateLedgerV3 } from "./ledgerV3.service";
import { ensureDailyAccounts } from "./ledgerDaily.service";
import { postOrderDelivered, postOrderReturned } from "./ledgerOrders.service";
import { incomeStatement } from "./ledgerReports.service";
import { makeInventoryKey } from "./inventoryV2.service";
import { businessDateKey } from "../shared/businessTime";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * المرحلة 4 — التغليف والإدخال اليدوي على قاعدة حقيقية مؤقتة (0040 + 0045 + 0047):
 *  • الحسابات الآلية (رسوم الشحن، خسائر المرتجع، مرتجعات قيد الفحص، إيراد الشحن، التغليف…) ممنوعة في الإدخال اليدوي؛
 *    شراء التغليف مخزون.
 *  • رصيد التغليف الافتتاحي: المالك فقط، من عدّ يوم Go-live، مرة لكل نشاط.
 *  • استهلاك التغليف عند التسليم لمندوب الشحن من الإعداد المُدخل، مرة واحدة تحت التزامن وإعادة المسح وتغيير الإعداد؛ بلا إعداد
 *    لا قيد؛ مخزون لا يكفي = مراجعة والتسليم ينجح؛ المرتجع لا يعيد التغليف؛ والتكلفة في قائمة الدخل مرة واحدة.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const caller = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const GOLIVE = "2026-10-01";

describe.runIf(CAN)("📦 المرحلة 4 — التغليف والإدخال اليدوي", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  const acc: Record<string, number> = {};
  let wh = 0, product = 0, seq = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const mkOrder = async (qty = 1) => {
    const id = insId(await q(`INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, productId, quantity, totalAmount, shippingFees, status, source)
      VALUES (?, ?, 'عميل', '01000000000', 'عنوان', 'القاهرة', 'أسورة', ?, ?, '500', '0', 'new', 'manual')`, [A.businessId, `PK-${tmp.name.slice(-6)}-${++seq}`, product, qty]));
    await q("INSERT INTO order_items (orderId, productId, productName, quantity) VALUES (?, ?, 'أسورة', ?)", [id, product, qty]);
    await confirmOrder(id, e.ownerA, "مالك");
    return id;
  };
  const lines = async (key: string) => (await q("SELECT a.code, e.side, e.amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.accountId JOIN ledger_transactions t ON t.id = e.transactionId WHERE t.idempotencyKey = ? ORDER BY e.id", [key])).map((r: any) => [r.code, r.side, r.amount]);
  const count = async (key: string) => Number((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE idempotencyKey = ?", [key]))[0].n);
  const bal = async (c: string) => (await q("SELECT currentBalance b FROM ledger_accounts WHERE tenantId = ? AND code = ?", [A.tenantId, c]))[0].b;
  const post = (who: number, kind: string, debit: string, credit: string, amount: string, key: string) => caller(who).then(c => c.ledger.post({
    sourceBusinessId: A.businessId, kind, idempotencyKey: key, effectiveDate: "2026-10-02", currency: "EGP", description: "يدوي",
    entries: [{ accountId: acc[debit], side: "debit", amount, businessId: A.businessId }, { accountId: acc[credit], side: "credit", amount, businessId: A.businessId }] } as any));

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_pkg");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    expect((await runHandMigration(LEDGER_CARRIER_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync("drizzle/0047_ledger_carrier.sql", "utf-8"), deployEnv: "test", confirm: confirmPhrase("0047", "apply", tmp.name) } as any)).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("pk-a"); B = await createCoreTestFixture("pk-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-pk`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("amA", "accounts_manager", A); await mk("accA", "accountant", A); await mk("whA", "warehouse", A);
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accountant', 'ledger.post', 1, ?)", [A.tenantId, e.ownerA]);
    wh = insId(await q("INSERT INTO warehouses (businessId, name) VALUES (?, 'المكتب')", [A.businessId]));
    await q("UPDATE businesses SET accountingGoLiveAt = ?, defaultWarehouseId = ? WHERE id = ?", [new Date("2026-09-30T00:00:00Z"), wh, A.businessId]);
    product = insId(await q("INSERT INTO products (name, businessId) VALUES ('أسورة نحاس', ?)", [A.businessId]));
    await q("INSERT INTO inventory_balances (businessId, warehouseId, productId, inventoryKey, onHandQuantity, inventoryValue, movingAverageCost) VALUES (?, ?, ?, ?, 50, '2000.0000', '40.0000')", [A.businessId, wh, product, makeInventoryKey(product)]);
    await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: GOLIVE, currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "1000" }, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId] } } as any);
    await ensureDailyAccounts({ tenantId: A.tenantId, businessIds: [A.businessId], actor: { type: "employee", employeeId: e.ownerA } });
    for (const r of await q("SELECT id, code FROM ledger_accounts WHERE tenantId = ?", [A.tenantId])) acc[r.code] = r.id;
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("الإدخال اليدوي: الحسابات الآلية مرفوضة قبل أي كتابة (مصروف رسوم شحن، شراء لـ«قيد الفحص»، إيراد شحن، تكلفة تغليف)؛ شراء التغليف مخزون مسموح", async () => {
    const before = Number((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ?", [A.tenantId]))[0].n);
    expect(await code(() => post(e.accA, "expense", "EXP_CARRIER_FEES", "OFFICE_CASH", "10", "pk-man-0001"))).toBe("BAD_REQUEST");
    expect(await code(() => post(e.accA, "expense", "RETURN_LOSS", "OFFICE_CASH", "10", "pk-man-0002"))).toBe("BAD_REQUEST");
    expect(await code(() => post(e.accA, "inventory_purchase", "RETURNS_PENDING", "OFFICE_CASH", "10", "pk-man-0003"))).toBe("BAD_REQUEST");
    expect(await code(() => post(e.accA, "revenue_prepaid", "OFFICE_CASH", "REV_SHIPPING", "10", "pk-man-0004"))).toBe("BAD_REQUEST");
    expect(await code(() => post(e.ownerA, "adjustment", "COGS_PACKAGING", "INV_PACKAGING", "10", "pk-man-0005"))).toBe("BAD_REQUEST"); // حتى المالك
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ?", [A.tenantId]))[0].n)).toBe(before);
    await post(e.accA, "inventory_purchase", "INV_PACKAGING", "OFFICE_CASH", "20", "pk-man-0006");
    await post(e.accA, "expense", "EXP_ADS", "OFFICE_CASH", "15", "pk-man-0007"); // الإعلانات مصروف يومها
    expect(await bal("INV_PACKAGING")).toBe("20.0000");
  });

  it("رصيد التغليف الافتتاحي: المالك فقط، من عدّ يوم Go-live فقط، مرة لكل نشاط", async () => {
    expect(await code(async () => (await caller(e.amA)).ledger.inventory.packagingOpening({ businessId: A.businessId, amount: "30", countedOn: GOLIVE }))).toBe("FORBIDDEN");
    const owner = (await caller(e.ownerA)).ledger;
    expect(await code(() => owner.inventory.packagingOpening({ businessId: A.businessId, amount: "30", countedOn: "2026-10-05" }))).toBe("PRECONDITION_FAILED");
    expect(await code(() => owner.inventory.packagingOpening({ businessId: B.businessId, amount: "30", countedOn: GOLIVE }))).toBe("FORBIDDEN");
    expect((await owner.inventory.packagingOpening({ businessId: A.businessId, amount: "30", countedOn: GOLIVE })).replay).toBe(false);
    expect((await owner.inventory.packagingOpening({ businessId: A.businessId, amount: "30", countedOn: GOLIVE })).replay).toBe(true);
    expect(await code(() => owner.inventory.packagingOpening({ businessId: A.businessId, amount: "31", countedOn: GOLIVE }))).toBe("PRECONDITION_FAILED");
    expect(await lines(`packaging-opening:business:${A.businessId}`)).toEqual([["INV_PACKAGING", "debit", "30.0000"], ["OPENING_EQUITY", "credit", "30.0000"]]);
    expect(await bal("INV_PACKAGING")).toBe("50.0000");
  });

  it("الاستهلاك عند التسليم: بلا إعداد لا قيد؛ بالإعداد قيد واحد تحت 4 مسحات متزامنة؛ إعادة المسح بعد تغيير الإعداد لا تكرر ولا تعدّل", async () => {
    const wh1 = await caller(e.whA);
    const o1 = await mkOrder();
    expect((await wh1.inventoryLedger.handover({ businessId: A.businessId, orderId: o1 })).packaging).toMatchObject({ status: "skipped", reason: expect.stringMatching(/غير مُدخلة/) });
    expect(await count(`order:${o1}:packaging`)).toBe(0);
    await (await caller(e.amA)).ledger.settings.set({ key: "packaging.cost_per_order", scopeBusinessId: A.businessId, value: "3.5" });
    const o2 = await mkOrder();
    const runs = await Promise.allSettled(Array.from({ length: 4 }, () => wh1.inventoryLedger.handover({ businessId: A.businessId, orderId: o2 })));
    expect(runs.some(r => r.status === "fulfilled")).toBe(true);
    expect(await count(`order:${o2}:packaging`)).toBe(1);
    expect(await lines(`order:${o2}:packaging`)).toEqual([["COGS_PACKAGING", "debit", "3.5000"], ["INV_PACKAGING", "credit", "3.5000"]]);
    expect((await q("SELECT DATE_FORMAT(effectiveDate,'%Y-%m-%d') d FROM ledger_transactions WHERE idempotencyKey = ?", [`order:${o2}:packaging`]))[0].d).toBe(businessDateKey(new Date(), "Africa/Cairo"));
    await (await caller(e.amA)).ledger.settings.set({ key: "packaging.cost_per_order", scopeBusinessId: A.businessId, value: "5" });
    expect((await wh1.inventoryLedger.handover({ businessId: A.businessId, orderId: o2 })).packaging).toMatchObject({ status: "replay" });
    expect(await lines(`order:${o2}:packaging`)).toEqual([["COGS_PACKAGING", "debit", "3.5000"], ["INV_PACKAGING", "credit", "3.5000"]]);
    expect(await bal("INV_PACKAGING")).toBe("46.5000");
  });

  it("مخزون التغليف لا يكفي: مراجعة على الأوردر وفي الطابور، والتسليم (الخروج من المخزن) ينجح", async () => {
    await (await caller(e.amA)).ledger.settings.set({ key: "packaging.cost_per_order", scopeBusinessId: A.businessId, value: "100" });
    const o = await mkOrder();
    const r = await (await caller(e.whA)).inventoryLedger.handover({ businessId: A.businessId, orderId: o });
    expect(r.packaging).toMatchObject({ status: "review" });
    expect(Number((await q("SELECT stockOutQuantity n FROM order_items WHERE orderId = ?", [o]))[0].n)).toBe(1);
    expect(await count(`order:${o}:packaging`)).toBe(0);
    expect((await q("SELECT needsReview n, reviewReason r FROM orders WHERE id = ?", [o]))[0]).toMatchObject({ n: 1, r: expect.stringMatching(/التغليف/) });
    expect((await q("SELECT status FROM ledger_carrier_review_items WHERE referenceKey = ?", [`order:${o}`]))[0].status).toBe("open");
  });

  it("التكلفة مرة واحدة في قائمة الدخل (منتج + تغليف)، والمرتجع لا يعيد التغليف", async () => {
    // أوردر o2 من الاختبار السابق: سُلّم ثم ارتد
    const o2 = Number((await q("SELECT CAST(sourceReference AS UNSIGNED) id FROM ledger_transactions WHERE kind = 'packaging_consumption' AND tenantId = ? ORDER BY id LIMIT 1", [A.tenantId]))[0].id);
    await post(e.accA, "inventory_purchase", "INV_GOODS", "OFFICE_CASH", "400", "pk-goods-0001"); // قيمة مخزون في الدفتر تغطي التكلفة
    await q("UPDATE orders SET status = 'delivered' WHERE id = ?", [o2]);
    expect((await postOrderDelivered({ businessId: A.businessId, orderId: o2, cod: 500, occurredAt: new Date(), actor: { type: "webhook" } })).status).toBe("posted");
    const today = businessDateKey(new Date(), "Africa/Cairo");
    const s = await incomeStatement({ tenantId: A.tenantId, from: GOLIVE, to: today, scope: null });
    expect(s.cogs).toBe("43.5000"); // 40 منتج + 3.5 تغليف — مرة واحدة
    await q("UPDATE orders SET status = 'returned' WHERE id = ?", [o2]);
    await postOrderReturned({ businessId: A.businessId, orderId: o2, occurredAt: new Date(), actor: { type: "webhook" } });
    expect(await count(`order:${o2}:packaging`)).toBe(1);
    expect((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE reversalOfTransactionId = (SELECT id FROM ledger_transactions WHERE idempotencyKey = ?)", [`order:${o2}:packaging`]))[0].n).toBe(0);
    const after = await incomeStatement({ tenantId: A.tenantId, from: GOLIVE, to: today, scope: null });
    expect(after.cogs).toBe("3.5000"); // تكلفة المنتج انتقلت لـ«قيد الفحص»؛ التغليف استُهلك فعلًا
  });
});
