import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { confirmPhrase, runHandMigration } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { runLedgerKindsMigration } from "./ledgerKindsMigration.service";
import { LEDGER_SUPPLIERS_MIGRATION } from "./ledgerPhaseMigrations";
import { activateLedgerV3 } from "./ledgerV3.service";
import { ensureDailyAccounts } from "./ledgerDaily.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * المرحلة 6 على قاعدة حقيقية مؤقتة (0040/0045 ثم 0046/0049 بأدواتها الرسمية): هوية مورد ثابتة بلا تكرار، فاتورة على مخزون
 * مربوطة بإيصال (فاتورة واحدة للإيصال وبمبلغه)، دفعة ≤ المستحق حتى تحت التزامن، دفعة مقدمة وتطبيقها، مرتجع، الإلغاء بالعكس
 * بقيوده، الأعمار، والورشة: عهدة بالكمية والقيمة، استلام جزئي بمتوسط الباقي + أجر القطعة، عجز على الورشة أو خسارة، تصليح،
 * إغلاق بالباقي الدقيق؛ وصلاحيات الشركة والعزل.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

describe.runIf(CAN)("🏭 المرحلة 6 — الموردون والورشة", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  let sup = 0, shop = 0, receipt = 0, advDoc = 0, batch = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const bal = async (c: string) => (await q("SELECT currentBalance b FROM ledger_accounts WHERE tenantId = ? AND code = ?", [A.tenantId, c]))[0]?.b;
  const am = () => call(e.amA);
  const am_ = am;
  const num = (v: string) => Number(v);
  const fmt = (v: number) => v.toFixed(4);
  const doc = (x: Record<string, unknown>) => am().then(c => c.suppliers.postDocument({ supplierId: sup, docDate: "2026-10-05", ...x } as any));

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_sup");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("su-a"); B = await createCoreTestFixture("su-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-su`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("amA", "accounts_manager", A); await mk("accA", "accountant", A); await mk("ownerB", "super_admin", B);
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'accountant', 'ledger.post', 1, ?)", [A.tenantId, e.ownerA]);
    await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: "2026-10-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-09-30T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-09-30T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "20000" }, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId] } } as any);
    await ensureDailyAccounts({ tenantId: A.tenantId, businessIds: [A.businessId], actor: { type: "employee", employeeId: e.ownerA } });
    const wh = insId(await q("INSERT INTO warehouses (businessId, name) VALUES (?, 'المكتب')", [A.businessId]));
    receipt = insId(await q("INSERT INTO purchase_receipts (businessId, warehouseId, receiptType, supplierName, receiptDate, totalAmount, status, createdBy) VALUES (?, ?, 'purchase', 'مورد نحاس', ?, '5000.0000', 'approved', ?)", [A.businessId, wh, new Date("2026-10-04T10:00:00Z"), e.ownerA]));
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("قبل 0046/0049: «غير متاح»؛ بعدهما تجهيز الحسابات ومورد بهوية ثابتة بلا تكرار", async () => {
    expect(await (await am()).suppliers.list()).toMatchObject({ available: false });
    expect((await runLedgerKindsMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0046", "apply", tmp.name) })).ok).toBe(true);
    expect((await runHandMigration(LEDGER_SUPPLIERS_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync("drizzle/0049_ledger_suppliers.sql", "utf-8"), deployEnv: "test", confirm: confirmPhrase("0049", "apply", tmp.name) } as any)).ok).toBe(true);
    const c = await am();
    expect((await c.suppliers.ensureAccounts()).created.sort()).toEqual(["EXP_REPAIRS", "EXP_WORKSHOP_SHORTAGE", "SUPPLIER_ADVANCES", "SUPPLIER_PAYABLE", "WORKSHOP_CUSTODY"]);
    sup = (await c.suppliers.create({ code: "cu-01", name: "مورد نحاس", isWorkshop: false })).supplierId;
    expect((await c.suppliers.create({ code: "CU-01", name: "مورد نحاس", isWorkshop: false })).replay).toBe(true);
    expect(await code(() => c.suppliers.create({ code: "CU-02", name: "مورد نحاس", isWorkshop: false }))).toBe("CONFLICT"); // نفس الاسم
    shop = (await c.suppliers.create({ code: "WS-01", name: "ورشة الأسطى", isWorkshop: true })).supplierId;
    expect(await code(async () => (await call(e.accA)).suppliers.create({ code: "X-01", name: "س", isWorkshop: false }))).toBe("FORBIDDEN");
  });

  it("فاتورة مربوطة بإيصال: مبلغ الإيصال نفسه، فاتورة واحدة للإيصال؛ على مخزون لا على حساب آلي", async () => {
    expect(await code(() => doc({ docType: "invoice", docNo: "INV-1", amount: "4999", businessId: A.businessId, purchaseReceiptId: receipt, itemAccountCode: "INV_RAW", dueDate: "2026-10-20" }))).toBe("CONFLICT");
    expect(await code(() => doc({ docType: "invoice", docNo: "INV-1", amount: "5000", businessId: A.businessId, itemAccountCode: "RETURNS_PENDING" }))).toBe("NOT_FOUND");
    const r = await doc({ docType: "invoice", docNo: "INV-1", amount: "5000", businessId: A.businessId, purchaseReceiptId: receipt, itemAccountCode: "INV_RAW", dueDate: "2026-10-20" });
    expect(r.replay).toBe(false);
    expect((await doc({ docType: "invoice", docNo: "INV-1", amount: "5000", businessId: A.businessId, purchaseReceiptId: receipt, itemAccountCode: "INV_RAW", dueDate: "2026-10-20" })).replay).toBe(true);
    expect(await code(() => doc({ docType: "invoice", docNo: "INV-2", amount: "5000", businessId: A.businessId, purchaseReceiptId: receipt, itemAccountCode: "INV_RAW" }))).toBe("CONFLICT"); // فاتورتان لإيصال
    expect(await code(() => doc({ docType: "invoice", docNo: "INV-1", amount: "5100", businessId: A.businessId, itemAccountCode: "INV_RAW" }))).toBe("CONFLICT"); // نفس الرقم ببيانات أخرى
    expect([await bal("INV_RAW"), await bal("SUPPLIER_PAYABLE")]).toEqual(["5000.0000", "5000.0000"]);
  });

  it("الدفعات: لا تتجاوز المستحق حتى تحت التزامن؛ المقدّم أصل يُطبَّق حتى المتبقي منه والمستحق", async () => {
    const runs = await Promise.allSettled([1, 2, 3].map(i => doc({ docType: "payment", docNo: `PAY-${i}`, amount: "2000", cashAccountCode: "OFFICE_CASH", docDate: "2026-10-06" })));
    expect(runs.filter(r => r.status === "fulfilled")).toHaveLength(2); // 2000 + 2000 ≤ 5000، الثالثة تتجاوز
    expect(await bal("SUPPLIER_PAYABLE")).toBe("1000.0000");
    advDoc = (await doc({ docType: "advance", docNo: "ADV-1", amount: "1500", cashAccountCode: "OFFICE_CASH", docDate: "2026-10-07" })).documentId;
    expect(await code(() => doc({ docType: "advance_application", docNo: "APP-1", amount: "1200", appliesToDocumentId: advDoc, docDate: "2026-10-08" }))).toBe("CONFLICT"); // > المستحق 1000
    await doc({ docType: "advance_application", docNo: "APP-1", amount: "1000", appliesToDocumentId: advDoc, docDate: "2026-10-08" });
    const st = await (await am()).suppliers.statement({ supplierId: sup });
    expect([st.payable, st.advance]).toEqual(["0.0000", "500.0000"]);
    expect(st.advancesOpen).toEqual([{ documentId: advDoc, docNo: "ADV-1", remaining: "500.0000" }]);
  });

  it("الإلغاء بالعكس فقط وبترتيب منطقي: مقدّم مطبَّق لا يُلغى قبل تطبيقه؛ فاتورة مدفوعة لا تُلغى قبل دفعتها؛ الأعمار من الاستحقاق", async () => {
    const c = await am();
    expect(await code(async () => (await call(e.accA)).suppliers.cancelDocument({ documentId: advDoc, reason: "خطأ" }))).toBe("FORBIDDEN");
    expect(await code(() => c.suppliers.cancelDocument({ documentId: advDoc, reason: "صرف بالخطأ" }))).toBe("CONFLICT");
    const docs = (await c.suppliers.statement({ supplierId: sup })).documents;
    const inv = docs.find((x: any) => x.docNo === "INV-1")!, app = docs.find((x: any) => x.docNo === "APP-1")!;
    expect(await code(() => c.suppliers.cancelDocument({ documentId: inv.id, reason: "فاتورة خاطئة" }))).toBe("CONFLICT");
    await c.suppliers.cancelDocument({ documentId: app.id, reason: "تطبيق خاطئ" });
    await c.suppliers.cancelDocument({ documentId: advDoc, reason: "صرف بالخطأ" });
    const st = await c.suppliers.statement({ supplierId: sup, asOf: "2026-11-25" });
    expect([st.payable, st.advance]).toEqual(["1000.0000", "0.0000"]);
    expect(st.aging).toMatchObject({ d31_60: "1000.0000", notDue: "0.0000" }); // استحقاق 20/10 → متأخر 36 يومًا يوم 25/11
    expect(st.lines.filter((l: any) => l.reversal)).toHaveLength(2);
    expect(await bal("OFFICE_CASH")).toBe("16000.0000"); // 20000 − 4000 دفعات (المقدّم عاد)
  });

  it("الورشة: عهدة بالكمية والقيمة، استلام جزئي بمتوسط الباقي + أجر القطعة، عجز على الورشة/خسارة باختيار صريح، تصليح، وإغلاق بالباقي الدقيق", async () => {
    const c = await am();
    expect(await code(() => c.suppliers.createBatch({ supplierId: sup, businessId: A.businessId, reference: "B-NOT", pieceWage: "5" }))).toBe("CONFLICT"); // ليس ورشة
    batch = (await c.suppliers.createBatch({ supplierId: shop, businessId: A.businessId, reference: "B-1", pieceWage: "5" })).batchId;
    const ev = (x: Record<string, unknown>) => c.suppliers.workshopEvent({ batchId: batch, date: "2026-10-09", ...x } as any);
    await ev({ eventType: "send", quantity: 30, value: "1000", operationId: "ui:ws-send-0001" });
    expect([await bal("WORKSHOP_CUSTODY"), await bal("INV_RAW")]).toEqual(["1000.0000", "4000.0000"]);
    // استلام 10: 1000 × 10/30 = 333.3333 من العهدة + أجر 50 مستحق للورشة — مرة واحدة بنفس العملية
    await Promise.all([1, 2].map(() => ev({ eventType: "receive", quantity: 10, operationId: "ui:ws-recv-0001" }).catch(() => null)));
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_workshop_events WHERE batchId = ? AND eventType = 'receive'", [batch]))[0].n)).toBe(1);
    expect([await bal("INV_GOODS"), await bal("WORKSHOP_CUSTODY")]).toEqual(["383.3333", "666.6667"]);
    expect(await code(() => ev({ eventType: "shortage", quantity: 2, operationId: "ui:ws-short-0001" }))).toBe("BAD_REQUEST"); // بلا اختيار
    // عجز قطعتين = 666.6667 × 2/20 = 66.6667 > مستحق الورشة (أجر 50) ⇒ لا يُحمَّل عليها
    expect(await code(() => ev({ eventType: "shortage", quantity: 2, chargeTo: "workshop", operationId: "ui:ws-short-0002" }))).toBe("CONFLICT");
    expect(await code(() => ev({ eventType: "repair_cost", value: "30", operationId: "ui:ws-rep-0001" }))).toBe("BAD_REQUEST"); // وصف إلزامي
    await ev({ eventType: "repair_cost", value: "30", note: "لحام قفل", operationId: "ui:ws-rep-0001" });
    await ev({ eventType: "shortage", quantity: 2, chargeTo: "workshop", operationId: "ui:ws-short-0003" }); // 66.6667 ≤ 80
    await ev({ eventType: "shortage", quantity: 1, chargeTo: "loss", operationId: "ui:ws-short-0004" });       // 600 / 18 = 33.3333
    expect(await bal("EXP_WORKSHOP_SHORTAGE")).toBe("33.3333");
    expect(await code(() => ev({ eventType: "receive", quantity: 18, operationId: "ui:ws-recv-0002" }))).toBe("CONFLICT"); // الباقي 17
    await ev({ eventType: "receive", quantity: 17, operationId: "ui:ws-recv-0003" }); // آخر قطعة تأخذ الباقي بالضبط 566.6667 + أجر 85
    const [b] = await c.suppliers.batches({ supplierId: shop });
    expect([b.status, b.remainingQuantity, b.remainingValue]).toEqual(["closed", 0, "0.0000"]);
    expect([await bal("WORKSHOP_CUSTODY"), await bal("INV_GOODS")]).toEqual(["0.0000", "1035.0000"]);
    expect(await code(() => ev({ eventType: "send", quantity: 1, value: "10", operationId: "ui:ws-send-0002" }))).toBe("CONFLICT"); // مغلقة
    const st = await c.suppliers.statement({ supplierId: shop });
    expect(st.payable).toBe("98.3333"); // أجور 50 + 85 + تصليح 30 − عجز على الورشة 66.6667
  });

  it("رصيد افتتاحي لمورد: المالك فقط، مقابل الرصيد الافتتاحي بتاريخ Go-live (لا مخزون ولا مصروف)، مرجع مطابقة إلزامي، بلا تكرار ولا عدّ مزدوج مع فاتورة عادية", async () => {
    const op = await call(e.ownerA), am = await am_();
    const s2 = (await am.suppliers.create({ code: "OP-01", name: "مورد قديم", isWorkshop: false })).supplierId;
    const base = { supplierId: s2, side: "payable" as const, originalDocNo: "OLD-77", originalDate: "2026-08-15", dueDate: "2026-09-15", amount: "1200", evidenceRef: "كشف حساب المورد 30/9 موقّع" };
    const invBefore = await bal("INV_RAW"), expBefore = (await q("SELECT COALESCE(SUM(currentBalance),0) s FROM ledger_accounts WHERE tenantId = ? AND kind = 'expense'", [A.tenantId]))[0].s;
    expect(await code(() => am.suppliers.opening(base))).toBe("FORBIDDEN"); // ledger.activate للمالك فقط
    expect(await code(() => op.suppliers.opening({ ...base, evidenceRef: "x" }))).toBe("BAD_REQUEST");
    expect(await code(() => op.suppliers.opening({ ...base, originalDate: "2026-10-05" }))).toBe("BAD_REQUEST"); // بعد Go-live ليس افتتاحيًا
    const r = await op.suppliers.opening(base);
    expect((await op.suppliers.opening(base)).replay).toBe(true);
    expect(await code(() => op.suppliers.opening({ ...base, amount: "1300" }))).toBe("CONFLICT");
    expect(await code(() => am.suppliers.postDocument({ supplierId: s2, docType: "invoice", docNo: "OLD-77", docDate: "2026-10-05", amount: "1200", businessId: A.businessId, itemAccountCode: "INV_RAW" }))).toBe("CONFLICT"); // نفس الفاتورة الأصلية لا تُسجَّل مرتين
    const lines = (await q("SELECT a.code, e.side, e.amount, DATE_FORMAT(t.effectiveDate,'%Y-%m-%d') d FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.accountId JOIN ledger_transactions t ON t.id = e.transactionId WHERE t.id = ? ORDER BY a.code", [r.transactionId]));
    expect(lines.map((x: any) => [x.code, x.side, x.amount, x.d])).toEqual([["OPENING_EQUITY", "debit", "1200.0000", "2026-10-01"], ["SUPPLIER_PAYABLE", "credit", "1200.0000", "2026-10-01"]]);
    expect([await bal("INV_RAW"), (await q("SELECT COALESCE(SUM(currentBalance),0) s FROM ledger_accounts WHERE tenantId = ? AND kind = 'expense'", [A.tenantId]))[0].s]).toEqual([invBefore, expBefore]);
    await op.suppliers.opening({ ...base, side: "advance", originalDocNo: "OLD-ADV-3", dueDate: null, amount: "200" });
    const st = await am.suppliers.statement({ supplierId: s2, asOf: "2026-10-20" });
    expect([st.payable, st.advance, st.aging.d31_60]).toEqual(["1200.0000", "200.0000", "1200.0000"]); // الأعمار من استحقاقه الأصلي 15/9
    expect(st.documents.every((x: any) => x.opening)).toBe(true);
    // إلغاء الرصيد الافتتاحي للمالك وحده
    const doc = st.documents.find((x: any) => x.docNo === "OLD-77")!;
    expect(await code(() => am.suppliers.cancelDocument({ documentId: doc.id, reason: "خطأ في الكشف" }))).toBe("FORBIDDEN");
    await op.suppliers.cancelDocument({ documentId: doc.id, reason: "خطأ في الكشف" });
    expect((await am.suppliers.statement({ supplierId: s2 })).payable).toBe("0.0000");
  });

  it("تصحيح أحداث الورشة بالعكس: من الأحدث للأقدم، يعيد الكميات والقيمة بالضبط، سبب وفاعل، مرة واحدة؛ ما يُنقص مستحقًا مدفوعًا يُرفض", async () => {
    const c = await am_();
    const ws2 = (await c.suppliers.create({ code: "WS-02", name: "ورشة التصحيح", isWorkshop: true })).supplierId;
    const b2 = (await c.suppliers.createBatch({ supplierId: ws2, businessId: A.businessId, reference: "B-REV", pieceWage: "4" })).batchId;
    const ev = (x: Record<string, unknown>) => c.suppliers.workshopEvent({ batchId: b2, date: "2026-10-09", ...x } as any);
    await ev({ eventType: "send", quantity: 10, value: "300", operationId: "ui:rv-send-0001" });
    await ev({ eventType: "receive", quantity: 4, operationId: "ui:rv-recv-0001" });      // 120 + أجر 16
    await ev({ eventType: "shortage", quantity: 1, chargeTo: "loss", operationId: "ui:rv-short-0001" }); // 30
    await ev({ eventType: "repair_cost", value: "9", note: "تلميع", operationId: "ui:rv-rep-0001" });
    const events = async () => (await c.suppliers.batches({ supplierId: ws2 }))[0];
    const byType = async (t: string) => (await events()).events.find((x: any) => x.eventType === t && !x.reversal)!;
    const before = { custody: await bal("WORKSHOP_CUSTODY"), goods: await bal("INV_GOODS"), raw: await bal("INV_RAW"), shortage: await bal("EXP_WORKSHOP_SHORTAGE") };
    // الاستلام له حدث لاحق (العجز) يعتمد على متوسطه ⇒ مرفوض مع ذكره
    const recv = await byType("receive");
    const err = await c.suppliers.reverseWorkshopEvent({ eventId: recv.id, reason: "عدّ خاطئ" }).then(() => null, (x: any) => x);
    expect(err?.code).toBe("CONFLICT"); expect(err?.message).toMatch(/shortage/);
    expect(await code(() => c.suppliers.reverseWorkshopEvent({ eventId: recv.id, reason: "x" }))).toBe("BAD_REQUEST");
    expect(await code(async () => (await call(e.accA)).suppliers.reverseWorkshopEvent({ eventId: recv.id, reason: "عدّ خاطئ" }))).toBe("FORBIDDEN");
    // التصليح مستقل عن العهدة: يُعكس في أي وقت
    await c.suppliers.reverseWorkshopEvent({ eventId: (await byType("repair_cost")).id, reason: "سُجّل لدفعة أخرى" });
    // العكس بالترتيب: العجز ثم الاستلام — مرة واحدة حتى تحت التزامن
    const sh = await byType("shortage");
    const runs = await Promise.allSettled([1, 2].map(() => c.suppliers.reverseWorkshopEvent({ eventId: sh.id, reason: "القطعة وُجدت" })));
    expect(runs.every(x => x.status === "fulfilled")).toBe(true);
    expect(Number((await q("SELECT COUNT(*) n FROM ledger_transactions WHERE reversalOfTransactionId = ?", [sh.transactionId]))[0].n)).toBe(1);
    await c.suppliers.reverseWorkshopEvent({ eventId: recv.id, reason: "عدّ خاطئ" });
    const b = await events();
    expect([b.sentQuantity, b.receivedQuantity, b.shortageQuantity, b.remainingQuantity, b.remainingValue, b.status]).toEqual([10, 0, 0, 10, "300.0000", "open"]);
    expect([await bal("WORKSHOP_CUSTODY"), await bal("INV_GOODS"), await bal("EXP_WORKSHOP_SHORTAGE")])
      .toEqual([fmt(num(before.custody) + 150), fmt(num(before.goods) - 136), fmt(num(before.shortage) - 30)]); // 120+30 للعهدة، 120+16 من البضاعة
    const rev = (await events()).events.find((x: any) => x.id === recv.id).reversal;
    expect(rev).toMatchObject({ actorEmployeeId: e.amA, description: expect.stringMatching(/عدّ خاطئ/) });
    // بعد العكس: الاستلام من جديد يحسب من العهدة الأصلية (300 / 10)
    await ev({ eventType: "receive", quantity: 5, operationId: "ui:rv-recv-0002" });
    expect((await events()).remainingValue).toBe("150.0000");
    // أجر مستحق ثم سُدد للورشة: عكس الاستلام يُنقص مستحقًا مدفوعًا ⇒ مرفوض حتى تُعكس الدفعة
    await c.suppliers.postDocument({ supplierId: ws2, docType: "payment", docNo: "WS2-PAY-1", docDate: "2026-10-10", amount: "20", cashAccountCode: "OFFICE_CASH" });
    const recv2 = (await events()).events.filter((x: any) => x.eventType === "receive" && !x.reversal).pop()!;
    const e2 = await c.suppliers.reverseWorkshopEvent({ eventId: recv2.id, reason: "تصحيح" }).then(() => null, (x: any) => x);
    expect(e2?.code).toBe("CONFLICT"); expect(e2?.message).toMatch(/سُدد/);
  });

  it("العزل والصلاحيات: المحاسب لا يرى الموردين؛ الشركة B لا ترى موردي A ولا كشوفهم", async () => {
    expect(await code(async () => (await call(e.accA)).suppliers.list())).toBe("FORBIDDEN");
    const ob = await call(e.ownerB);
    const list = await ob.suppliers.list();
    expect(list.available ? list.suppliers : []).toEqual([]);
    expect(await code(() => ob.suppliers.statement({ supplierId: sup }))).toBe("NOT_FOUND");
    expect(await code(() => ob.suppliers.postDocument({ supplierId: sup, docType: "payment", docNo: "X-1", docDate: "2026-10-09", amount: "1", cashAccountCode: "OFFICE_CASH" } as any))).not.toBe("ok");
  });
});
