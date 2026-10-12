import { and, asc, eq } from "drizzle-orm";
import { businesses, orderItems, orders } from "../drizzle/schema";
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from "../drizzle/ledgerV3.schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { businessDateKey } from "../shared/businessTime";
import { LedgerError, type LedgerActor } from "../shared/ledgerV3Core";
import { getLedgerStatus, postLedgerTransaction, resolveDb, reverseLedgerTransaction, type LedgerDb } from "./ledgerV3.service";

/**
 * المرحلتان 3/4 — الأثر المالي للأوردر في Ledger V3 فقط (لا كتابة V1/V2)، مرة واحدة بمفاتيح دائمة:
 *
 *  • التسليم الناجح (`order:<id>:delivered`): مدين ذمة COD بوسطة بمبلغ التحصيل الذي أبلغته بوسطة؛ دائن إيراد المنتج
 *    (الإجمالي − الشحن) وإيراد الشحن المحصّل من العميل منفصلًا. لا تخمين: مبلغ تحصيل غائب أو ≠ إجمالي الأوردر = مراجعة بلا قيد.
 *  • التكلفة (`order:<id>:cogs`): من لقطة تكلفة الأوردر المثبتة عند خروج البضاعة (unitCostSnapshot × الكمية الخارجة)؛
 *    لقطة ناقصة = مراجعة «تكلفة غير مثبتة» بلا قيد تكلفة (لا تكلفة مقدّرة).
 *  • المرتجع بعد التسليم (`order:<id>:returned`): عكس قيد التسليم (الإيراد والذمة)، ثم تحويل التكلفة إلى «خسائر المرتجعات»
 *    (`order:<id>:return-loss`) — الربح لا يتضخم والمرتجع خسارة نهائية افتراضيًا؛ مرتجع قبل التسليم = لا أثر مالي.
 *  • يعمل فقط لشركة دفترها مفعّل، وبتاريخ القاهرة/منطقة النشاط من لحظة الحدث، ولا يسبق Go-live، ولا يدخل شهرًا مقفولًا
 *    (الرفض يتحول لمراجعة واضحة على الأوردر «دفتر: …» — لا يُسقط الـwebhook ولا يُعاد تأريخ الحركة).
 */
export type OrderLedgerOutcome =
  | { status: "posted" | "replay"; transactionIds: number[]; review?: string }
  | { status: "skipped"; reason: string }
  | { status: "review"; reason: string; transactionIds?: number[] };

const REVIEW_PREFIX = "دفتر:";

async function orderContext(d: LedgerDb, businessId: number) {
  const [b] = await d.select({ tenantId: businesses.tenantId, timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  if (!b?.tenantId) return null;
  return { tenantId: Number(b.tenantId), timezone: b.timezone || "Africa/Cairo" };
}

async function accountsByCode(d: LedgerDb, tenantId: number, codes: string[]) {
  const rows = await d.select({ id: ledgerAccounts.id, code: ledgerAccounts.code, isActive: ledgerAccounts.isActive }).from(ledgerAccounts).where(eq(ledgerAccounts.tenantId, tenantId));
  const map = new Map(rows.filter(r => codes.includes(r.code)).map(r => [r.code, r]));
  const missing = codes.filter(c => !map.get(c) || map.get(c)!.isActive !== 1);
  return { ids: Object.fromEntries([...map].map(([c, r]) => [c, r.id])) as Record<string, number>, missing };
}

async function txByKey(d: LedgerDb, tenantId: number, key: string) {
  const [t] = await d.select({ id: ledgerTransactions.id }).from(ledgerTransactions).where(and(eq(ledgerTransactions.tenantId, tenantId), eq(ledgerTransactions.idempotencyKey, key))).limit(1);
  return t?.id ?? null;
}

/** سبب مراجعة على الأوردر (يُضاف مرة واحدة) — نفس عمودي المراجعة الحاليين. */
export async function flagOrderLedgerReview(d: LedgerDb, businessId: number, orderId: number, reason: string): Promise<void> {
  const [o] = await d.select({ reviewReason: orders.reviewReason }).from(orders).where(and(eq(orders.id, orderId), eq(orders.businessId, businessId))).limit(1);
  if (!o) return;
  const text = `${REVIEW_PREFIX} ${reason}`;
  const parts = (o.reviewReason ?? "").split(" | ").map(s => s.trim()).filter(Boolean);
  if (!parts.includes(text)) parts.push(text);
  await d.update(orders).set({ needsReview: true, reviewReason: parts.join(" | ") }).where(and(eq(orders.id, orderId), eq(orders.businessId, businessId)));
}

const reasonOf = (e: unknown) => (e instanceof LedgerError ? e.message : e instanceof Error ? e.message : String(e));

async function gate(d: LedgerDb, businessId: number, occurredAt: Date) {
  const ctx = await orderContext(d, businessId);
  if (!ctx) return { skip: "النشاط بلا شركة" } as const;
  const status = await getLedgerStatus(ctx.tenantId, d);
  if (!status.tablesPresent || !status.enabled) return { skip: "دفتر الشركة غير مفعّل" } as const;
  const date = businessDateKey(occurredAt, ctx.timezone);
  if (!status.goLiveDate || date < status.goLiveDate) return { skip: `قبل بداية الدفتر (${date})` } as const;
  return { ctx, date } as const;
}

/** تكلفة الأوردر من اللقطة المثبتة عند الخروج — null = غير مثبتة (لا تخمين). */
export function orderCostFromSnapshots(items: { quantity: number; stockOutQuantity: number | null; unitCostSnapshot: string | null }[]): bigint | null {
  if (items.length === 0) return null;
  let total = 0n;
  for (const it of items) {
    if (it.unitCostSnapshot == null || it.stockOutQuantity == null || it.stockOutQuantity !== it.quantity) return null;
    total += toMinorUnits(String(it.unitCostSnapshot)) * BigInt(it.stockOutQuantity);
  }
  return total;
}

export async function postOrderDelivered(input: { businessId: number; orderId: number; cod: number | null; occurredAt: Date; actor: LedgerActor }, db?: LedgerDb): Promise<OrderLedgerOutcome> {
  const d = await resolveDb(db);
  const g = await gate(d, input.businessId, input.occurredAt);
  if ("skip" in g) return { status: "skipped", reason: g.skip as string };
  const { ctx, date } = g;
  const [order] = await d.select().from(orders).where(and(eq(orders.id, input.orderId), eq(orders.businessId, input.businessId))).limit(1);
  if (!order) return { status: "skipped", reason: "الأوردر خارج هذا النشاط" };
  if (order.status !== "delivered") return { status: "skipped", reason: `حالة الأوردر «${order.status}» ليست تسليمًا` };
  const review = async (reason: string, ids?: number[]): Promise<OrderLedgerOutcome> => { await flagOrderLedgerReview(d, input.businessId, input.orderId, reason); return { status: "review", reason, transactionIds: ids }; };

  const total = toMinorUnits(String(order.totalAmount));
  const fees = toMinorUnits(String(order.shippingFees ?? "0"));
  if (fees < 0n || fees > total) return review(`الشحن (${fromMinorUnits(fees)}) أكبر من إجمالي الأوردر (${fromMinorUnits(total)})`);
  if (input.cod == null) return review("مبلغ التحصيل غير مذكور في حدث التسليم — لم يُسجَّل الإيراد");
  const cod = toMinorUnits(input.cod.toFixed(4));
  if (cod !== total) return review(`مبلغ التحصيل من بوسطة ${fromMinorUnits(cod)} ≠ إجمالي الأوردر ${fromMinorUnits(total)} — لم يُسجَّل الإيراد`);
  if (total === 0n) return { status: "skipped", reason: "أوردر بلا مبلغ" };

  const need = ["COD_BOSTA", "REVENUE", ...(fees > 0n ? ["REV_SHIPPING"] : [])];
  const acc = await accountsByCode(d, ctx.tenantId, need);
  if (acc.missing.length) return review(`حسابات ناقصة أو موقوفة: ${acc.missing.join("، ")} — جهّز الحسابات القياسية`);

  const biz = input.businessId;
  const productRevenue = total - fees;
  const entries = [
    { accountId: acc.ids.COD_BOSTA, side: "debit" as const, amount: fromMinorUnits(total), businessId: biz },
    ...(productRevenue > 0n ? [{ accountId: acc.ids.REVENUE, side: "credit" as const, amount: fromMinorUnits(productRevenue), businessId: biz }] : []),
    ...(fees > 0n ? [{ accountId: acc.ids.REV_SHIPPING, side: "credit" as const, amount: fromMinorUnits(fees), businessId: biz }] : []),
  ];
  let revenueTx: number; let replay = false;
  try {
    const r = await postLedgerTransaction({ tenantId: ctx.tenantId, sourceBusinessId: biz, kind: "revenue_cod", idempotencyKey: `order:${order.id}:delivered`, effectiveDate: date, currency: "EGP",
      actor: input.actor, entries, description: `تسليم الأوردر ${order.orderNumber}`, sourceType: "order", sourceReference: String(order.id) } as any, d);
    revenueTx = r.transactionId; replay = r.replay;
  } catch (e) { return review(`لم يُسجَّل الإيراد: ${reasonOf(e)}`); }

  // التكلفة من اللقطة المثبتة فقط
  const items = await d.select({ quantity: orderItems.quantity, stockOutQuantity: orderItems.stockOutQuantity, unitCostSnapshot: orderItems.unitCostSnapshot }).from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(asc(orderItems.id));
  const cost = orderCostFromSnapshots(items as any);
  if (cost == null) return review("تكلفة الأوردر غير مثبتة (لم يخرج من المخزون بلقطة تكلفة) — لم تُسجَّل التكلفة", [revenueTx]);
  if (cost === 0n) return { status: replay ? "replay" : "posted", transactionIds: [revenueTx] };
  const stock = await accountsByCode(d, ctx.tenantId, ["COGS", "INV_GOODS"]);
  if (stock.missing.length) return review(`حسابات التكلفة ناقصة: ${stock.missing.join("، ")}`, [revenueTx]);
  try {
    const c = await postLedgerTransaction({ tenantId: ctx.tenantId, sourceBusinessId: biz, kind: "cost_of_sales", idempotencyKey: `order:${order.id}:cogs`, effectiveDate: date, currency: "EGP", actor: input.actor,
      entries: [{ accountId: stock.ids.COGS, side: "debit", amount: fromMinorUnits(cost), businessId: biz }, { accountId: stock.ids.INV_GOODS, side: "credit", amount: fromMinorUnits(cost), businessId: biz }],
      description: `تكلفة الأوردر ${order.orderNumber}`, sourceType: "order", sourceReference: String(order.id) } as any, d);
    return { status: replay && c.replay ? "replay" : "posted", transactionIds: [revenueTx, c.transactionId] };
  } catch (e) { return review(`لم تُسجَّل التكلفة: ${reasonOf(e)}`, [revenueTx]); }
}

export async function postOrderReturned(input: { businessId: number; orderId: number; occurredAt: Date; actor: LedgerActor }, db?: LedgerDb): Promise<OrderLedgerOutcome> {
  const d = await resolveDb(db);
  const g = await gate(d, input.businessId, input.occurredAt);
  if ("skip" in g) return { status: "skipped", reason: g.skip as string };
  const { ctx, date } = g;
  const [order] = await d.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(and(eq(orders.id, input.orderId), eq(orders.businessId, input.businessId))).limit(1);
  if (!order) return { status: "skipped", reason: "الأوردر خارج هذا النشاط" };
  const delivered = await txByKey(d, ctx.tenantId, `order:${order.id}:delivered`);
  if (delivered == null) return { status: "skipped", reason: "مرتجع قبل التسليم — لا إيراد ولا تكلفة مسجّلة" };
  const review = async (reason: string, ids?: number[]): Promise<OrderLedgerOutcome> => { await flagOrderLedgerReview(d, input.businessId, input.orderId, reason); return { status: "review", reason, transactionIds: ids }; };
  const ids: number[] = []; let allReplay = true;
  try {
    const r = await reverseLedgerTransaction({ tenantId: ctx.tenantId, transactionId: delivered, idempotencyKey: `order:${order.id}:returned`, effectiveDate: date, reason: `مرتجع بعد التسليم — الأوردر ${order.orderNumber}`, actor: input.actor }, d);
    ids.push(r.transactionId); allReplay &&= r.replay;
  } catch (e) {
    if (!(e instanceof LedgerError && e.code === "reversedAlready")) return review(`لم يُعكس الإيراد: ${reasonOf(e)}`);
    const existing = await txByKey(d, ctx.tenantId, `order:${order.id}:returned`);
    if (existing == null) return review("قيد التسليم معكوس بحركة أخرى — راجع يدويًا");
    ids.push(existing);
  }
  const cogsTx = await txByKey(d, ctx.tenantId, `order:${order.id}:cogs`);
  if (cogsTx == null) return { status: allReplay ? "replay" : "posted", transactionIds: ids };
  const acc = await accountsByCode(d, ctx.tenantId, ["RETURN_LOSS", "COGS"]);
  if (acc.missing.length) return review(`حسابات المرتجع ناقصة: ${acc.missing.join("، ")}`, ids);
  // مبلغ التكلفة المسجّل نفسه (لا إعادة حساب)
  const [line] = await d.select({ amount: ledgerEntries.amount }).from(ledgerEntries).where(and(eq(ledgerEntries.transactionId, cogsTx), eq(ledgerEntries.side, "debit"))).limit(1);
  try {
    const r = await postLedgerTransaction({ tenantId: ctx.tenantId, sourceBusinessId: input.businessId, kind: "return_loss", idempotencyKey: `order:${order.id}:return-loss`, effectiveDate: date, currency: "EGP", actor: input.actor,
      entries: [{ accountId: acc.ids.RETURN_LOSS, side: "debit", amount: String(line.amount), businessId: input.businessId }, { accountId: acc.ids.COGS, side: "credit", amount: String(line.amount), businessId: input.businessId }],
      description: `خسارة مرتجع الأوردر ${order.orderNumber}`, sourceType: "order", sourceReference: String(order.id) } as any, d);
    ids.push(r.transactionId); allReplay &&= r.replay;
    return { status: allReplay ? "replay" : "posted", transactionIds: ids };
  } catch (e) { return review(`لم تُسجَّل خسارة المرتجع: ${reasonOf(e)}`, ids); }
}

/**
 * نقطة الربط من webhook بوسطة بعد تطبيق الحدث على الأوردر — لا ترمي أبدًا (أي فشل غير متوقع = مراجعة على الأوردر)،
 * ولا تعمل إلا عندما يكون الحدث قد نقل الأوردر فعلًا إلى «تم التسليم» أو «مرتجع».
 */
export async function afterCarrierOrderUpdate(input: { businessId: number; orderId: number; orderStatus: string | null | undefined; eventStatus: string | null | undefined; cod: number | null; occurredAt: Date }): Promise<OrderLedgerOutcome | null> {
  if (!input.eventStatus || input.orderStatus !== input.eventStatus) return null;
  const actor: LedgerActor = { type: "webhook" };
  try {
    if (input.eventStatus === "delivered") return await postOrderDelivered({ businessId: input.businessId, orderId: input.orderId, cod: input.cod, occurredAt: input.occurredAt, actor });
    if (input.eventStatus === "returned") return await postOrderReturned({ businessId: input.businessId, orderId: input.orderId, occurredAt: input.occurredAt, actor });
    return null;
  } catch (e) {
    try { const d = await resolveDb(); await flagOrderLedgerReview(d, input.businessId, input.orderId, `خطأ غير متوقع في القيد: ${reasonOf(e)}`); } catch { /* لا يُسقط الـwebhook */ }
    return { status: "review", reason: reasonOf(e) };
  }
}
