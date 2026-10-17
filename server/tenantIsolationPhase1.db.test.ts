import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { COOKIE_NAME } from "@shared/const";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import {
  __setDbForTests, createEmployee, createProductWithVariants, createOrderWithItems, confirmOrder, cancelOrder,
  countActiveAdminTierEmployees, deleteOrders, replaceOrderItemsFromEditor, OrderLineScopeError,
} from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * المرحلة 1 — عزل التجار والصلاحيات على MySQL حقيقي (قاعدة مؤقتة): تاجرين A وB، وأدوار owner/manager/accountant/agent/viewer.
 * كل اختبار سلبي بيثبت «لا قراءة ولا كتابة برّه النطاق» بلقطة قبل/بعد، وكل اختبار إيجابي إن الاستخدام المشروع شغال.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? e?.name ?? "ERR"; } }
async function failure(fn: () => Promise<any>): Promise<any> { try { await fn(); return null; } catch (e) { return e; } }

describe.runIf(CAN)("🛡️ المرحلة 1 — عزل التجار والصلاحيات", { timeout: 60_000 }, () => {
  let tmp: TempSchema; let A: CoreTestFixture; let B: CoreTestFixture;
  let A2 = 0; // نشاط تاني في نفس تاجر A
  const e: Record<string, number> = {};
  let seq = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const orderRow = async (id: number) => (await q("SELECT * FROM orders WHERE id = ?", [id]))[0];
  const snapOrders = async (businessId: number) => JSON.stringify(await q(
    "SELECT o.*, (SELECT COUNT(*) FROM order_items i WHERE i.orderId = o.id) AS items FROM orders o WHERE o.businessId = ? ORDER BY o.id", [businessId]));
  const vStock = async (id: number) => Number((await q("SELECT currentStock FROM product_variants WHERE id = ?", [id]))[0].currentStock);
  const moveCount = async () => Number((await q("SELECT COUNT(*) AS n FROM inventory_movements"))[0].n);

  async function product(businessId: number, stock = 10) {
    const k = ++seq;
    const r = await createProductWithVariants(businessId, { name: `منتج ${k}` }, [
      { sku: `P1-${k}-${tmp.name}`.slice(0, 50), color: "ذهبي", currentStock: stock } as any,
      { sku: `P2-${k}-${tmp.name}`.slice(0, 50), color: "فضي", currentStock: stock } as any,
    ]);
    return { p: r.productId, a: r.variantIds[0], b: r.variantIds[1] };
  }
  async function order(businessId: number, prod: { p: number; a: number }, extra: Record<string, any> = {}) {
    const k = ++seq;
    return (await createOrderWithItems({
      businessId, orderNumber: `I${tmp.name.slice(-6)}${k}`.slice(0, 20), customerName: `عميل ${businessId}-${k}`,
      customerPhone: `0101${String(1000000 + k).slice(-7)}`, customerAddress: "شارع النيل رقم 5 الدقي", governorate: "القاهرة",
      productName: "x", productId: prod.p, variantId: prod.a, quantity: 1, totalAmount: "100.00", status: "new", source: "manual", ...extra,
    } as any, [{ productId: prod.p, variantId: prod.a, productName: "x", quantity: 1, unitPrice: 100 }]))!;
  }

  beforeAll(async () => {
    tmp = await createTempSchema("iso_p1");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("iso-a");
    B = await createCoreTestFixture("iso-b");
    A2 = insId(await q("INSERT INTO businesses (tenantId, name, slug, baseCurrency, timezone) VALUES (?, 'A2', ?, 'EGP', 'Africa/Cairo')", [A.tenantId, `a2-${tmp.name}`.slice(0, 50)]));
    const mk = async (key: string, role: string, f: CoreTestFixture) => {
      e[key] = insId(await createEmployee({ name: `${key}-iso`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId,
        username: `${key}_${tmp.name}`.slice(0, 50), passwordHash: `hash-${key}` } as any));
    };
    await mk("ownerA", "super_admin", A); await mk("managerA", "manager", A); await mk("accountantA", "accountant", A);
    await mk("agentA", "agent", A); await mk("agentA2", "agent", A); await mk("viewerA", "viewer", A);
    await mk("ownerB", "super_admin", B); await mk("managerB", "manager", B); await mk("agentB", "agent", B);
  }, 180_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  // ==================== P1 ====================

  it("C2 · «حذف كل المكررات» يمسح مكررات تاجر المستخدم بس — مكررات B (حتى غير القابلة للحذف) لا تُلمس ولا تظهر في الرسائل؛ ومتزامن من التاجرين", async () => {
    const PA = await product(A.businessId); const PB = await product(B.businessId);
    const a1 = await order(A.businessId, PA); const a2 = await order(A.businessId, PA);
    const b1 = await order(B.businessId, PB); const b2 = await order(B.businessId, PB);
    await confirmOrder(b2, e.ownerB); // مكرر B غير قابل للحذف (مؤكد)
    await q("UPDATE orders SET isDuplicate = 1, duplicateMarkedAt = NOW() WHERE id IN (?, ?, ?, ?)", [a1, a2, b1, b2]);
    const beforeB = await snapOrders(B.businessId);
    // قائمة A ما فيهاش B
    const list = await (await web(e.ownerA)).duplicates.list();
    expect(list.map((o: any) => o.businessId).every((b: number) => b === A.businessId)).toBe(true);
    expect(list.map((o: any) => o.id).sort()).toEqual([a1, a2].sort());
    expect((await (await web(e.ownerA)).duplicates.deleteAll()).deleted).toBe(2);
    expect([await orderRow(a1), await orderRow(a2)]).toEqual([undefined, undefined]);
    expect(await snapOrders(B.businessId)).toBe(beforeB);
    // B نفسه: الحذف الكلي عنده بيترفض بسبب b2 المؤكد — الرسالة بأرقام B بس، وA مايتأثرش
    const a3 = await order(A.businessId, PA);
    await q("UPDATE orders SET isDuplicate = 1 WHERE id = ?", [a3]);
    const beforeA = await snapOrders(A.businessId);
    const err = await failure(async () => (await web(e.ownerB)).duplicates.deleteAll());
    expect(err?.code).toBe("BAD_REQUEST");
    const aNumber = (await orderRow(a3)).orderNumber;
    expect(String(err?.message)).not.toContain(aNumber);
    expect(await snapOrders(A.businessId)).toBe(beforeA);
    // متزامن: مالك A ومالك B في نفس اللحظة — كل واحد على تاجره بس
    await q("UPDATE orders SET isDuplicate = 0 WHERE id = ?", [b2]);
    const [ra, rb] = await Promise.all([(await web(e.ownerA)).duplicates.deleteAll(), (await web(e.ownerB)).duplicates.deleteAll()]);
    expect([ra.deleted, rb.deleted]).toEqual([1, 1]);
    expect([await orderRow(a3), await orderRow(b1), (await orderRow(b2)).id]).toEqual([undefined, undefined, b2]);
  });

  it("C2 · deleteOrders بنطاق: معرّف برّه النطاق وسط الدفعة = رفض كامل بلا حذف (Rollback) ورسالة بلا أرقام أوردرات", async () => {
    const PA = await product(A.businessId); const PB = await product(B.businessId);
    const a = await order(A.businessId, PA); const b = await order(B.businessId, PB);
    const err = await failure(() => deleteOrders([a, b], [A.businessId]));
    expect(String(err?.message)).toContain("خارج نطاقك");
    expect(String(err?.message)).not.toMatch(/\d{3,}/);
    expect([(await orderRow(a)).id, (await orderRow(b)).id]).toEqual([a, b]);
    expect(await code(async () => (await web(e.ownerA)).orders.bulkDelete({ orderIds: [a, b] }))).toBe("FORBIDDEN");
    expect([(await orderRow(a)).id, (await orderRow(b)).id]).toEqual([a, b]);
  });

  it("C2 · deleteOrders: النطاق إلزامي (غيابه/null/فاضي = رفض بلا قراءة ولا حذف)، النطاق الخاطئ = رفض، الحذف المشروع يمسح الأصناف، وفشل وسط الحذف = Rollback كامل", async () => {
    const PA = await product(A.businessId); const PB = await product(B.businessId);
    const a1 = await order(A.businessId, PA); const a2 = await order(A.businessId, PA); const b = await order(B.businessId, PB);
    const items = async (id: number) => Number((await q("SELECT COUNT(*) AS n FROM order_items WHERE orderId = ?", [id]))[0].n);
    const before = [await snapOrders(A.businessId), await snapOrders(B.businessId)];
    const same = async () => expect([await snapOrders(A.businessId), await snapOrders(B.businessId)]).toEqual(before);
    // غياب النطاق: مفيش مسار «من غير نطاق» — حتى لو المتصل JS اتجاهل النوع
    for (const missing of [undefined, null, "all", { length: 1 }]) {
      const err = await failure(() => (deleteOrders as any)([a1, b], missing));
      expect(err?.name, String(missing)).toBe("OrderStatusGuardError");
      expect(String(err?.message)).toContain("نطاق التاجر");
    }
    await same();
    // نطاق فاضي ونطاق خاطئ (تاجر B على أوردرات A، وA على أوردر B لوحده)
    for (const [ids, scope] of [[[a1], []], [[a1, a2], [B.businessId]], [[b], [A.businessId, A2]]] as [number[], number[]][]) {
      expect(String((await failure(() => deleteOrders(ids, scope)))?.message)).toContain("خارج نطاقك");
    }
    await same();
    // Rollback كامل: فشل حقيقي من القاعدة بعد ما أصناف الدفعة اتمسحت وأثناء حذف الأوردرات
    expect([await items(a1), await items(a2)]).toEqual([1, 1]);
    await q(`CREATE TRIGGER trg_fail_delete_${tmp.name} BEFORE DELETE ON orders FOR EACH ROW BEGIN IF OLD.id = ${a2} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced failure'; END IF; END`);
    try {
      expect(await failure(() => deleteOrders([a1, a2], [A.businessId]))).toBeTruthy();
    } finally {
      await q(`DROP TRIGGER trg_fail_delete_${tmp.name}`);
    }
    await same();
    expect([await items(a1), await items(a2)]).toEqual([1, 1]);
    // الحذف المشروع: أوردرات A بنطاق A (مع نشاط تاني في النطاق) — الأوردرات وأصنافها، وB زي ما هو
    await deleteOrders([a1, a2, a1], [A.businessId, A2]);
    expect([await orderRow(a1), await orderRow(a2), await items(a1), await items(a2)]).toEqual([undefined, undefined, 0, 0]);
    expect(await snapOrders(B.businessId)).toBe(before[1]);
  });

  it("M2 · تعليم المكرر: الموظف غير الإداري على أوردراته المعيّنة بس؛ المدير على كل أوردرات نشاطه", async () => {
    const PA = await product(A.businessId);
    const mine = await order(A.businessId, PA, { assignedEmployeeId: e.agentA });
    const other = await order(A.businessId, PA, { assignedEmployeeId: e.agentA2 });
    const before = JSON.stringify(await orderRow(other));
    expect(await code(async () => (await portal(e.agentA)).employeePortal.markDuplicate({ orderId: other }))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(e.agentA)).employeePortal.unmarkDuplicate({ orderId: other }))).toBe("FORBIDDEN");
    expect(JSON.stringify(await orderRow(other))).toBe(before);
    await (await portal(e.agentA)).employeePortal.markDuplicate({ orderId: mine });
    await (await portal(e.managerA)).employeePortal.markDuplicate({ orderId: other });
    expect([Boolean((await orderRow(mine)).isDuplicate), Boolean((await orderRow(other)).isDuplicate)]).toEqual([true, true]);
  });

  it("C1 · المسح: موظف A (حتى viewer) يمسح رقم/تتبع/شحنة/هاتف أوردر B = «غير موجود» بلا بيانات عميل ولا تعليم «متجهز»؛ ومسح أوردر A شغال", async () => {
    const PA = await product(A.businessId); const PB = await product(B.businessId);
    const b = await order(B.businessId, PB, { bostaTrackingNumber: `N-77${seq}${Date.now() % 10000}`, bostaShipmentId: `SH-B-${seq}`, customerPhone: "01099988877" });
    const bRow = await orderRow(b);
    const beforeB = JSON.stringify(bRow);
    for (const caller of [await portal(e.viewerA), await portal(e.agentA)]) {
      for (const value of [bRow.orderNumber, bRow.bostaTrackingNumber, bRow.bostaShipmentId, bRow.serialNumber, "01099988877"].filter(Boolean)) {
        const r: any = await caller.employeePortal.scan({ serialNumber: String(value) });
        expect([r.success, r.result, r.order], String(value)).toEqual([false, "failed", undefined]);
        expect(JSON.stringify(r)).not.toContain(bRow.customerName);
      }
    }
    const rw: any = await (await web(e.managerA)).orders.scan({ serialNumber: bRow.orderNumber });
    expect([rw.success, rw.order]).toEqual([false, undefined]);
    expect(JSON.stringify(await orderRow(b))).toBe(beforeB);
    const a = await order(A.businessId, PA);
    const ok: any = await (await portal(e.agentA)).employeePortal.scan({ serialNumber: (await orderRow(a)).orderNumber });
    expect([ok.success, ok.order?.id, Boolean((await orderRow(a)).isPrepared)]).toEqual([true, a, true]);
    expect((await orderRow(a)).preparedBy).toBe(e.agentA);
    // الويب: الفاعل من الجلسة (مش getAllEmployees)
    const a2 = await order(A.businessId, PA);
    await (await web(e.managerA)).orders.scan({ serialNumber: (await orderRow(a2)).orderNumber });
    expect((await orderRow(a2)).preparedBy).toBe(e.managerA);
  });

  it("C3 · قوائم بلا تسريب: الأوردرات المحتاجة مراجعة، سجلات الدمج وتنبيهها، سجلات المسح (والقديمة اللي بتشاور على أوردر B)، أسماء الإعلانات", async () => {
    const PA = await product(A.businessId); const PB = await product(B.businessId);
    const a = await order(A.businessId, PA, { needsReview: true, adName: "إعلان-A" });
    const b = await order(B.businessId, PB, { needsReview: true, adName: "إعلان-B-سري" });
    const c = await web(e.ownerA);
    const review = await c.orders.needingReview({ limit: 500 });
    expect(review.some((o: any) => o.id === a)).toBe(true);
    expect(review.every((o: any) => o.businessId === A.businessId || o.businessId === A2)).toBe(true);
    await q("INSERT INTO merge_logs (businessId, keptOrderId, keptOrderNumber, customerName, customerPhone, mergedQty, totalQtyAfter) VALUES (?, ?, 'KA', 'عميل-A', '010', 1, 2), (?, ?, 'KB', 'عميل-B-سري', '011', 3, 4)",
      [A.businessId, a, B.businessId, b]);
    const ml: any = await c.reports.mergeLogs({});
    expect(ml.logs.map((l: any) => l.customerName)).toEqual(["عميل-A"]);
    expect(await c.reports.mergeAlert()).toMatchObject({ count: 1, totalMergedQty: 1 });
    // سجلات مسح: سطر لأوردر A، وسطر قديم (قبل الإصلاح) لموظف A بيشاور على أوردر B، ومسح فاشل
    await q("INSERT INTO scan_logs (orderId, serialNumber, scannedBy, scannedByName, result) VALUES (?, 'sA', ?, 'x', 'success'), (?, 'sB', ?, 'x', 'success'), (0, 'zz', ?, 'x', 'failed')",
      [a, e.agentA, b, e.agentA, e.agentA]);
    const logs: any[] = await c.orders.scanLogs({ limit: 1000 } as any);
    expect(logs.every(l => l.orderId === a || l.orderId !== b)).toBe(true);
    expect(logs.some(l => l.orderId === b) || logs.some(l => l.orderId === 0)).toBe(false);
    const mineLogs: any = await (await portal(e.agentA)).facebookEntry.scanLogs({ limit: 100 } as any);
    const leaked = (mineLogs.logs ?? mineLogs).find((l: any) => l.orderId === b);
    expect(leaked?.customerName ?? null).toBeNull();
    const ads = await c.orders.distinctAdNames();
    expect([ads.includes("إعلان-A"), ads.includes("إعلان-B-سري")]).toEqual([true, false]);
    // getByIds: المملوك بس
    expect((await c.orders.getByIds({ ids: [a, b] })).map((o: any) => o.id)).toEqual([a]);
  });

  // ==================== P2 ====================

  it("C4 · إذن استلام بصنف/تركيبة/مخزن من B: إنشاء وتعديل مسودة FORBIDDEN بلا كتابة؛ وبند قديم مزروع يمنع الاعتماد بلا حركة على مخزون B", async () => {
    const PA = await product(A.businessId); const PB = await product(B.businessId, 50);
    const c = await web(e.ownerA);
    const base = { businessId: A.businessId, warehouseId: A.warehouseId, receiptType: "purchase", supplierName: "مورد", receiptDate: new Date() };
    const receipts = async () => Number((await q("SELECT COUNT(*) AS n FROM purchase_receipts"))[0].n);
    const r0 = await receipts();
    for (const items of [[{ productId: PB.p, variantId: PB.a, quantity: 5, unitCost: "10.00" }], [{ productId: PA.p, variantId: PB.a, quantity: 5, unitCost: "10.00" }]])
      expect(await code(() => c.accountingV2.purchaseReceiptCreate({ ...base, items } as any))).toBe("FORBIDDEN");
    expect(await code(() => c.accountingV2.purchaseReceiptCreate({ ...base, warehouseId: B.warehouseId, items: [{ productId: PA.p, variantId: PA.a, quantity: 1, unitCost: "10.00" }] } as any))).toBe("FORBIDDEN");
    expect(await receipts()).toBe(r0);
    const draft: any = await c.accountingV2.purchaseReceiptCreate({ ...base, items: [{ productId: PA.p, variantId: PA.a, quantity: 2, unitCost: "10.00" }] } as any);
    const receiptId = Number(draft?.receiptId ?? draft?.id ?? (await q("SELECT MAX(id) AS id FROM purchase_receipts"))[0].id);
    const itemsBefore = JSON.stringify(await q("SELECT productId, variantId, quantity FROM purchase_receipt_items WHERE receiptId = ?", [receiptId]));
    expect(await code(() => c.accountingV2.purchaseReceiptDraftUpdate({ businessId: A.businessId, receiptId, items: [{ productId: PB.p, variantId: PB.a, quantity: 9, unitCost: "10.00" }] } as any))).toBe("FORBIDDEN");
    expect(JSON.stringify(await q("SELECT productId, variantId, quantity FROM purchase_receipt_items WHERE receiptId = ?", [receiptId]))).toBe(itemsBefore);
    // بند قديم مزروع (من قبل الإصلاح) بصنف B → الاعتماد يترفض جوه المعاملة، ومخزون B وحركاته وأرصدته كما هي
    await q("UPDATE purchase_receipt_items SET productId = ?, variantId = ? WHERE receiptId = ?", [PB.p, PB.a, receiptId]);
    await q("UPDATE purchase_receipts SET status = 'pending_approval', evidenceUrl = 'https://example.test/inv.pdf' WHERE id = ?", [receiptId]);
    const stockB = await vStock(PB.a); const moves = await moveCount();
    const balances = Number((await q("SELECT COUNT(*) AS n FROM inventory_balances"))[0].n);
    expect(await code(() => c.accountingV2.purchaseReceiptApprove({ businessId: A.businessId, receiptId }))).toBe("FORBIDDEN");
    expect([await vStock(PB.a), await moveCount(), Number((await q("SELECT COUNT(*) AS n FROM inventory_balances"))[0].n),
      (await q("SELECT status FROM purchase_receipts WHERE id = ?", [receiptId]))[0].status]).toEqual([stockB, moves, balances, "pending_approval"]);
  });

  it("H2 · حركة يدوية: orderId من B مرفوض، السبب المحجوز مرفوض (ويب وبوابة)، وحركة قديمة مزروعة على أوردر B لا تعطّله", async () => {
    const PA = await product(A.businessId); const PB = await product(B.businessId);
    const b = await order(B.businessId, PB);
    const c = await web(e.ownerA);
    const moves = await moveCount();
    expect(await code(() => c.products.addMovement({ productId: PA.p, type: "in", quantity: 1, reason: "جرد", orderId: b }))).toBe("FORBIDDEN");
    expect(await code(() => c.variants.addMovement({ variantId: PA.a, type: "out", quantity: 1, reason: "تالف", orderId: b }))).toBe("FORBIDDEN");
    for (const reason of ["تأكيد أوردر 1", "  إلغاء أوردر x", "مرتجع - أوردر 9", "تعديل بنود أوردر"]) {
      expect(await code(() => c.variants.addMovement({ variantId: PA.a, type: "in", quantity: 1, reason })), reason).toBe("BAD_REQUEST");
      expect(await code(async () => (await portal(e.managerA)).employeePortal.addInventoryMovement({ productId: PA.p, type: "in", quantity: 1, reason })), reason).toBe("BAD_REQUEST");
    }
    // أوردر نشاط تاني في نفس التاجر: مرفوض برضه
    const PA2 = await product(A2);
    const a2Order = await order(A2, PA2);
    expect(await code(() => c.variants.addMovement({ variantId: PA.a, type: "in", quantity: 1, reason: "جرد", orderId: a2Order }))).toBe("BAD_REQUEST");
    expect(await moveCount()).toBe(moves);
    await c.variants.addMovement({ variantId: PA.a, type: "in", quantity: 3, reason: "جرد" });
    expect(await moveCount()).toBe(moves + 1);
    // حركة مزروعة قديمة: صنف A بسبب أوردر على أوردر B — B يتأكد ويتلغي عادي ومخزون A مايتحركش
    await q("INSERT INTO inventory_movements (businessId, productId, variantId, type, quantity, reason, orderId, performedBy) VALUES (?, ?, ?, 'out', 1, 'تأكيد أوردر مزروع', ?, ?)",
      [A.businessId, PA.p, PA.a, b, e.ownerA]);
    const stockA = await vStock(PA.a);
    await confirmOrder(b, e.ownerB);
    expect((await cancelOrder(b, "x", undefined, e.ownerB)).restoredQuantity).toBe(1);
    expect([await vStock(PB.a), await vStock(PA.a)]).toEqual([10, stockA]);
  });

  // ==================== P3 ====================

  it("H1 · المدير لا ينشئ محاسب ولا يرقّي لمحاسب ولا يدير حساب محاسب (ويب وبوابة)؛ المالك يقدر؛ وإدارة الوكيل العادي شغالة", async () => {
    const mw = await web(e.managerA); const mp = await portal(e.managerA);
    const acc = (await q("SELECT username, passwordHash, role, isActive FROM employees WHERE id = ?", [e.accountantA]))[0];
    expect(await code(() => mw.employees.create({ name: "محاسب جديد", role: "accountant", businessId: A.businessId } as any))).toBe("FORBIDDEN");
    expect(await code(() => mw.employees.update({ id: e.agentA2, role: "accountant" }))).toBe("FORBIDDEN");
    expect(await code(() => mw.employees.setCredentials({ id: e.accountantA, username: `acc_${seq}_x`, password: "secret123" }))).toBe("FORBIDDEN");
    expect(await code(() => mw.employees.changePassword({ id: e.accountantA, newPassword: "secret123" }))).toBe("FORBIDDEN");
    expect(await code(() => mw.employees.update({ id: e.accountantA, isActive: false }))).toBe("FORBIDDEN");
    expect(await code(() => mp.employeePortal.setEmployeeCredentials({ id: e.accountantA, username: `acc_${seq}_y`, password: "secret123" }))).toBe("FORBIDDEN");
    expect(await code(() => mp.employeePortal.changeEmployeePassword({ id: e.accountantA, newPassword: "secret123" }))).toBe("FORBIDDEN");
    expect((await q("SELECT username, passwordHash, role, isActive FROM employees WHERE id = ?", [e.accountantA]))[0]).toEqual(acc);
    expect((await q("SELECT role FROM employees WHERE id = ?", [e.agentA2]))[0].role).toBe("agent");
    expect((await q("SELECT COUNT(*) AS n FROM employees WHERE tenantId = ? AND role = 'accountant'", [A.tenantId]))[0].n).toBe(1);
    // إدارة وكيل عادي شغالة للمدير
    await mw.employees.changePassword({ id: e.agentA2, newPassword: "secret123" });
    // دور اتمنح صلاحية مالية في إعدادات الشركة = أعلى من المدير برضه
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'viewer', 'accounting.view', 1, ?)", [A.tenantId, e.ownerA]);
    expect(await code(() => mw.employees.changePassword({ id: e.viewerA, newPassword: "secret123" }))).toBe("FORBIDDEN");
    await q("DELETE FROM tenant_role_permissions WHERE tenantId = ? AND role = 'viewer'", [A.tenantId]);
    // المالك يقدر
    await (await web(e.ownerA)).employees.create({ name: "محاسب المالك", role: "accountant", businessId: A.businessId } as any);
    expect((await q("SELECT COUNT(*) AS n FROM employees WHERE tenantId = ? AND role = 'accountant'", [A.tenantId]))[0].n).toBe(2);
  });

  it("M3 · سحب employees.manage من المدير في إعدادات الشركة يُحترم على الويب (كان بيتحترم في البوابة بس)", async () => {
    const mw = await web(e.managerA);
    await q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, 'manager', 'employees.manage', 0, ?)", [A.tenantId, e.ownerA]);
    try {
      const before = Number((await q("SELECT COUNT(*) AS n FROM employees WHERE tenantId = ?", [A.tenantId]))[0].n);
      expect(await code(() => mw.employees.create({ name: "وكيل", role: "agent", businessId: A.businessId } as any))).toBe("FORBIDDEN");
      expect(await code(() => mw.employees.changePassword({ id: e.agentA2, newPassword: "secret123" }))).toBe("FORBIDDEN");
      expect(await code(() => mw.employees.reclaimOrders({ employeeId: e.agentA2 } as any))).toBe("FORBIDDEN");
      expect(Number((await q("SELECT COUNT(*) AS n FROM employees WHERE tenantId = ?", [A.tenantId]))[0].n)).toBe(before);
    } finally {
      await q("DELETE FROM tenant_role_permissions WHERE tenantId = ? AND role = 'manager'", [A.tenantId]);
    }
    expect(await code(() => mw.employees.create({ name: "وكيل", role: "agent", businessId: A.businessId } as any))).toBe("ok");
  });

  it("L1 · عدّ الإداريين النشطين جوه الشركة بس", async () => {
    const a = await countActiveAdminTierEmployees(A.tenantId);
    const b = await countActiveAdminTierEmployees(B.tenantId);
    expect([a, b]).toEqual([
      Number((await q("SELECT COUNT(*) AS n FROM employees WHERE tenantId = ? AND isActive = 1 AND role IN ('super_admin','admin','manager')", [A.tenantId]))[0].n),
      2,
    ]);
    expect(await countActiveAdminTierEmployees(B.tenantId, e.managerB)).toBe(1);
  });

  // ==================== P4 ====================

  it("M1 · بنود الأوردر: صنف/تركيبة من B أو من نشاط تاني أو تركيبة لمنتج تاني مرفوضة في الإنشاء والمحررات وحسم المراجعة — بلا كتابة ولا كشف أسماء", async () => {
    const PA = await product(A.businessId); const PA2 = await product(A2); const PB = await product(B.businessId);
    await q("UPDATE products SET name = 'كتالوج-B-سري' WHERE id = ?", [PB.p]);
    const a = await order(A.businessId, PA, { assignedEmployeeId: e.agentA });
    const c = await web(e.ownerA);
    const before = await snapOrders(A.businessId);
    const line = (productId: number, variantId: number | null) => ({ productId, productName: "x", variantId, quantity: 1, unitPrice: 100, discount: 0 });
    expect(await code(() => c.orders.editOrderItems({ orderId: a, items: [line(PB.p, PB.a)] } as any))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(e.agentA)).employeePortal.editOrderItems({ orderId: a, items: [line(PB.p, null)] } as any))).toBe("FORBIDDEN");
    expect(await code(() => c.orders.editOrderItems({ orderId: a, items: [line(PA.p, PB.a)] } as any))).toBe("FORBIDDEN");
    expect(await code(() => c.orders.editOrderItems({ orderId: a, items: [line(PA.p, PA2.a)] } as any))).toBe("BAD_REQUEST"); // تركيبة لمنتج تاني
    expect(await code(() => c.orders.editOrderItems({ orderId: a, items: [line(PA2.p, PA2.a)] } as any))).toBe("BAD_REQUEST"); // نشاط تاني في نفس التاجر
    expect(await code(() => c.orders.editOrder({ orderId: a, productId: PB.p } as any))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(e.agentA)).employeePortal.editOrder({ orderId: a, variantId: PB.a } as any))).toBe("FORBIDDEN");
    expect(await code(() => c.orders.resolveReview({ orderId: a, productId: PB.p } as any))).toBe("FORBIDDEN");
    expect(await code(() => c.orders.resolveReview({ orderId: a, productId: PA2.p } as any))).toBe("BAD_REQUEST");
    expect(await snapOrders(A.businessId)).toBe(before);
    const items = await c.orders.orderItems({ orderId: a } as any);
    expect(JSON.stringify(items)).not.toContain("كتالوج-B-سري");
    // الإنشاء
    const baseCreate = { customerName: "عميل", customerPhone: "01012345678", customerAddress: "شارع النيل رقم 5 الدقي", governorate: "القاهرة", productName: "x", quantity: 1, totalAmount: "100", source: "manual", businessId: A.businessId };
    expect(await code(() => c.orders.create({ ...baseCreate, productId: PB.p, variantId: PB.a } as any))).toBe("FORBIDDEN");
    expect(await code(() => c.orders.create({ ...baseCreate, productId: PA2.p, variantId: PA2.a } as any))).toBe("FORBIDDEN");
    expect(await code(() => c.orders.create({ ...baseCreate, productId: PA.p, variantId: PA2.a } as any))).toBe("BAD_REQUEST");
    expect(await snapOrders(A.businessId)).toBe(before);
    // طبقة الكتابة نفسها (دفاع ثاني)
    expect(await failure(() => replaceOrderItemsFromEditor(a, [line(PA2.p, PA2.a)], undefined, { id: e.ownerA, name: "o", role: "super_admin" }))).toBeInstanceOf(OrderLineScopeError);
    // المشروع شغال
    await c.orders.editOrderItems({ orderId: a, items: [line(PA.p, PA.b)] } as any);
    expect((await q("SELECT variantId FROM order_items WHERE orderId = ?", [a]))[0].variantId).toBe(PA.b);
  });

  it("L2 · تعيين أوردر لموظف تاجر تاني مرفوض؛ وفك تعيين موظف مايلمسش أوردرات تاجر تاني", async () => {
    const PA = await product(A.businessId); const PB = await product(B.businessId);
    const a = await order(A.businessId, PA);
    const before = JSON.stringify(await orderRow(a));
    expect(["FORBIDDEN", "NOT_FOUND"]).toContain(await code(async () => (await web(e.ownerA)).orders.assign({ orderId: a, employeeId: e.agentB })));
    expect(JSON.stringify(await orderRow(a))).toBe(before);
    // أوردر B متعيّن (بيانات قديمة) لموظف A — فك تعيين موظف A من A مايلمسهوش
    const b = await order(B.businessId, PB, { assignedEmployeeId: e.agentA });
    const a2 = await order(A.businessId, PA, { assignedEmployeeId: e.agentA });
    await (await web(e.ownerA)).orders.unassignEmployeeOrders({ employeeId: e.agentA });
    expect([(await orderRow(b)).assignedEmployeeId, (await orderRow(a2)).assignedEmployeeId]).toEqual([e.agentA, null]);
  });

  it("L3 · تصنيف من B في إنشاء منتج مرفوض؛ والمخزن الافتراضي لازم يتبع النشاط", async () => {
    const catB = insId(await q("INSERT INTO categories (businessId, name) VALUES (?, 'تصنيف B')", [B.businessId]));
    const catA = insId(await q("INSERT INTO categories (businessId, name) VALUES (?, 'تصنيف A')", [A.businessId]));
    const c = await web(e.ownerA);
    const products = async () => Number((await q("SELECT COUNT(*) AS n FROM products"))[0].n);
    const n = await products();
    expect(await code(() => c.products.create({ name: "منتج", businessId: A.businessId, categoryId: catB } as any))).toBe("FORBIDDEN");
    expect(await products()).toBe(n);
    expect(await code(() => c.products.create({ name: "منتج", businessId: A.businessId, categoryId: catA } as any))).toBe("ok");
    const settings = (await q("SELECT defaultWarehouseId FROM businesses WHERE id = ?", [A.businessId]))[0];
    expect(await code(() => c.accountingV2.updateBusinessSettings({ businessId: A.businessId, baseCurrency: "EGP", timezone: "Africa/Cairo", accountingGoLiveAt: new Date("2027-01-01T00:00:00Z"), defaultWarehouseId: B.warehouseId } as any))).toBe("FORBIDDEN");
    expect((await q("SELECT defaultWarehouseId FROM businesses WHERE id = ?", [A.businessId]))[0]).toEqual(settings);
  });

  it("المخاطر المؤكدة · مرتبات: المدير مرفوض في الإعدادات وتعديل البنود (نفس صلاحية payroll.manage)؛ myOrders على الويب بيرجّع أوردرات الموظف الإداري المعيّنة له", async () => {
    const mw = await web(e.managerA);
    expect(await code(() => mw.payroll.settingsSave({ businessId: A.businessId } as any))).toBe("FORBIDDEN");
    expect(await code(() => mw.payroll.itemUpdate({ id: 1 } as any))).toBe("FORBIDDEN");
    const PA = await product(A.businessId);
    const a = await order(A.businessId, PA, { assignedEmployeeId: e.managerA, assignedAt: new Date() });
    const r: any = await mw.orders.myOrders({});
    expect((r.orders ?? r).some((o: any) => o.id === a)).toBe(true);
  });
});
