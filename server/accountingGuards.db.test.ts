import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb, addTreasuryTransaction, getTreasuryBalance, insertOrderWithItems, createProductWithVariants } from "./db";
import { createFinancialAccount, IdempotencyConflictError } from "./accountingV2.service";
import { payExpense } from "./expensesV2.service";
import { recordShipmentEvent, recordIntegrationOrderEvent } from "./shippingV2.service";
import { assertOwned, assertAllOwned, ScopeUnavailableError, OutOfScopeError, RecordNotFoundError } from "./tenantScope";
import {
  businessEvents, businessShippingProviders, businesses, expensePayments, expenses, financialAccounts,
  financialTransactionEntries, financialTransactions, orderItems, orders, products, productVariants,
  shipmentEvents, shipments, shippingProviders, treasuryTransactions,
} from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * حراس المال الحيّة (DB حقيقية): مجموع الخزنة لكل نشاط، منع التكرار في دفع المصروف وحدث
 * الشحنة، تجميد كتابات EasyOrder V2، وfail-closed لحارس الملكية.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN)("💰 حراس المال — DB حقيقية", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const actor = { id: 1, name: "owner" };
  const ids = { orderIds: [] as number[], productIds: [] as number[], expenseIds: [] as number[] };
  let providerCode = "";
  let savedFlag: string | undefined;
  const db = async () => (await getDb())!;
  const owner = (tenantId: number) => appRouter.createCaller({
    user: { id: 1, role: "admin", name: "owner" }, employee: null, tenantId,
    req: { protocol: "https", headers: {}, cookies: {} }, res: { clearCookie: () => {}, cookie: () => {} },
  } as any);
  const code = async (fn: () => Promise<any>) => { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? e?.name ?? "ERR"; } };
  const tBase = { performedBy: 1, performedByName: "owner", description: "اختبار", referenceType: "manual" as const };
  const treasury = (businessId: number, direction: "in" | "out", amount: string) =>
    addTreasuryTransaction({ businessId, type: direction === "in" ? "deposit" : "withdrawal", direction, amount, ...tBase });

  /** أوردر COD ببند واحد مكتمل الخروج من المخزون (شرط التسليم في V2) + شحنة V2. */
  const mkDeliverable = async (fx: CoreTestFixture, productId: number, variantId: number, bspId: number, external: string) => {
    const n = ids.orderIds.length + 1;
    const orderId = await insertOrderWithItems({
      orderNumber: `AG${n}-${tag}`.slice(0, 20), businessId: fx.businessId, customerName: "عميل", customerPhone: "01000000001",
      governorate: "القاهرة", customerAddress: "شارع طويل رقم 10", productName: "p", quantity: 1, totalAmount: "500.00",
      source: "facebook", status: "shipped", paymentMethod: "cod",
    } as any, [{ productId, productName: "p", quantity: 1, variantId, unitPrice: 500 }]);
    ids.orderIds.push(orderId);
    const d = await db();
    await d.update(orderItems).set({ stockOutQuantity: 1, unitCostSnapshot: "200.0000", costCapturedAt: new Date() }).where(eq(orderItems.orderId, orderId));
    const [ins] = await d.insert(shipments).values({ businessId: fx.businessId, orderId, businessShippingProviderId: bspId, externalShipmentId: external, currentStatus: "created" });
    return { orderId, shipmentId: Number((ins as any).insertId) };
  };
  const codCount = async (businessId: number) => (await (await db()).select().from(financialTransactions)
    .where(and(eq(financialTransactions.businessId, businessId), eq(financialTransactions.transactionType, "cod_receivable")))).length;

  let prodA = 0, varA = 0, prodB = 0, varB = 0, bspA = 0, bspB = 0, codAccA = 0;

  beforeAll(async () => {
    savedFlag = process.env.ACCOUNTING_MODULE_ENABLED;
    A = await createCoreTestFixture("ag-a"); B = await createCoreTestFixture("ag-b");
    const pa = await createProductWithVariants(A.businessId, { name: `منتج AG-A ${tag}` }, [{ name: "سادة", sku: `AGA-${tag}`, currentStock: 50, price: "500" }]);
    const pb = await createProductWithVariants(B.businessId, { name: `منتج AG-B ${tag}` }, [{ name: "سادة", sku: `AGB-${tag}`, currentStock: 50, price: "500" }]);
    prodA = pa.productId; varA = pa.variantIds[0]; prodB = pb.productId; varB = pb.variantIds[0]; ids.productIds.push(prodA, prodB);
    // شركة شحن (مصدر تكامل) + حساب ذمم COD لكل نشاط
    providerCode = `easyorder-${tag}`;
    const d = await db();
    const [sp] = await d.insert(shippingProviders).values({ code: providerCode, name: "EasyOrder test" });
    const providerId = Number((sp as any).insertId);
    codAccA = (await createFinancialAccount({ businessId: A.businessId, code: "COD-T", name: "ذمم COD", accountType: "receivable", currencyCode: "EGP", isCashEquivalent: false })).id;
    const codAccB = (await createFinancialAccount({ businessId: B.businessId, code: "COD-T", name: "ذمم COD", accountType: "receivable", currencyCode: "EGP", isCashEquivalent: false })).id;
    const mapping = JSON.stringify({ delivered: "delivered", pickup: "pickup" });
    const [ba] = await d.insert(businessShippingProviders).values({ businessId: A.businessId, providerId, displayName: "EO", codSettlementAccountId: codAccA, statusMappingJson: mapping });
    const [bb] = await d.insert(businessShippingProviders).values({ businessId: B.businessId, providerId, displayName: "EO", codSettlementAccountId: codAccB, statusMappingJson: mapping });
    bspA = Number((ba as any).insertId); bspB = Number((bb as any).insertId);
  });
  afterEach(() => { if (savedFlag == null) delete process.env.ACCOUNTING_MODULE_ENABLED; else process.env.ACCOUNTING_MODULE_ENABLED = savedFlag; });
  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    const bids = [A.businessId, B.businessId];
    await d.delete(shipmentEvents).where(inArray(shipmentEvents.businessId, bids));
    await d.delete(shipments).where(inArray(shipments.businessId, bids));
    await d.delete(financialTransactionEntries).where(inArray(financialTransactionEntries.businessId, bids));
    await d.delete(financialTransactions).where(inArray(financialTransactions.businessId, bids));
    await d.delete(expensePayments).where(inArray(expensePayments.businessId, bids));
    if (ids.expenseIds.length) await d.delete(expenses).where(inArray(expenses.id, ids.expenseIds));
    await d.delete(businessEvents).where(inArray(businessEvents.businessId, bids));
    await d.delete(financialAccounts).where(inArray(financialAccounts.businessId, bids));
    await d.delete(treasuryTransactions).where(inArray(treasuryTransactions.businessId, bids));
    await d.delete(businessShippingProviders).where(inArray(businessShippingProviders.businessId, bids));
    await d.delete(shippingProviders).where(eq(shippingProviders.code, providerCode));
    if (ids.orderIds.length) { await d.delete(orderItems).where(inArray(orderItems.orderId, ids.orderIds)); await d.delete(orders).where(inArray(orders.id, ids.orderIds)); }
    if (ids.productIds.length) { await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds)); await d.delete(products).where(inArray(products.id, ids.productIds)); }
    await B?.cleanup(); await A?.cleanup();
  });

  // ═══ 1) getTreasuryBalance ═══
  describe("1) رصيد الخزنة = مجموع آخر رصيد لكل نشاط", () => {
    it("نشاط واحد، نشاطان، نشاط بلا حركات — ولا «أحدث صف عام»", async () => {
      expect(await getTreasuryBalance([A.businessId])).toBe(0);
      await treasury(A.businessId, "in", "1000.00"); await treasury(A.businessId, "out", "300.00"); // A = 700
      await treasury(B.businessId, "in", "50.00"); // B = 50 — وهو **أحدث** صف عام
      expect(await getTreasuryBalance([A.businessId])).toBe(700);
      expect(await getTreasuryBalance([B.businessId])).toBe(50);
      expect(await getTreasuryBalance([A.businessId, B.businessId])).toBe(750); // كان يرجع 50
      expect(await getTreasuryBalance([999999999])).toBe(0);
      expect(await getTreasuryBalance([])).toBe(0);
    });
    it("🔒 عزل tenant عبر الراوتر: مالك A يرى 700 فقط، ومالك B يرى 50 فقط، وطلب A لنشاط B يُرفض", async () => {
      expect((await owner(A.tenantId).accounting.treasuryBalance({})).balance).toBe(700);
      expect((await owner(B.tenantId).accounting.treasuryBalance({})).balance).toBe(50);
      // طلب A لنشاط B: النطاق يُقصّ إلى لا شيء → صفر (لا يُسرّب رصيد B)
      expect((await owner(A.tenantId).accounting.treasuryBalance({ businessIds: [B.businessId] })).balance).toBe(0);
    });
  });

  // ═══ 2) payExpense idempotency ═══
  describe("2) دفع المصروف — لا دفعة ثانية بنفس العملية؛ التعارض يُرفض", () => {
    let expenseId = 0;
    beforeAll(async () => {
      const d = await db();
      const [ins] = await d.insert(expenses).values({
        businessId: A.businessId, amount: "400.0000", currencyCode: "EGP", status: "accrued", recognizedAmount: "400.0000", paidAmount: "0.0000",
        description: `مصروف اختبار ${tag}`, expenseDate: new Date(), createdBy: 1, createdByName: "owner",
      } as any);
      expenseId = Number((ins as any).insertId); ids.expenseIds.push(expenseId);
    });
    const pay = (amount: string, operationId?: string) =>
      payExpense({ businessId: A.businessId, expenseId, amount, paidAt: new Date(), operationId, actor });
    const paymentsCount = async () => (await (await db()).select().from(expensePayments).where(eq(expensePayments.expenseId, expenseId))).length;

    it("double-click/إعادة إرسال متزامنة بنفس operationId → دفعة واحدة وخصم واحد", async () => {
      const before = await getTreasuryBalance([A.businessId]);
      const results = await Promise.all([pay("100.00", `op-${tag}-1`), pay("100.00", `op-${tag}-1`), pay("100.00", `op-${tag}-1`)]);
      expect(results.filter(r => !r.duplicate)).toHaveLength(1);
      expect(results.filter(r => r.duplicate)).toHaveLength(2);
      expect(await paymentsCount()).toBe(1);
      expect(await getTreasuryBalance([A.businessId])).toBe(before - 100);
      const [row] = await (await db()).select().from(expenses).where(eq(expenses.id, expenseId));
      expect(row.paidAmount).toBe("100.0000"); expect(row.status).toBe("partially_paid");
    });
    it("إعادة المحاولة **بعد** النجاح بنفس operationId → duplicate بلا أي كتابة", async () => {
      const r = await pay("100.00", `op-${tag}-1`);
      expect(r.duplicate).toBe(true); expect(r.treasuryTransactionId).toBeNull();
      expect(await paymentsCount()).toBe(1);
    });
    it("نفس operationId بمبلغ مختلف → IdempotencyConflictError (ليس نجاحًا ولا تكرارًا) وبلا كتابة", async () => {
      await expect(pay("150.00", `op-${tag}-1`)).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(await paymentsCount()).toBe(1);
      expect(await code(() => owner(A.tenantId).accountingV2.expensePay({ businessId: A.businessId, expenseId, amount: "150.00", paidAt: new Date(), operationId: `op-${tag}-1` }))).toBe("CONFLICT");
    });
    it("عملية جديدة (operationId جديد) تدفع عاديًا — الحارس لا يمنع الدفعات الشرعية", async () => {
      const r = await pay("100.00", `op-${tag}-2`);
      expect(r.duplicate).toBe(false); expect(await paymentsCount()).toBe(2);
    });
  });

  // ═══ 3) recordShipmentEvent idempotency + status ═══
  describe("3) حدث الشحنة — ذمة COD واحدة مهما تكرر التسليم", () => {
    it("نفس providerEventId: الأول يسجّل، التكرار المتزامن وبعده لا يضيف شيئًا؛ حمولة مختلفة = تعارض؛ معرّف جديد لشحنة مسلَّمة = متجاهل", async () => {
      process.env.ACCOUNTING_MODULE_ENABLED = "true";
      const { shipmentId } = await mkDeliverable(A, prodA, varA, bspA, `shp-${tag}-1`);
      const deliver = (providerEventId: string, payload: unknown, collectedAmount?: string) => recordShipmentEvent({
        businessId: A.businessId, shipmentId, providerStatusCode: "delivered", normalizedEvent: "delivered", occurredAt: new Date(), payload, providerEventId, actor, collectedAmount,
      });
      const results = await Promise.all([deliver(`ev-${tag}-1`, { s: 1 }), deliver(`ev-${tag}-1`, { s: 1 })]);
      expect(results.filter(r => !r.duplicate)).toHaveLength(1);
      expect(await codCount(A.businessId)).toBe(1);
      // إعادة بعد الالتزام (نفس المعرّف، حمولة خام مختلفة لكن نفس هوية الحدث) → replay بلا كتابة
      expect((await deliver(`ev-${tag}-1`, { s: 1 })).duplicate).toBe(true);
      expect((await deliver(`ev-${tag}-1`, { s: 2, raw: "changed" })).duplicate).toBe(true);
      // نفس المعرّف بهوية مختلفة (مبلغ محصَّل آخر) → تعارض صريح، بلا ذمة ثانية
      await expect(deliver(`ev-${tag}-1`, { s: 2 }, "450.00")).rejects.toBeInstanceOf(IdempotencyConflictError);
      // معرّف جديد لشحنة مسلَّمة فعلًا → متجاهل بسبب الحالة، بلا ذمة ثانية
      const again = await deliver(`ev-${tag}-2`, { s: 3 });
      expect(again).toMatchObject({ duplicate: true, reason: "already_delivered" });
      expect(await codCount(A.businessId)).toBe(1);
      expect((await (await db()).select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, shipmentId))).length).toBe(1);
      // مالك B لا يستطيع تسجيل حدث على شحنة A
      expect(await code(() => recordShipmentEvent({ businessId: B.businessId, shipmentId, providerStatusCode: "delivered", normalizedEvent: "delivered", occurredAt: new Date(), payload: { x: 1 }, providerEventId: `ev-${tag}-9`, actor }))).not.toBe("ok");
      expect(await codCount(B.businessId)).toBe(0);
    });
  });

  // ═══ 4) EasyOrder → V2 مجمّد ═══
  describe("4) تكامل EasyOrder: لا كتابة مالية والوحدة مجمّدة؛ تعمل عند التفعيل؛ عزل نشاطين", () => {
    const integrate = (fx: CoreTestFixture, orderId: number, ref: string) => recordIntegrationOrderEvent({
      businessId: fx.businessId, orderId, integrationCode: providerCode, providerStatusCode: "delivered", occurredAt: new Date(), payload: { ref }, providerEventId: ref,
    });
    const counts = async (bid: number) => {
      const d = await db();
      return {
        shipments: (await d.select().from(shipments).where(eq(shipments.businessId, bid))).length,
        events: (await d.select().from(businessEvents).where(eq(businessEvents.businessId, bid))).length,
        cod: await codCount(bid),
      };
    };
    it("disabled → accounting_not_active وصفر shipments/business_events/cod_receivable جديدة (حتى مع Go-Live مضبوط)", async () => {
      process.env.ACCOUNTING_MODULE_ENABLED = "false";
      await (await db()).update(businesses).set({ accountingGoLiveAt: new Date(Date.now() - 60_000) }).where(eq(businesses.id, B.businessId));
      const orderId = await insertOrderWithItems({
        orderNumber: `AGB1-${tag}`.slice(0, 20), businessId: B.businessId, customerName: "عميل", customerPhone: "01000000001", governorate: "القاهرة",
        customerAddress: "شارع طويل رقم 10", productName: "p", quantity: 1, totalAmount: "500.00", source: "easy_order", status: "shipped", paymentMethod: "cod",
      } as any, [{ productId: prodB, productName: "p", quantity: 1, variantId: varB, unitPrice: 500 }]);
      ids.orderIds.push(orderId);
      await (await db()).update(orderItems).set({ stockOutQuantity: 1, unitCostSnapshot: "200.0000", costCapturedAt: new Date() }).where(eq(orderItems.orderId, orderId));
      const before = await counts(B.businessId);
      const r = await integrate(B, orderId, `eo-${tag}-off`);
      expect(r).toEqual({ ignored: true, reason: "accounting_not_active" });
      expect(await counts(B.businessId)).toEqual(before);
    });
    it("enabled → يُنشئ شحنة التكامل وحدثها وذمة COD مرة واحدة فقط، ونشاط A لا يتأثر", async () => {
      process.env.ACCOUNTING_MODULE_ENABLED = "true";
      const [o] = await (await db()).select().from(orders).where(and(eq(orders.businessId, B.businessId), eq(orders.source, "easy_order")));
      const aBefore = await counts(A.businessId);
      const first = await integrate(B, o.id, `eo-${tag}-on`);
      expect((first as any).ignored).toBeFalsy();
      const replay = await integrate(B, o.id, `eo-${tag}-on`);
      expect((replay as any).duplicate).toBe(true);
      const after = await counts(B.businessId);
      expect(after.shipments).toBe(1); expect(after.cod).toBe(1);
      expect(await counts(A.businessId)).toEqual(aBefore);
      const [row] = await (await db()).select().from(orders).where(eq(orders.id, o.id));
      expect(row.status).toBe("delivered"); expect(row.collectionStatus).toBe("collected");
    });
  });

  // ═══ 5) assertOwned fail-closed ═══
  describe("5) حارس الملكية: تعذّر الإثبات = رفض", () => {
    it("نطاق مجهول (null) → ScopeUnavailableError؛ خارج النطاق → OutOfScope؛ غير موجود → NotFound؛ داخل النطاق → يمر", async () => {
      const orderA = ids.orderIds[0];
      await expect(assertOwned(null, "order", orderA)).rejects.toBeInstanceOf(ScopeUnavailableError);
      await expect(assertAllOwned(null, "order", [orderA])).rejects.toBeInstanceOf(ScopeUnavailableError);
      await expect(assertOwned([B.businessId], "order", orderA)).rejects.toBeInstanceOf(OutOfScopeError);
      await expect(assertOwned([A.businessId], "order", 999999999)).rejects.toBeInstanceOf(RecordNotFoundError);
      await expect(assertOwned([A.businessId], "order", orderA)).resolves.toBeUndefined();
      await expect(assertAllOwned([A.businessId], "order", [orderA, orderA])).resolves.toBeUndefined();
    });
  });
});
