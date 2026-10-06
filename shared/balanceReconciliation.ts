/**
 * مطابقة الأرصدة — الحساب النقي (بلا قاعدة بيانات).
 *
 * القاعدة: الرصيد المخزّن لكل خزنة/حساب لازم يساوي الرصيد المحسوب من حركاته.
 *   • خزنة `treasury_transactions` (سلسلة واحدة لكل نشاط): المخزّن = `balanceAfter` لآخر صف؛
 *     المحسوب = مجموع الداخل − مجموع الخارج. وتُفحص السلسلة نفسها: كل صف لازم يساوي
 *     الصف السابق ± مبلغه (كسر السلسلة = إدخال متوازٍ بلا قفل أو تعديل يدوي).
 *   • حساب `financial_accounts`: المخزّن = `currentBalance`؛ المحسوب = `openingBalance`
 *     + مجموع قيود الدخول − مجموع قيود الخروج من `financial_transaction_entries`.
 *
 * الفصل عن SQL مقصود: الحساب هنا يُختبر بأرقام مكسورة عمدًا للتأكد أنه يكتشفها.
 */

export type TreasuryRow = { id: number; businessId: number; direction: "in" | "out"; amount: string | number; balanceAfter: string | number; transactionDate: Date | string | null };
export type AccountRow = { id: number; businessId: number; code: string; name: string; accountType: string; openingBalance: string | number; currentBalance: string | number; isActive: boolean | number };
export type EntryRow = { accountId: number; direction: "in" | "out"; amount: string | number; createdAt: Date | string | null; transactionId: number };

export type BalanceLine = {
  kind: "treasury" | "financial_account";
  businessId: number;
  /** للخزنة: `treasury`؛ للحساب: الكود */
  key: string;
  label: string;
  stored: number;
  computed: number;
  difference: number;
  movements: number;
  lastMovementAt: string | null;
  /** كسور سلسلة balanceAfter (خزنة فقط): أرقام الصفوف المخالفة */
  chainBreaks: number[];
  ok: boolean;
};

export type BalanceReconciliationReport = {
  generatedAt: string;
  businessIds: number[];
  lines: BalanceLine[];
  ok: boolean;
  mismatches: BalanceLine[];
};

/** فرق أقل من قرش = صفر (تقريب الكسور لا غلط). */
export const TOLERANCE = 0.01;
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const num = (v: string | number | null | undefined) => Number(v ?? 0);
const iso = (d: Date | string | null | undefined) => (d == null ? null : d instanceof Date ? d.toISOString() : String(d));

export function reconcileTreasury(businessId: number, rows: TreasuryRow[]): BalanceLine {
  const sorted = [...rows].filter(r => r.businessId === businessId).sort((a, b) => a.id - b.id);
  let computed = 0;
  let prev = 0;
  const chainBreaks: number[] = [];
  let last: TreasuryRow | null = null;
  for (const r of sorted) {
    const signed = r.direction === "in" ? num(r.amount) : -num(r.amount);
    computed += signed;
    const expectedAfter = round2(prev + signed);
    if (Math.abs(expectedAfter - num(r.balanceAfter)) > TOLERANCE) chainBreaks.push(r.id);
    prev = num(r.balanceAfter);
    last = r;
  }
  const stored = last ? num(last.balanceAfter) : 0;
  const difference = round2(stored - round2(computed));
  return {
    kind: "treasury", businessId, key: "treasury", label: "الخزنة (treasury_transactions)",
    stored: round2(stored), computed: round2(computed), difference,
    movements: sorted.length, lastMovementAt: iso(last?.transactionDate ?? null),
    chainBreaks, ok: Math.abs(difference) <= TOLERANCE && chainBreaks.length === 0,
  };
}

export function reconcileFinancialAccount(account: AccountRow, entries: EntryRow[]): BalanceLine {
  const mine = entries.filter(e => e.accountId === account.id);
  let computed = num(account.openingBalance);
  let lastAt: Date | string | null = null;
  for (const e of mine) {
    computed += e.direction === "in" ? num(e.amount) : -num(e.amount);
    if (e.createdAt != null && (lastAt == null || new Date(e.createdAt) > new Date(lastAt))) lastAt = e.createdAt;
  }
  const stored = num(account.currentBalance);
  const difference = round2(stored - round2(computed));
  return {
    kind: "financial_account", businessId: account.businessId, key: account.code,
    label: `${account.name} (${account.accountType}${account.isActive ? "" : "، موقوف"})`,
    stored: round2(stored), computed: round2(computed), difference,
    movements: mine.length, lastMovementAt: iso(lastAt), chainBreaks: [],
    ok: Math.abs(difference) <= TOLERANCE,
  };
}

export function buildBalanceReport(input: {
  businessIds: number[];
  treasury: TreasuryRow[];
  accounts: AccountRow[];
  entries: EntryRow[];
  now?: Date;
}): BalanceReconciliationReport {
  const lines: BalanceLine[] = [];
  for (const businessId of input.businessIds) {
    lines.push(reconcileTreasury(businessId, input.treasury));
    for (const account of input.accounts.filter(a => a.businessId === businessId).sort((a, b) => a.code.localeCompare(b.code)))
      lines.push(reconcileFinancialAccount(account, input.entries));
  }
  const mismatches = lines.filter(l => !l.ok);
  return { generatedAt: (input.now ?? new Date()).toISOString(), businessIds: input.businessIds, lines, ok: mismatches.length === 0, mismatches };
}

/** هل الهدف يبدو إنتاجًا؟ (مضيف غير محلي واسم قاعدة لا يحوي test) — بلا طباعة أي سر. */
export function looksLikeProductionTarget(databaseUrl: string): { production: boolean; host: string; database: string } {
  let host = "?", database = "?";
  try { const u = new URL(databaseUrl); host = u.hostname; database = u.pathname.replace(/^\//, "") || "?"; } catch { /* يبقى ? */ }
  const local = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(host);
  const test = /test|staging/i.test(database);
  return { production: !local && !test, host, database };
}
