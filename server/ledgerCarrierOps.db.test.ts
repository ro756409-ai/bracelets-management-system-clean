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
import { postOrderDelivered } from "./ledgerOrders.service";
import { businessDateKey } from "../shared/businessTime";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * المرحلة 3 بعد 0047 على قاعدة حقيقية مؤقتة: قبل 0047 = سلوك سابق بلا خطأ؛ ربط أوردر↔شحنة موحّد (شحنة لأوردر واحد حتى تحت
 * التزامن، والتسوية عبر الربط)؛ طابور مراجعة دائم (بلا تكرار، حل بسبب وفاعل مرة واحدة، إغلاق تلقائي عند النجاح لاحقًا)؛
 * إعدادات مُدخلة (صلاحيات، تحقق، نطاق نشاط، حذف = غير مُدخل)؛ رسوم الكشف مقابل الإعداد = تنبيه والقيد بالفعلي؛ موعد التحويل
 * والتأخر من أيام الصرف؛ وعزل الشركات.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const W = { type: "webhook" } as const;
const AT = new Date("2026-10-03T10:00:00Z");

describe.runIf(CAN)("🚚 بعد 0047 — الربط، طابور المراجعة، الإعدادات", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  let seq = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const tag = () => tmp.name.slice(-5);
  const sh = (s: string) => `${s}-${tag()}`;
  const order = async (shipment: string, total = "300", status = "delivered") => {
    const id = insId(await q(`INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, totalAmount, shippingFees, status, source, bostaShipmentId)
      VALUES (?, ?, 'عميل', '01000000000', 'عنوان', 'القاهرة', 'أسورة', ?, '0', ?, 'manual', ?)`, [A.businessId, `CO-${tag()}-${++seq}`, total, status, sh(shipment)]));
    await q("INSERT INTO order_items (orderId, productName, quantity, unitCostSnapshot, stockOutQuantity) VALUES (?, 'أسورة', 1, '10.0000', 1)", [id]);
    return id;
  };
  const csv = (rows: string[]) => ["shipment,cod,fees,net", ...rows].join("\n");
  const openItems = async (like = "%") => (await q("SELECT referenceKey k, source s, status, reason FROM ledger_carrier_review_items WHERE tenantId = ? AND referenceKey LIKE ? ORDER BY id", [A.tenantId, like]));
  const revenueCount = async (orderId: number) => Number((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE idempotencyKey = ?", [`order:${orderId}:delivered`]))[0].n);

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_cops");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("co-a"); B = await createCoreTestFixture("co-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-co`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("amA", "accounts_manager", A); await mk("accA", "accountant", A); await mk("ownerB", "super_admin", B);
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accountant', 'ledger.post', 1, ?)", [A.tenantId, e.ownerA]);
    await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: "2026-10-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "100" }, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId] } } as any);
    await ensureDailyAccounts({ tenantId: A.tenantId, businessIds: [A.businessId], actor: { type: "employee", employeeId: e.ownerA } });
    const accs = Object.fromEntries((await q("SELECT id, code FROM ledger_accounts WHERE tenantId = ?", [A.tenantId])).map((r: any) => [r.code, r.id]));
    await postLedgerTransaction({ tenantId: A.tenantId, sourceBusinessId: A.businessId, kind: "inventory_purchase", idempotencyKey: "co-buy-0001", effectiveDate: "2026-10-02", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      description: "شراء", sourceType: null, sourceReference: null, entries: [{ accountId: accs.INV_GOODS, side: "debit", amount: "90", businessId: A.businessId }, { accountId: accs.OFFICE_CASH, side: "credit", amount: "90", businessId: A.businessId }] } as any);
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("قبل 0047: الإعدادات والطابور «غير متاحة» بلا خطأ، والتسليم يعمل بلا ربط كما قبل", async () => {
    const am = await call(e.amA);
    expect((await am.settings.list()).available).toBe(false);
    expect((await am.carrier.reviews.list()).available).toBe(false);
    expect(await code(() => am.settings.set({ key: "carrier.bosta.fee_per_shipment", scopeBusinessId: 0, value: "40" }))).toBe("PRECONDITION_FAILED");
    const id = await order("PRE");
    expect((await postOrderDelivered({ businessId: A.businessId, orderId: id, cod: 300, occurredAt: AT, actor: W })).status).toBe("posted");
    // تطبيق 0047 على القاعدة المؤقتة نفسها (نفس أداة الـMigration الرسمية)
    const r = await runHandMigration(LEDGER_CARRIER_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync("drizzle/0047_ledger_carrier.sql", "utf-8"), deployEnv: "test", confirm: confirmPhrase("0047", "apply", tmp.name) } as any);
    expect(r.ok).toBe(true);
    expect((await am.settings.list()).available).toBe(true);
  });

  it("الربط: الشحنة لأوردر واحد — أوردر ثانٍ بنفس الشحنة = مراجعة دائمة بلا إيراد؛ وتحت التزامن قيد إيراد واحد فقط", async () => {
    const first = await order("L1"), second = await order("L1");
    expect((await postOrderDelivered({ businessId: A.businessId, orderId: first, cod: 300, occurredAt: AT, actor: W })).status).toBe("posted");
    const r2 = await postOrderDelivered({ businessId: A.businessId, orderId: second, cod: 300, occurredAt: AT, actor: W });
    expect(r2).toMatchObject({ status: "review", reason: expect.stringMatching(/مربوطة بأوردر آخر/) });
    expect(await revenueCount(second)).toBe(0);
    expect(await openItems(`order:${second}`)).toEqual([expect.objectContaining({ s: "delivery", status: "open", reason: expect.stringMatching(/مربوطة بأوردر آخر/) })]);
    // إعادة نفس الحدث: نفس العنصر (لا تكرار)
    await postOrderDelivered({ businessId: A.businessId, orderId: second, cod: 300, occurredAt: AT, actor: W });
    expect(await openItems(`order:${second}`)).toHaveLength(1);
    // تزامن: أوردران مختلفان بنفس شحنة جديدة
    const x = await order("L2"), y = await order("L2");
    const runs = await Promise.all([x, y, x, y].map(id => postOrderDelivered({ businessId: A.businessId, orderId: id, cod: 300, occurredAt: AT, actor: W })));
    expect((await revenueCount(x)) + (await revenueCount(y))).toBe(1);
    expect(runs.some(r => r.status === "review")).toBe(true);
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_shipments WHERE tenantId = ? AND shipmentId = ?", [A.tenantId, sh("L2")]))[0].n)).toBe(1);
  });

  it("التسوية عبر الربط: شحنة يشاركها أوردر آخر غير مُسلَّم تُسوّى لأوردرها المربوط (كانت «أكثر من أوردر»)", async () => {
    const am = await call(e.amA);
    const s = await am.carrier.settle({ statementRef: "CO-ST-1", statementDate: "2026-10-05", csv: csv([`${sh("L1")},300,0,300`]) });
    expect(s.outcomes[0].status).toBe("posted");
  });

  it("الطابور: سطر غامض = عنصر واحد حتى مع إعادة الكشف؛ الحل بسبب مرة واحدة؛ الإغلاق التلقائي عند تسوية صحيحة لاحقًا؛ المحاسب ممنوع", async () => {
    const am = await call(e.amA);
    const id = await order("Q1", "500");
    await postOrderDelivered({ businessId: A.businessId, orderId: id, cod: 500, occurredAt: AT, actor: W });
    // تحصيل مختلف = مراجعة؛ إعادة الكشف = نفس العنصر
    for (let i = 0; i < 2; i++) expect((await am.carrier.settle({ statementRef: "CO-ST-2", statementDate: "2026-10-05", csv: csv([`${sh("Q1")},450,0,450`, `GHOST-${tag()},50,5,45`]) })).outcomes.map((o: any) => o.status)).toEqual(["review", "review"]);
    expect((await openItems("settle:CO-ST-2:%")).map((r: any) => [r.k, r.status])).toEqual([[`settle:CO-ST-2:${sh("Q1")}`, "open"], [`settle:CO-ST-2:GHOST-${tag()}`, "open"]]);
    // كشف تالٍ صحيح لنفس الشحنة ⇒ يُغلق عنصرها تلقائيًا باسم من سوّى
    expect((await am.carrier.settle({ statementRef: "CO-ST-3", statementDate: "2026-10-06", csv: csv([`${sh("Q1")},500,0,500`]) })).outcomes[0].status).toBe("posted");
    const [auto] = await q("SELECT status, resolvedByEmployeeId r, resolutionNote n FROM ledger_carrier_review_items WHERE referenceKey = ?", [`settle:CO-ST-2:${sh("Q1")}`]);
    expect(auto).toMatchObject({ status: "resolved", r: e.amA, n: expect.stringMatching(/CO-ST-3/) });
    // الحل اليدوي: سبب إلزامي، مرة واحدة، المحاسب ممنوع
    const ghost = (await am.carrier.reviews.list()).items.find((x: any) => x.referenceKey === `settle:CO-ST-2:GHOST-${tag()}`)!;
    expect(await code(async () => (await call(e.accA)).carrier.reviews.resolve({ id: ghost.id, status: "dismissed", note: "ليست لنا" }))).toBe("FORBIDDEN");
    expect(await code(() => am.carrier.reviews.resolve({ id: ghost.id, status: "dismissed", note: "x" }))).toBe("BAD_REQUEST");
    await am.carrier.reviews.resolve({ id: ghost.id, status: "dismissed", note: "شحنة ليست لنا — بلغنا بوسطة" });
    expect(await code(() => am.carrier.reviews.resolve({ id: ghost.id, status: "resolved", note: "مرة ثانية" }))).toBe("NOT_FOUND");
    // المستبعد يبقى مستبعدًا لو تكرر في كشف آخر بنفس المفتاح؛ المحلول يُفتح مجددًا
    await am.carrier.settle({ statementRef: "CO-ST-2", statementDate: "2026-10-05", csv: csv([`GHOST-${tag()},50,5,45`]) });
    expect((await openItems(`settle:CO-ST-2:GHOST-${tag()}`))[0].status).toBe("dismissed");
    expect((await am.carrier.reviews.list({ status: "closed" })).items.length).toBeGreaterThanOrEqual(2);
  });

  it("الإعدادات: مدير الحسابات يُدخل، المحاسب ممنوع، التحقق والنطاق، الحذف = غير مُدخل، والشركة B لا ترى إعدادات A", async () => {
    const am = await call(e.amA);
    expect(await code(async () => (await call(e.accA)).settings.set({ key: "carrier.bosta.fee_per_shipment", scopeBusinessId: 0, value: "40" }))).toBe("FORBIDDEN");
    expect(await code(() => am.settings.set({ key: "carrier.bosta.fee_per_shipment", scopeBusinessId: 0, value: "-5" }))).toBe("BAD_REQUEST");
    expect(await code(() => am.settings.set({ key: "carrier.bosta.vat_percent", scopeBusinessId: 0, value: "120" }))).toBe("BAD_REQUEST");
    expect(await code(() => am.settings.set({ key: "carrier.bosta.fee_per_shipment", scopeBusinessId: A.businessId, value: "40" }))).toBe("BAD_REQUEST"); // إعداد شركة
    expect(await code(() => am.settings.set({ key: "packaging.cost_per_order", scopeBusinessId: B.businessId, value: "3" }))).toBe("FORBIDDEN"); // نشاط شركة أخرى
    expect(await code(() => am.settings.set({ key: "unknown.key", scopeBusinessId: 0, value: "3" }))).toBe("BAD_REQUEST");
    await am.settings.set({ key: "carrier.bosta.fee_per_shipment", scopeBusinessId: 0, value: "40" });
    await am.settings.set({ key: "carrier.bosta.vat_percent", scopeBusinessId: 0, value: "14" });
    await am.settings.set({ key: "carrier.bosta.payout_weekdays", scopeBusinessId: 0, value: (1 << 1) | (1 << 3) });
    await am.settings.set({ key: "packaging.cost_per_order", scopeBusinessId: A.businessId, value: "3.5" });
    await am.settings.set({ key: "carrier.bosta.fee_per_shipment", scopeBusinessId: 0, value: "40" }); // تعديل بنفس القيمة = صف واحد
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_settings WHERE tenantId = ?", [A.tenantId]))[0].n)).toBe(4);
    const list = await am.settings.list();
    expect(list.settings.find((s: any) => s.key === "packaging.cost_per_order")!.values).toEqual([expect.objectContaining({ scopeBusinessId: A.businessId, value: "3.5000" })]);
    await am.settings.set({ key: "carrier.bosta.return_fee", scopeBusinessId: 0, value: "25" });
    await am.settings.clear({ key: "carrier.bosta.return_fee", scopeBusinessId: 0 });
    expect((await am.settings.list()).settings.find((s: any) => s.key === "carrier.bosta.return_fee")!.values).toEqual([]);
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_settings WHERE tenantId = ?", [B.tenantId]))[0].n)).toBe(0);
    // مالك B يرى إعدادات شركته فقط (فارغة) — لا قيمة من A، ولا نشاط من A في قائمة الأنشطة
    const bList = await (await call(e.ownerB)).settings.list();
    expect(bList.settings.every((s: any) => s.values.length === 0)).toBe(true);
    expect(bList.businesses.map((b: any) => b.id)).not.toContain(A.businessId);
  });

  it("رسوم الكشف مقابل الإعداد (40 + 14% = 45.60): مطابقة بلا تنبيه، ومخالفة = تنبيه في الطابور والقيد بالفعلي؛ ومرتجع بلا إعداد رسومه = لا مقارنة", async () => {
    const am = await call(e.amA);
    const ok = await order("F1", "200"), off = await order("F2", "200"), ret = await order("F3", "200", "returned");
    for (const id of [ok, off]) await postOrderDelivered({ businessId: A.businessId, orderId: id, cod: 200, occurredAt: AT, actor: W });
    const s = await am.carrier.settle({ statementRef: "CO-ST-4", statementDate: "2026-10-05", csv: csv([`${sh("F1")},200,45.60,154.40`, `${sh("F2")},200,50,150`, `${sh("F3")},0,30,-30`]) });
    const by = Object.fromEntries(s.outcomes.map((o: any) => [o.shipment, o]));
    expect([by[sh("F1")].status, by[sh("F2")].status, by[sh("F3")].status]).toEqual(["posted", "posted", "posted"]);
    expect(by[sh("F1")].feeNote).toBeUndefined();
    expect(by[sh("F2")].feeNote).toMatch(/50 ≠ المتوقعة من الإعداد 45\.6000/);
    expect(by[sh("F3")].feeNote).toBeUndefined(); // رسوم المرتجع غير مُدخلة
    expect((await openItems("settle-fees:CO-ST-4:%")).map((r: any) => r.k)).toEqual([`settle-fees:CO-ST-4:${sh("F2")}`]);
    const fee = (await q("SELECT e.amount a FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transactionId JOIN ledger_accounts a ON a.id = e.accountId WHERE t.idempotencyKey = ? AND a.code = 'EXP_CARRIER_FEES'", [`bosta-settle:${sh("F2")}:cod`]))[0].a;
    expect(fee).toBe("50.0000"); // الفعلي
    expect(ret).toBeGreaterThan(0);
  });

  it("موعد التحويل من أيام الصرف (إثنين/أربعاء)، والتأخر؛ تحويل بمبلغ خاطئ = مرفوض + عنصر طابور يُغلق تلقائيًا بالتحويل الصحيح", async () => {
    const am = await call(e.amA);
    const st = await am.carrier.status({ statementRef: "CO-ST-4" });
    expect([st.statementDate, st.expectedPayoutOn]).toEqual(["2026-10-05", "2026-10-05"]);
    const today = businessDateKey(new Date(), "Africa/Cairo");
    const row = (await am.carrier.statements()).find((x: any) => x.statementRef === "CO-ST-4")!;
    expect(row).toMatchObject({ net: "274.4000", payoutTransactionId: null, expectedPayoutOn: "2026-10-05", overdue: today > "2026-10-05" });
    expect(await code(() => am.carrier.payout({ statementRef: "CO-ST-4", receivedOn: "2026-10-07", amount: "270", accountCode: "BANK_MAIN" }))).toBe("CONFLICT");
    expect((await openItems("payout:CO-ST-4"))[0]).toMatchObject({ s: "payout", status: "open" });
    await am.carrier.payout({ statementRef: "CO-ST-4", receivedOn: "2026-10-07", amount: "274.4", accountCode: "BANK_MAIN" });
    expect((await openItems("payout:CO-ST-4"))[0].status).toBe("resolved");
    expect((await am.carrier.statements()).find((x: any) => x.statementRef === "CO-ST-4")).toMatchObject({ overdue: false, payoutTransactionId: expect.any(Number) });
  });

  it("العزل: الشركة B لا ترى طابور A ولا كشوفه", async () => {
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_carrier_review_items WHERE tenantId = ?", [B.tenantId]))[0].n)).toBe(0);
    const ob = await call(e.ownerB);
    expect((await ob.carrier.reviews.list()).items).toEqual([]);
    expect((await ob.carrier.reviews.list({ status: "closed" })).items).toEqual([]);
    expect(await ob.carrier.statements()).toEqual([]);
    // ولا يستطيع حل عنصر من A
    const aItem = (await q("SELECT id FROM ledger_carrier_review_items WHERE tenantId = ? AND status = 'open' LIMIT 1", [A.tenantId]))[0].id;
    expect(await code(() => ob.carrier.reviews.resolve({ id: aItem, status: "dismissed", note: "محاولة من شركة أخرى" }))).toBe("NOT_FOUND");
    expect((await q("SELECT status FROM ledger_carrier_review_items WHERE id = ?", [aItem]))[0].status).toBe("open");
  });
});
