import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee, confirmOrder, cancelOrder } from "./db";
import { confirmPhrase } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { activateLedgerV3 } from "./ledgerV3.service";
import { ensureDailyAccounts } from "./ledgerDaily.service";
import { postOrderDelivered, postOrderReturned } from "./ledgerOrders.service";
import { openReturnInspection, postReturnInspection, postStocktakeVariance } from "./ledgerInventory.service";
import { makeInventoryKey, submitReturnInspection } from "./inventoryV2.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * المرحلة 4 — المخزون وتكلفة الأوردر على قاعدة حقيقية: الحجز عند التأكيد وفكّه عند الإلغاء (بعد اعتمادهما)، التسليم
 * لمندوب الشحن بالمسح = خروج وتثبيت تكلفة مرة واحدة تحت التزامن، التكلفة عند التسليم من نفس اللقطة، المخزون الافتتاحي
 * من جرد يوم Go-live (المالك فقط، مرة لكل مخزن)، فروق الجرد، والمرتجع المفحوص قبل/بعد التسليم بلا تكلفة مكررة؛
 * والبوابات (شركة دفترها غير مفعّل/نشاط بلا تقييم مخزون/نطاق شركة أخرى).
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const caller = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const GOLIVE = "2026-10-01";

describe.runIf(CAN)("📦 المرحلة 4 — المخزون وتكلفة الأوردر", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  let wh = 0, product = 0, seq = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const balance = async () => (await q("SELECT onHandQuantity h, reservedQuantity r, inventoryValue v, movingAverageCost c FROM inventory_balances WHERE warehouseId = ? AND inventoryKey = ?", [wh, makeInventoryKey(product)]))[0];
  const mkOrder = async (status = "new", qty = 2, f: CoreTestFixture = A) => {
    const id = insId(await q(`INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, productId, quantity, totalAmount, shippingFees, status, source)
      VALUES (?, ?, 'عميل', '01000000000', 'عنوان', 'القاهرة', 'أسورة', ?, ?, '500', '0', ?, 'manual')`, [f.businessId, `IN-${tmp.name.slice(-6)}-${++seq}`, product, qty, status]));
    await q("INSERT INTO order_items (orderId, productId, productName, quantity) VALUES (?, ?, 'أسورة', ?)", [id, product, qty]);
    return id;
  };
  const txKinds = async (like: string) => (await q("SELECT kind, idempotencyKey FROM ledger_transactions WHERE idempotencyKey LIKE ? ORDER BY id", [like])).map((r: any) => r.kind);
  const lines = async (key: string) => (await q("SELECT a.code, e.side, e.amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.accountId JOIN ledger_transactions t ON t.id = e.transactionId WHERE t.idempotencyKey = ? ORDER BY e.id", [key])).map((r: any) => [r.code, r.side, r.amount]);

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_inv");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("in-a"); B = await createCoreTestFixture("in-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-in`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("amA", "accounts_manager", A); await mk("whA", "warehouse", A); await mk("whB", "warehouse", B); await mk("ownerB", "super_admin", B);
    wh = insId(await q("INSERT INTO warehouses (businessId, name) VALUES (?, 'المكتب')", [A.businessId]));
    await q("UPDATE businesses SET accountingGoLiveAt = ?, defaultWarehouseId = ? WHERE id = ?", [new Date("2026-09-30T00:00:00Z"), wh, A.businessId]);
    product = insId(await q("INSERT INTO products (name, businessId) VALUES ('أسورة نحاس', ?)", [A.businessId]));
    await q("INSERT INTO inventory_balances (businessId, warehouseId, productId, inventoryKey, onHandQuantity, inventoryValue, movingAverageCost) VALUES (?, ?, ?, ?, 10, '400.0000', '40.0000')", [A.businessId, wh, product, makeInventoryKey(product)]);
    await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: GOLIVE, currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "1000" }, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId] } } as any);
    await ensureDailyAccounts({ tenantId: A.tenantId, businessIds: [A.businessId], actor: { type: "employee", employeeId: e.ownerA } });
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("المخزون الافتتاحي من جرد يوم Go-live (المالك فقط): Σ المعدود × التكلفة المجمّدة، مرة واحدة لكل مخزن؛ جرد يوم آخر مرفوض", async () => {
    const st = insId(await q("INSERT INTO stocktakes (businessId, warehouseId, status, createdBy, createdByName, approvedAt) VALUES (?, ?, 'approved', ?, 'مالك', ?)", [A.businessId, wh, e.ownerA, new Date("2026-09-30T18:00:00Z")]));
    await q("INSERT INTO stocktake_lines (stocktakeId, businessId, warehouseId, productId, inventoryKey, systemQuantity, countedQuantity, unitCostSnapshot) VALUES (?, ?, ?, ?, ?, 10, 10, '40.0000')", [st, A.businessId, wh, product, makeInventoryKey(product)]);
    expect(await code(async () => (await caller(e.amA)).ledger.inventory.openingFromStocktake({ stocktakeId: st }))).toBe("FORBIDDEN");
    const r = await (await caller(e.ownerA)).ledger.inventory.openingFromStocktake({ stocktakeId: st });
    expect(r.replay).toBe(false);
    expect(await lines(`inventory-opening:warehouse:${wh}`)).toEqual([["INV_GOODS", "debit", "400.0000"], ["OPENING_EQUITY", "credit", "400.0000"]]);
    expect((await q("SELECT DATE_FORMAT(effectiveDate,'%Y-%m-%d') d FROM ledger_transactions WHERE idempotencyKey = ?", [`inventory-opening:warehouse:${wh}`]))[0].d).toBe(GOLIVE);
    // جرد ثانٍ لنفس المخزن = رفض (لا تكرار)؛ جرد معتمد في يوم آخر = رفض
    const st2 = insId(await q("INSERT INTO stocktakes (businessId, warehouseId, status, createdBy, createdByName, approvedAt) VALUES (?, ?, 'approved', ?, 'مالك', ?)", [A.businessId, wh, e.ownerA, new Date("2026-10-01T08:00:00Z")]));
    await q("INSERT INTO stocktake_lines (stocktakeId, businessId, warehouseId, productId, inventoryKey, systemQuantity, countedQuantity, unitCostSnapshot) VALUES (?, ?, ?, ?, ?, 10, 11, '40.0000')", [st2, A.businessId, wh, product, makeInventoryKey(product)]);
    expect(await code(async () => (await caller(e.ownerA)).ledger.inventory.openingFromStocktake({ stocktakeId: st2 }))).toBe("PRECONDITION_FAILED");
    const st3 = insId(await q("INSERT INTO stocktakes (businessId, warehouseId, status, createdBy, createdByName, approvedAt) VALUES (?, ?, 'approved', ?, 'مالك', ?)", [A.businessId, wh + 1000, e.ownerA, new Date("2026-10-09T08:00:00Z")]));
    expect(await code(async () => (await caller(e.ownerA)).ledger.inventory.openingFromStocktake({ stocktakeId: st3 }))).toBe("PRECONDITION_FAILED");
    expect(await code(async () => (await caller(e.ownerB)).ledger.inventory.openingFromStocktake({ stocktakeId: st }))).not.toBe("ok"); // شركة أخرى
  });

  it("الحجز عند التأكيد وفكّه عند الإلغاء — بعد اعتمادهما، مرة واحدة", async () => {
    const o = await mkOrder("new", 2);
    await confirmOrder(o, e.ownerA, "مالك");
    expect((await balance()).r).toBe(2);
    expect((await q("SELECT status FROM inventory_reservations WHERE orderId = ?", [o])).map((r: any) => r.status)).toEqual(["active"]);
    await cancelOrder(o, "customer_request", undefined, e.ownerA);
    await cancelOrder(o, "customer_request", undefined, e.ownerA); // تكرار = لا فك مرتين
    expect((await balance()).r).toBe(0);
    expect((await q("SELECT status FROM inventory_reservations WHERE orderId = ?", [o])).map((r: any) => r.status)).toEqual(["released"]);
  });

  it("التسليم لمندوب الشحن بالمسح: خروج + تثبيت تكلفة مرة واحدة تحت 4 طلبات متزامنة؛ والتكلفة عند التسليم من نفس اللقطة", async () => {
    const o = await mkOrder("confirmed", 3);
    const wh1 = await caller(e.whA);
    const runs = await Promise.allSettled(Array.from({ length: 4 }, () => wh1.inventoryLedger.handover({ businessId: A.businessId, orderId: o })));
    const ok = runs.filter(r => r.status === "fulfilled").map(r => (r as any).value);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(ok.every(v => v.cost === "120.0000")).toBe(true); // 3 × 40 متوسط التكلفة
    expect((await q("SELECT COUNT(*) n FROM inventory_transactions WHERE sourceType = 'order_item' AND sourceId IN (SELECT id FROM order_items WHERE orderId = ?)", [o]))[0].n).toBe(1);
    const b = await balance();
    expect([b.h, b.r]).toEqual([7, 0]);
    expect((await q("SELECT unitCostSnapshot s, stockOutQuantity n FROM order_items WHERE orderId = ?", [o]))[0]).toMatchObject({ s: "40.0000", n: 3 });
    // إعادة المسح بعد الخروج = replay بلا خروج ثانٍ
    expect((await wh1.inventoryLedger.handover({ businessId: A.businessId, orderId: o })).duplicate).toBe(true);
    await q("UPDATE orders SET status = 'delivered' WHERE id = ?", [o]);
    await postOrderDelivered({ businessId: A.businessId, orderId: o, cod: 500, occurredAt: new Date("2026-10-10T10:00:00Z"), actor: { type: "webhook" } });
    expect(await lines(`order:${o}:cogs`)).toEqual([["COGS", "debit", "120.0000"], ["INV_GOODS", "credit", "120.0000"]]);
  });

  it("البوابات: أوردر ملغي لا يُسلَّم، ونشاط شركة أخرى مرفوض بالنطاق، وشركة بلا دفتر/تقييم = PRECONDITION", async () => {
    const cancelled = await mkOrder("cancelled", 1);
    expect(await code(async () => (await caller(e.whA)).inventoryLedger.handover({ businessId: A.businessId, orderId: cancelled }))).toBe("PRECONDITION_FAILED");
    expect(await code(async () => (await caller(e.whB)).inventoryLedger.handover({ businessId: A.businessId, orderId: cancelled }))).toBe("FORBIDDEN");
    const bOrder = await mkOrder("confirmed", 1, B);
    expect(await code(async () => (await caller(e.whB)).inventoryLedger.handover({ businessId: B.businessId, orderId: bOrder }))).toBe("PRECONDITION_FAILED");
    // تأكيد/إلغاء في شركة بلا دفتر: لا حجز ولا أثر
    await confirmOrder(bOrder, e.ownerB, "مالك").catch(() => null);
    expect((await q("SELECT COUNT(*) n FROM inventory_reservations WHERE orderId = ?", [bOrder]))[0].n).toBe(0);
  });

  it("فروق جرد لاحق: صافي العجز على «فروقات الجرد» مرة واحدة؛ جرد افتتاحي بلا فروق", async () => {
    const st = insId(await q("INSERT INTO stocktakes (businessId, warehouseId, status, createdBy, createdByName, approvedAt) VALUES (?, ?, 'approved', ?, 'مالك', ?)", [A.businessId, wh, e.ownerA, new Date("2026-10-12T09:00:00Z")]));
    await q("INSERT INTO stocktake_lines (stocktakeId, businessId, warehouseId, productId, inventoryKey, systemQuantity, countedQuantity, differenceQuantity, unitCostSnapshot, differenceValue) VALUES (?, ?, ?, ?, ?, 7, 6, -1, '40.0000', '-40.0000'), (?, ?, ?, ?, ?, 0, 0, 0, '10.0000', '10.0000')",
      [st, A.businessId, wh, product, makeInventoryKey(product), st, A.businessId, wh, product, `${makeInventoryKey(product)}-x`]);
    const r1 = await postStocktakeVariance({ businessId: A.businessId, stocktakeId: st, actor: { type: "employee", employeeId: e.ownerA } });
    const r2 = await postStocktakeVariance({ businessId: A.businessId, stocktakeId: st, actor: { type: "employee", employeeId: e.ownerA } });
    expect([r1.status, r2.status]).toEqual(["posted", "replay"]);
    expect(await lines(`stocktake:${st}:variance`)).toEqual([["INV_VARIANCE", "debit", "30.0000"], ["INV_GOODS", "credit", "30.0000"]]);
    const opening = (await q("SELECT sourceReference s FROM ledger_transactions WHERE idempotencyKey = ?", [`inventory-opening:warehouse:${wh}`]))[0].s;
    expect((await postStocktakeVariance({ businessId: A.businessId, stocktakeId: Number(opening), actor: { type: "system" } })).status).toBe("skipped");
  });

  it("المرتجع المفحوص: بعد التسليم السليم للمخزون والتالف للخسائر من «قيد الفحص»؛ فحص ثانٍ يتجاوز المتبقي مرفوض؛ قبل التسليم التالف = خسائر/مخزون", async () => {
    // بعد التسليم: أوردر سُلّم وارتد ثم فُحص وأُرجع 1 من 2 للمخزون
    const delivered = await mkOrder("delivered", 2);
    const item = (await q("SELECT id FROM order_items WHERE orderId = ?", [delivered]))[0].id;
    await q("UPDATE order_items SET unitCostSnapshot = '40.0000', stockOutQuantity = 2 WHERE id = ?", [item]);
    await postOrderDelivered({ businessId: A.businessId, orderId: delivered, cod: 500, occurredAt: new Date("2026-10-10T10:00:00Z"), actor: { type: "webhook" } });
    const insp = insId(await q("INSERT INTO return_inspections (businessId, orderId, status, approvedAt) VALUES (?, ?, 'approved', ?)", [A.businessId, delivered, new Date("2026-10-14T10:00:00Z")]));
    await q("INSERT INTO return_inspection_items (inspectionId, businessId, orderItemId, quantity, unitCostSnapshot, disposition) VALUES (?, ?, ?, 1, '40.0000', 'restock'), (?, ?, ?, 1, '40.0000', 'scrap')", [insp, A.businessId, item, insp, A.businessId, item]);
    // قبل تسجيل المرتجع المالي: لا قيد (تخطٍّ بسبب واضح)، ثم بعد حدث الإرجاع يُسجَّل
    expect(await postReturnInspection({ businessId: A.businessId, inspectionId: insp, actor: { type: "system" } })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/لم يُسجَّل بعد/) });
    await q("UPDATE orders SET status = 'returned' WHERE id = ?", [delivered]);
    await postOrderReturned({ businessId: A.businessId, orderId: delivered, occurredAt: new Date("2026-10-13T10:00:00Z"), actor: { type: "webhook" } });
    const a1 = await postReturnInspection({ businessId: A.businessId, inspectionId: insp, actor: { type: "system" } });
    const a2 = await postReturnInspection({ businessId: A.businessId, inspectionId: insp, actor: { type: "system" } });
    expect([a1.status, a2.status]).toEqual(["posted", "replay"]);
    expect(await lines(`return-inspection:${insp}`)).toEqual([["INV_GOODS", "debit", "40.0000"], ["RETURN_LOSS", "debit", "40.0000"], ["RETURNS_PENDING", "credit", "80.0000"]]);
    // فحص ثانٍ لنفس الأوردر = استلام مرتين — مرفوض (المتبقي قيد الفحص صفر)
    const insp3 = insId(await q("INSERT INTO return_inspections (businessId, orderId, status, approvedAt) VALUES (?, ?, 'approved', ?)", [A.businessId, delivered, new Date("2026-10-15T10:00:00Z")]));
    await q("INSERT INTO return_inspection_items (inspectionId, businessId, orderItemId, quantity, unitCostSnapshot, disposition) VALUES (?, ?, ?, 1, '40.0000', 'restock')", [insp3, A.businessId, item]);
    await expect(postReturnInspection({ businessId: A.businessId, inspectionId: insp3, actor: { type: "system" } })).rejects.toThrow(/لا استلام مرتين/);
    // قبل التسليم: إعدام قطعة لم تُسجَّل تكلفتها كمبيعات
    const shipped = await mkOrder("returned", 1);
    const item2 = (await q("SELECT id FROM order_items WHERE orderId = ?", [shipped]))[0].id;
    const insp2 = insId(await q("INSERT INTO return_inspections (businessId, orderId, status, approvedAt) VALUES (?, ?, 'approved', ?)", [A.businessId, shipped, new Date("2026-10-14T10:00:00Z")]));
    await q("INSERT INTO return_inspection_items (inspectionId, businessId, orderItemId, quantity, unitCostSnapshot, disposition) VALUES (?, ?, ?, 1, '40.0000', 'scrap')", [insp2, A.businessId, item2]);
    expect((await postReturnInspection({ businessId: A.businessId, inspectionId: insp2, actor: { type: "system" } })).status).toBe("posted");
    expect(await lines(`return-inspection:${insp2}`)).toEqual([["RETURN_LOSS", "debit", "40.0000"], ["INV_GOODS", "credit", "40.0000"]]);
    expect(await txKinds(`order:${shipped}:%`)).toEqual([]); // لا إيراد ولا تكلفة لأوردر لم يُسلَّم
  });

  it("محرك V2 للكمية والمتوسط فقط: دورة كاملة (تأكيد → مسح متزامن → تسليم → مرتجع → فحص معتمد عبر الراوتر) بلا أي كتابة مالية في V1/V2، وخروج وتكلفة مرة واحدة", async () => {
    const tables: string[] = (await q("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME")).map((r: any) => r.t);
    const snapshot = async () => {
      const out: Record<string, string> = {};
      for (const t of tables) { const [row] = await q(`CHECKSUM TABLE \`${t}\``); out[t] = String(row.Checksum); }
      return out;
    };
    const before = await snapshot();
    const o = await mkOrder("new", 2);
    await confirmOrder(o, e.ownerA, "مالك");
    const wh1 = await caller(e.whA);
    await Promise.allSettled([1, 2, 3].map(() => wh1.inventoryLedger.handover({ businessId: A.businessId, orderId: o })));
    await q("UPDATE orders SET status = 'delivered' WHERE id = ?", [o]);
    await postOrderDelivered({ businessId: A.businessId, orderId: o, cod: 500, occurredAt: new Date("2026-10-16T10:00:00Z"), actor: { type: "webhook" } });
    await q("UPDATE orders SET status = 'returned' WHERE id = ?", [o]);
    await postOrderReturned({ businessId: A.businessId, orderId: o, occurredAt: new Date("2026-10-17T10:00:00Z"), actor: { type: "webhook" } });
    const item = (await q("SELECT id FROM order_items WHERE orderId = ?", [o]))[0].id;
    // مسار بوسطة: فتح الفحص مرة واحدة تحت التزامن، والكمية المرتجعة = ما خرج فعلًا
    const opened = await Promise.all([1, 2, 3].map(() => openReturnInspection({ businessId: A.businessId, orderId: o })));
    expect(opened.filter(r => r.status === "opened")).toHaveLength(1);
    expect((await q("SELECT returnedQuantity n FROM order_items WHERE id = ?", [item]))[0].n).toBe(2);
    const insp = (opened.find(r => r.status === "opened") as any).inspectionId;
    expect((await q("SELECT COUNT(*) n FROM return_inspections WHERE orderId = ?", [o]))[0].n).toBe(1);
    await submitReturnInspection({ businessId: A.businessId, inspectionId: insp, receivedAt: new Date("2026-10-18T09:00:00Z"), actor: { id: e.amA, name: "مدير حسابات" } as any,
      items: [{ orderItemId: item, quantity: 1, disposition: "restock" }, ] });
    const approved = await (await caller(e.ownerA)).accountingV2.returnInspectionApprove({ businessId: A.businessId, inspectionId: insp, warehouseId: wh, occurredAt: new Date("2026-10-18T10:00:00Z") });
    expect((approved as any).ledger).toMatchObject({ status: "posted" });
    const after = await snapshot();
    const changed = tables.filter(t => before[t] !== after[t]);
    // المسموح: الأوردر وبنوده، كميات ومتوسط V2، الفحص، أحداث العمل (مفتاح منع تكرار الخروج)، سجلات التدقيق، وجداول V3 فقط
    const allowed = /^(orders|order_items|order_status_history|inventory_(balances|transactions|movements|reservations)|return_inspections|return_inspection_items|business_events|audit_logs?|activity_logs?|ledger_(transactions|entries|accounts|periods))$/;
    expect(changed.filter(t => !allowed.test(t))).toEqual([]);
    for (const t of ["expenses", "expense_payments", "treasury_transactions", "employee_advances"]) expect(changed).not.toContain(t);
    // خروج واحد وتكلفة واحدة رغم 3 مسحات متزامنة؛ المرتجع: قيد عكس واحد ونقل تكلفة واحد؛ الفحص: استلام واحد بالسليم فقط
    expect((await q("SELECT COUNT(*) n FROM inventory_transactions WHERE sourceType = 'order_item' AND sourceId = ?", [item]))[0].n).toBe(1);
    expect(await txKinds(`order:${o}:%`)).toEqual(["revenue_cod", "cost_of_sales", "reversal", "return_cost"]);
    expect(await lines(`order:${o}:cogs`)).toEqual([["COGS", "debit", "80.0000"], ["INV_GOODS", "credit", "80.0000"]]);
    expect(await lines(`return-inspection:${insp}`)).toEqual([["INV_GOODS", "debit", "40.0000"], ["RETURNS_PENDING", "credit", "40.0000"]]);
  });
});
