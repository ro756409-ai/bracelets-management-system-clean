import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee, resolveOrderReviewProduct } from "./db";
import { confirmPhrase, runHandMigration } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { LEDGER_CARRIER_MIGRATION } from "./ledgerPhaseMigrations";
import { activateLedgerV3 } from "./ledgerV3.service";
import { ensureDailyAccounts } from "./ledgerDaily.service";
import { postOrderDelivered, postOrderReturned } from "./ledgerOrders.service";
import { postInventoryOpeningFromStocktake, postReturnInspection, postStocktakeVariance } from "./ledgerInventory.service";
import { makeInventoryKey } from "./inventoryV2.service";
import { approveStocktake, createStocktake, getStocktake, submitStocktake, updateStocktakeLine } from "./stocktake.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * BUG-88 — الإقفال يُرفض من السيرفر لو في الشهر قيد مطلوب فعلًا ولم يُسجَّل، أو بند مراجعة مالية مفتوح؛ والاستثناءات الصحيحة
 * (جرد افتتاحي، بلا فروق، قبل Go-live، نشاط بلا تقييم مخزون، مرتجع سليم قبل التسليم، تكلفة صفرية، مرتجع قبل التسليم) لا تمنع؛
 * وشركة أخرى لا تؤثر؛ وحل مراجعة المنتج لا يمسح أسباب «دفتر:»؛ والمسار السليم يُقفل.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const W = { type: "webhook" } as const;
const PERIOD = "2026-10";

describe.runIf(CAN)("🔒 BUG-88 — لا إقفال لشهر فيه قيد مطلوب ناقص أو مراجعة مالية مفتوحة", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  let A2 = 0, wh = 0, seq = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const checks = async () => Object.fromEntries((await (await call(e.amA)).period.checklist({ period: PERIOD })).checks.map((c: any) => [c.key, c]));
  const okMap = async () => Object.fromEntries(Object.entries(await checks()).map(([k, c]: any) => [k, c.ok]));

  const stocktake = async (biz: number, approvedAt: string, lines: { counted: number; system: number; cost: string }[], warehouseId = wh) => {
    const st = insId(await q("INSERT INTO stocktakes (businessId, warehouseId, status, createdBy, createdByName, approvedAt) VALUES (?, ?, 'approved', ?, 'مالك', ?)", [biz, warehouseId, e.ownerA, new Date(approvedAt)]));
    for (const [i, l] of lines.entries()) {
      const diff = l.counted - l.system;
      await q("INSERT INTO stocktake_lines (stocktakeId, businessId, warehouseId, productId, inventoryKey, systemQuantity, countedQuantity, differenceQuantity, unitCostSnapshot, differenceValue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [st, biz, warehouseId, A.productId, `${makeInventoryKey(A.productId)}-${st}-${i}`, l.system, l.counted, diff, l.cost, (diff * Number(l.cost)).toFixed(4)]);
    }
    return st;
  };
  const order = async (biz: number, total: string, item: { qty: number; cost: string | null; out: number }, status = "delivered") => {
    const id = insId(await q(`INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, productId, totalAmount, shippingFees, status, source, bostaShipmentId)
      VALUES (?, ?, 'عميل', '01000000000', 'عنوان', 'القاهرة', 'أسورة', ?, ?, '0', ?, 'manual', ?)`, [biz, `CR-${tmp.name.slice(-6)}-${++seq}`, A.productId, total, status, `CS-${tmp.name.slice(-6)}-${seq}`]));
    const item_ = insId(await q("INSERT INTO order_items (orderId, productId, productName, quantity, unitPrice, unitCostSnapshot, stockOutQuantity) VALUES (?, ?, 'أسورة', ?, ?, ?, ?)", [id, A.productId, item.qty, total, item.cost, item.out]));
    return { id, item: item_ };
  };
  const inbox = async (orderId: number, state: number, at: string, tenantId = A.tenantId, biz = A.businessId) => {
    const sid = (await q("SELECT bostaShipmentId s FROM orders WHERE id = ?", [orderId]))[0].s;
    await q("INSERT INTO carrier_webhook_inbox (tenantId, businessId, provider, shipmentId, eventKey, stateCode, eventTimestamp, processingStatus, payloadJson) VALUES (?, ?, 'bosta', ?, ?, ?, ?, 'processed', '{}')",
      [tenantId, biz, sid, `cr-${tmp.name.slice(-8)}-${++seq}`, state, Date.parse(at)]);
  };
  const inspection = async (biz: number, orderId: number, orderItemId: number, approvedAt: string, disposition: "restock" | "scrap", cost = "30.0000") => {
    const id = insId(await q("INSERT INTO return_inspections (businessId, orderId, status, approvedAt) VALUES (?, ?, 'approved', ?)", [biz, orderId, new Date(approvedAt)]));
    await q("INSERT INTO return_inspection_items (inspectionId, businessId, orderItemId, quantity, unitCostSnapshot, disposition) VALUES (?, ?, ?, 1, ?, ?)", [id, biz, orderItemId, cost, disposition]);
    return id;
  };
  const clearOrderReviews = async () => {
    await q("UPDATE orders o JOIN businesses b ON b.id = o.businessId SET o.needsReview = 0, o.reviewReason = NULL WHERE b.tenantId = ?", [A.tenantId]);
    await q("UPDATE ledger_carrier_review_items SET status = 'resolved', resolvedAt = NOW(3), resolvedByEmployeeId = ?, resolutionNote = 'حُل في الاختبار' WHERE tenantId = ? AND status = 'open'", [e.ownerA, A.tenantId]);
  };
  const periodStatus = async () => (await q("SELECT status FROM ledger_periods WHERE tenantId = ? AND period = ?", [A.tenantId, PERIOD]))[0]?.status ?? "none";

  beforeAll(async () => {
    tmp = await createTempSchema("close_req");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    expect((await runHandMigration(LEDGER_CARRIER_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync("drizzle/0047_ledger_carrier.sql", "utf-8"), deployEnv: "test", confirm: confirmPhrase("0047", "apply", tmp.name) } as any)).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("cr-a"); B = await createCoreTestFixture("cr-b");
    A2 = insId(await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'نشاط بلا تقييم مخزون', ?)", [A.tenantId, `cr2-${tmp.name}`.slice(0, 50)]));
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-cr`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("amA", "accounts_manager", A); await mk("ownerB", "super_admin", B);
    wh = A.warehouseId;
    await q("UPDATE businesses SET accountingGoLiveAt = ? WHERE id = ?", [new Date("2026-09-30T21:00:00Z"), A.businessId]);
    await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: "2026-10-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "1000" }, businessIds: [A.businessId, A2], safeGrants: { OFFICE_CASH: [A.businessId, A2], BANK_MAIN: [A.businessId, A2], COD_BOSTA: [A.businessId, A2] } } as any);
    await ensureDailyAccounts({ tenantId: A.tenantId, businessIds: [A.businessId, A2], actor: { type: "employee", employeeId: e.ownerA } });
    // مخزون افتتاحي موثّق من جرد يوم Go-live (10 × 40 = 400) — الجرد نفسه لا يُعدّ فرقًا ناقصًا
    const opening = await stocktake(A.businessId, "2026-10-01T09:00:00Z", [{ counted: 10, system: 10, cost: "40.0000" }]);
    await postInventoryOpeningFromStocktake({ tenantId: A.tenantId, stocktakeId: opening, actor: { type: "employee", employeeId: e.ownerA } });
    // رصيد V2 للمنتج (10 × 40) — الجرد الحقيقي يُعتمد عليه فتُكتب حركاته الفعلية (BUG-89A: القيمة من V2)
    await q("INSERT INTO inventory_balances (businessId, warehouseId, productId, inventoryKey, onHandQuantity, inventoryValue, movingAverageCost) VALUES (?, ?, ?, ?, 10, '400.0000', '40.0000')", [A.businessId, wh, A.productId, makeInventoryKey(A.productId)]);
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("البداية سليمة: كل بنود القائمة الجديدة ok والجرد الافتتاحي لا يُعدّ ناقصًا", async () => {
    const c = await okMap();
    expect(c).toMatchObject({ stocktake_variances: true, return_inspections: true, order_costs: true, order_returns: true, review_queue: true });
    expect(Object.values(c).every(Boolean)).toBe(true);
  });

  it("فرق جرد بلا قيد يمنع الإقفال من الـAPI؛ والاستثناءات الصحيحة لا تمنع؛ وبعد الترحيل يزول", async () => {
    // جرد حقيقي بعجز 1 (اعتماد فعلي يكتب حركة V2) — بلا قيد في الدفتر
    const { stocktakeId: missing } = await createStocktake({ businessId: A.businessId, warehouseId: wh, actor: { id: e.amA, name: "عادّ" } } as any);
    const line = (await getStocktake({ businessId: A.businessId, stocktakeId: missing }))!.lines.find((l: any) => l.productId === A.productId)!;
    await updateStocktakeLine({ businessId: A.businessId, stocktakeId: missing, lineId: line.id, countedQuantity: 9, actor: { id: e.amA, name: "عادّ" } } as any);
    await submitStocktake({ businessId: A.businessId, stocktakeId: missing });
    await approveStocktake({ businessId: A.businessId, stocktakeId: missing, actor: { id: e.ownerA, name: "مالك" } });
    // استثناءات: بلا فروق، قبل Go-live، نشاط بلا تقييم مخزون، شركة أخرى
    await stocktake(A.businessId, "2026-10-11T09:00:00Z", [{ counted: 5, system: 5, cost: "40.0000" }]);
    await stocktake(A.businessId, "2026-09-25T09:00:00Z", [{ counted: 1, system: 3, cost: "40.0000" }]);
    await stocktake(A2, "2026-10-12T09:00:00Z", [{ counted: 1, system: 3, cost: "40.0000" }]);
    await stocktake(B.businessId, "2026-10-12T09:00:00Z", [{ counted: 1, system: 3, cost: "40.0000" }], B.warehouseId);
    const c = await checks();
    expect(c.stocktake_variances.ok).toBe(false);
    expect(c.stocktake_variances.label).toMatch(new RegExp(`^1 جرد .*#${missing}\\)`));
    expect(await code(async () => (await call(e.ownerA)).period.lock({ period: PERIOD, reason: "مراجعة الشهر" }))).toBe("CONFLICT");
    expect(await periodStatus()).not.toBe("locked");
    expect((await postStocktakeVariance({ businessId: A.businessId, stocktakeId: missing, actor: { type: "employee", employeeId: e.ownerA } })).status).toBe("posted");
    expect((await checks()).stocktake_variances.ok).toBe(true);
  });

  it("تكلفة أوردر ناقصة تُكتشف من البيانات حتى لو اتمسح علم المراجعة؛ التكلفة الصفرية لا تمنع", async () => {
    const noCost = await order(A.businessId, "100", { qty: 1, cost: null, out: 0 }); // لم يخرج من المخزون بلقطة تكلفة
    expect((await postOrderDelivered({ businessId: A.businessId, orderId: noCost.id, cod: 100, occurredAt: new Date("2026-10-12T10:00:00Z"), actor: W })).status).toBe("review");
    const zero = await order(A.businessId, "100", { qty: 1, cost: "0.0000", out: 1 });
    expect((await postOrderDelivered({ businessId: A.businessId, orderId: zero.id, cod: 100, occurredAt: new Date("2026-10-12T11:00:00Z"), actor: W })).status).toBe("posted");
    let c = await checks();
    expect([c.order_costs.ok, c.ledger_reviews.ok, c.review_queue.ok]).toEqual([false, false, false]);
    expect(c.order_costs.label).toMatch(new RegExp(`^1 أوردر .*#${noCost.id}\\)`));
    // مسح العلم والطابور (كما كان يحدث بحل مراجعة المنتج) لا يخفي القيد الناقص
    await clearOrderReviews();
    c = await checks();
    expect([c.order_costs.ok, c.ledger_reviews.ok, c.review_queue.ok]).toEqual([false, true, true]);
    expect(await code(async () => (await call(e.amA)).period.lock({ period: PERIOD, reason: "مراجعة الشهر" }))).toBe("CONFLICT");
    // تثبيت التكلفة ثم إعادة الربط (idempotent) يرحّل التكلفة
    await q("UPDATE order_items SET unitCostSnapshot = '30.0000', stockOutQuantity = 1 WHERE id = ?", [noCost.item]);
    expect((await postOrderDelivered({ businessId: A.businessId, orderId: noCost.id, cod: 100, occurredAt: new Date("2026-10-12T10:00:00Z"), actor: W })).status).toBe("posted");
    await clearOrderReviews();
    expect((await checks()).order_costs.ok).toBe(true);
  });

  it("مرتجع بعد التسليم بلا قيد يمنع؛ المرتجع قبل التسليم لا يمنع؛ فحص المرتجع بلا قيد يمنع؛ السليم قبل التسليم لا يمنع", async () => {
    const o = await order(A.businessId, "100", { qty: 1, cost: "30.0000", out: 1 });
    expect((await postOrderDelivered({ businessId: A.businessId, orderId: o.id, cod: 100, occurredAt: new Date("2026-10-13T10:00:00Z"), actor: W })).status).toBe("posted");
    await q("UPDATE orders SET status = 'returned' WHERE id = ?", [o.id]);
    await inbox(o.id, 46, "2026-10-14T10:00:00Z");
    const before = await order(A.businessId, "100", { qty: 1, cost: "30.0000", out: 1 }, "returned"); // لم يُسلَّم = لا إيراد
    await inbox(before.id, 60, "2026-10-14T11:00:00Z");
    let c = await checks();
    expect(c.order_returns.ok).toBe(false);
    expect(c.order_returns.label).toMatch(new RegExp(`^1 مرتجع .*#${o.id}\\)`));
    expect((await postOrderReturned({ businessId: A.businessId, orderId: o.id, occurredAt: new Date("2026-10-14T10:00:00Z"), actor: W })).status).toBe("posted");
    expect((await checks()).order_returns.ok).toBe(true);

    const insp = await inspection(A.businessId, o.id, o.item, "2026-10-15T10:00:00Z", "restock");
    const healthyBefore = await inspection(A.businessId, before.id, before.item, "2026-10-15T11:00:00Z", "restock"); // قبل التسليم سليم = لا قيد
    c = await checks();
    expect(c.return_inspections.ok).toBe(false);
    expect(c.return_inspections.label).toMatch(new RegExp(`^1 فحص .*#${insp}\\)`));
    expect(c.return_inspections.label).not.toContain(`#${healthyBefore}`);
    expect(await code(async () => (await call(e.ownerA)).period.lock({ period: PERIOD, reason: "مراجعة الشهر" }))).toBe("CONFLICT");
    expect((await postReturnInspection({ businessId: A.businessId, inspectionId: insp, actor: { type: "employee", employeeId: e.ownerA } })).status).toBe("posted");
    expect((await checks()).return_inspections.ok).toBe(true);
  });

  it("طابور المراجعة: بند مفتوح يمنع، المُستبعد لا يمنع، وبند شركة أخرى لا يؤثر", async () => {
    await q("INSERT INTO ledger_carrier_review_items (tenantId, businessId, source, referenceKey, reason) VALUES (?, ?, 'settlement', ?, 'فرق تسوية')", [B.tenantId, B.businessId, `settle:B:${tmp.name}`.slice(0, 191)]);
    expect((await checks()).review_queue.ok).toBe(true);
    const item = insId(await q("INSERT INTO ledger_carrier_review_items (tenantId, businessId, source, referenceKey, reason) VALUES (?, ?, 'payout', ?, 'تحويل مرفوض')", [A.tenantId, A.businessId, `payout:A:${tmp.name}`.slice(0, 191)]));
    expect((await checks()).review_queue.ok).toBe(false);
    expect(await code(async () => (await call(e.ownerA)).period.lock({ period: PERIOD, reason: "مراجعة الشهر" }))).toBe("CONFLICT");
    await q("UPDATE ledger_carrier_review_items SET status = 'dismissed', resolvedAt = NOW(3), resolvedByEmployeeId = ?, resolutionNote = 'مستبعد بعد مراجعة' WHERE id = ?", [e.ownerA, item]);
    expect((await checks()).review_queue.ok).toBe(true);
  });

  it("حل مراجعة المنتج يحتفظ بأسباب «دفتر:» والعلم؛ وبدونها يرفع العلم كما كان", async () => {
    const withLedger = await order(A.businessId, "100", { qty: 1, cost: "30.0000", out: 1 }, "new");
    await q("UPDATE orders SET needsReview = 1, reviewReason = 'منتج غير مطابق | دفتر: لم تُسجَّل التكلفة' WHERE id = ?", [withLedger.id]);
    await resolveOrderReviewProduct(withLedger.id, { productId: A.productId });
    expect((await q("SELECT needsReview n, reviewReason r FROM orders WHERE id = ?", [withLedger.id]))[0]).toMatchObject({ n: 1, r: "دفتر: لم تُسجَّل التكلفة" });
    const plain = await order(A.businessId, "100", { qty: 1, cost: "30.0000", out: 1 }, "new");
    await q("UPDATE orders SET needsReview = 1, reviewReason = 'منتج غير مطابق' WHERE id = ?", [plain.id]);
    await resolveOrderReviewProduct(plain.id, { productId: A.productId });
    expect((await q("SELECT needsReview n, reviewReason r FROM orders WHERE id = ?", [plain.id]))[0]).toMatchObject({ n: 0, r: null });
    await clearOrderReviews();
  });

  it("المسار السليم: بعد استكمال كل القيود القائمة جاهزة والإقفال من الـAPI ينجح", async () => {
    const c = await okMap();
    expect(Object.entries(c).filter(([, ok]) => !ok)).toEqual([]);
    const r = await (await call(e.ownerA)).period.lock({ period: PERIOD, reason: "مراجعة الشهر وطابقت الخزنة" });
    expect(r.status).toBe("locked");
    expect(await periodStatus()).toBe("locked");
  });
});
