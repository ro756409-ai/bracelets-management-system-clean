import { sql } from "drizzle-orm";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { businessDayRange } from "../shared/businessTime";
import { LedgerError } from "../shared/ledgerV3Core";
import { legacyFinanceWritesBetween } from "./legacyFinanceArchive";
import { getLedgerStatus, listLedgerAccountsScoped, listLedgerPeriods, rawRows, reconcileLedgerV3, resolveDb, scopeVisibleTx, type LedgerDb, type LedgerReadScope } from "./ledgerV3.service";

/**
 * المرحلة 7 — تقارير من مصدر واحد متسق (Ledger V3 فقط) داخل نطاق القراءة:
 *  • قائمة الدخل لفترة: الإيراد (منتج/شحن)، تكلفة المبيعات، مجمل الربح، المصروفات حسب التصنيف، خسائر المرتجعات وفروق
 *    الجرد، صافي الربح — كلها أرباح فتتطلب reports.view_profit (يُرفض الطلب كله بدونها، لا أصفار).
 *  • الربح حسب النشاط (قيود كل نشاط؛ قيود الشركة بلا نشاط منفصلة) وحسب المنتج (من لقطات تكلفة الأوردرات وأسعار بنودها؛
 *    أوردر متعدد البنود بلا أسعار كاملة = «غير قابل للتوزيع» لا تقسيم مخمّن).
 *  • ما لنا وما علينا: النقدية منفصلة عن الذمم (COD/سلف موظفين/مقدمات موردين) والالتزامات (موردون/مقدمات عملاء/مرتبات) —
 *    الأرصدة المحجوبة عن النطاق تبقى محجوبة.
 *  • قائمة فحص الإقفال (قراءة فقط): ترتيب الشهور، أوردرات مُسلَّمة بلا قيد، مراجعات «دفتر:» مفتوحة، مطابقة الأرصدة.
 */
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const minor = (v: unknown) => toMinorUnits(v == null ? "0" : String(v));
const fmt = (v: bigint) => fromMinorUnits(v);

async function aggregate(d: LedgerDb, tenantId: number, from: string, to: string, scope: LedgerReadScope, businessId?: number | null) {
  const scoped = scope ? sql` AND ${scopeVisibleTx(scope)}` : sql``;
  const biz = businessId != null ? sql` AND e.businessId = ${businessId}` : sql``;
  return rawRows(await d.execute(sql`SELECT a.id AS accountId, a.code, a.name, a.kind, e.businessId,
      SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE 0 END) AS debit, SUM(CASE WHEN e.side = 'credit' THEN e.amount ELSE 0 END) AS credit
    FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transactionId AND t.tenantId = e.tenantId JOIN ledger_accounts a ON a.id = e.accountId AND a.tenantId = e.tenantId
    WHERE e.tenantId = ${tenantId} AND t.effectiveDate BETWEEN ${from} AND ${to} AND a.kind IN ('revenue','expense','cogs')${scoped}${biz}
    GROUP BY a.id, a.code, a.name, a.kind, e.businessId`));
}

type Line = { code: string; name: string; amount: string };
export type IncomeStatement = {
  from: string; to: string;
  revenue: { total: string; lines: Line[] }; cogs: string; grossProfit: string;
  expenses: { total: string; lines: Line[] }; netProfit: string;
};

function statementFrom(rows: any[], from: string, to: string): IncomeStatement {
  const acc = new Map<string, { code: string; name: string; kind: string; net: bigint }>();
  for (const r of rows) {
    const cur = acc.get(r.code) ?? { code: r.code, name: r.name, kind: r.kind, net: 0n };
    const dr = minor(r.debit), cr = minor(r.credit);
    cur.net += r.kind === "revenue" ? cr - dr : dr - cr;
    acc.set(r.code, cur);
  }
  const all = [...acc.values()].filter(x => x.net !== 0n).sort((a, b) => a.code.localeCompare(b.code));
  const sum = (k: string) => all.filter(x => x.kind === k).reduce((s, x) => s + x.net, 0n);
  const revenue = sum("revenue"), cogs = sum("cogs"), expenses = sum("expense");
  const lines = (k: string) => all.filter(x => x.kind === k).map(x => ({ code: x.code, name: x.name, amount: fmt(x.net) }));
  return { from, to, revenue: { total: fmt(revenue), lines: lines("revenue") }, cogs: fmt(cogs), grossProfit: fmt(revenue - cogs),
    expenses: { total: fmt(expenses), lines: lines("expense") }, netProfit: fmt(revenue - cogs - expenses) };
}

/** دفتر غير مفعّل = «غير متاح» صريح (PRECONDITION) — لا تقرير بأصفار عن بيانات غير موجودة. */
async function assertEnabled(d: LedgerDb, tenantId: number) {
  const s = await getLedgerStatus(tenantId, d);
  if (!s.tablesPresent) throw new LedgerError("unavailable");
  if (!s.enabled) throw new LedgerError("disabled");
}

function assertRange(from: string, to: string) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new LedgerError("date", `${from}..${to}`);
}

export async function incomeStatement(input: { tenantId: number; from: string; to: string; scope: LedgerReadScope; businessId?: number | null }, db?: LedgerDb) {
  assertRange(input.from, input.to);
  const d = await resolveDb(db);
  await assertEnabled(d, input.tenantId);
  return statementFrom(await aggregate(d, input.tenantId, input.from, input.to, input.scope, input.businessId), input.from, input.to);
}

/** الربح حسب النشاط: قيود كل نشاط؛ قيود الشركة (بلا نشاط) سطر مستقل — لا توزيع مخمّن للمصروفات المشتركة. */
export async function profitByBusiness(input: { tenantId: number; from: string; to: string; scope: LedgerReadScope }, db?: LedgerDb) {
  assertRange(input.from, input.to);
  const d = await resolveDb(db);
  await assertEnabled(d, input.tenantId);
  const rows = await aggregate(d, input.tenantId, input.from, input.to, input.scope);
  const names = new Map(rawRows(await d.execute(sql`SELECT id, name FROM businesses WHERE tenantId = ${input.tenantId}`)).map((r: any) => [Number(r.id), r.name]));
  const groups = new Map<string, any[]>();
  for (const r of rows) { const k = r.businessId == null ? "company" : String(r.businessId); groups.set(k, [...(groups.get(k) ?? []), r]); }
  return [...groups.entries()].map(([k, rs]) => ({ businessId: k === "company" ? null : Number(k), name: k === "company" ? "مستوى الشركة (غير موزّع)" : names.get(Number(k)) ?? "نشاط", ...statementFrom(rs, input.from, input.to) }))
    .sort((a, b) => (a.businessId ?? Infinity) - (b.businessId ?? Infinity));
}

/**
 * الربح حسب المنتج من أوردرات سُلّمت في الفترة (قيد التسليم موجود ولم يُعكس): الإيراد بنسبة سعر × كمية كل بند،
 * والتكلفة من لقطة البند نفسه. أوردر بلا أسعار بنود كاملة (وأكثر من بند) = «غير قابل للتوزيع» بإجمالياته.
 */
export async function profitByProduct(input: { tenantId: number; from: string; to: string; scope: LedgerReadScope }, db?: LedgerDb) {
  assertRange(input.from, input.to);
  const d = await resolveDb(db);
  await assertEnabled(d, input.tenantId);
  const scoped = input.scope ? sql` AND ${scopeVisibleTx(input.scope)}` : sql``;
  const delivered = rawRows(await d.execute(sql`SELECT t.id, CAST(t.sourceReference AS UNSIGNED) AS orderId,
      (SELECT SUM(e.amount) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.accountId WHERE e.transactionId = t.id AND e.side = 'credit' AND a.code = 'REVENUE') AS revenue
    FROM ledger_transactions t WHERE t.tenantId = ${input.tenantId} AND t.kind = 'revenue_cod' AND t.sourceType = 'order' AND t.effectiveDate BETWEEN ${input.from} AND ${input.to}
      AND NOT EXISTS (SELECT 1 FROM ledger_transactions r WHERE r.reversalOfTransactionId = t.id)${scoped}`));
  const byProduct = new Map<string, { productId: number | null; name: string; quantity: number; revenue: bigint; cogs: bigint }>();
  let unallocated = { orders: 0, revenue: 0n, cogs: 0n };
  for (const o of delivered) {
    const items = rawRows(await d.execute(sql`SELECT productId, productName, quantity, unitPrice, unitCostSnapshot, stockOutQuantity FROM order_items WHERE orderId = ${Number(o.orderId)} ORDER BY id`));
    const rev = minor(o.revenue);
    const costs = items.map((it: any) => (it.unitCostSnapshot == null ? 0n : minor(it.unitCostSnapshot) * BigInt(it.stockOutQuantity ?? 0)));
    const priced = items.every((it: any) => it.unitPrice != null);
    if (items.length > 1 && !priced) { unallocated = { orders: unallocated.orders + 1, revenue: unallocated.revenue + rev, cogs: unallocated.cogs + costs.reduce((s: bigint, c: bigint) => s + c, 0n) }; continue; }
    const weights = items.map((it: any) => (items.length === 1 ? 1n : minor(it.unitPrice) * BigInt(it.quantity)));
    const totalW = weights.reduce((s: bigint, w: bigint) => s + w, 0n) || 1n;
    let given = 0n;
    items.forEach((it: any, i: number) => {
      const share = i === items.length - 1 ? rev - given : (rev * weights[i]) / totalW; given += share;
      const key = String(it.productId ?? `n:${it.productName}`);
      const cur = byProduct.get(key) ?? { productId: it.productId == null ? null : Number(it.productId), name: it.productName, quantity: 0, revenue: 0n, cogs: 0n };
      cur.quantity += Number(it.quantity); cur.revenue += share; cur.cogs += costs[i];
      byProduct.set(key, cur);
    });
  }
  return {
    from: input.from, to: input.to,
    products: [...byProduct.values()].map(p => ({ ...p, revenue: fmt(p.revenue), cogs: fmt(p.cogs), grossProfit: fmt(p.revenue - p.cogs) })).sort((a, b) => b.quantity - a.quantity),
    unallocated: { orders: unallocated.orders, revenue: fmt(unallocated.revenue), cogs: fmt(unallocated.cogs) },
  };
}

const OURS = new Set(["carrier_receivable", "employee_receivable", "supplier_advance"]);
/**
 * تكلفة/مساهمة الأوردر (المرحلة 7) — لكل أوردر سُلّم في الفترة، من قيوده هو فقط: قيود `order:<id>:*` (تسليم، تكلفة، تغليف،
 * مرتجع، رد/احتجاز)، تسوية شحنته (`bosta-settle:<شحنة>:*` — الرسوم الفعلية)، وقيود فحص مرتجعه. المساهمة = الإيراد − التكلفة
 * − المصروفات المرتبطة به. الإعلانات والمصروفات العامة لا تُوزَّع على الأوردرات (مصروف يومها) — لا توزيع مخمّن.
 */
export async function orderCostReport(input: { tenantId: number; from: string; to: string; scope: LedgerReadScope; businessId?: number | null }, db?: LedgerDb) {
  assertRange(input.from, input.to);
  const d = await resolveDb(db);
  await assertEnabled(d, input.tenantId);
  const scoped = input.scope === null ? sql`` : input.scope.length === 0 ? sql` AND 1 = 0` : sql` AND o.businessId IN (${sql.join(input.scope.map(b => sql`${b}`), sql`, `)})`;
  const biz = input.businessId ? sql` AND o.businessId = ${input.businessId}` : sql``;
  const rows = rawRows(await d.execute(sql`SELECT o.id AS orderId, o.orderNumber, o.businessId, a.kind,
      SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END) AS debitNet,
      MAX(CASE WHEN t.idempotencyKey = CONCAT('order:', o.id, ':returned') THEN 1 ELSE 0 END) AS returned
    FROM ledger_transactions dl
    JOIN orders o ON dl.idempotencyKey = CONCAT('order:', o.id, ':delivered')
    JOIN ledger_transactions t ON t.tenantId = dl.tenantId AND (
      t.idempotencyKey LIKE CONCAT('order:', o.id, ':%')
      OR (o.bostaShipmentId IS NOT NULL AND t.idempotencyKey IN (CONCAT('bosta-settle:', o.bostaShipmentId, ':cod'), CONCAT('bosta-settle:', o.bostaShipmentId, ':fees')))
      OR (t.sourceType = 'return_inspection' AND EXISTS (SELECT 1 FROM return_inspections ri WHERE ri.orderId = o.id AND ri.id = t.sourceReference)))
    JOIN ledger_entries e ON e.transactionId = t.id
    JOIN ledger_accounts a ON a.id = e.accountId AND a.kind IN ('revenue','cogs','expense')
    WHERE dl.tenantId = ${input.tenantId} AND dl.effectiveDate BETWEEN ${input.from} AND ${input.to}${scoped}${biz}
    GROUP BY o.id, o.orderNumber, o.businessId, a.kind ORDER BY o.id LIMIT 3000`));
  const by = new Map<number, { orderId: number; orderNumber: string; businessId: number; revenue: bigint; cost: bigint; expenses: bigint; returned: boolean }>();
  for (const r of rows as any[]) {
    const id = Number(r.orderId);
    const cur = by.get(id) ?? { orderId: id, orderNumber: String(r.orderNumber), businessId: Number(r.businessId), revenue: 0n, cost: 0n, expenses: 0n, returned: false };
    const v = String(r.debitNet ?? "0").startsWith("-") ? -minor(String(r.debitNet).slice(1)) : minor(r.debitNet);
    if (r.kind === "revenue") cur.revenue += -v; else if (r.kind === "cogs") cur.cost += v; else cur.expenses += v;
    cur.returned ||= Number(r.returned) === 1;
    by.set(id, cur);
  }
  const orders = [...by.values()].map(o => ({ ...o, revenue: fmt(o.revenue), cost: fmt(o.cost), expenses: fmt(o.expenses), contribution: fmt(o.revenue - o.cost - o.expenses) }));
  const sum = (k: "revenue" | "cost" | "expenses" | "contribution") => fmt(orders.reduce((s2, o) => s2 + minor(o[k]), 0n));
  return { from: input.from, to: input.to, count: orders.length, totals: { revenue: sum("revenue"), cost: sum("cost"), expenses: sum("expenses"), contribution: sum("contribution") }, orders };
}

const THEIRS = new Set(["supplier_payable", "customer_advance", "payroll_payable"]);
const CASH = new Set(["cash", "bank", "wallet"]);

/** ما لنا وما علينا الآن: النقدية منفصلة عن الذمم والالتزامات؛ رصيد محجوب عن النطاق = null والإجمالي null. */
export async function positionSummary(input: { tenantId: number; scope: LedgerReadScope }, db?: LedgerDb) {
  await assertEnabled(await resolveDb(db), input.tenantId);
  const accounts = await listLedgerAccountsScoped(input.tenantId, input.scope, db);
  const pick = (set: Set<string>) => {
    const rows = accounts.filter(a => set.has(a.kind)).map(a => ({ code: a.code, name: a.name, kind: a.kind, balance: (a as any).balanceHidden ? null : String(a.currentBalance) }));
    const total = rows.some(r => r.balance == null) ? null : fmt(rows.reduce((s, r) => s + minor(r.balance), 0n));
    return { total, rows };
  };
  return { cash: pick(CASH), receivables: pick(OURS), payables: pick(THEIRS), inventory: pick(new Set(["inventory"])) };
}

/** قائمة فحص الإقفال لشهر (قراءة فقط) — لا تُقفل شيئًا؛ القفل يبقى بملاحظة مراجعة إلزامية. */
export async function closeChecklist(input: { tenantId: number; period: string }, db?: LedgerDb) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw new LedgerError("periodNotFound", input.period);
  const d = await resolveDb(db);
  await assertEnabled(d, input.tenantId);
  const status = await getLedgerStatus(input.tenantId, d);
  const periods = await listLedgerPeriods(input.tenantId, d);
  const goLiveMonth = status.goLiveDate?.slice(0, 7) ?? null;
  const prev = (() => { const [y, m] = input.period.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 2, 1)); return dt.toISOString().slice(0, 7); })();
  const prevLocked = goLiveMonth == null || input.period <= goLiveMonth || periods.some(p => p.period === prev && p.status === "locked");
  // حدود الشهر بتوقيت القاهرة كلحظات مطلقة؛ التسليم = حدث بوسطة 45 الفعلي في صندوق الوارد (deliveredAt لا يُملأ من الـwebhook)
  const [y, m] = input.period.split("-").map(Number);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  const startMs = businessDayRange(`${input.period}-01`, "Africa/Cairo").from.getTime();
  const endMs = businessDayRange(`${next}-01`, "Africa/Cairo").from.getTime();
  let missingCount = 0;
  try {
    const [missing] = rawRows(await d.execute(sql`SELECT COUNT(DISTINCT o.id) AS n FROM orders o JOIN businesses b ON b.id = o.businessId
      JOIN carrier_webhook_inbox i ON i.businessId = o.businessId AND i.shipmentId = o.bostaShipmentId AND i.stateCode = 45
      WHERE b.tenantId = ${input.tenantId} AND o.status IN ('delivered','returned') AND i.eventTimestamp >= ${startMs} AND i.eventTimestamp < ${endMs}
        AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.tenantId = ${input.tenantId} AND t.idempotencyKey = CONCAT('order:', o.id, ':delivered'))`));
    missingCount = Number(missing?.n ?? 0);
  } catch { missingCount = -1; } // صندوق الوارد (0039) غير موجود — يُعرض «تعذر الفحص» لا صفر
  const [reviews] = rawRows(await d.execute(sql`SELECT COUNT(*) AS n FROM orders o JOIN businesses b ON b.id = o.businessId WHERE b.tenantId = ${input.tenantId} AND o.needsReview = 1 AND o.reviewReason LIKE '%دفتر:%'`));
  // المرحلة 7: الحسابات القديمة أرشيف — أي كتابة مالية قديمة خلال الشهر (بعد التفعيل) = بند مفتوح
  // من لحظة تفعيل الدفتر فقط: ما قبل التفعيل في نفس الشهر مشروع (قبل Go-live كان القديم هو المعتمد)
  const [en] = rawRows(await d.execute(sql`SELECT ROUND(UNIX_TIMESTAMP(enabledAt) * 1000) AS ms FROM ledger_tenant_flags WHERE tenantId = ${input.tenantId}`));
  const legacyFrom = Math.max(startMs, en?.ms != null ? Number(en.ms) : startMs);
  const legacy = legacyFrom >= endMs ? [] : await legacyFinanceWritesBetween(d, input.tenantId, legacyFrom, endMs);
  let reconciliationOk: boolean | null = null;
  try { reconciliationOk = (await reconcileLedgerV3(input.tenantId, d)).ok; } catch { reconciliationOk = null; }
  const checks = [
    { key: "previous_locked", ok: prevLocked, label: prevLocked ? "الشهر السابق مقفل (ترتيب الشهور سليم)" : `الشهر السابق ${prev} غير مقفل — اقفله أولًا` },
    { key: "deliveries_posted", ok: missingCount === 0, label: missingCount < 0 ? "تعذر فحص التسليمات (صندوق وارد شركة الشحن غير متاح)" : missingCount === 0 ? "كل تسليمات الشهر لها قيد" : `${missingCount} أوردر مُسلَّم في الشهر بلا قيد في الدفتر` },
    { key: "ledger_reviews", ok: Number(reviews?.n ?? 0) === 0, label: Number(reviews?.n ?? 0) === 0 ? "لا مراجعات دفتر مفتوحة" : `${reviews.n} أوردر عليه مراجعة دفتر مفتوحة` },
    { key: "legacy_writes", ok: legacy.length === 0, label: legacy.length === 0 ? "لا كتابات مالية في الحسابات القديمة خلال الشهر" : `كتابات في الحسابات القديمة خلال الشهر: ${legacy.map(l => `${l.label} ${l.count}`).join("، ")} — يجب تسجيلها في الدفتر الجديد` },
    { key: "reconciliation", ok: reconciliationOk === true, label: reconciliationOk == null ? "تعذر تشغيل مطابقة الأرصدة" : reconciliationOk ? "الأرصدة مطابقة لمجموع القيود" : "فرق في مطابقة الأرصدة — راجع قبل الإقفال" },
  ];
  return { period: input.period, ready: checks.every(c => c.ok), checks };
}
