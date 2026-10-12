import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { drizzle } from "drizzle-orm/mysql2";
import { __setDbForTests, createEmployee } from "./db";
import { activateLedgerV3, lockLedgerPeriod, postLedgerTransaction, reopenLedgerPeriod } from "./ledgerV3.service";
import { ensureDailyAccounts } from "./ledgerDaily.service";
import { afterCarrierOrderUpdate, orderCostFromSnapshots, postOrderDelivered, postOrderReturned } from "./ledgerOrders.service";
import { reprocessBostaInboxEvent } from "./bostaWebhook";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * المرحلتان 3/4 — أثر الأوردر المالي في Ledger V3 على قاعدة حقيقية: التسليم (إيراد منتج + إيراد شحن منفصل + ذمة COD)
 * والتكلفة من اللقطة المثبتة فقط، مرة واحدة تحت التزامن؛ مبلغ تحصيل مختلف/غائب أو تكلفة غير مثبتة = مراجعة بلا تخمين؛
 * المرتجع بعد التسليم يعكس الإيراد ويحوّل التكلفة لخسارة مرتجع، وقبل التسليم بلا أثر؛ البوابات (دفتر غير مفعّل، قبل
 * Go-live، شهر مقفول)، التوقيت عند منتصف ليل القاهرة، ومسار webhook الحقيقي (إعادة معالجة صندوق الوارد).
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const WEBHOOK = { type: "webhook" } as const;
const AT = new Date("2026-10-15T10:00:00Z");

describe.runIf(CAN)("🚚 أثر الأوردر المالي (تسليم/تكلفة/مرتجع)", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  let owner = 0; let seq = 0;
  const acc: Record<string, number> = {};
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const mkOrder = async (f: CoreTestFixture, o: { total: string; fees?: string; status?: string; items: { qty: number; snap: string | null; out: number }[]; shipment?: string }) => {
    const id = insId(await q(`INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, totalAmount, shippingFees, status, source, bostaShipmentId)
      VALUES (?, ?, 'عميل', '01000000000', 'عنوان', 'القاهرة', 'أسورة', ?, ?, ?, 'manual', ?)`, [f.businessId, `LO-${tmp.name.slice(-6)}-${++seq}`, o.total, o.fees ?? "0", o.status ?? "delivered", o.shipment ?? null]));
    for (const it of o.items) await q("INSERT INTO order_items (orderId, productName, quantity, unitCostSnapshot, stockOutQuantity) VALUES (?, 'أسورة', ?, ?, ?)", [id, it.qty, it.snap, it.out]);
    return id;
  };
  const txs = async (orderId: number) => q("SELECT id, kind, idempotencyKey, effectiveDate, reversalOfTransactionId FROM ledger_transactions WHERE sourceReference = ? AND sourceType IN ('order','reversal') OR idempotencyKey LIKE ? ORDER BY id", [String(orderId), `order:${orderId}:%`]);
  const lines = async (txId: number) => (await q("SELECT a.code, e.side, e.amount, e.businessId FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.accountId WHERE e.transactionId = ? ORDER BY e.id", [txId])).map((r: any) => [r.code, r.side, r.amount]);
  const review = async (orderId: number) => (await q("SELECT needsReview, reviewReason FROM orders WHERE id = ?", [orderId]))[0];

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_ord");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("lo-a"); B = await createCoreTestFixture("lo-b");
    owner = insId(await createEmployee({ name: "مالك", role: "super_admin", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `lo_owner_${tmp.name}`.slice(0, 50) } as any));
    const r = await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: "2026-10-01", currency: "EGP", actor: { type: "employee", employeeId: owner },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: owner, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "1000" }, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId] } } as any);
    Object.assign(acc, r.accounts);
    await ensureDailyAccounts({ tenantId: A.tenantId, businessIds: [A.businessId], actor: { type: "employee", employeeId: owner } });
    for (const row of await q("SELECT id, code FROM ledger_accounts WHERE tenantId = ?", [A.tenantId])) acc[row.code] = row.id;
    // قيمة مخزون في الدفتر من شراء فعلي (التكلفة تُخصم منها عند البيع)
    await postLedgerTransaction({ tenantId: A.tenantId, sourceBusinessId: A.businessId, kind: "inventory_purchase", idempotencyKey: "lo-stock-buy-1", effectiveDate: "2026-10-02", currency: "EGP",
      actor: { type: "employee", employeeId: owner }, description: "شراء مخزون", sourceType: null, sourceReference: null,
      entries: [{ accountId: acc.INV_GOODS, side: "debit", amount: "900", businessId: A.businessId }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "900", businessId: A.businessId }] } as any);
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("لقطة التكلفة: مجموع اللقطة × الكمية الخارجة؛ أي بند بلا لقطة أو بكمية ناقصة = غير مثبتة (null)", () => {
    expect(orderCostFromSnapshots([{ quantity: 2, stockOutQuantity: 2, unitCostSnapshot: "40.1250" }, { quantity: 1, stockOutQuantity: 1, unitCostSnapshot: "9.7500" }])).toBe(900000n);
    expect(orderCostFromSnapshots([{ quantity: 2, stockOutQuantity: 1, unitCostSnapshot: "40" }])).toBeNull();
    expect(orderCostFromSnapshots([{ quantity: 1, stockOutQuantity: 1, unitCostSnapshot: null }])).toBeNull();
    expect(orderCostFromSnapshots([])).toBeNull();
  });

  it("التسليم: إيراد المنتج والشحن منفصلان وذمة COD بمبلغ بوسطة، والتكلفة من اللقطة — مرة واحدة تحت 5 طلبات متزامنة", async () => {
    const id = await mkOrder(A, { total: "750", fees: "50", items: [{ qty: 2, snap: "120.5000", out: 2 }] });
    const runs = await Promise.all(Array.from({ length: 5 }, () => postOrderDelivered({ businessId: A.businessId, orderId: id, cod: 750, occurredAt: AT, actor: WEBHOOK })));
    expect(runs.filter(r => r.status === "posted")).toHaveLength(1);
    expect(runs.every(r => r.status === "posted" || r.status === "replay")).toBe(true);
    const t = await txs(id);
    expect(t.map((x: any) => [x.kind, x.idempotencyKey])).toEqual([["revenue_cod", `order:${id}:delivered`], ["cost_of_sales", `order:${id}:cogs`]]);
    expect(await lines(t[0].id)).toEqual([["COD_BOSTA", "debit", "750.0000"], ["REVENUE", "credit", "700.0000"], ["REV_SHIPPING", "credit", "50.0000"]]);
    expect(await lines(t[1].id)).toEqual([["COGS", "debit", "241.0000"], ["INV_GOODS", "credit", "241.0000"]]);
    expect((await review(id)).needsReview).toBe(0);
  });

  it("لا تخمين: مبلغ تحصيل ≠ الإجمالي أو غائب = مراجعة واضحة بلا أي قيد", async () => {
    const id = await mkOrder(A, { total: "600", items: [{ qty: 1, snap: "50", out: 1 }] });
    expect(await postOrderDelivered({ businessId: A.businessId, orderId: id, cod: 450, occurredAt: AT, actor: WEBHOOK })).toMatchObject({ status: "review" });
    const id2 = await mkOrder(A, { total: "600", items: [{ qty: 1, snap: "50", out: 1 }] });
    expect(await postOrderDelivered({ businessId: A.businessId, orderId: id2, cod: null, occurredAt: AT, actor: WEBHOOK })).toMatchObject({ status: "review" });
    expect(await txs(id)).toEqual([]); expect(await txs(id2)).toEqual([]);
    const r = await review(id);
    expect(r.needsReview).toBe(1);
    expect(r.reviewReason).toMatch(/دفتر: مبلغ التحصيل من بوسطة 450\.0000 ≠ إجمالي الأوردر 600\.0000/);
    expect((await review(id2)).reviewReason).toMatch(/غير مذكور/);
  });

  it("تكلفة غير مثبتة: الإيراد يُسجَّل والتكلفة لا (مراجعة)؛ بعد تثبيت اللقطة تُسجَّل التكلفة وحدها مرة واحدة", async () => {
    const id = await mkOrder(A, { total: "300", items: [{ qty: 1, snap: null, out: 0 }] });
    const first = await postOrderDelivered({ businessId: A.businessId, orderId: id, cod: 300, occurredAt: AT, actor: WEBHOOK });
    expect(first).toMatchObject({ status: "review" });
    expect((await txs(id)).map((x: any) => x.kind)).toEqual(["revenue_cod"]);
    expect((await review(id)).reviewReason).toMatch(/تكلفة الأوردر غير مثبتة/);
    await q("UPDATE order_items SET unitCostSnapshot = '80.0000', stockOutQuantity = 1 WHERE orderId = ?", [id]);
    const second = await postOrderDelivered({ businessId: A.businessId, orderId: id, cod: 300, occurredAt: AT, actor: WEBHOOK });
    expect(second.status).toBe("posted");
    expect((await txs(id)).map((x: any) => x.kind)).toEqual(["revenue_cod", "cost_of_sales"]);
  });

  it("المرتجع بعد التسليم: عكس الإيراد والذمة + تحويل التكلفة لخسائر المرتجعات (الربح لا يتضخم)؛ مكرر = replay؛ قبل التسليم بلا أثر", async () => {
    const id = await mkOrder(A, { total: "400", fees: "40", items: [{ qty: 1, snap: "100", out: 1 }] });
    await postOrderDelivered({ businessId: A.businessId, orderId: id, cod: 400, occurredAt: AT, actor: WEBHOOK });
    await q("UPDATE orders SET status = 'returned' WHERE id = ?", [id]);
    const r1 = await postOrderReturned({ businessId: A.businessId, orderId: id, occurredAt: new Date("2026-10-20T10:00:00Z"), actor: WEBHOOK });
    const r2 = await postOrderReturned({ businessId: A.businessId, orderId: id, occurredAt: new Date("2026-10-20T10:00:00Z"), actor: WEBHOOK });
    expect([r1.status, r2.status]).toEqual(["posted", "replay"]);
    const t = await txs(id);
    const rev = t.find((x: any) => x.idempotencyKey === `order:${id}:returned`);
    expect(rev.reversalOfTransactionId).toBe(t.find((x: any) => x.idempotencyKey === `order:${id}:delivered`).id);
    expect(await lines(t.find((x: any) => x.idempotencyKey === `order:${id}:return-loss`).id)).toEqual([["RETURN_LOSS", "debit", "100.0000"], ["COGS", "credit", "100.0000"]]);
    // صافي الأوردر: إيراد 0، تكلفة مبيعات 0، خسارة مرتجع = التكلفة
    const net = async (code: string) => (await q(`SELECT SUM(CASE WHEN e.side='debit' THEN e.amount ELSE -e.amount END) n FROM ledger_entries e JOIN ledger_accounts a ON a.id=e.accountId JOIN ledger_transactions t ON t.id=e.transactionId WHERE a.code=? AND t.idempotencyKey LIKE ?`, [code, `order:${id}:%`]))[0].n;
    expect([await net("REVENUE"), await net("REV_SHIPPING"), await net("COGS"), await net("RETURN_LOSS"), await net("COD_BOSTA")]).toEqual(["0.0000", "0.0000", "0.0000", "100.0000", "0.0000"]);
    const before = await mkOrder(A, { total: "200", status: "returned", items: [{ qty: 1, snap: "60", out: 1 }] });
    expect(await postOrderReturned({ businessId: A.businessId, orderId: before, occurredAt: AT, actor: WEBHOOK })).toMatchObject({ status: "skipped" });
    expect(await txs(before)).toEqual([]);
  });

  it("البوابات: شركة دفترها غير مفعّل، تاريخ قبل Go-live، وحالة ليست تسليمًا = لا قيد؛ الشهر المقفول = مراجعة ثم يُقبل بعد إعادة الفتح", async () => {
    const bOrder = await mkOrder(B, { total: "100", items: [{ qty: 1, snap: "10", out: 1 }] });
    expect(await postOrderDelivered({ businessId: B.businessId, orderId: bOrder, cod: 100, occurredAt: AT, actor: WEBHOOK })).toMatchObject({ status: "skipped", reason: "دفتر الشركة غير مفعّل" });
    expect((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ?", [B.tenantId]))[0].n).toBe(0);
    const early = await mkOrder(A, { total: "100", items: [{ qty: 1, snap: "10", out: 1 }] });
    expect((await postOrderDelivered({ businessId: A.businessId, orderId: early, cod: 100, occurredAt: new Date("2026-09-30T10:00:00Z"), actor: WEBHOOK })).status).toBe("skipped");
    const notDelivered = await mkOrder(A, { total: "100", status: "shipped", items: [{ qty: 1, snap: "10", out: 1 }] });
    expect((await postOrderDelivered({ businessId: A.businessId, orderId: notDelivered, cod: 100, occurredAt: AT, actor: WEBHOOK })).status).toBe("skipped");
    // شهر مقفول: لا قيد ولا إعادة تأريخ — مراجعة؛ بعد الفتح بسبب يُسجَّل
    await lockLedgerPeriod({ tenantId: A.tenantId, period: "2026-10", reason: "إقفال للاختبار", actor: { type: "employee", employeeId: owner } });
    const locked = await mkOrder(A, { total: "100", items: [{ qty: 1, snap: "10", out: 1 }] });
    expect(await postOrderDelivered({ businessId: A.businessId, orderId: locked, cod: 100, occurredAt: AT, actor: WEBHOOK })).toMatchObject({ status: "review" });
    expect(await txs(locked)).toEqual([]);
    expect((await review(locked)).reviewReason).toMatch(/مقفولة/);
    await reopenLedgerPeriod({ tenantId: A.tenantId, period: "2026-10", reason: "فتح بعد الاختبار", actor: { type: "employee", employeeId: owner } });
    expect((await postOrderDelivered({ businessId: A.businessId, orderId: locked, cod: 100, occurredAt: AT, actor: WEBHOOK })).status).toBe("posted");
  });

  it("قيمة المخزون في الدفتر لا تغطي التكلفة: الإيراد يُسجَّل والتكلفة تُرفض (لا رصيد سالب) بمراجعة واضحة", async () => {
    const id = await mkOrder(A, { total: "100000", items: [{ qty: 1, snap: "99999", out: 1 }] });
    expect(await postOrderDelivered({ businessId: A.businessId, orderId: id, cod: 100000, occurredAt: AT, actor: WEBHOOK })).toMatchObject({ status: "review" });
    expect((await txs(id)).map((x: any) => x.kind)).toEqual(["revenue_cod"]);
    expect((await review(id)).reviewReason).toMatch(/دفتر: لم تُسجَّل التكلفة: .*سالب/);
  });

  it("التوقيت: تسليم 21:30Z يوم 15/10 = 00:30 يوم 16/10 بالقاهرة → تاريخ الحركة 2026-10-16 (لا يتبع توقيت Node)", async () => {
    const id = await mkOrder(A, { total: "90", items: [{ qty: 1, snap: "10", out: 1 }] });
    await postOrderDelivered({ businessId: A.businessId, orderId: id, cod: 90, occurredAt: new Date("2026-10-15T21:30:00Z"), actor: WEBHOOK });
    expect((await q("SELECT DATE_FORMAT(effectiveDate, '%Y-%m-%d') d FROM ledger_transactions WHERE idempotencyKey = ?", [`order:${id}:delivered`]))[0].d).toBe("2026-10-16");
  });

  it("الربط من webhook: حالة لم تنتقل فعلًا = لا شيء؛ ومسار webhook الحقيقي (إعادة معالجة صندوق الوارد) يسجّل التسليم مرة واحدة", async () => {
    const id = await mkOrder(A, { total: "500", status: "shipped", items: [{ qty: 1, snap: "70", out: 1 }], shipment: `SHP-${tmp.name.slice(-6)}` });
    expect(await afterCarrierOrderUpdate({ businessId: A.businessId, orderId: id, orderStatus: "shipped", eventStatus: "delivered", cod: 500, occurredAt: AT })).toBeNull();
    const payload = { _id: `SHP-${tmp.name.slice(-6)}`, trackingNumber: 99887766, state: 45, type: "SEND", cod: 500, timeStamp: Date.parse("2026-10-15T12:00:00Z"), isConfirmedDelivery: true };
    const inbox = insId(await q("INSERT INTO carrier_webhook_inbox (tenantId, businessId, provider, shipmentId, eventKey, stateCode, processingStatus, payloadJson) VALUES (?, ?, 'bosta', ?, ?, 45, 'failed', ?)",
      [A.tenantId, A.businessId, payload._id, `k-${tmp.name}`.slice(0, 64), JSON.stringify(payload)]));
    const r = await reprocessBostaInboxEvent(inbox, A.businessId);
    expect(r.ok).toBe(true);
    expect((await q("SELECT status FROM orders WHERE id = ?", [id]))[0].status).toBe("delivered");
    expect((await txs(id)).map((x: any) => x.kind)).toEqual(["revenue_cod", "cost_of_sales"]);
    // إعادة الإرسال نفسها: لا قيد ثانٍ
    await q("UPDATE carrier_webhook_inbox SET processingStatus = 'failed' WHERE id = ?", [inbox]);
    await reprocessBostaInboxEvent(inbox, A.businessId);
    expect((await txs(id)).length).toBe(2);
  });
});
