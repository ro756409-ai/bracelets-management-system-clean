import { sql } from "drizzle-orm";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { LEDGER_DAILY_ACCOUNTS } from "../shared/ledgerDailyAccounts";
import { LedgerError, type LedgerActor } from "../shared/ledgerV3Core";
import {
  createLedgerAccount, getLedgerStatus, grantLedgerAccountBusiness, listLedgerAccounts, listLedgerAccountsScoped, listLedgerTransactions, rawRows, resolveDb,
  scopeVisibleTx, type LedgerDb, type LedgerReadScope,
} from "./ledgerV3.service";

/**
 * المرحلة 2 — الاستخدام اليومي (Ledger V3 فقط، بلا أي كتابة في V1/V2):
 *  • تجهيز الحسابات القياسية (تصنيفات المصروفات + حسابات المخزون/التكلفة) — idempotent بالكود، ويربطها بأنشطة الجلسة.
 *  • التقرير اليومي داخل نطاق القراءة: الحركات، المصروفات حسب التصنيف، المشتريات (أصل لا مصروف)، الإيراد،
 *    والنقدية المتاحة/ذمة COD «حتى نهاية اليوم». الربح يُحسب فقط لمن يملك reports.view_profit — وإلا null صريح.
 *  • الأرصدة المحجوبة عن المحاسب (حساب مشترك أو عليه قيود الشركة) تبقى محجوبة هنا بنفس القاعدة — لا صفر ولا مجموع جزئي.
 */
export type DailyAccountsStatus = { present: string[]; missing: string[]; conflicts: string[] };

export async function dailyAccountsStatus(tenantId: number, db?: LedgerDb): Promise<DailyAccountsStatus> {
  const accounts = await listLedgerAccounts(tenantId, db);
  const byCode = new Map(accounts.map(a => [a.code, a]));
  const out: DailyAccountsStatus = { present: [], missing: [], conflicts: [] };
  for (const spec of LEDGER_DAILY_ACCOUNTS) {
    const a = byCode.get(spec.code);
    if (!a) out.missing.push(spec.code);
    else if (a.kind !== spec.kind || a.normalSide !== spec.normalSide) out.conflicts.push(spec.code);
    else out.present.push(spec.code);
  }
  return out;
}

/** ينشئ الناقص فقط (نفس الكود = replay) ويمنح كل أنشطة الجلسة الترحيل عليه. كود موجود بنوع مختلف = لا يُلمس (conflict). */
export async function ensureDailyAccounts(input: { tenantId: number; businessIds: number[]; actor: LedgerActor }, db?: LedgerDb) {
  const before = await dailyAccountsStatus(input.tenantId, db);
  const created: string[] = [];
  for (const spec of LEDGER_DAILY_ACCOUNTS) {
    if (before.conflicts.includes(spec.code)) continue;
    let id: number;
    try {
      const r = await createLedgerAccount({ tenantId: input.tenantId, code: spec.code, name: spec.name, kind: spec.kind, normalSide: spec.normalSide, actor: input.actor }, db);
      id = r.id; if (!r.replay) created.push(spec.code);
    } catch (e) {
      if (e instanceof LedgerError && e.code === "conflict") { before.conflicts.push(spec.code); continue; }
      throw e;
    }
    for (const businessId of input.businessIds) await grantLedgerAccountBusiness({ tenantId: input.tenantId, accountId: id, businessId, actor: input.actor }, db);
  }
  return { created, conflicts: before.conflicts, status: await dailyAccountsStatus(input.tenantId, db) };
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONEY_KINDS = new Set(["cash", "bank", "wallet"]);
const minor = (v: unknown) => toMinorUnits(v == null ? "0" : String(v));
const fmt = (v: bigint) => fromMinorUnits(v);

export type DailyReport = {
  date: string;
  transactions: { rows: unknown[]; total: number };
  countsByKind: { kind: string; count: number }[];
  revenue: string;
  expenses: { total: string; byCategory: { accountId: number; code: string; name: string; amount: string }[] };
  purchases: string;
  cogs: string;
  transfers: string;
  /** النقدية المتاحة (خزن + بنوك + محافظ) حتى نهاية اليوم — null = محجوبة عن نطاقك */
  availableCash: string | null;
  /** ذمة COD على شركات الشحن حتى نهاية اليوم — ليست نقدية — null = محجوبة */
  codReceivable: string | null;
  balances: { accountId: number; code: string; name: string; kind: string; balance: string | null }[];
  /** null + profitHidden = لا صلاحية reports.view_profit */
  profit: string | null;
  profitHidden: boolean;
  /** التاريخ قبل بداية العمل بالدفتر: لا بيانات — الأرصدة null لا صفر */
  beforeGoLive: boolean;
};

export async function dailyLedgerReport(input: { tenantId: number; date: string; scope: LedgerReadScope; businessId?: number | null; canViewProfit: boolean; page?: number }, db?: LedgerDb): Promise<DailyReport> {
  if (!DATE_RE.test(input.date)) throw new LedgerError("date", input.date);
  const d = await resolveDb(db);
  const scoped = input.scope ? sql` AND ${scopeVisibleTx(input.scope)}` : sql``;
  const biz = input.businessId != null ? sql` AND t.sourceBusinessId = ${input.businessId}` : sql``;
  // حركة اليوم لكل حساب ونوع حركة فعلي (العكس يُنسب لنوع أصله فيُصافي المصروف/الشراء نفسه)
  const lines = rawRows(await d.execute(sql`SELECT a.id AS accountId, a.code, a.name, a.kind, COALESCE(o.kind, t.kind) AS effKind,
      SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE 0 END) AS debit, SUM(CASE WHEN e.side = 'credit' THEN e.amount ELSE 0 END) AS credit
    FROM ledger_entries e
    JOIN ledger_transactions t ON t.id = e.transactionId AND t.tenantId = e.tenantId
    LEFT JOIN ledger_transactions o ON o.id = t.reversalOfTransactionId AND o.tenantId = t.tenantId
    JOIN ledger_accounts a ON a.id = e.accountId AND a.tenantId = e.tenantId
    WHERE e.tenantId = ${input.tenantId} AND t.effectiveDate = ${input.date}${scoped}${biz}
    GROUP BY a.id, a.code, a.name, a.kind, effKind ORDER BY a.code`));
  const counts = rawRows(await d.execute(sql`SELECT t.kind AS kind, COUNT(*) AS n FROM ledger_transactions t
    WHERE t.tenantId = ${input.tenantId} AND t.effectiveDate = ${input.date}${scoped}${biz} GROUP BY t.kind ORDER BY t.kind`));

  let revenue = 0n, purchases = 0n, cogs = 0n, transfers = 0n;
  const expenseBy = new Map<number, { accountId: number; code: string; name: string; amount: bigint }>();
  for (const l of lines) {
    const dr = minor(l.debit), cr = minor(l.credit);
    if (l.kind === "revenue") revenue += cr - dr;
    else if (l.kind === "expense") {
      const cur = expenseBy.get(Number(l.accountId)) ?? { accountId: Number(l.accountId), code: l.code, name: l.name, amount: 0n };
      cur.amount += dr - cr; expenseBy.set(cur.accountId, cur);
    } else if (l.kind === "inventory" && l.effKind === "inventory_purchase") purchases += dr - cr;
    else if (l.kind === "cogs") cogs += dr - cr;
    if (l.effKind === "transfer" && MONEY_KINDS.has(l.kind)) transfers += dr; // مبلغ التحويل = جانب الاستلام
  }
  const byCategory = [...expenseBy.values()].filter(x => x.amount !== 0n).sort((a, b) => a.code.localeCompare(b.code));
  const expensesTotal = byCategory.reduce((s, x) => s + x.amount, 0n);

  // الأرصدة حتى نهاية اليوم: لكل حساب ظاهر لنطاقك (نفس قاعدة الحجب) من كل قيوده حتى التاريخ
  const visible = await listLedgerAccountsScoped(input.tenantId, input.scope, db);
  const balanceAccounts = visible.filter(a => MONEY_KINDS.has(a.kind) || a.kind === "carrier_receivable");
  const shown = balanceAccounts.filter(a => !(a as any).balanceHidden);
  const asOf = new Map<number, bigint>();
  if (shown.length) {
    const ids = sql.join(shown.map(a => sql`${a.id}`), sql`, `);
    for (const r of rawRows(await d.execute(sql`SELECT e.accountId, SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE 0 END) AS debit, SUM(CASE WHEN e.side = 'credit' THEN e.amount ELSE 0 END) AS credit
      FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transactionId AND t.tenantId = e.tenantId
      WHERE e.tenantId = ${input.tenantId} AND e.accountId IN (${ids}) AND t.effectiveDate <= ${input.date} GROUP BY e.accountId`))) {
      const a = shown.find(x => x.id === Number(r.accountId))!;
      const net = minor(r.debit) - minor(r.credit);
      asOf.set(a.id, a.normalSide === "debit" ? net : -net);
    }
  }
  const status = await getLedgerStatus(input.tenantId, db);
  const beforeGoLive = !status.goLiveDate || input.date < status.goLiveDate;
  const balances = balanceAccounts.map(a => ({
    accountId: a.id, code: a.code, name: a.name, kind: a.kind,
    balance: beforeGoLive || (a as any).balanceHidden ? null : fmt(asOf.get(a.id) ?? 0n),
  }));
  const sumOf = (pred: (k: string) => boolean) => {
    const rows = balances.filter(b => pred(b.kind));
    if (rows.some(b => b.balance == null)) return null;
    return fmt(rows.reduce((s, b) => s + minor(b.balance), 0n));
  };

  const transactions = await listLedgerTransactions(input.tenantId, { page: input.page ?? 1, limit: 100, from: input.date, to: input.date, scope: input.scope, businessId: input.businessId ?? undefined }, db);
  return {
    date: input.date,
    transactions: { rows: transactions.rows, total: transactions.total },
    countsByKind: counts.map(c => ({ kind: String(c.kind), count: Number(c.n) })),
    revenue: fmt(revenue),
    expenses: { total: fmt(expensesTotal), byCategory: byCategory.map(x => ({ ...x, amount: fmt(x.amount) })) },
    purchases: fmt(purchases), cogs: fmt(cogs), transfers: fmt(transfers),
    availableCash: sumOf(k => MONEY_KINDS.has(k)), codReceivable: sumOf(k => k === "carrier_receivable"),
    balances,
    profit: input.canViewProfit && !beforeGoLive ? fmt(revenue - expensesTotal - cogs) : null,
    profitHidden: !input.canViewProfit,
    beforeGoLive,
  };
}
