import { and, asc, eq, sql } from "drizzle-orm";
import { businesses, inventoryBalances, inventoryReservations, orderItems, orders, returnInspectionItems, returnInspections, stocktakeLines, stocktakes, warehouses } from "../drizzle/schema";
import { ledgerAccounts, ledgerTransactions } from "../drizzle/ledgerV3.schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { businessDateKey } from "../shared/businessTime";
import { LedgerError, type LedgerActor } from "../shared/ledgerV3Core";
import { dispatchOrderInventory, reserveOrderInventory } from "./inventoryV2.service";
import { getLedgerStatus, postLedgerTransaction, rawRows, resolveDb, type LedgerDb } from "./ledgerV3.service";
import { flagOrderLedgerReview } from "./ledgerOrders.service";
import { getCarrierSettingValues } from "./ledgerCarrierOps.service";

/**
 * المرحلة 4 — المخزون وتكلفة الأوردر مع Ledger V3. محرك المخزون (الكميات/متوسط التكلفة/الحجز) هو V2 كما هو؛
 * الأثر المالي في V3 فقط. كل المسارات الجديدة تعمل فقط لنشاط له تقييم مخزون (accountingGoLiveAt) **وشركة دفترها مفعّل**:
 *
 *  • الحجز عند التأكيد وفكّه عند الإلغاء (بعد اعتماد التأكيد/الإلغاء نفسه، لا يُسقطهما؛ الفشل مراجعة على الأوردر).
 *  • التسليم لمندوب الشحن بمسح QR: حجز (إن لزم) ثم خروج البضاعة وتثبيت لقطة التكلفة مرة واحدة (مفتاح الخروج الدائم في V2).
 *    لا قيد V3 عند الخروج — التكلفة تُعترف بها عند التسليم الناجح من اللقطة نفسها (ledgerOrders).
 *  • قيمة المخزون الافتتاحية من جرد فعلي معتمد يوم Go-live (المالك فقط) — مرة واحدة لكل مخزن، لا من أرصدة قديمة.
 *  • فروق الجرد اللاحقة، والمرتجع المفحوص (إرجاع للمخزون/إعدام) → قيود V3 بمفاتيح دائمة، بلا تكلفة مكررة.
 */
export class InventoryLedgerError extends Error {}

async function activeContext(d: LedgerDb, businessId: number) {
  const [b] = await d.select({ tenantId: businesses.tenantId, timezone: businesses.timezone, goLiveAt: businesses.accountingGoLiveAt, warehouseId: businesses.defaultWarehouseId })
    .from(businesses).where(eq(businesses.id, businessId)).limit(1);
  if (!b?.tenantId) return null;
  const status = await getLedgerStatus(Number(b.tenantId), d);
  if (!status.tablesPresent || !status.enabled || !status.goLiveDate || b.goLiveAt == null) return null;
  return { tenantId: Number(b.tenantId), timezone: b.timezone || "Africa/Cairo", warehouseId: b.warehouseId ?? null, ledgerGoLive: status.goLiveDate };
}

async function accountIds(d: LedgerDb, tenantId: number, codes: string[]) {
  const rows = await d.select({ id: ledgerAccounts.id, code: ledgerAccounts.code, isActive: ledgerAccounts.isActive }).from(ledgerAccounts).where(eq(ledgerAccounts.tenantId, tenantId));
  const ids: Record<string, number> = {};
  for (const r of rows) if (codes.includes(r.code) && r.isActive === 1) ids[r.code] = r.id;
  const missing = codes.filter(c => ids[c] == null);
  if (missing.length) throw new InventoryLedgerError(`حسابات ناقصة أو موقوفة في الدفتر: ${missing.join("، ")} — جهّز الحسابات القياسية`);
  return ids;
}

const systemActor = { id: 0, name: "النظام (Ledger V3)" };

/** هل مسارات المخزون الجديدة فعّالة لهذا النشاط؟ (تقييم مخزون + دفتر مفعّل) — للواجهة فقط؛ الحارس الحقيقي في كل إجراء. */
export async function isInventoryLedgerActive(businessId: number): Promise<boolean> {
  const d = await resolveDb();
  return (await activeContext(d, businessId)) != null;
}

/** جرود مرشحة للمخزون الافتتاحي (معتمدة يوم Go-live أو السابق) لكل مخزن، بقيمتها وهل سُجّل افتتاحي المخزن. */
export async function listInventoryOpeningCandidates(tenantId: number) {
  const d = await resolveDb();
  const status = await getLedgerStatus(tenantId, d);
  if (!status.enabled || !status.goLiveDate) return { goLiveDate: null, rows: [] as { stocktakeId: number; businessId: number; businessName: string; warehouseId: number; warehouseName: string; approvedDay: string; value: string | null; postedFromStocktakeId: number | null }[] };
  const dayBefore = new Date(`${status.goLiveDate}T12:00:00Z`); dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const allowed = new Set([status.goLiveDate, dayBefore.toISOString().slice(0, 10)]);
  const sts = await d.select({ id: stocktakes.id, businessId: stocktakes.businessId, warehouseId: stocktakes.warehouseId, approvedAt: stocktakes.approvedAt, timezone: businesses.timezone, businessName: businesses.name, warehouseName: warehouses.name })
    .from(stocktakes).innerJoin(businesses, eq(businesses.id, stocktakes.businessId)).leftJoin(warehouses, eq(warehouses.id, stocktakes.warehouseId)).where(and(eq(businesses.tenantId, tenantId), eq(stocktakes.status, "approved")));
  const rows = [];
  for (const st of sts) {
    if (!st.approvedAt) continue;
    const approvedDay = businessDateKey(st.approvedAt, st.timezone || "Africa/Cairo");
    if (!allowed.has(approvedDay)) continue;
    const lines = await d.select({ countedQuantity: stocktakeLines.countedQuantity, unitCostSnapshot: stocktakeLines.unitCostSnapshot }).from(stocktakeLines).where(eq(stocktakeLines.stocktakeId, st.id));
    let value: string | null = null;
    try { value = fromMinorUnits(stocktakeValue(lines as any)); } catch { value = null; }
    const [posted] = await d.select({ ref: ledgerTransactions.sourceReference }).from(ledgerTransactions).where(and(eq(ledgerTransactions.tenantId, tenantId), eq(ledgerTransactions.idempotencyKey, `inventory-opening:warehouse:${st.warehouseId}`))).limit(1);
    rows.push({ stocktakeId: st.id, businessId: st.businessId, businessName: st.businessName, warehouseId: st.warehouseId, warehouseName: st.warehouseName ?? "مخزن", approvedDay, value, postedFromStocktakeId: posted?.ref ? Number(posted.ref) : null });
  }
  return { goLiveDate: status.goLiveDate, rows };
}

/** بعد اعتماد تأكيد الأوردر: حجز المخزون (idempotent). لا يرمي أبدًا. */
export async function afterOrderConfirmed(orderId: number): Promise<"reserved" | "skipped" | "review"> {
  try {
    const d = await resolveDb();
    const [o] = await d.select({ businessId: orders.businessId }).from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) return "skipped";
    const ctx = await activeContext(d, o.businessId);
    if (!ctx) return "skipped";
    try {
      if (ctx.warehouseId == null) throw new InventoryLedgerError("لا مخزن افتراضي للنشاط");
      await reserveOrderInventory({ businessId: o.businessId, orderId, warehouseId: ctx.warehouseId, actor: systemActor });
      return "reserved";
    } catch (e) {
      await flagOrderLedgerReview(d, o.businessId, orderId, `مخزون: تعذر الحجز — ${(e as Error).message}`);
      return "review";
    }
  } catch { return "review"; }
}

/** فك الحجز النشط للأوردر (مرة واحدة، داخل معاملة بقفل الأرصدة). البضاعة الخارجة فعلًا لا تُفك هنا (تحتاج مرتجعًا). */
export async function releaseOrderReservations(businessId: number, orderId: number): Promise<{ released: number; dispatched: boolean }> {
  const d = await resolveDb();
  return d.transaction(async tx => {
    const active = await tx.select().from(inventoryReservations).where(and(eq(inventoryReservations.businessId, businessId), eq(inventoryReservations.orderId, orderId), eq(inventoryReservations.status, "active")))
      .orderBy(asc(inventoryReservations.inventoryBalanceId)).for("update");
    const [consumed] = await tx.select({ n: sql<number>`COUNT(*)` }).from(inventoryReservations).where(and(eq(inventoryReservations.businessId, businessId), eq(inventoryReservations.orderId, orderId), eq(inventoryReservations.status, "consumed")));
    for (const r of active) {
      const [bal] = await tx.select().from(inventoryBalances).where(eq(inventoryBalances.id, r.inventoryBalanceId)).limit(1).for("update");
      if (!bal) continue;
      await tx.update(inventoryBalances).set({ reservedQuantity: Math.max(0, bal.reservedQuantity - r.quantity), version: bal.version + 1 }).where(eq(inventoryBalances.id, bal.id));
      await tx.update(inventoryReservations).set({ status: "released", releasedAt: new Date() }).where(eq(inventoryReservations.id, r.id));
      await tx.update(orderItems).set({ reservedQuantity: 0 }).where(eq(orderItems.id, r.orderItemId));
    }
    return { released: active.length, dispatched: Number(consumed?.n ?? 0) > 0 };
  });
}

/** بعد اعتماد إلغاء الأوردر: فك الحجز؛ أوردر خرجت بضاعته = مراجعة (مرتجع). لا يرمي أبدًا. */
export async function afterOrderCancelled(orderId: number): Promise<"released" | "skipped" | "review"> {
  try {
    const d = await resolveDb();
    const [o] = await d.select({ businessId: orders.businessId }).from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!o) return "skipped";
    const ctx = await activeContext(d, o.businessId);
    if (!ctx) return "skipped";
    const r = await releaseOrderReservations(o.businessId, orderId);
    if (r.dispatched) { await flagOrderLedgerReview(d, o.businessId, orderId, "مخزون: أوردر ملغي بعد خروج البضاعة — سجّل مرتجعًا لإعادتها"); return "review"; }
    return r.released > 0 ? "released" : "skipped";
  } catch { return "review"; }
}

/**
 * التسليم لمندوب الشحن بمسح QR: حجز إن لم يوجد ثم خروج البضاعة وتثبيت لقطة التكلفة — مرة واحدة (مفتاح الخروج الدائم).
 * يرجع تكلفة الأوردر المثبتة من اللقطة.
 */
export async function handoverOrder(input: { businessId: number; orderId: number; actor: { id: number; name: string } }) {
  const d = await resolveDb();
  const ctx = await activeContext(d, input.businessId);
  if (!ctx) throw new InventoryLedgerError("تقييم المخزون أو دفتر الحسابات غير مفعّل لهذا النشاط");
  const [o] = await d.select({ id: orders.id, status: orders.status, orderNumber: orders.orderNumber }).from(orders).where(and(eq(orders.id, input.orderId), eq(orders.businessId, input.businessId))).limit(1);
  if (!o) throw new InventoryLedgerError("الأوردر خارج هذا النشاط");
  // مؤكد/قيد التجهيز/مطبوع يُسلَّم؛ «مشحون» = إعادة مسح (replay بمفتاح الخروج)؛ غير ذلك مرفوض
  if (!["confirmed", "preparing", "printed", "shipped"].includes(o.status))
    throw new InventoryLedgerError(`لا يُسلَّم أوردر بحالة «${o.status}» لمندوب الشحن`);
  const [active] = await d.select({ n: sql<number>`COUNT(*)` }).from(inventoryReservations).where(and(eq(inventoryReservations.businessId, input.businessId), eq(inventoryReservations.orderId, o.id), eq(inventoryReservations.status, "active")));
  const [consumed] = await d.select({ n: sql<number>`COUNT(*)` }).from(inventoryReservations).where(and(eq(inventoryReservations.businessId, input.businessId), eq(inventoryReservations.orderId, o.id), eq(inventoryReservations.status, "consumed")));
  if (Number(active?.n ?? 0) === 0 && Number(consumed?.n ?? 0) === 0) {
    if (ctx.warehouseId == null) throw new InventoryLedgerError("لا مخزن افتراضي للنشاط");
    await reserveOrderInventory({ businessId: input.businessId, orderId: o.id, warehouseId: ctx.warehouseId, actor: input.actor });
  }
  const r = await dispatchOrderInventory({ businessId: input.businessId, orderId: o.id, occurredAt: new Date(), actor: input.actor });
  const items = await d.select({ quantity: orderItems.quantity, stockOutQuantity: orderItems.stockOutQuantity, unitCostSnapshot: orderItems.unitCostSnapshot }).from(orderItems).where(eq(orderItems.orderId, o.id));
  let cost = 0n;
  for (const it of items) if (it.unitCostSnapshot != null) cost += toMinorUnits(String(it.unitCostSnapshot)) * BigInt(it.stockOutQuantity ?? 0);
  const packaging = await postPackagingForOrder(d, ctx, input.businessId, o, { type: "employee", employeeId: input.actor.id });
  return { orderId: o.id, orderNumber: o.orderNumber, duplicate: r.duplicate, cost: fromMinorUnits(cost), packaging };
}

/**
 * التغليف عند التسليم لمندوب الشحن: تكلفة التغليف للأوردر = الإعداد المُدخل للنشاط («packaging.cost_per_order») من «مخزون مواد
 * التغليف» إلى «تكلفة تغليف الأوردرات»، مرة واحدة (`order:<id>:packaging`) — إعادة المسح أو تغيير الإعداد لاحقًا لا يكرر ولا
 * يعدّل. بلا إعداد = لا قيد (لا تخمين). مخزون التغليف لا يكفي = مراجعة على الأوردر والتسليم نفسه لا يفشل. المرتجع لا يعيد
 * التغليف (استُهلك فعلًا)، والإعلانات لا تُحمَّل على الأوردر (مصروف يومها).
 */
async function postPackagingForOrder(d: LedgerDb, ctx: { tenantId: number; timezone: string; ledgerGoLive: string }, businessId: number, o: { id: number; orderNumber: string }, actor: LedgerActor) {
  const key = `order:${o.id}:packaging`;
  const [existing] = await d.select({ id: ledgerTransactions.id }).from(ledgerTransactions).where(and(eq(ledgerTransactions.tenantId, ctx.tenantId), eq(ledgerTransactions.idempotencyKey, key))).limit(1);
  if (existing) return { status: "replay" as const, transactionId: existing.id };
  const value = (await getCarrierSettingValues(d, ctx.tenantId, businessId))["packaging.cost_per_order"];
  if (value == null || toMinorUnits(String(value)) === 0n) return { status: "skipped" as const, reason: "تكلفة التغليف للأوردر غير مُدخلة" };
  const date = businessDateKey(new Date(), ctx.timezone);
  if (date < ctx.ledgerGoLive) return { status: "skipped" as const, reason: "قبل بداية الدفتر" };
  try {
    const acc = await accountIds(d, ctx.tenantId, ["COGS_PACKAGING", "INV_PACKAGING"]);
    const amount = fromMinorUnits(toMinorUnits(String(value)));
    const r = await postLedgerTransaction({ tenantId: ctx.tenantId, sourceBusinessId: businessId, kind: "packaging_consumption", idempotencyKey: key, effectiveDate: date, currency: "EGP", actor,
      entries: [{ accountId: acc.COGS_PACKAGING, side: "debit", amount, businessId }, { accountId: acc.INV_PACKAGING, side: "credit", amount, businessId }],
      description: `تغليف الأوردر ${o.orderNumber}`, sourceType: "order", sourceReference: String(o.id) } as any, d);
    return { status: r.replay ? "replay" as const : "posted" as const, transactionId: r.transactionId, amount };
  } catch (e) {
    const reason = `لم تُسجَّل تكلفة التغليف: ${e instanceof Error ? e.message : String(e)}`;
    await flagOrderLedgerReview(d, businessId, o.id, reason);
    return { status: "review" as const, reason };
  }
}

/**
 * رصيد مخزون التغليف الافتتاحي (المالك فقط) من عدّ فعلي يوم Go-live: مدين «مخزون مواد التغليف» للنشاط / دائن الرصيد
 * الافتتاحي، بتاريخ Go-live، مرة واحدة لكل نشاط. لا يُقرأ أي رصيد قديم.
 */
export async function postPackagingOpening(input: { tenantId: number; businessId: number; amount: string; countedOn: string; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  const [b] = await d.select({ id: businesses.id }).from(businesses).where(and(eq(businesses.id, input.businessId), eq(businesses.tenantId, input.tenantId))).limit(1);
  if (!b) throw new LedgerError("business", `#${input.businessId}`);
  const status = await getLedgerStatus(input.tenantId, d);
  if (!status.enabled || !status.goLiveDate) throw new LedgerError("disabled");
  if (input.countedOn !== status.goLiveDate) throw new InventoryLedgerError(`العدّ بتاريخ ${input.countedOn} — رصيد التغليف الافتتاحي من عدّ يوم Go-live (${status.goLiveDate}) فقط`);
  const value = toMinorUnits(input.amount);
  if (value <= 0n) throw new InventoryLedgerError("قيمة العدّ صفر — لا قيد افتتاحي");
  const acc = await accountIds(d, input.tenantId, ["INV_PACKAGING", "OPENING_EQUITY"]);
  try {
    return await postLedgerTransaction({ tenantId: input.tenantId, sourceBusinessId: input.businessId, kind: "adjustment", idempotencyKey: `packaging-opening:business:${input.businessId}`, effectiveDate: status.goLiveDate, currency: "EGP",
      actor: input.actor, description: "رصيد مخزون التغليف الافتتاحي من عدّ يوم Go-live", sourceType: "packaging_opening", sourceReference: String(input.businessId),
      entries: [{ accountId: acc.INV_PACKAGING, side: "debit", amount: fromMinorUnits(value), businessId: input.businessId }, { accountId: acc.OPENING_EQUITY, side: "credit", amount: fromMinorUnits(value), businessId: null }] } as any, d);
  } catch (e) {
    if (e instanceof LedgerError && e.code === "conflict") throw new InventoryLedgerError("رصيد التغليف الافتتاحي لهذا النشاط مسجّل بالفعل — لا يُكرر");
    throw e;
  }
}

const stocktakeValue = (lines: { countedQuantity: number; unitCostSnapshot: string | null }[]) => {
  let v = 0n;
  for (const l of lines) {
    if (l.unitCostSnapshot == null) throw new InventoryLedgerError("بند جرد بلا تكلفة مثبتة — لا تخمين لقيمة المخزون");
    v += toMinorUnits(String(l.unitCostSnapshot)) * BigInt(l.countedQuantity);
  }
  return v;
};

/**
 * قيمة المخزون الافتتاحية (المالك فقط، ledger.activate) من جرد فعلي معتمد يوم Go-live أو اليوم السابق له:
 * Σ الكمية المعدودة × تكلفة الوحدة المجمّدة. مدين مخزون البضاعة (للنشاط) / دائن الرصيد الافتتاحي، بتاريخ Go-live.
 * مرة واحدة لكل مخزن (مفتاح دائم بالمخزن)؛ لا تُقرأ أي أرصدة V1/V2 نقدية.
 */
export async function postInventoryOpeningFromStocktake(input: { tenantId: number; stocktakeId: number; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  const [st] = await d.select({ id: stocktakes.id, businessId: stocktakes.businessId, warehouseId: stocktakes.warehouseId, status: stocktakes.status, approvedAt: stocktakes.approvedAt, tenantId: businesses.tenantId, timezone: businesses.timezone })
    .from(stocktakes).innerJoin(businesses, eq(businesses.id, stocktakes.businessId)).where(eq(stocktakes.id, input.stocktakeId)).limit(1);
  if (!st || Number(st.tenantId) !== input.tenantId) throw new InventoryLedgerError("الجرد غير موجود في هذه الشركة");
  if (st.status !== "approved" || !st.approvedAt) throw new InventoryLedgerError("الجرد غير معتمد بعد");
  const status = await getLedgerStatus(input.tenantId, d);
  if (!status.enabled || !status.goLiveDate) throw new InventoryLedgerError("دفتر الشركة غير مفعّل");
  const approvedDay = businessDateKey(st.approvedAt, st.timezone || "Africa/Cairo");
  const dayBefore = new Date(`${status.goLiveDate}T12:00:00Z`); dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  if (approvedDay !== status.goLiveDate && approvedDay !== dayBefore.toISOString().slice(0, 10))
    throw new InventoryLedgerError(`الجرد معتمد يوم ${approvedDay} — المخزون الافتتاحي من جرد يوم Go-live (${status.goLiveDate}) أو اليوم السابق فقط`);
  const lines = await d.select({ countedQuantity: stocktakeLines.countedQuantity, unitCostSnapshot: stocktakeLines.unitCostSnapshot }).from(stocktakeLines).where(eq(stocktakeLines.stocktakeId, st.id));
  if (lines.length === 0) throw new InventoryLedgerError("الجرد بلا بنود");
  const value = stocktakeValue(lines as any);
  if (value <= 0n) throw new InventoryLedgerError("قيمة الجرد صفر — لا قيد افتتاحي");
  const acc = await accountIds(d, input.tenantId, ["INV_GOODS", "OPENING_EQUITY"]);
  try {
    // «opening_balance» محجوز لأداة التفعيل — المخزون الافتتاحي تسوية بمصدر صريح «inventory_opening» ومفتاح دائم بالمخزن
    return await postLedgerTransaction({ tenantId: input.tenantId, sourceBusinessId: st.businessId, kind: "adjustment", idempotencyKey: `inventory-opening:warehouse:${st.warehouseId}`, effectiveDate: status.goLiveDate, currency: "EGP",
      actor: input.actor, description: `مخزون افتتاحي من الجرد #${st.id}`, sourceType: "inventory_opening", sourceReference: String(st.id),
      entries: [{ accountId: acc.INV_GOODS, side: "debit", amount: fromMinorUnits(value), businessId: st.businessId }, { accountId: acc.OPENING_EQUITY, side: "credit", amount: fromMinorUnits(value), businessId: null }] } as any, d);
  } catch (e) {
    if (e instanceof LedgerError && e.code === "conflict") throw new InventoryLedgerError("المخزون الافتتاحي لهذا المخزن مسجّل بالفعل من جرد آخر — لا يُكرر");
    throw e;
  }
}

/** فروق جرد معتمد بعد Go-live → V3 (ربح/عجز على «فروقات الجرد»)؛ جرد استُخدم كافتتاحي = لا فروق. */
export async function postStocktakeVariance(input: { businessId: number; stocktakeId: number; actor: LedgerActor }) {
  const d = await resolveDb();
  const ctx = await activeContext(d, input.businessId);
  if (!ctx) return { status: "skipped" as const, reason: "الدفتر أو تقييم المخزون غير مفعّل" };
  const [st] = await d.select().from(stocktakes).where(and(eq(stocktakes.id, input.stocktakeId), eq(stocktakes.businessId, input.businessId))).limit(1);
  if (!st || st.status !== "approved" || !st.approvedAt) return { status: "skipped" as const, reason: "الجرد غير معتمد" };
  const [opening] = await d.select({ id: ledgerTransactions.id }).from(ledgerTransactions).where(and(eq(ledgerTransactions.tenantId, ctx.tenantId), eq(ledgerTransactions.sourceType, "inventory_opening"), eq(ledgerTransactions.sourceReference, String(st.id)))).limit(1);
  if (opening) return { status: "skipped" as const, reason: "جرد افتتاحي — بلا فروق" };
  const date = businessDateKey(st.approvedAt, ctx.timezone);
  if (date < ctx.ledgerGoLive) return { status: "skipped" as const, reason: "قبل بداية الدفتر" };
  const lines = await d.select({ differenceValue: stocktakeLines.differenceValue }).from(stocktakeLines).where(eq(stocktakeLines.stocktakeId, st.id));
  const net = lines.reduce((s, l) => s + toMinorUnits(String(l.differenceValue ?? "0")), 0n);
  if (net === 0n) return { status: "skipped" as const, reason: "لا فروق" };
  const acc = await accountIds(d, ctx.tenantId, ["INV_GOODS", "INV_VARIANCE"]);
  const amount = fromMinorUnits(net < 0n ? -net : net);
  const entries = net > 0n
    ? [{ accountId: acc.INV_GOODS, side: "debit" as const, amount, businessId: input.businessId }, { accountId: acc.INV_VARIANCE, side: "credit" as const, amount, businessId: input.businessId }]
    : [{ accountId: acc.INV_VARIANCE, side: "debit" as const, amount, businessId: input.businessId }, { accountId: acc.INV_GOODS, side: "credit" as const, amount, businessId: input.businessId }];
  const r = await postLedgerTransaction({ tenantId: ctx.tenantId, sourceBusinessId: input.businessId, kind: "adjustment", idempotencyKey: `stocktake:${st.id}:variance`, effectiveDate: date, currency: "EGP", actor: input.actor,
    description: `فروق الجرد #${st.id} (${net > 0n ? "زيادة" : "عجز"})`, sourceType: "stocktake", sourceReference: String(st.id), entries } as any);
  return { status: r.replay ? "replay" as const : "posted" as const, transactionId: r.transactionId, amount, direction: net > 0n ? "gain" : "loss" };
}

/**
 * مرتجع مفحوص ومعتمد → V3 بلا تكلفة مكررة ولا استلام مرتين (قيد واحد بمفتاح `return-inspection:<id>`):
 *  • بعد التسليم (تكلفته نُقلت لـ«مرتجعات قيد الفحص» عند المرتجع): السليم المُستلم فعليًا ⇒ مخزون، والتالف/الفاقد ⇒ خسائر
 *    المرتجعات — كلاهما من «قيد الفحص»؛ وقيمة الفحص لا تتجاوز المتبقي قيد الفحص لنفس الأوردر (لا استلام مرتين).
 *  • قبل التسليم (لا تكلفة مبيعات مسجّلة، والقيمة ما زالت في المخزون): التالف/الفاقد ⇒ خسائر من المخزون؛ السليم بلا قيد.
 */
/**
 * فتح فحص المرتجع لأوردر رجع من شركة الشحن (مسار بوسطة لا يمر بـshippingV2 الذي كان يفتحه وحده): الكمية المرتجعة لكل بند
 * = ما خرج فعلًا من المخزن (stockOutQuantity) — ما لم يخرج لا يُفحص؛ وفحص «pending» واحد للأوردر. كتابة كميات V2 فقط بلا أي
 * أثر مالي؛ القيمة لا تعود للمخزون إلا بعد الفحص والاعتماد (postReturnInspection). مرة واحدة تحت التزامن (قفل الأوردر)،
 * ولشركة دفترها مفعّل فقط — بلا تغيير لسلوك الشركات الأخرى.
 */
export async function openReturnInspection(input: { businessId: number; orderId: number }) {
  const d = await resolveDb();
  const ctx = await activeContext(d, input.businessId);
  if (!ctx) return { status: "skipped" as const, reason: "الدفتر أو تقييم المخزون غير مفعّل" };
  return d.transaction(async (tx: any) => {
    const [order] = await tx.select({ id: orders.id, status: orders.status }).from(orders)
      .where(and(eq(orders.id, input.orderId), eq(orders.businessId, input.businessId))).limit(1).for("update");
    if (!order) return { status: "skipped" as const, reason: "الأوردر خارج هذا النشاط" };
    if (order.status !== "returned") return { status: "skipped" as const, reason: "الأوردر ليس مرتجعًا" };
    const items = await tx.select({ id: orderItems.id, out: orderItems.stockOutQuantity, returned: orderItems.returnedQuantity }).from(orderItems)
      .where(eq(orderItems.orderId, order.id)).for("update");
    let toInspect = 0;
    for (const it of items) {
      const out = Number(it.out ?? 0), ret = Number(it.returned ?? 0);
      if (ret < out) await tx.update(orderItems).set({ returnedQuantity: out }).where(eq(orderItems.id, it.id));
      toInspect += Math.max(out, ret);
    }
    if (toInspect === 0) return { status: "skipped" as const, reason: "لم يخرج شيء من المخزن — لا فحص" };
    const existing = await tx.select({ id: returnInspections.id, status: returnInspections.status }).from(returnInspections)
      .where(and(eq(returnInspections.businessId, input.businessId), eq(returnInspections.orderId, order.id)));
    if (existing.length > 0) return { status: "exists" as const, inspectionId: existing[0].id };
    const r: any = await tx.insert(returnInspections).values({ businessId: input.businessId, orderId: order.id, status: "pending" });
    return { status: "opened" as const, inspectionId: Number(r?.insertId ?? r?.[0]?.insertId) };
  });
}

export async function postReturnInspection(input: { businessId: number; inspectionId: number; actor: LedgerActor }) {
  const d = await resolveDb();
  const ctx = await activeContext(d, input.businessId);
  if (!ctx) return { status: "skipped" as const, reason: "الدفتر أو تقييم المخزون غير مفعّل" };
  const [insp] = await d.select().from(returnInspections).where(and(eq(returnInspections.id, input.inspectionId), eq(returnInspections.businessId, input.businessId))).limit(1);
  if (!insp || insp.status !== "approved" || !insp.approvedAt) return { status: "skipped" as const, reason: "الفحص غير معتمد" };
  const date = businessDateKey(insp.approvedAt, ctx.timezone);
  if (date < ctx.ledgerGoLive) return { status: "skipped" as const, reason: "قبل بداية الدفتر" };
  const items = await d.select({ quantity: returnInspectionItems.quantity, unitCostSnapshot: returnInspectionItems.unitCostSnapshot, disposition: returnInspectionItems.disposition })
    .from(returnInspectionItems).where(eq(returnInspectionItems.inspectionId, insp.id));
  let restock = 0n, loss = 0n;
  for (const it of items) {
    if (it.unitCostSnapshot == null) throw new InventoryLedgerError("بند مرتجع بلا تكلفة مثبتة");
    const v = toMinorUnits(String(it.unitCostSnapshot)) * BigInt(it.quantity);
    if (it.disposition === "restock") restock += v; else loss += v;
  }
  const key = `return-inspection:${insp.id}`;
  const [delivered] = await d.select({ id: ledgerTransactions.id }).from(ledgerTransactions).where(and(eq(ledgerTransactions.tenantId, ctx.tenantId), eq(ledgerTransactions.idempotencyKey, `order:${insp.orderId}:delivered`))).limit(1);
  const afterDelivery = Boolean(delivered);
  const acc = await accountIds(d, ctx.tenantId, afterDelivery ? ["INV_GOODS", "RETURN_LOSS", "RETURNS_PENDING"] : ["INV_GOODS", "RETURN_LOSS"]);
  type E = { accountId: number; side: "debit" | "credit"; amount: string; businessId: number };
  const entries: E[] = [];
  let guard: ((tx: any) => Promise<void>) | undefined;
  if (afterDelivery) {
    const [moved] = rawRows(await d.execute(sql`SELECT (SELECT SUM(e.amount) FROM ledger_entries e WHERE e.transactionId = t.id AND e.side = 'debit') AS amount
      FROM ledger_transactions t WHERE t.tenantId = ${ctx.tenantId} AND t.idempotencyKey = ${`order:${insp.orderId}:return-cost`}`));
    if (!moved) return { status: "skipped" as const, reason: "المرتجع المالي للأوردر لم يُسجَّل بعد (حدث الإرجاع من شركة الشحن) — أعد المحاولة بعده" };
    // ما استُهلك من «قيد الفحص» لنفس الأوردر بفحوص أخرى — يُفحص داخل transaction الترحيل بعد قفل الحسابات (guard)
    const siblingRefs = (await d.select({ id: returnInspections.id }).from(returnInspections)
      .where(and(eq(returnInspections.businessId, input.businessId), eq(returnInspections.orderId, insp.orderId)))).map(r => String(r.id)).filter(r => r !== String(insp.id));
    const pendingMoved = toMinorUnits(String(moved.amount ?? "0"));
    guard = async (tx: any) => {
      if (restock + loss === 0n) return;
      let used = 0n;
      if (siblingRefs.length > 0) {
        const [row] = rawRows(await tx.execute(sql`SELECT COALESCE(SUM(e.amount), 0) AS amount FROM ledger_transactions t
          JOIN ledger_entries e ON e.transactionId = t.id AND e.side = 'credit' AND e.accountId = ${acc.RETURNS_PENDING}
          WHERE t.tenantId = ${ctx.tenantId} AND t.sourceType = 'return_inspection' AND t.sourceReference IN (${sql.join(siblingRefs.map(r => sql`${r}`), sql`, `)})
          FOR SHARE`));
        used = toMinorUnits(String(row?.amount ?? "0"));
      }
      const remaining = pendingMoved - used;
      if (restock + loss > remaining) throw new InventoryLedgerError(`قيمة الفحص ${fromMinorUnits(restock + loss)} أكبر من المتبقي قيد الفحص للأوردر ${fromMinorUnits(remaining)} — لا استلام مرتين`);
    };
    if (restock > 0n) entries.push({ accountId: acc.INV_GOODS, side: "debit", amount: fromMinorUnits(restock), businessId: input.businessId });
    if (loss > 0n) entries.push({ accountId: acc.RETURN_LOSS, side: "debit", amount: fromMinorUnits(loss), businessId: input.businessId });
    if (restock + loss > 0n) entries.push({ accountId: acc.RETURNS_PENDING, side: "credit", amount: fromMinorUnits(restock + loss), businessId: input.businessId });
  } else if (loss > 0n) {
    entries.push({ accountId: acc.RETURN_LOSS, side: "debit", amount: fromMinorUnits(loss), businessId: input.businessId }, { accountId: acc.INV_GOODS, side: "credit", amount: fromMinorUnits(loss), businessId: input.businessId });
  }
  if (entries.length === 0) return { status: "skipped" as const, reason: afterDelivery ? "لا بنود في الفحص" : "مرتجع قبل التسليم سليم — القيمة في المخزون أصلًا" };
  const r = await postLedgerTransaction({ tenantId: ctx.tenantId, sourceBusinessId: input.businessId, kind: afterDelivery ? "adjustment" : "return_loss", idempotencyKey: key, effectiveDate: date, currency: "EGP", actor: input.actor,
    description: afterDelivery ? `فحص مرتجع #${insp.id}: سليم للمخزون ${fromMinorUnits(restock)} · تالف/فاقد ${fromMinorUnits(loss)}` : `تالف/فاقد مرتجع قبل التسليم — فحص #${insp.id}`,
    sourceType: "return_inspection", sourceReference: String(insp.id), entries, guard } as any);
  return { status: r.replay ? "replay" as const : "posted" as const, transactionId: r.transactionId, restock: fromMinorUnits(restock), loss: fromMinorUnits(loss), afterDelivery };
}
