import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { and, eq, inArray, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import {
  getDb, createEmployee, createProductWithVariants, insertOrderWithItems, getVariantById, confirmOrder, cancelOrder,
  addInventoryMovement,
} from "./db";
import {
  employees, orders, orderItems, products, productVariants, inventoryMovements, returns, treasuryTransactions,
  financialTransactions, financialTransactionEntries, businessEvents, employeeAdvances, financialAccounts,
  tenantRolePermissions, salesChannels, webhookLogs,
} from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { issueEmployeeAdvance } from "./advancesV2.service";
import { registerWebhookRoutes } from "./easyorderWebhook";
import { ACCOUNTING_FROZEN_MESSAGE } from "./permissions";

/**
 * المرحلة 0.5 — إصلاح الأعطال التشغيلية الحرجة الخمسة المثبتة في المرحلة 0 (قاعدة اختبار فقط):
 *  1) عزل حركة المخزون   2) انتقالات الحالة (التأكيد عبر confirmOrder فقط، لا تسليم يدوي لبوسطة)
 *  3) حجب صافي الربح من السيرفر   4) الإلغاء يعيد المخصوم مرة واحدة، لا حذف للمؤكد، لا إعادة للمرتجع
 *  5) تجميد المسارات المالية المتبقية   6) السُلفة لا تُصرف مرتين.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN)("🔒 المرحلة 0.5 — الأعطال التشغيلية الحرجة", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const ids = { productIds: [] as number[], empIds: [] as number[], orderIds: [] as number[], channelIds: [] as number[] };
  let prodA = 0, varA = 0, prodB = 0, varB = 0, whA = 0, accA = 0, accB = 0;
  let seq = 0;
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  const d = async () => (await getDb())!;
  const emp = (employeeId: number) => appRouter.createCaller({
    user: null, employee: null, tenantId: null,
    req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId }, process.env.JWT_SECRET as string) } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as any);
  /** جلسة موظف غير أدمن كما يبنيها createContext: user=null + صف الموظف + tenantId. */
  const empSession = async (employeeId: number) => {
    const [row] = await (await d()).select().from(employees).where(eq(employees.id, employeeId));
    return appRouter.createCaller({ user: null, employee: row, tenantId: row.tenantId, req: { protocol: "https", headers: {}, cookies: {} }, res: { clearCookie() {}, cookie() {} } } as any);
  };
  const owner = (tenantId: number) => appRouter.createCaller({
    user: { id: 1, role: "admin", name: "owner" }, employee: null, tenantId,
    req: { protocol: "https", headers: {}, cookies: {} }, res: { clearCookie: () => {}, cookie: () => {} },
  } as any);
  const superAdmin = (tenantId: number) => appRouter.createCaller({
    user: { id: -1, role: "admin", name: "المالك" }, employee: { id: 1, role: "super_admin", businessId: null, tenantId, isActive: true }, tenantId,
    req: { protocol: "https", headers: {}, cookies: {} }, res: { clearCookie: () => {}, cookie: () => {} },
  } as any);
  const fail = async (fn: () => Promise<any>) => { try { await fn(); return { code: "ok", message: "" }; } catch (e: any) { return { code: e?.code ?? "ERR", message: String(e?.message ?? "") }; } };
  const stockOf = async (vid: number) => (await getVariantById(vid))!.currentStock;
  const prodStock = async (pid: number) => (await (await d()).select({ s: products.currentStock }).from(products).where(eq(products.id, pid)))[0].s;
  const orderRow = async (id: number) => (await (await d()).select().from(orders).where(eq(orders.id, id)))[0];
  const movesOf = async (orderId: number) => (await d()).select().from(inventoryMovements).where(eq(inventoryMovements.orderId, orderId));
  const mkOrder = async (fx: CoreTestFixture, productId: number, variantId: number, extra: Record<string, unknown> = {}) => {
    const n = ++seq;
    const id = await insertOrderWithItems({
      orderNumber: `P5-${n}-${tag}`.slice(0, 20), businessId: fx.businessId, customerName: "عميل", customerPhone: "01000000001",
      governorate: "القاهرة", customerAddress: "شارع طويل رقم 10", productName: "p", productId, quantity: 2, totalAmount: "1500.00",
      source: "facebook", status: "new", ...extra,
    } as any, [{ productId, productName: "p", quantity: 2, variantId, unitPrice: 750 }]);
    ids.orderIds.push(id); return id;
  };

  beforeAll(async () => {
    A = await createCoreTestFixture("p5-a"); B = await createCoreTestFixture("p5-b");
    const pa = await createProductWithVariants(A.businessId, { name: `P5A ${tag}` }, [{ name: "سادة", sku: `P5A-${tag}`, currentStock: 100, price: "750" }]);
    const pb = await createProductWithVariants(B.businessId, { name: `P5B ${tag}` }, [{ name: "سادة", sku: `P5B-${tag}`, currentStock: 100, price: "750" }]);
    prodA = pa.productId; varA = pa.variantIds[0]; prodB = pb.productId; varB = pb.variantIds[0]; ids.productIds.push(prodA, prodB);
    whA = insId(await createEmployee({ name: "wh", role: "warehouse", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `p5wh_${tag}` } as any));
    accA = insId(await createEmployee({ name: "acc", role: "accountant", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `p5acc_${tag}` } as any));
    accB = insId(await createEmployee({ name: "accB", role: "accountant", isActive: true, tenantId: B.tenantId, businessId: B.businessId, username: `p5accb_${tag}` } as any));
    ids.empIds.push(whA, accA, accB);
  });
  afterAll(async () => {
    const db = await getDb(); if (!db) return;
    const bids = [A.businessId, B.businessId];
    await db.delete(inventoryMovements).where(inArray(inventoryMovements.productId, ids.productIds));
    if (ids.orderIds.length) { await db.delete(returns).where(inArray(returns.orderId, ids.orderIds)); await db.delete(orderItems).where(inArray(orderItems.orderId, ids.orderIds)); await db.delete(orders).where(inArray(orders.id, ids.orderIds)); }
    await db.delete(webhookLogs).where(inArray(webhookLogs.businessId, bids));
    if (ids.channelIds.length) await db.delete(salesChannels).where(inArray(salesChannels.id, ids.channelIds));
    await db.delete(tenantRolePermissions).where(inArray(tenantRolePermissions.tenantId, [A.tenantId, B.tenantId]));
    await db.delete(employeeAdvances).where(inArray(employeeAdvances.employeeId, ids.empIds));
    await db.delete(financialTransactionEntries).where(inArray(financialTransactionEntries.businessId, bids));
    await db.delete(financialTransactions).where(inArray(financialTransactions.businessId, bids));
    await db.delete(treasuryTransactions).where(inArray(treasuryTransactions.businessId, bids));
    await db.delete(businessEvents).where(inArray(businessEvents.businessId, bids));
    await db.delete(financialAccounts).where(inArray(financialAccounts.businessId, bids));
    if (ids.empIds.length) await db.delete(employees).where(inArray(employees.id, ids.empIds));
    if (ids.productIds.length) { await db.delete(productVariants).where(inArray(productVariants.productId, ids.productIds)); await db.delete(products).where(inArray(products.id, ids.productIds)); }
    await B?.cleanup(); await A?.cleanup();
  });

  // ───────────────── 1) عزل حركة المخزون ─────────────────
  it("🔒 1) موظف مخزن في A لا يحرّك منتج B: رفض كامل بلا أي تغيير", async () => {
    const before = await prodStock(prodB);
    const r = await fail(() => emp(whA).employeePortal.addInventoryMovement({ productId: prodB, type: "in", quantity: 5, reason: "p5-iso" }));
    expect(r.code).toBe("FORBIDDEN");
    expect(await prodStock(prodB)).toBe(before);
    expect(await (await d()).select().from(inventoryMovements).where(and(eq(inventoryMovements.productId, prodB), eq(inventoryMovements.reason, "p5-iso")))).toEqual([]);
    // منتج غير موجود → رفض مغلق أيضًا
    expect((await fail(() => emp(whA).employeePortal.addInventoryMovement({ productId: 999999999, type: "in", quantity: 1 }))).code).not.toBe("ok");
  });

  it("🔒 1) الحركة الصحيحة تُسجَّل على نشاط المنتج لا على النشاط 1، والمحاولة بنشاط مختلف مرفوضة", async () => {
    await emp(whA).employeePortal.addInventoryMovement({ productId: prodA, type: "in", quantity: 3, reason: "p5-own" });
    const [mv] = await (await d()).select().from(inventoryMovements).where(and(eq(inventoryMovements.productId, prodA), eq(inventoryMovements.reason, "p5-own")));
    expect(mv.businessId).toBe(A.businessId);
    // الأدمن أيضًا
    await owner(A.tenantId).products.addMovement({ productId: prodA, type: "in", quantity: 1, reason: "p5-admin" });
    const [mv2] = await (await d()).select().from(inventoryMovements).where(and(eq(inventoryMovements.productId, prodA), eq(inventoryMovements.reason, "p5-admin")));
    expect(mv2.businessId).toBe(A.businessId);
    // مستوى الخدمة: businessId مغاير لنشاط المنتج = رفض
    const before = await prodStock(prodA);
    const r = await fail(() => addInventoryMovement({ productId: prodA, businessId: B.businessId, type: "in", quantity: 1, reason: "p5-wrong", performedBy: 1 } as any));
    expect(r.message).toContain("لا يتبع هذا النشاط");
    expect(await prodStock(prodA)).toBe(before);
    // أدمن tenant B لا يحرّك منتج A
    expect((await fail(() => owner(B.tenantId).products.addMovement({ productId: prodA, type: "in", quantity: 1 }))).code).not.toBe("ok");
  });

  // ───────────────── 2) انتقالات الحالة ─────────────────
  it("🔒 2) orders.update لا يحوّل إلى «مؤكد»؛ التأكيد الطبيعي عبر confirmOrder يخصم كما كان", async () => {
    const oid = await mkOrder(A, prodA, varA);
    const before = await stockOf(varA);
    const r = await fail(() => owner(A.tenantId).orders.update({ id: oid, status: "confirmed" as any }));
    expect(r.code).toBe("BAD_REQUEST"); expect(r.message).toContain("زر التأكيد");
    expect((await orderRow(oid)).status).toBe("new");
    expect(await stockOf(varA)).toBe(before);
    // التأكيد الطبيعي ما زال يعمل ويخصم من النوع الصحيح
    await owner(A.tenantId).orders.confirm({ orderId: oid });
    expect((await orderRow(oid)).status).toBe("confirmed");
    expect(await stockOf(varA)).toBe(before - 2);
    expect((await movesOf(oid)).filter(m => m.type === "out")).toHaveLength(1);
    // تعديل بيانات العميل بلا حالة ما زال يعمل
    await owner(A.tenantId).orders.update({ id: oid, notes: "ملاحظة" });
    expect((await orderRow(oid)).notes).toBe("ملاحظة");
  });

  it("🔒 2) شحنة بوسطة لا تُسلَّم يدويًا؛ الأوردر بلا شحنة بوسطة يبقى له المسار اليدوي", async () => {
    const bosta = await mkOrder(A, prodA, varA, { status: "shipped", bostaShipmentId: `BS-${tag}`, bostaStatus: "sent" });
    const r = await fail(() => owner(A.tenantId).orders.update({ id: bosta, status: "delivered" as any }));
    expect(r.code).toBe("BAD_REQUEST"); expect(r.message).toContain("بوسطة");
    expect((await orderRow(bosta)).status).toBe("shipped");
    const manual = await mkOrder(A, prodA, varA, { status: "shipped" });
    await owner(A.tenantId).orders.update({ id: manual, status: "delivered" as any });
    expect((await orderRow(manual)).status).toBe("delivered");
  });

  // ───────────────── 3) صافي الربح ─────────────────
  it("🔒 3) صافي الربح: المالك يراه، المحاسب بلا الصلاحية لا يراه، ومع الصلاحية يراه، ونشاط آخر مرفوض", async () => {
    const asOwner: any = await superAdmin(A.tenantId).accountingV2.dashboard({ businessIds: [A.businessId] });
    expect(asOwner.realized).toBeTruthy(); expect(typeof asOwner.realized.netProfit).toBe("number");
    const accSession = await empSession(accA);
    const hidden: any = await accSession.accountingV2.dashboard({ businessIds: [A.businessId] });
    expect(hidden.realized).toBeNull(); expect(hidden.projected).toBeNull(); expect(hidden.profitHidden).toBe(true);
    expect(JSON.stringify(hidden)).not.toContain("netProfit"); expect(JSON.stringify(hidden)).not.toContain("profitMargin");
    expect(hidden.cash).toBeTruthy(); // البيانات التشغيلية المسموحة ما زالت موجودة
    // منح الصلاحية على مستوى الشركة → يراه
    await (await d()).insert(tenantRolePermissions).values({ tenantId: A.tenantId, role: "accountant", permission: "reports.view_profit", isAllowed: true, updatedBy: 1 } as any);
    const shown: any = await accSession.accountingV2.dashboard({ businessIds: [A.businessId] });
    expect(shown.realized).toBeTruthy(); expect(typeof shown.realized.netProfit).toBe("number");
    await (await d()).delete(tenantRolePermissions).where(eq(tenantRolePermissions.tenantId, A.tenantId));
    // محاسب شركة B على نشاط A: مرفوض أو بلا بيانات — لا ربح ولا نقدية لنشاط A
    const cross = await fail(async () => {
      const r: any = await (await empSession(accB)).accountingV2.dashboard({ businessIds: [A.businessId] });
      if (r.cash?.balance || r.realized) throw new Error("leak");
      return r;
    });
    expect(cross.message).not.toBe("leak");
  });

  // ───────────────── 4) الإلغاء والحذف والمرتجع ─────────────────
  it("🔒 4) إلغاء أوردر مؤكد يعيد الكمية مرة واحدة إلى نفس النوع، ولا تتكرر بالتكرار أو التزامن", async () => {
    const oid = await mkOrder(A, prodA, varA);
    const before = await stockOf(varA); const pBefore = await prodStock(prodA);
    await confirmOrder(oid, 1, "owner");
    expect(await stockOf(varA)).toBe(before - 2);
    const r = await owner(A.tenantId).orders.cancel({ orderId: oid, cancelReason: "other" as any, notes: "p5" } as any);
    expect((await orderRow(oid)).status).toBe("cancelled");
    expect(await stockOf(varA)).toBe(before);
    expect(await prodStock(prodA)).toBe(pBefore); // المنتج الأب لم يُلمس
    const ins = (await movesOf(oid)).filter(m => m.type === "in");
    expect(ins).toHaveLength(1); expect(ins[0].variantId).toBe(varA); expect(ins[0].businessId).toBe(A.businessId);
    // إلغاء ثانٍ: لا إعادة ثانية
    await cancelOrder(oid, "other", "p5-again", 1);
    expect(await stockOf(varA)).toBe(before);
    expect((await movesOf(oid)).filter(m => m.type === "in")).toHaveLength(1);
    // تزامن: أوردر آخر مؤكد وإلغاءان في نفس اللحظة → إعادة واحدة
    const o2 = await mkOrder(A, prodA, varA);
    await confirmOrder(o2, 1, "owner");
    const b2 = await stockOf(varA);
    await Promise.all([cancelOrder(o2, "other", "c1", 1), cancelOrder(o2, "other", "c2", 1)]);
    expect(await stockOf(varA)).toBe(b2 + 2);
    expect((await movesOf(o2)).filter(m => m.type === "in")).toHaveLength(1);
    // أوردر لم يُؤكد: الإلغاء لا ينشئ أي حركة
    const o3 = await mkOrder(A, prodA, varA);
    await owner(A.tenantId).orders.cancel({ orderId: o3, cancelReason: "other" as any } as any);
    expect(await movesOf(o3)).toEqual([]);
  });

  it("🔒 4) لا حذف لأوردر مؤكد أو له حركة مخزون؛ حذف الجديد مسموح؛ الحذف الجماعي يُرفض كله", async () => {
    const confirmed = await mkOrder(A, prodA, varA);
    await confirmOrder(confirmed, 1, "owner");
    const r = await fail(() => superAdmin(A.tenantId).orders.delete({ orderId: confirmed }));
    expect(r.code).toBe("BAD_REQUEST"); expect(r.message).toContain("الإلغاء");
    expect(await orderRow(confirmed)).toBeTruthy();
    const fresh = await mkOrder(A, prodA, varA);
    await superAdmin(A.tenantId).orders.delete({ orderId: fresh });
    expect(await orderRow(fresh)).toBeUndefined();
    const fresh2 = await mkOrder(A, prodA, varA);
    const bulk = await fail(() => superAdmin(A.tenantId).orders.bulkDelete({ orderIds: [fresh2, confirmed] }));
    expect(bulk.code).toBe("BAD_REQUEST");
    expect(await orderRow(fresh2)).toBeTruthy(); expect(await orderRow(confirmed)).toBeTruthy();
  });

  it("🔒 4) المرتجع اليدوي: لا إعادة للمخزون ولا للمنتج الأب، وطلب الإعادة مرفوض، والاسترجاع المكرر مرفوض", async () => {
    const oid = await mkOrder(A, prodA, varA);
    await confirmOrder(oid, 1, "owner");
    const vBefore = await stockOf(varA); const pBefore = await prodStock(prodA);
    const rejected = await fail(() => owner(A.tenantId).returns.markAsReturned({ orderId: oid, returnReason: "customer_refused", restoreStock: true } as any));
    expect(rejected.code).toBe("BAD_REQUEST"); expect(rejected.message).toContain("لا يعود للمخزون");
    expect((await orderRow(oid)).status).toBe("confirmed");
    const ok: any = await owner(A.tenantId).returns.markAsReturned({ orderId: oid, returnReason: "customer_refused" } as any);
    expect(ok.stockRestored).toBe(false);
    expect((await orderRow(oid)).status).toBe("returned");
    expect(await stockOf(varA)).toBe(vBefore); expect(await prodStock(prodA)).toBe(pBefore);
    expect((await movesOf(oid)).filter(m => m.type === "in")).toEqual([]);
    const [ret] = await (await d()).select().from(returns).where(eq(returns.orderId, oid));
    expect(ret.stockRestored).toBe(false);
    const dup = await fail(() => owner(A.tenantId).returns.markAsReturned({ orderId: oid, returnReason: "customer_refused" } as any));
    expect(dup.code).not.toBe("ok");
    await expect((await d()).select().from(returns).where(eq(returns.orderId, oid))).resolves.toHaveLength(1);
  });

  // ───────────────── 5) تجميد المسارات المالية المتبقية ─────────────────
  it("🔒 5) كل مسار مالي متبقٍ يفشل برسالة التجميد (ACCOUNTING_MODULE_ENABLED غير مفعّل)", async () => {
    const saved = process.env.ACCOUNTING_MODULE_ENABLED; delete process.env.ACCOUNTING_MODULE_ENABLED;
    try {
      const c = superAdmin(A.tenantId);
      const now = new Date();
      const attempts: Record<string, () => Promise<any>> = {
        shipmentManualEvent: () => c.accountingV2.shipmentManualEvent({ businessId: A.businessId, shipmentId: 1, providerStatusCode: "45", normalizedEvent: "delivered", occurredAt: now, evidenceUrl: "https://example.test/e" } as any),
        dailySettlementRecord: () => c.accountingV2.dailySettlementRecord({ businessId: A.businessId } as any),
        dailySettlementVoid: () => c.accountingV2.dailySettlementVoid({ businessId: A.businessId, settlementId: 1 } as any),
        carrierSettlementApprove: () => c.accountingV2.carrierSettlementApprove({ businessId: A.businessId, settlementId: 1 } as any),
        closingLock: () => c.accountingV2.closingLock({ businessId: A.businessId, closingId: 1 } as any),
        payrollSettingsSave: () => c.payroll.settingsSave({ businessId: A.businessId } as any),
        payrollItemUpdate: () => c.payroll.itemUpdate({ itemId: 1 } as any),
        supplierOpeningBalance: () => c.suppliers.openingBalance({ businessId: A.businessId, supplierKey: "x", amount: 10, occurredAt: now } as any),
        supplierAdjustment: () => c.suppliers.adjustment({ businessId: A.businessId, supplierKey: "x", amount: 10, occurredAt: now } as any),
        goLive: () => c.accountingV2.updateBusinessSettings({ businessId: A.businessId, baseCurrency: "EGP", timezone: "Africa/Cairo", accountingGoLiveAt: new Date("2026-11-01T00:00:00Z"), defaultWarehouseId: 1 } as any),
      };
      for (const [name, fn] of Object.entries(attempts)) {
        const r = await fail(fn);
        expect(`${name}:${r.code}:${r.message}`).toBe(`${name}:FORBIDDEN:${ACCOUNTING_FROZEN_MESSAGE}`);
      }
      // ولا أثر: لا أحداث ولا حركات مالية للنشاط
      expect(await (await d()).select().from(businessEvents).where(eq(businessEvents.businessId, A.businessId))).toEqual([]);
    } finally { if (saved != null) process.env.ACCOUNTING_MODULE_ENABLED = saved; }
  });

  // ───────────────── 6) السُلفة ─────────────────
  it("🔒 6) نفس مفتاح السُلفة لا يصرف مرتين (تكرارًا وتزامنًا)، وموظف شركة أخرى مرفوض", async () => {
    const db = await d();
    const input = { businessId: A.businessId, employeeId: accA, amount: "300.00", advanceDate: new Date("2026-11-03T10:00:00Z"), actor: { id: 1, name: "owner" } } as any;
    const first = await issueEmployeeAdvance(input);
    const second = await issueEmployeeAdvance(input);
    expect(first.duplicate).toBe(false); expect(second.duplicate).toBe(true); expect(second.id).toBe(first.id);
    const count = async () => ({
      advances: (await db.select().from(employeeAdvances).where(eq(employeeAdvances.employeeId, accA))).length,
      treasury: (await db.select().from(treasuryTransactions).where(eq(treasuryTransactions.businessId, A.businessId))).length,
      fin: (await db.select().from(financialTransactions).where(eq(financialTransactions.businessId, A.businessId))).length,
      events: (await db.select().from(businessEvents).where(and(eq(businessEvents.businessId, A.businessId), eq(businessEvents.eventType, "employee_advance.issued")))).length,
    });
    expect(await count()).toEqual({ advances: 1, treasury: 1, fin: 1, events: 1 });
    // تزامن: مفتاح جديد مرتين في نفس اللحظة
    const input2 = { ...input, amount: "150.00", advanceDate: new Date("2026-11-04T10:00:00Z") };
    const results = await Promise.allSettled([issueEmployeeAdvance(input2), issueEmployeeAdvance(input2)]);
    expect(results.filter(r => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(await count()).toEqual({ advances: 2, treasury: 2, fin: 2, events: 2 });
    // موظف شركة B على نشاط A: مرفوض بلا أثر
    const cross = await fail(() => issueEmployeeAdvance({ ...input, employeeId: accB, amount: "99.00" }));
    expect(cross.code).not.toBe("ok");
    expect(await count()).toEqual({ advances: 2, treasury: 2, fin: 2, events: 2 });
  });

  // ───────────────── EasyOrder لم ينكسر ─────────────────
  it("🔑 EasyOrder: «confirmed» يمر عبر confirmOrder فيخصم، وعند عجز المخزون يُرفض بـ200 والأوردر يبقى جديدًا", async () => {
    const db = await d();
    const secret = `p5-secret-${tag}`;
    const chId = insId(await db.insert(salesChannels).values({ businessId: A.businessId, name: "EO", platform: "easyorder", webhookSecret: secret, isActive: true } as any));
    ids.channelIds.push(chId);
    const app = express(); app.use(express.json()); registerWebhookRoutes(app);
    const oid = await mkOrder(A, prodA, varA, { externalOrderId: `EO-${tag}-1`, source: `easyorder:${chId}` });
    const before = await stockOf(varA);
    const ok = await request(app).post("/api/webhooks/easyorder").set("x-webhook-secret", secret)
      .send({ event_type: "order-status-update", order_id: `EO-${tag}-1`, old_status: "pending", new_status: "confirmed" });
    expect(ok.status).toBe(200); expect(ok.body.action).toBe("status_updated");
    expect((await orderRow(oid)).status).toBe("confirmed");
    expect(await stockOf(varA)).toBe(before - 2);
    // عجز: أوردر بكمية أكبر من المخزون → رفض بلا 500، ولا تغيير
    const big = await mkOrder(A, prodA, varA, { externalOrderId: `EO-${tag}-2`, source: `easyorder:${chId}` });
    await db.update(orderItems).set({ quantity: 100000 }).where(eq(orderItems.orderId, big));
    const b2 = await stockOf(varA);
    const rej = await request(app).post("/api/webhooks/easyorder").set("x-webhook-secret", secret)
      .send({ event_type: "order-status-update", order_id: `EO-${tag}-2`, old_status: "pending", new_status: "confirmed" });
    expect(rej.status).toBe(200); expect(rej.body.action).toBe("status_rejected");
    expect((await orderRow(big)).status).toBe("new"); expect(await stockOf(varA)).toBe(b2);
    // «delivered» لشحنة بوسطة من EasyOrder مرفوض أيضًا
    const bosta = await mkOrder(A, prodA, varA, { externalOrderId: `EO-${tag}-3`, source: `easyorder:${chId}`, status: "shipped", bostaShipmentId: `BS2-${tag}` });
    const rej2 = await request(app).post("/api/webhooks/easyorder").set("x-webhook-secret", secret)
      .send({ event_type: "order-status-update", order_id: `EO-${tag}-3`, old_status: "shipped", new_status: "delivered" });
    expect(rej2.status).toBe(200); expect(rej2.body.action).toBe("status_rejected");
    expect((await orderRow(bosta)).status).toBe("shipped");
  });
});
