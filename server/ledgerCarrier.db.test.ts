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
import { parseSettlementCsv } from "../shared/carrierSettlement";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * المرحلة 3 — تسوية كشف بوسطة على قاعدة حقيقية: كل شحنة مرة واحدة بمفتاح دائم (كشف آخر = «مسوّاة من قبل»، نفس الكشف =
 * replay، تزامن = قيد واحد)، الرسوم منفصلة، سطر رسوم المرتجع، المراجعة الواضحة بلا قيد (بلا أوردر/أكثر من أوردر/بلا تسليم/
 * مبلغ مختلف)، والتحويل الفعلي بمبلغ = صافي الكشف فقط؛ نطاق الشركة فقط، وعزل الشركات.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const W = { type: "webhook" } as const;

describe("🧾 صيغة كشف التسوية", () => {
  it("العناوين، المعادلة، المكرر، والسالب — أخطاء بالأسطر؛ والصحيح فقط يُمرَّر", () => {
    expect(parseSettlementCsv("a,b\n1,2").errors[0].reason).toMatch(/العناوين/);
    const p = parseSettlementCsv("shipment,cod,fees,net\nS1,750,50,700\nS2,300,20,200\nS1,10,0,10\nS3,0,40,-40\nS4,-5,0,-5\nS5,1,000,0,1");
    expect(p.lines.map(l => l.shipment)).toEqual(["S1", "S3"]);
    expect(p.errors.map(e => e.row)).toEqual([3, 4, 6, 7]);
    expect(p.errors.find(e => e.row === 3)?.reason).toMatch(/غير متسقة/);
  });
});

describe.runIf(CAN)("🚛 تسوية بوسطة والتحويل", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  const acc: Record<string, number> = {};
  let seq = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const tag = () => tmp.name.slice(-5);
  const order = async (biz: number, shipment: string, total: string, status = "delivered") => {
    const id = insId(await q(`INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, totalAmount, shippingFees, status, source, bostaShipmentId)
      VALUES (?, ?, 'عميل', '01000000000', 'عنوان', 'القاهرة', 'أسورة', ?, '0', ?, 'manual', ?)`, [biz, `CS-${tag()}-${++seq}`, total, status, shipment]));
    await q("INSERT INTO order_items (orderId, productName, quantity, unitCostSnapshot, stockOutQuantity) VALUES (?, 'أسورة', 1, '10.0000', 1)", [id]);
    return id;
  };
  const sh = (s: string) => `${s}-${tag()}`;
  const csv = (rows: string[]) => ["shipment,cod,fees,net", ...rows].join("\n");
  const bal = async (code: string) => (await q("SELECT currentBalance b FROM ledger_accounts WHERE tenantId = ? AND code = ?", [A.tenantId, code]))[0].b;

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_cs");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("cs-a"); B = await createCoreTestFixture("cs-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-cs`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("amA", "accounts_manager", A); await mk("accA", "accountant", A); await mk("ownerB", "super_admin", B);
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accountant', 'ledger.post', 1, ?)", [A.tenantId, e.ownerA]);
    const r = await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: "2026-10-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "100" }, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId] } } as any);
    Object.assign(acc, r.accounts);
    await ensureDailyAccounts({ tenantId: A.tenantId, businessIds: [A.businessId], actor: { type: "employee", employeeId: e.ownerA } });
    for (const row of await q("SELECT id, code FROM ledger_accounts WHERE tenantId = ?", [A.tenantId])) acc[row.code] = row.id;
    await postLedgerTransaction({ tenantId: A.tenantId, sourceBusinessId: A.businessId, kind: "inventory_purchase", idempotencyKey: "cs-buy-xx", effectiveDate: "2026-10-02", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      description: "شراء", sourceType: null, sourceReference: null, entries: [{ accountId: acc.INV_GOODS, side: "debit", amount: "90", businessId: A.businessId }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "90", businessId: A.businessId }] } as any);
    const at = new Date("2026-10-10T10:00:00Z");
    for (const [s, total] of [["S1", "750"], ["S2", "300"], ["S5", "200"]] as const) { const id = await order(A.businessId, sh(s), total); await postOrderDelivered({ businessId: A.businessId, orderId: id, cod: Number(total), occurredAt: at, actor: W }); }
    await order(A.businessId, sh("S3"), "180", "returned"); // مرتجع قبل التسليم — سطر رسوم فقط
    await order(A.businessId, sh("S9"), "100"); await order(A.businessId, sh("S9"), "100"); // نفس الشحنة لأوردرين
    const s4 = await order(A.businessId, sh("S4"), "120"); await postOrderDelivered({ businessId: A.businessId, orderId: s4, cod: 120, occurredAt: at, actor: W });
    await q("UPDATE orders SET status = 'returned' WHERE id = ?", [s4]); await postOrderReturned({ businessId: A.businessId, orderId: s4, occurredAt: at, actor: W }); // مرتجع بعد التسليم وقبل التسوية — قيد التسليم معكوس
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("الكشف: تحصيل + رسوم منفصلة + سطر رسوم مرتجع؛ والمراجعة بلا قيد لكل حالة غامضة؛ صافي متوقع صحيح", async () => {
    const am = await call(e.amA);
    const r = await am.carrier.settle({ statementRef: "ST-1", statementDate: "2026-10-15", csv: csv([
      `${sh("S1")},750,50,700`, `${sh("S2")},300,20,280`, `${sh("S3")},0,40,-40`, `${sh("S9")},100,5,95`, `UNKNOWN-${tag()},50,5,45`, `${sh("S4")},120,10,110`, `${sh("S5")},999,9,990`, `${sh("S2")},1,1,1`,
    ]) });
    const by = Object.fromEntries(r.outcomes.map((o: any) => [o.shipment, o]));
    expect([by[sh("S1")].status, by[sh("S2")].status, by[sh("S3")].status]).toEqual(["posted", "posted", "posted"]);
    expect(by[sh("S9")].reason).toMatch(/أكثر من أوردر/);
    expect(by[`UNKNOWN-${tag()}`].reason).toMatch(/لا أوردر مطابق/);
    // S4 رجع بعد التسليم وقبل التسوية ثم ظهر تحصيله في الكشف ⇒ التحصيل التزام رد للعميل، لا ذمة بوسطة ولا إيراد
    expect(by[sh("S4")].status).toBe("posted");
    const s4l = (await q("SELECT a.code, e.side, e.amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.accountId WHERE e.transactionId = ? ORDER BY e.id", [by[sh("S4")].transactionId])).map((x: any) => [x.code, x.side, x.amount]);
    expect(s4l).toEqual([["REFUND_PAYABLE", "credit", "120.0000"], ["EXP_CARRIER_FEES", "debit", "10.0000"], ["COD_PAYOUT", "debit", "110.0000"]]);
    expect(by[sh("S5")].reason).toMatch(/≠ المسجّل عند التسليم/);
    expect(r.parseErrors.map((x: any) => x.row)).toEqual([9]); // S2 مكرر في نفس الكشف
    expect(r.expectedPayout).toBe("1050.0000"); // 700 + 280 − 40 + 110
    const s1 = (await q("SELECT a.code, e.side, e.amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.accountId WHERE e.transactionId = ? ORDER BY e.id", [by[sh("S1")].transactionId])).map((x: any) => [x.code, x.side, x.amount]);
    expect(s1).toEqual([["COD_BOSTA", "credit", "750.0000"], ["EXP_CARRIER_FEES", "debit", "50.0000"], ["COD_PAYOUT", "debit", "700.0000"]]);
    expect(await bal("COD_PAYOUT")).toBe("1050.0000");
    expect(await bal("COD_BOSTA")).toBe("200.0000"); // S1+S2 سُوّيا؛ S5 (مبلغ مخالف) باقٍ للمراجعة؛ S4 لم يعد ذمة بعد عكس التسليم
  });

  it("لا تسوية مرتين: نفس الكشف = replay؛ كشف آخر بنفس الشحنة = «مسوّاة من قبل في ST-1»؛ والتزامن = قيد واحد", async () => {
    const am = await call(e.amA);
    const before = (await q("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ?", [A.tenantId]))[0].n;
    const again = await am.carrier.settle({ statementRef: "ST-1", statementDate: "2026-10-15", csv: csv([`${sh("S1")},750,50,700`]) });
    expect(again.outcomes[0].status).toBe("replay");
    const other = await am.carrier.settle({ statementRef: "ST-2", statementDate: "2026-10-16", csv: csv([`${sh("S1")},750,50,700`]) });
    expect(other.outcomes[0]).toMatchObject({ status: "already_settled", reason: expect.stringMatching(/ST-1/) });
    expect((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE tenantId = ?", [A.tenantId]))[0].n).toBe(before);
    // تزامن على شحنة جديدة
    const id = await order(A.businessId, sh("S6"), "400"); await postOrderDelivered({ businessId: A.businessId, orderId: id, cod: 400, occurredAt: new Date("2026-10-11T10:00:00Z"), actor: W });
    const runs = await Promise.all([1, 2, 3].map(() => am.carrier.settle({ statementRef: "ST-3", statementDate: "2026-10-17", csv: csv([`${sh("S6")},400,10,390`]) })));
    expect(runs.map(x => x.outcomes[0].status).sort()).toEqual(["posted", "replay", "replay"]);
    expect((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE idempotencyKey = ?", [`bosta-settle:${sh("S6")}:cod`]))[0].n).toBe(1);
  });

  it("التحويل: مبلغ ≠ صافي الكشف مرفوض؛ الصحيح لبنك مرة واحدة ويُصفّر «قيد الصرف» للكشف", async () => {
    const am = await call(e.amA);
    expect(await code(() => am.carrier.payout({ statementRef: "ST-1", receivedOn: "2026-10-20", amount: "900", accountCode: "BANK_MAIN" }))).toBe("CONFLICT");
    expect(await code(() => am.carrier.payout({ statementRef: "ST-1", receivedOn: "2026-10-20", amount: "1050", accountCode: "EXP_ADS" }))).toBe("NOT_FOUND");
    const p = await am.carrier.payout({ statementRef: "ST-1", receivedOn: "2026-10-20", amount: "1050", accountCode: "BANK_MAIN" });
    expect(p.replay).toBe(false);
    expect((await am.carrier.payout({ statementRef: "ST-1", receivedOn: "2026-10-20", amount: "1050", accountCode: "BANK_MAIN" })).replay).toBe(true);
    expect(await bal("BANK_MAIN")).toBe("1050.0000");
    expect((await am.carrier.status({ statementRef: "ST-1" })).payoutTransactionId).toBe(p.transactionId);
  });

  it("النطاق: المحاسب (ولو يرحّل) مرفوض؛ الشركة B لا ترى كشف A؛ ما قبل Go-live مرفوض", async () => {
    const acc1 = await call(e.accA);
    expect(await code(() => acc1.carrier.settle({ statementRef: "ST-9", statementDate: "2026-10-15", csv: csv([`${sh("S2")},300,20,280`]) }))).toBe("FORBIDDEN");
    expect(await code(() => acc1.carrier.status({ statementRef: "ST-1" }))).toBe("FORBIDDEN");
    expect(await code(async () => (await call(e.ownerB)).carrier.settle({ statementRef: "ST-1", statementDate: "2026-10-15", csv: csv([`${sh("S1")},750,50,700`]) }))).toBe("PRECONDITION_FAILED");
    expect(await code(async () => (await call(e.ownerA)).carrier.settle({ statementRef: "ST-0", statementDate: "2026-09-20", csv: csv([`${sh("S2")},300,20,280`]) }))).toBe("BAD_REQUEST");
  });
});
