import { sql } from "drizzle-orm";
import { toMinorUnits } from "../shared/accountingMoney";
import { businessDateKey } from "../shared/businessTime";
import { tablesPresent } from "./ledgerCarrierOps.service";
import { orderCostFromSnapshots } from "./ledgerOrders.service";
import { rawRows, type LedgerDb } from "./ledgerV3.service";

/**
 * BUG-88 — قيود مطلوبة فعلًا لشهر ولم تُسجَّل، **من البيانات المصدرية** (لا من أعلام المراجعة التي قد تُمسح ولا من سجل النشاط).
 * كل قاعدة تطابق شروط دالة الترحيل نفسها (الحالة، تاريخ بداية الدفتر، تفعيل تقييم المخزون للنشاط، القيمة) — فالغياب يُحسب مشكلة
 * فقط حين كانت الدالة ستُرحّل قيدًا:
 *  • فرق جرد (postStocktakeVariance): نشاط بتقييم مخزون، جرد معتمد في الشهر بعد Go-live، ليس جردًا افتتاحيًا، ولحركات V2 الفعلية
 *    للاعتماد قيمة غير صفرية (زيادة أو عجز — BUG-89A إجمالي)، أو فروق بلا حركات مثبتة.
 *  • فحص مرتجع (postReturnInspection): نفس الشرطين؛ بعد التسليم = سليم + تالف > 0، قبل التسليم = تالف/فاقد > 0.
 *  • تكلفة أوردر (postOrderDelivered): إيراد تسليم بتاريخ الشهر بلا قيد تكلفة، وتكلفته من اللقطة ليست صفرًا (غير المثبتة = ناقصة).
 *  • مرتجع بعد التسليم (postOrderReturned): حدث إرجاع 46/60 في الشهر لأوردر له إيراد تسليم ⇒ قيد المرتجع، وقيد نقل التكلفة إن
 *    وُجد قيد تكلفة.
 * وطابور مراجعة الدفتر (بعد 0047): أي بند مفتوح للشركة يمنع الإقفال — البند بلا تاريخ حدث، فلا يُنسب لشهر بعينه (تحفّظ مقصود).
 */
export type CloseRequirementGaps = {
  stocktakes: number[];
  returnInspections: number[];
  orderCosts: number[];
  orderReturns: number[] | null; // null = تعذر الفحص (صندوق وارد شركة الشحن غير متاح)
  openReviewItems: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function periodWindow(period: string) {
  const [y, m] = period.split("-").map(Number);
  const start = Date.UTC(y, m - 1, 1), end = Date.UTC(y, m, 1);
  const next = new Date(end).toISOString().slice(0, 10);
  // نافذة أوسع بيومين من الجانبين تغطي أي منطقة زمنية؛ الحسم بتاريخ النشاط المحلي في الكود (نفس businessDateKey الترحيل)
  return { firstDay: `${period}-01`, nextFirstDay: next, from: new Date(start - 2 * DAY_MS), to: new Date(end + 2 * DAY_MS) };
}

async function presentKeys(d: LedgerDb, tenantId: number, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = rawRows(await d.execute(sql`SELECT idempotencyKey AS k FROM ledger_transactions WHERE tenantId = ${tenantId}
    AND idempotencyKey IN (${sql.join(keys.map(k => sql`${k}`), sql`, `)})`));
  return new Set(rows.map((r: any) => String(r.k)));
}

const inPeriod = (approvedAt: unknown, timezone: unknown, period: string, goLive: string) => {
  const day = businessDateKey(new Date(approvedAt as any), (timezone as string) || "Africa/Cairo");
  return day.slice(0, 7) === period && day >= goLive;
};

export async function missingRequiredEntries(d: LedgerDb, input: { tenantId: number; period: string; goLiveDate: string; startMs: number; endMs: number }): Promise<CloseRequirementGaps> {
  const { tenantId, period, goLiveDate } = input;
  const w = periodWindow(period);

  // 1) فروق الجرد
  // BUG-89A: القيد مطلوب لو لحركات V2 الفعلية للاعتماد قيمة غير صفرية (زيادة أو عجز — إجمالي لا صافي)؛ وجرد بفروق بلا حركات
  // مثبتة لا يمكن ترحيله بقيمة صحيحة ⇒ يُعدّ ناقصًا (لا تخمين).
  const stRows = rawRows(await d.execute(sql`SELECT s.id, s.approvedAt, s.businessEventId, b.timezone,
      (SELECT COUNT(*) FROM inventory_transactions it WHERE it.businessId = s.businessId AND it.businessEventId = s.businessEventId
        AND it.sourceType = 'stocktake_line' AND it.valueDelta <> 0) AS valuedMoves,
      (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktakeId = s.id AND l.differenceQuantity <> 0) AS movingLines
    FROM stocktakes s JOIN businesses b ON b.id = s.businessId
    WHERE b.tenantId = ${tenantId} AND b.accountingGoLiveAt IS NOT NULL AND s.status = 'approved' AND s.approvedAt IS NOT NULL
      AND s.approvedAt >= ${w.from} AND s.approvedAt < ${w.to}`))
    .filter((r: any) => inPeriod(r.approvedAt, r.timezone, period, goLiveDate)
      && (Number(r.valuedMoves) > 0 || (r.businessEventId == null && Number(r.movingLines) > 0)));
  let stocktakes: number[] = [];
  if (stRows.length) {
    const ids = stRows.map((r: any) => Number(r.id));
    const posted = await presentKeys(d, tenantId, ids.map(id => `stocktake:${id}:variance`));
    const openings = new Set(rawRows(await d.execute(sql`SELECT sourceReference AS r FROM ledger_transactions WHERE tenantId = ${tenantId}
      AND sourceType = 'inventory_opening' AND sourceReference IN (${sql.join(ids.map(id => sql`${String(id)}`), sql`, `)})`)).map((r: any) => String(r.r)));
    stocktakes = ids.filter(id => !posted.has(`stocktake:${id}:variance`) && !openings.has(String(id)));
  }

  // 2) فحص المرتجعات
  const riRows = rawRows(await d.execute(sql`SELECT ri.id, ri.orderId, ri.approvedAt, b.timezone
    FROM return_inspections ri JOIN businesses b ON b.id = ri.businessId
    WHERE b.tenantId = ${tenantId} AND b.accountingGoLiveAt IS NOT NULL AND ri.status = 'approved' AND ri.approvedAt IS NOT NULL
      AND ri.approvedAt >= ${w.from} AND ri.approvedAt < ${w.to}`))
    .filter((r: any) => inPeriod(r.approvedAt, r.timezone, period, goLiveDate));
  let returnInspections: number[] = [];
  if (riRows.length) {
    const ids = riRows.map((r: any) => Number(r.id));
    const items = rawRows(await d.execute(sql`SELECT inspectionId, quantity, unitCostSnapshot, disposition FROM return_inspection_items
      WHERE inspectionId IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`));
    const delivered = await presentKeys(d, tenantId, riRows.map((r: any) => `order:${r.orderId}:delivered`));
    const posted = await presentKeys(d, tenantId, ids.map(id => `return-inspection:${id}`));
    returnInspections = riRows.filter((r: any) => {
      let restock = 0n, loss = 0n;
      for (const it of items.filter((x: any) => Number(x.inspectionId) === Number(r.id))) {
        const v = toMinorUnits(String(it.unitCostSnapshot)) * BigInt(Number(it.quantity));
        if (it.disposition === "restock") restock += v; else loss += v;
      }
      const required = delivered.has(`order:${r.orderId}:delivered`) ? restock + loss > 0n : loss > 0n;
      return required && !posted.has(`return-inspection:${r.id}`);
    }).map((r: any) => Number(r.id));
  }

  // 3) تكلفة الأوردرات المُسلَّمة بإيراد في الشهر
  const revenue = rawRows(await d.execute(sql`SELECT sourceReference AS orderId FROM ledger_transactions WHERE tenantId = ${tenantId}
    AND sourceType = 'order' AND idempotencyKey LIKE 'order:%:delivered' AND effectiveDate >= ${w.firstDay} AND effectiveDate < ${w.nextFirstDay}`))
    .map((r: any) => Number(r.orderId)).filter(n => Number.isInteger(n) && n > 0);
  let orderCosts: number[] = [];
  if (revenue.length) {
    const cogs = await presentKeys(d, tenantId, revenue.map(id => `order:${id}:cogs`));
    const without = revenue.filter(id => !cogs.has(`order:${id}:cogs`));
    if (without.length) {
      const items = rawRows(await d.execute(sql`SELECT orderId, quantity, stockOutQuantity, unitCostSnapshot FROM order_items
        WHERE orderId IN (${sql.join(without.map(id => sql`${id}`), sql`, `)}) ORDER BY id`));
      orderCosts = without.filter(id => {
        const cost = orderCostFromSnapshots(items.filter((x: any) => Number(x.orderId) === id).map((x: any) => ({
          quantity: Number(x.quantity), stockOutQuantity: x.stockOutQuantity == null ? null : Number(x.stockOutQuantity),
          unitCostSnapshot: x.unitCostSnapshot == null ? null : String(x.unitCostSnapshot) })));
        return cost !== 0n; // null (غير مثبتة) أو > 0 = تكلفة مطلوبة ناقصة
      });
    }
  }

  // 4) المرتجعات بعد التسليم (حدث 46/60 من شركة الشحن داخل الشهر)
  let orderReturns: number[] | null = [];
  try {
    const returned = rawRows(await d.execute(sql`SELECT DISTINCT o.id FROM orders o JOIN businesses b ON b.id = o.businessId
      JOIN carrier_webhook_inbox i ON i.businessId = o.businessId AND i.shipmentId = o.bostaShipmentId AND i.stateCode IN (46, 60)
      WHERE b.tenantId = ${tenantId} AND o.status = 'returned' AND i.eventTimestamp >= ${input.startMs} AND i.eventTimestamp < ${input.endMs}`))
      .map((r: any) => Number(r.id));
    if (returned.length) {
      const keys = await presentKeys(d, tenantId, returned.flatMap(id => [`order:${id}:delivered`, `order:${id}:returned`, `order:${id}:cogs`, `order:${id}:return-cost`]));
      orderReturns = returned.filter(id => keys.has(`order:${id}:delivered`) &&
        (!keys.has(`order:${id}:returned`) || (keys.has(`order:${id}:cogs`) && !keys.has(`order:${id}:return-cost`))));
    }
  } catch { orderReturns = null; }

  // 5) طابور مراجعة الدفتر (0047) — بلا الجدول لا يُسجَّل بند أصلًا
  let openReviewItems = 0;
  if (await tablesPresent(d, ["ledger_carrier_review_items"])) {
    const [row] = rawRows(await d.execute(sql`SELECT COUNT(*) AS n FROM ledger_carrier_review_items WHERE tenantId = ${tenantId} AND status = 'open'`));
    openReviewItems = Number(row?.n ?? 0);
  }

  return { stocktakes, returnInspections, orderCosts, orderReturns, openReviewItems };
}

const refs = (prefix: string, ids: number[]) => ids.slice(0, 5).map(id => `${prefix}${id}`).join("، ") + (ids.length > 5 ? "، …" : "");

/** بنود قائمة الفحص من الفجوات — كل بند ok=false يمنع الإقفال من السيرفر (closeLedgerPeriod → beforeLock). */
export function requirementChecks(g: CloseRequirementGaps) {
  return [
    { key: "stocktake_variances", ok: g.stocktakes.length === 0,
      label: g.stocktakes.length === 0 ? "كل فروق الجرد المعتمدة في الشهر لها قيد" : `${g.stocktakes.length} جرد معتمد بفرق بلا قيد في الدفتر (${refs("جرد #", g.stocktakes)})` },
    { key: "return_inspections", ok: g.returnInspections.length === 0,
      label: g.returnInspections.length === 0 ? "كل فحوص المرتجعات المعتمدة في الشهر لها قيد" : `${g.returnInspections.length} فحص مرتجع معتمد بلا قيد في الدفتر (${refs("فحص #", g.returnInspections)})` },
    { key: "order_costs", ok: g.orderCosts.length === 0,
      label: g.orderCosts.length === 0 ? "كل أوردر له إيراد تسليم في الشهر له قيد تكلفة" : `${g.orderCosts.length} أوردر له إيراد تسليم بلا قيد تكلفة (${refs("أوردر #", g.orderCosts)})` },
    { key: "order_returns", ok: g.orderReturns !== null && g.orderReturns.length === 0,
      label: g.orderReturns === null ? "تعذر فحص المرتجعات (صندوق وارد شركة الشحن غير متاح)"
        : g.orderReturns.length === 0 ? "كل مرتجعات الشهر بعد التسليم لها قيد" : `${g.orderReturns.length} مرتجع بعد التسليم بلا قيد في الدفتر (${refs("أوردر #", g.orderReturns)})` },
    { key: "review_queue", ok: g.openReviewItems === 0,
      label: g.openReviewItems === 0 ? "لا بنود مفتوحة في طابور مراجعة الدفتر" : `${g.openReviewItems} بند مفتوح في طابور مراجعة الدفتر (تسليم/تسوية/تحويل) — يُحل أو يُستبعد قبل الإقفال` },
  ];
}
