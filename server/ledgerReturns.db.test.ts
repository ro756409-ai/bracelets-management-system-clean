import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { confirmPhrase } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { activateLedgerV3, postLedgerTransaction } from "./ledgerV3.service";
import { ensureDailyAccounts } from "./ledgerDaily.service";
import { postOrderDelivered, postOrderReturned } from "./ledgerOrders.service";
import { settleCarrierStatement } from "./ledgerCarrier.service";
import { postReturnInspection } from "./ledgerInventory.service";
import { incomeStatement, profitByProduct } from "./ledgerReports.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * المرتجع بعد التسليم على قاعدة حقيقية — حسب حالة التحصيل:
 *  • قبل التسوية: عكس الإيراد وذمة COD؛ وإن ظهر التحصيل لاحقًا في كشف بوسطة يصبح التزام رد للعميل لا ذمة.
 *  • بعد التسوية: الإيراد يُعكس مقابل التزام رد؛ الرد الفعلي من خزنة والاحتجاز بسبب معلن — كلٌّ مرة واحدة وفي حدود الالتزام،
 *    حتى تحت التزامن.
 *  • التكلفة تنتظر الفحص («مرتجعات قيد الفحص»)؛ السليم يعود للمخزون بعد الفحص والاستلام فقط، والتالف وحده خسارة؛
 *    فحص جزئي ثم الباقي، ولا استلام مرتين (ولا تحت التزامن)؛ والربح لا يتضخم.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const W = { type: "webhook" } as const;
const SYS = { type: "system" } as const;
const DELIVERED_AT = new Date("2026-10-10T10:00:00Z");
const RETURNED_AT = new Date("2026-10-13T10:00:00Z");

describe.runIf(CAN)("↩️ المرتجع بعد التسليم — التحصيل، الرد، الفحص", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  let seq = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const tag = () => tmp.name.slice(-5);
  const sh = (s: string) => `${s}-${tag()}`;
  /** أوردر 2 قطعة × 40 تكلفة، إجمالي 500 منها 50 شحن، مُسلَّم بقيد إيراد وتكلفة. */
  const delivered = async (shipment: string) => {
    const id = insId(await q(`INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, totalAmount, shippingFees, status, source, bostaShipmentId)
      VALUES (?, ?, 'عميل', '01000000000', 'عنوان', 'القاهرة', 'أسورة', '500', '50', 'delivered', 'manual', ?)`, [A.businessId, `RT-${tag()}-${++seq}`, sh(shipment)]));
    const item = insId(await q("INSERT INTO order_items (orderId, productName, quantity, unitCostSnapshot, stockOutQuantity) VALUES (?, 'أسورة', 2, '40.0000', 2)", [id]));
    expect((await postOrderDelivered({ businessId: A.businessId, orderId: id, cod: 500, occurredAt: DELIVERED_AT, actor: W })).status).toBe("posted");
    return { id, item };
  };
  const returned = async (id: number) => { await q("UPDATE orders SET status = 'returned' WHERE id = ?", [id]); return postOrderReturned({ businessId: A.businessId, orderId: id, occurredAt: RETURNED_AT, actor: W }); };
  const settle = (ref: string, shipment: string, cod = "500", fees = "30") =>
    settleCarrierStatement({ tenantId: A.tenantId, statementRef: ref, statementDate: "2026-10-12", actor: SYS,
      lines: [{ row: 2, shipment: sh(shipment), cod, fees, net: String(Number(cod) - Number(fees)) }] });
  const inspect = async (orderId: number, item: number, rows: { qty: number; disposition: "restock" | "scrap" }[], at = "2026-10-14T10:00:00Z") => {
    const insp = insId(await q("INSERT INTO return_inspections (businessId, orderId, status, approvedAt) VALUES (?, ?, 'approved', ?)", [A.businessId, orderId, new Date(at)]));
    for (const r of rows) await q("INSERT INTO return_inspection_items (inspectionId, businessId, orderItemId, quantity, unitCostSnapshot, disposition) VALUES (?, ?, ?, ?, '40.0000', ?)", [insp, A.businessId, item, r.qty, r.disposition]);
    return insp;
  };
  const lines = async (key: string) => (await q(`SELECT a.code, e.side, e.amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.accountId
    JOIN ledger_transactions t ON t.id = e.transactionId WHERE t.tenantId = ? AND t.idempotencyKey = ? ORDER BY e.id`, [A.tenantId, key])).map((r: any) => [r.code, r.side, r.amount]);
  const bal = async (code: string) => (await q("SELECT currentBalance b FROM ledger_accounts WHERE tenantId = ? AND code = ?", [A.tenantId, code]))[0]?.b;
  const countKey = async (key: string) => Number((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ? AND idempotencyKey = ?", [A.tenantId, key]))[0].n);
  /** صافي حساب لأوردر واحد (debit − credit) عبر كل قيوده. */
  const orderNet = async (orderId: number, codeName: string, extraKeys: string[] = []) => {
    const rows = await q(`SELECT COALESCE(SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END), 0) n FROM ledger_entries e
      JOIN ledger_accounts a ON a.id = e.accountId JOIN ledger_transactions t ON t.id = e.transactionId
      WHERE t.tenantId = ? AND a.code = ? AND (t.idempotencyKey LIKE ? OR t.idempotencyKey IN (?) OR (t.sourceType = 'return_inspection' AND t.sourceReference IN (SELECT id FROM return_inspections WHERE orderId = ?)))`,
      [A.tenantId, codeName, `order:${orderId}:%`, extraKeys.length ? extraKeys : ["-"], orderId]);
    return Number(rows[0].n).toFixed(4);
  };

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_ret");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("rt-a"); B = await createCoreTestFixture("rt-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-rt`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("amA", "accounts_manager", A); await mk("accA", "accountant", A); await mk("ownerB", "super_admin", B);
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accountant', 'ledger.post', 1, ?)", [A.tenantId, e.ownerA]);
    await q("UPDATE businesses SET accountingGoLiveAt = ? WHERE id = ?", [new Date("2026-09-30T00:00:00Z"), A.businessId]);
    await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: "2026-10-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "2000" }, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId] } } as any);
    await ensureDailyAccounts({ tenantId: A.tenantId, businessIds: [A.businessId], actor: { type: "employee", employeeId: e.ownerA } });
    const accs = Object.fromEntries((await q("SELECT id, code FROM ledger_accounts WHERE tenantId = ?", [A.tenantId])).map((r: any) => [r.code, r.id]));
    await postLedgerTransaction({ tenantId: A.tenantId, sourceBusinessId: A.businessId, kind: "inventory_purchase", idempotencyKey: "rt-stock-buy-1", effectiveDate: "2026-10-02", currency: "EGP",
      actor: { type: "employee", employeeId: e.ownerA }, description: "شراء مخزون", sourceType: null, sourceReference: null,
      entries: [{ accountId: accs.INV_GOODS, side: "debit", amount: "800", businessId: A.businessId }, { accountId: accs.OFFICE_CASH, side: "credit", amount: "800", businessId: A.businessId }] } as any);
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("قبل التسوية: عكس الإيراد وذمة COD مرة واحدة (حتى تحت التزامن)؛ لا التزام رد؛ التكلفة قيد الفحص لا خسارة", async () => {
    const o = await delivered("P1");
    const runs = await Promise.all([1, 2, 3].map(() => returned(o.id)));
    expect(runs.filter(r => r.status === "posted")).toHaveLength(1);
    expect(runs.every(r => r.status === "posted" || r.status === "replay")).toBe(true);
    expect(await countKey(`order:${o.id}:returned`)).toBe(1);
    expect(await countKey(`order:${o.id}:return-cost`)).toBe(1);
    expect(await lines(`order:${o.id}:returned`)).toEqual([["COD_BOSTA", "credit", "500.0000"], ["REVENUE", "debit", "450.0000"], ["REV_SHIPPING", "debit", "50.0000"]]);
    expect(await lines(`order:${o.id}:return-cost`)).toEqual([["RETURNS_PENDING", "debit", "80.0000"], ["COGS", "credit", "80.0000"]]);
    expect([await orderNet(o.id, "REVENUE"), await orderNet(o.id, "COGS"), await orderNet(o.id, "COD_BOSTA"), await orderNet(o.id, "RETURN_LOSS"), await orderNet(o.id, "RETURNS_PENDING")])
      .toEqual(["0.0000", "0.0000", "0.0000", "0.0000", "80.0000"]);
    expect((await (await call(e.amA)).refunds.list()).find((x: any) => x.orderId === o.id)).toBeUndefined();
  });

  it("رجع قبل التسوية ثم ظهر تحصيله في الكشف: التزام رد للعميل (لا ذمة ولا إيراد)، الرد مرة واحدة، والكشف التالي «مسوّى من قبل»", async () => {
    const o = await delivered("P2");
    await returned(o.id);
    const s = await settle("RT-ST-1", "P2");
    expect(s.outcomes[0].status).toBe("posted");
    expect(await lines(`bosta-settle:${sh("P2")}:cod`)).toEqual([["REFUND_PAYABLE", "credit", "500.0000"], ["EXP_CARRIER_FEES", "debit", "30.0000"], ["COD_PAYOUT", "debit", "470.0000"]]);
    expect(await orderNet(o.id, "COD_BOSTA", [`bosta-settle:${sh("P2")}:cod`])).toBe("0.0000");
    expect((await (await call(e.amA)).refunds.list()).find((x: any) => x.orderId === o.id)?.outstanding).toBe("500.0000");
    expect((await settle("RT-ST-2", "P2")).outcomes[0].status).toBe("already_settled");
    const am = await call(e.amA);
    expect(await code(() => am.refunds.pay({ orderId: o.id, accountCode: "OFFICE_CASH", amount: "500.01", date: "2026-10-16", operationId: "ui:p2-over-01" }))).toBe("CONFLICT");
    expect(await code(() => am.refunds.pay({ orderId: o.id, accountCode: "REVENUE", amount: "500", date: "2026-10-16", operationId: "ui:p2-rev-001" }))).not.toBe("ok"); // ليست خزنة
    const p = await am.refunds.pay({ orderId: o.id, accountCode: "OFFICE_CASH", amount: "500", date: "2026-10-16", operationId: "ui:p2-pay-001" });
    expect(p.replay).toBe(false);
    expect((await am.refunds.pay({ orderId: o.id, accountCode: "OFFICE_CASH", amount: "500", date: "2026-10-16", operationId: "ui:p2-pay-001" })).replay).toBe(true); // نفس العملية = لا تكرار
    expect(await countKey(`order:${o.id}:refund:ui:p2-pay-001`)).toBe(1);
    expect((await am.refunds.list()).find((x: any) => x.orderId === o.id)).toBeUndefined();
    expect(await code(() => am.refunds.pay({ orderId: o.id, accountCode: "OFFICE_CASH", amount: "1", date: "2026-10-16", operationId: "ui:p2-pay-002" }))).toBe("CONFLICT"); // لا شيء قائم
  });

  it("بعد التسوية: الإيراد يُعكس مقابل التزام رد (ذمة بوسطة المسوّاة لا تُمس)؛ الاحتفاظ معطّل والطلب المباشر مرفوض؛ الرد على دفعات حتى الالتزام بلا تجاوز ولا تكرار", async () => {
    const o = await delivered("P3");
    expect((await settle("RT-ST-3", "P3")).outcomes[0].status).toBe("posted");
    const r = await returned(o.id);
    expect(r.status).toBe("posted");
    expect(await lines(`order:${o.id}:returned`)).toEqual([["REVENUE", "debit", "450.0000"], ["REV_SHIPPING", "debit", "50.0000"], ["REFUND_PAYABLE", "credit", "500.0000"]]);
    expect((await returned(o.id)).status).toBe("replay");
    expect(await orderNet(o.id, "COD_BOSTA", [`bosta-settle:${sh("P3")}:cod`])).toBe("0.0000");
    const am = await call(e.amA);
    // الاحتفاظ معطّل بقرار المالك: الطلب المباشر مرفوض للجميع (حتى المالك) ولا يكتب شيئًا
    for (const who of [e.amA, e.ownerA]) {
      const err = await (await call(who)).refunds.retain({ orderId: o.id, amount: "50", reason: "شحن المرتجع على العميل", date: "2026-10-16" }).then(() => null, (x: any) => x);
      expect(err?.code).toBe("FORBIDDEN"); expect(err?.message).toMatch(/معطّل بقرار المالك/);
    }
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ? AND idempotencyKey LIKE ?", [A.tenantId, `order:${o.id}:refund-retained%`]))[0].n)).toBe(0);
    // الرد على دفعات: 450 ثم الباقي 50؛ أي زيادة مرفوضة
    await am.refunds.pay({ orderId: o.id, accountCode: "OFFICE_CASH", amount: "450", date: "2026-10-16", operationId: "ui:p3-pay-001" });
    expect((await am.refunds.list()).find((x: any) => x.orderId === o.id)?.outstanding).toBe("50.0000"); // الباقي يظل التزامًا
    expect(await code(() => am.refunds.pay({ orderId: o.id, accountCode: "OFFICE_CASH", amount: "60", date: "2026-10-16", operationId: "ui:p3-pay-002" }))).toBe("CONFLICT");
    await am.refunds.pay({ orderId: o.id, accountCode: "OFFICE_CASH", amount: "50", date: "2026-10-16", operationId: "ui:p3-pay-003" });
    expect(await orderNet(o.id, "REFUND_PAYABLE", [`bosta-settle:${sh("P3")}:cod`])).toBe("0.0000");
    // لا إيراد لأوردر مرتجع، ولا حركة على «المحتجز»
    expect([await orderNet(o.id, "REVENUE"), await orderNet(o.id, "REV_SHIPPING"), await bal("REV_RETURN_RETAINED")]).toEqual(["0.0000", "0.0000", "0.0000"]);
    // نفس العملية بمبلغ مختلف = تعارض لا قيد جديد؛ أي دفعة إضافية = تجاوز
    expect(await code(() => am.refunds.pay({ orderId: o.id, accountCode: "OFFICE_CASH", amount: "10", date: "2026-10-16", operationId: "ui:p3-pay-001" }))).toBe("CONFLICT");
    expect(await code(() => am.refunds.pay({ orderId: o.id, accountCode: "OFFICE_CASH", amount: "1", date: "2026-10-16", operationId: "ui:p3-pay-004" }))).toBe("CONFLICT");
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ? AND idempotencyKey LIKE ?", [A.tenantId, `order:${o.id}:refund:%`]))[0].n)).toBe(2);
  });

  it("تزامن دفعتي رد بكامل الالتزام نفسه: واحدة فقط تنجح ولا يتجاوز المجموع الالتزام", async () => {
    // التزام قائم لأوردر آخر — رصيد الحساب الإجمالي يكفي للاثنين، فمنع التجاوز هنا من فحص الأوردر نفسه لا من «منع السالب»
    const other = await delivered("P4B"); await settle("RT-ST-4B", "P4B"); await returned(other.id);
    const o = await delivered("P4");
    await settle("RT-ST-4", "P4"); await returned(o.id);
    // الخزنة تكفي الطلبين معًا — فلا يوقف التجاوز إلا حماية الالتزام (لا «منع الرصيد السالب» للخزنة)
    const ids = Object.fromEntries((await q("SELECT id, code FROM ledger_accounts WHERE tenantId = ?", [A.tenantId])).map((r: any) => [r.code, r.id]));
    await postLedgerTransaction({ tenantId: A.tenantId, sourceBusinessId: A.businessId, kind: "owner_contribution", idempotencyKey: "rt-fund-cash-0001", effectiveDate: "2026-10-15", currency: "EGP",
      actor: { type: "employee", employeeId: e.ownerA }, description: "تمويل خزنة للاختبار", sourceType: null, sourceReference: null,
      entries: [{ accountId: ids.OFFICE_CASH, side: "debit", amount: "5000", businessId: A.businessId }, { accountId: ids.OPENING_EQUITY, side: "credit", amount: "5000", businessId: null }] } as any);
    const am = await call(e.amA);
    // تزامن متحكَّم فيه: اتصال مستقل يقفل صف حساب «مبالغ مستحقة للعملاء» FOR UPDATE؛ الطلبان يجتازان الفحص المسبق خارج
    // الـtransaction ثم ينتظران عند قفل الحسابات. لا نحرّر القفل إلا بعد رؤية انتظارين فعليين على مخطط هذا الاختبار وحده
    // (performance_schema.data_lock_waits) — فيصلان للحماية متزامنين في كل تشغيل، أيًا كان التوقيت أو الملفات الأخرى.
    const holder = await mysql.createConnection(tmp.url);
    const refundAcc = (await q("SELECT id FROM ledger_accounts WHERE tenantId = ? AND code = 'REFUND_PAYABLE'", [A.tenantId]))[0].id;
    await holder.query("START TRANSACTION");
    await holder.query("SELECT id FROM ledger_accounts WHERE id = ? FOR UPDATE", [refundAcc]);
    const pending = Promise.allSettled([
      am.refunds.pay({ orderId: o.id, accountCode: "OFFICE_CASH", amount: "500", date: "2026-10-16", operationId: "ui:p4-pay-A01" }),
      am.refunds.pay({ orderId: o.id, accountCode: "OFFICE_CASH", amount: "500", date: "2026-10-16", operationId: "ui:p4-pay-B01" }),
    ]);
    let waits = 0;
    for (let i = 0; i < 200 && waits < 2; i++) {
      waits = Number(((await holder.query("SELECT COUNT(DISTINCT w.REQUESTING_ENGINE_TRANSACTION_ID) n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA = ? AND l.OBJECT_NAME = 'ledger_accounts'", [tmp.name])) as any)[0][0].n);
      if (waits < 2) await new Promise(r => setTimeout(r, 25));
    }
    await holder.query("COMMIT"); await holder.end();
    expect(waits).toBe(2); // معاملتان منتظرتان (الطلبان) وصلتا معًا لقفل الحساب
    const runs = await pending;
    expect(runs.filter(r => r.status === "fulfilled")).toHaveLength(1);
    // الرفض من حماية الالتزام نفسها (داخل transaction القيد)، لا من أي سبب آخر
    expect((runs.find(r => r.status === "rejected") as PromiseRejectedResult).reason?.message).toMatch(/يتجاوز الالتزام القائم/);
    expect(await orderNet(o.id, "REFUND_PAYABLE", [`bosta-settle:${sh("P4")}:cod`])).toBe("0.0000");
    expect(await orderNet(other.id, "REFUND_PAYABLE", [`bosta-settle:${sh("P4B")}:cod`])).toBe("-500.0000"); // التزام الأوردر الآخر سليم
  });

  it("الفحص: جزئي ثم الباقي؛ السليم للمخزون بعد الاستلام فقط والتالف خسارة؛ لا استلام مرتين (ولا تحت التزامن)؛ الربح لا يتضخم", async () => {
    const o = await delivered("P5");
    await returned(o.id);
    const first = await inspect(o.id, o.item, [{ qty: 1, disposition: "restock" }]);
    expect((await postReturnInspection({ businessId: A.businessId, inspectionId: first, actor: SYS })).status).toBe("posted");
    expect(await lines(`return-inspection:${first}`)).toEqual([["INV_GOODS", "debit", "40.0000"], ["RETURNS_PENDING", "credit", "40.0000"]]);
    expect(await orderNet(o.id, "RETURNS_PENDING")).toBe("40.0000");
    // الباقي: فحصان متزامنان لنفس القطعة المتبقية — واحد فقط يُستلم
    const x = await inspect(o.id, o.item, [{ qty: 1, disposition: "scrap" }], "2026-10-15T10:00:00Z");
    const y = await inspect(o.id, o.item, [{ qty: 1, disposition: "restock" }], "2026-10-15T11:00:00Z");
    const runs = await Promise.allSettled([x, y].map(id => postReturnInspection({ businessId: A.businessId, inspectionId: id, actor: SYS })));
    expect(runs.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(runs.find(r => r.status === "rejected")?.reason?.message).toMatch(/لا استلام مرتين/);
    expect(await orderNet(o.id, "RETURNS_PENDING")).toBe("0.0000");
    expect((await postReturnInspection({ businessId: A.businessId, inspectionId: first, actor: SYS })).status).toBe("replay");
    // الربح: إيراد 0 وتكلفة 0؛ الخسارة فقط إن كانت القطعة الثانية تالفة، والمخزون رجع بقيمة السليم فقط
    const scrapWon = runs[0].status === "fulfilled";
    expect([await orderNet(o.id, "REVENUE"), await orderNet(o.id, "COGS"), await orderNet(o.id, "RETURN_LOSS"), await orderNet(o.id, "INV_GOODS")])
      .toEqual(["0.0000", "0.0000", scrapWon ? "40.0000" : "0.0000", scrapWon ? "-40.0000" : "0.0000"]); // INV: −80 عند البيع ثم +40 أو +80
  });

  it("الربح حسب المنتج متسق مع قائمة الدخل: المرتجع قبل التسوية وبعدها لا يُحسب ربحًا للمنتج", async () => {
    const kept = await delivered("P7"); // أوردر مُسلَّم لم يرتد — الوحيد الذي يُحسب
    const p = await profitByProduct({ tenantId: A.tenantId, from: "2026-10-01", to: "2026-10-31", scope: null });
    expect(p.products.map((x: any) => [x.quantity, x.revenue, x.cogs])).toEqual([[2, "450.0000", "80.0000"]]);
    const s = await incomeStatement({ tenantId: A.tenantId, from: "2026-10-01", to: "2026-10-31", scope: null });
    expect(s.revenue.lines.find((l: any) => l.code === "REVENUE")?.amount).toBe("450.0000"); // نفس المصدر: كل المرتجعات صافيها صفر
    expect(kept.id).toBeGreaterThan(0);
  });

  it("الصلاحيات والعزل: المحاسب (ولو يرحّل) لا يرى ولا يرد؛ الشركة B لا تلمس أوردرات A", async () => {
    const o = await delivered("P6");
    await settle("RT-ST-6", "P6"); await returned(o.id);
    const acc = await call(e.accA);
    expect(await code(() => acc.refunds.list())).toBe("FORBIDDEN");
    expect(await code(() => acc.refunds.pay({ orderId: o.id, accountCode: "OFFICE_CASH", amount: "500", date: "2026-10-16", operationId: "ui:p6-acc-001" }))).toBe("FORBIDDEN");
    const ob = await call(e.ownerB);
    expect(await code(() => ob.refunds.pay({ orderId: o.id, accountCode: "OFFICE_CASH", amount: "500", date: "2026-10-16", operationId: "ui:p6-ob-0001" }))).not.toBe("ok");
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ? AND idempotencyKey LIKE ?", [A.tenantId, `order:${o.id}:refund%`]))[0].n)).toBe(0);
  });
});
