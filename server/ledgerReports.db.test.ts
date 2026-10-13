import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { confirmPhrase } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { activateLedgerV3, postLedgerTransaction } from "./ledgerV3.service";
import { ensureDailyAccounts } from "./ledgerDaily.service";
import { postOrderDelivered, postOrderReturned } from "./ledgerOrders.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * المرحلة 7 — التقارير من V3 فقط على قاعدة حقيقية: قائمة الدخل (إيراد منتج/شحن، تكلفة، مجمل، مصروفات بالتصنيف، صافي) مع
 * صافي المرتجع، الربح حسب النشاط والمنتج (بلا توزيع مخمّن)، ما لنا وما علينا (النقدية منفصلة عن الذمم)، قائمة فحص الإقفال،
 * وصلاحية reports.view_profit (رفض لا أصفار)، ونطاق المحاسب، وعزل الشركات.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const W = { type: "webhook" } as const;
const RANGE = { from: "2026-10-01", to: "2026-10-31" };

describe.runIf(CAN)("📈 المرحلة 7 — التقارير والإقفال", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  const acc: Record<string, number> = {};
  let A2 = 0, seq = 0, P1 = 0, P2 = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const order = async (biz: number, total: string, fees: string, items: { p: number | null; qty: number; price: string | null; cost: string }[], status = "delivered") => {
    const id = insId(await q(`INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, totalAmount, shippingFees, status, source, bostaShipmentId)
      VALUES (?, ?, 'عميل', '01000000000', 'عنوان', 'القاهرة', 'أسورة', ?, ?, ?, 'manual', ?)`, [biz, `RP-${tmp.name.slice(-6)}-${++seq}`, total, fees, status, `S-${tmp.name.slice(-6)}-${seq}`]));
    for (const it of items) await q("INSERT INTO order_items (orderId, productId, productName, quantity, unitPrice, unitCostSnapshot, stockOutQuantity) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, it.p, it.p === P2 ? "سلسلة" : "أسورة", it.qty, it.price, it.cost, it.qty]);
    return id;
  };
  const expense = (biz: number | null, code: string, amount: string) => postLedgerTransaction({ tenantId: A.tenantId, sourceBusinessId: biz, kind: "expense", idempotencyKey: `rp-exp-${++seq}-xx`, effectiveDate: "2026-10-05", currency: "EGP",
    actor: { type: "employee", employeeId: e.ownerA }, description: code, sourceType: null, sourceReference: null,
    entries: [{ accountId: acc[code], side: "debit", amount, businessId: biz }, { accountId: acc.OFFICE_CASH, side: "credit", amount, businessId: biz }] } as any);

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_rp");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("rp-a"); B = await createCoreTestFixture("rp-b");
    A2 = insId(await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'براند السلاسل', ?)", [A.tenantId, `rp2-${tmp.name}`.slice(0, 50)]));
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-rp`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("amA", "accounts_manager", A); await mk("accA", "accountant", A); await mk("ownerB", "super_admin", B);
    P1 = insId(await q("INSERT INTO products (name, businessId) VALUES ('أسورة', ?)", [A.businessId]));
    P2 = insId(await q("INSERT INTO products (name, businessId) VALUES ('سلسلة', ?)", [A.businessId]));
    const r = await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: "2026-10-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "5000" }, businessIds: [A.businessId, A2], safeGrants: { OFFICE_CASH: [A.businessId, A2], BANK_MAIN: [A.businessId, A2], COD_BOSTA: [A.businessId, A2] } } as any);
    Object.assign(acc, r.accounts);
    await ensureDailyAccounts({ tenantId: A.tenantId, businessIds: [A.businessId, A2], actor: { type: "employee", employeeId: e.ownerA } });
    for (const row of await q("SELECT id, code FROM ledger_accounts WHERE tenantId = ?", [A.tenantId])) acc[row.code] = row.id;
    for (const biz of [A.businessId, A2]) await postLedgerTransaction({ tenantId: A.tenantId, sourceBusinessId: biz, kind: "inventory_purchase", idempotencyKey: `rp-buy-${biz}-xx`, effectiveDate: "2026-10-02", currency: "EGP",
      actor: { type: "employee", employeeId: e.ownerA }, description: "شراء", sourceType: null, sourceReference: null,
      entries: [{ accountId: acc.INV_GOODS, side: "debit", amount: "1000", businessId: biz }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1000", businessId: biz }] } as any);
    const at = new Date("2026-10-10T10:00:00Z");
    // A1: أوردر بند واحد (تكلفة 100)، وأوردر بندين مسعّرين (تكلفة 60+40)؛ A2: أوردر بندين بلا أسعار (غير قابل للتوزيع)
    const o1 = await order(A.businessId, "550", "50", [{ p: P1, qty: 1, price: "500", cost: "100" }]);
    const o2 = await order(A.businessId, "300", "0", [{ p: P1, qty: 1, price: "200", cost: "60" }, { p: P2, qty: 1, price: "100", cost: "40" }]);
    const o3 = await order(A2, "400", "0", [{ p: P1, qty: 1, price: null, cost: "50" }, { p: P2, qty: 1, price: null, cost: "30" }]);
    // مرتجع بعد التسليم: يُصافي الإيراد والتكلفة ويظهر كخسارة مرتجع
    const o4 = await order(A.businessId, "200", "0", [{ p: P2, qty: 1, price: "200", cost: "70" }]);
    for (const [id, biz, cod] of [[o1, A.businessId, 550], [o2, A.businessId, 300], [o3, A2, 400], [o4, A.businessId, 200]] as const) await postOrderDelivered({ businessId: biz, orderId: id, cod, occurredAt: at, actor: W });
    await q("UPDATE orders SET status = 'returned' WHERE id = ?", [o4]);
    await postOrderReturned({ businessId: A.businessId, orderId: o4, occurredAt: new Date("2026-10-12T10:00:00Z"), actor: W });
    await expense(A.businessId, "EXP_RENT", "120"); await expense(A2, "EXP_ADS", "80");
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("قائمة الدخل (المالك): إيراد المنتج والشحن، التكلفة، مجمل الربح، المصروفات بالتصنيف وخسارة المرتجع، والصافي", async () => {
    const s = await (await call(e.ownerA)).reports.incomeStatement(RANGE);
    // الإيراد: 500 + 300 + 400 (+200 − 200 بالعكس) ؛ الشحن 50
    expect(s.revenue.total).toBe("1250.0000");
    expect(s.revenue.lines.map((l: any) => [l.code, l.amount]).sort()).toEqual([["REVENUE", "1200.0000"], ["REV_SHIPPING", "50.0000"]]);
    expect(s.cogs).toBe("280.0000"); // 100 + 100 + 80 (+70 − 70 نُقلت لـ«مرتجعات قيد الفحص» — أصل لا مصروف قبل الفحص)
    expect(s.grossProfit).toBe("970.0000");
    expect(s.expenses.lines.map((l: any) => [l.code, l.amount])).toEqual([["EXP_ADS", "80.0000"], ["EXP_RENT", "120.0000"]]); // لا خسارة مرتجع قبل الفحص
    expect(s.netProfit).toBe("770.0000");
    // فلتر النشاط
    expect((await (await call(e.ownerA)).reports.incomeStatement({ ...RANGE, businessId: A2 })).netProfit).toBe("240.0000"); // 400 − 80 − 80
  });

  it("الربح حسب النشاط وحسب المنتج: بلا توزيع مخمّن (أوردر متعدد البنود بلا أسعار = غير قابل للتوزيع)", async () => {
    const owner = await call(e.ownerA);
    const byBiz = await owner.reports.profitByBusiness(RANGE);
    expect(byBiz.map((b: any) => [b.businessId, b.netProfit])).toEqual([[A.businessId, "530.0000"], [A2, "240.0000"]]);
    const byProd = await owner.reports.profitByProduct(RANGE);
    // o1: أسورة 500/100؛ o2: أسورة 200/60 + سلسلة 100/40؛ o4 معكوس = مستبعد؛ o3 غير قابل للتوزيع
    expect(byProd.products.map((p: any) => [p.productId, p.quantity, p.revenue, p.cogs])).toEqual([[P1, 2, "700.0000", "160.0000"], [P2, 1, "100.0000", "40.0000"]]);
    expect(byProd.unallocated).toEqual({ orders: 1, revenue: "400.0000", cogs: "80.0000" });
  });

  it("صلاحية الأرباح: المحاسب ومدير الحسابات بلا reports.view_profit = FORBIDDEN (لا أصفار)؛ بالمنح الصريح يُسمح", async () => {
    for (const id of [e.accA, e.amA]) {
      const l = await call(id);
      for (const fn of [() => l.reports.incomeStatement(RANGE), () => l.reports.profitByBusiness(RANGE), () => l.reports.profitByProduct(RANGE)]) expect(await code(fn)).toBe("FORBIDDEN");
    }
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accountant', 'reports.view_profit', 1, ?)", [A.tenantId, e.ownerA]);
    try {
      // المحاسب بنطاقه: ربح نشاطه فقط (لا أرقام النشاط الثاني ولا المختلط)
      const s = await (await call(e.accA)).reports.incomeStatement(RANGE);
      expect(s.netProfit).toBe("530.0000");
      expect(JSON.stringify(s)).not.toMatch(/"400\.0000"|"80\.0000"/);
    } finally { await q("DELETE FROM tenant_role_permissions WHERE tenantId = ? AND role = 'accountant' AND permission = 'reports.view_profit'", [A.tenantId]); }
  });

  it("ما لنا وما علينا: النقدية منفصلة عن ذمة COD؛ المحاسب يرى الخزنة المشتركة محجوبة والإجمالي null", async () => {
    const p = await (await call(e.ownerA)).reports.position();
    expect(p.cash.total).toBe("2800.0000"); // 5000 افتتاحي − 2000 شراء − 120 − 80؛ التسليمات ذمة COD لا نقدية
    expect(p.receivables.rows.find((r: any) => r.code === "COD_BOSTA")?.balance).toBe("1250.0000");
    const a = await (await call(e.accA)).reports.position();
    expect(a.cash.total).toBeNull();
    expect(a.cash.rows.find((r: any) => r.code === "OFFICE_CASH")?.balance).toBeNull();
  });

  it("قائمة فحص الإقفال: ترتيب الشهور، تسليم بلا قيد من صندوق الوارد، مراجعة دفتر مفتوحة، والمطابقة؛ للمالك ومدير الحسابات فقط", async () => {
    // تسليم وصل من بوسطة (45) لأوردر بلا قيد في الدفتر
    const lost = await order(A.businessId, "100", "0", [{ p: P1, qty: 1, price: "100", cost: "10" }]);
    const sid = (await q("SELECT bostaShipmentId s FROM orders WHERE id = ?", [lost]))[0].s;
    await q("INSERT INTO carrier_webhook_inbox (tenantId, businessId, provider, shipmentId, eventKey, stateCode, eventTimestamp, processingStatus, payloadJson) VALUES (?, ?, 'bosta', ?, ?, 45, ?, 'processed', '{}')",
      [A.tenantId, A.businessId, sid, `rp-${tmp.name}`.slice(0, 64), Date.parse("2026-10-20T10:00:00Z")]);
    await q("UPDATE orders SET needsReview = 1, reviewReason = 'دفتر: اختبار' WHERE id = ?", [lost]);
    const c = await (await call(e.amA)).period.checklist({ period: "2026-10" });
    expect(c.ready).toBe(false);
    expect(Object.fromEntries(c.checks.map((x: any) => [x.key, x.ok]))).toEqual({ previous_locked: true, deliveries_posted: false, ledger_reviews: false, legacy_writes: true, managed_accounts: true, reconciliation: true });
    expect(c.checks.find((x: any) => x.key === "deliveries_posted").label).toMatch(/^1 أوردر/);
    // نوفمبر: أكتوبر غير مقفل بعد → ترتيب الشهور غير سليم
    expect((await (await call(e.ownerA)).period.checklist({ period: "2026-11" })).checks.find((x: any) => x.key === "previous_locked").ok).toBe(false);
    expect(await code(async () => (await call(e.accA)).period.checklist({ period: "2026-10" }))).toBe("FORBIDDEN");
  });

  it("عزل الشركات: الشركة B لا ترى أي رقم من A في قائمة الدخل والمركز", async () => {
    const b = await call(e.ownerB);
    expect(await code(() => b.reports.incomeStatement(RANGE))).toBe("PRECONDITION_FAILED"); // دفتر B غير مفعّل = غير متاح لا أصفار
    expect(await code(() => b.reports.position())).toBe("PRECONDITION_FAILED");
    expect(await code(() => b.reports.daily({ date: "2026-10-10" }))).toBe("PRECONDITION_FAILED");
    expect(await code(() => b.reports.incomeStatement({ ...RANGE, businessId: A.businessId }))).toBe("FORBIDDEN");
  });
});
