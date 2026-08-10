/**
 * تدقيق الأرقام — إثبات إن الدفاتر متساوية.
 *
 * الملف ده **مالوش أي علاقة بقاعدة البيانات**. بياخد الأرقام الجاهزة ويقول: هل المعادلة
 * صح ولا لأ، وفين الفرق بالظبط.
 *
 * الفصل ده مش تنظيم — هو اللي بيخلي التدقيق نفسه **مُختبَر**. لو الحساب كان جوه استعلام
 * SQL، مكانش فيه طريقة نتأكد إنه بيمسك الغلط غير إننا نخرّب بيانات حقيقية ونشوف.
 * هنا بنقدر نديله أرقام غلط عن قصد ونتأكد إنه بيصرخ.
 *
 * القاعدة اللي بيحرسها: **حركة واقعية واحدة = أثر مالي واحد.**
 */

export type Check = {
  label: string;
  expected: number;
  actual: number;
  difference: number;
  ok: boolean;
};

export type ReconciliationReport = {
  checks: Check[];
  ok: boolean;
  failures: Check[];
};

/** فرق أقل من قرش اعتبره صفر — الكسور بتيجي من التقريب مش من غلط. */
const TOLERANCE = 0.01;

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function check(label: string, expected: number, actual: number): Check {
  const difference = round2(actual - expected);
  return {
    label,
    expected: round2(expected),
    actual: round2(actual),
    difference,
    ok: Math.abs(difference) < TOLERANCE,
  };
}

// ───────────────────────── الخزنة ─────────────────────────

export type TreasuryInputs = {
  /** أول `balanceAfter` ناقص أول مبلغ — أو صفر لو الخزنة بتبدأ من الأول. */
  openingBalance: number;
  collections: number;
  deposits: number;
  expensesPaid: number;
  advertisingPaid: number;
  payrollPaid: number;
  supplierPayments: number;
  withdrawals: number;
  /** آخر `balanceAfter` في الجدول — الرقم اللي التاجر بيشوفه. */
  currentBalance: number;
};

/**
 * الرصيد الافتتاحي + الداخل − الخارج = الرصيد الحالي.
 *
 * لو الفرق مش صفر، يبقى فيه حركة اتسجّلت في الخزنة من غير ما تتصنّف، أو حركة اتحسبت
 * مرتين، أو `balanceAfter` اتكتب غلط في صف.
 */
export function reconcileTreasury(input: TreasuryInputs): Check {
  const expected =
    input.openingBalance +
    input.collections +
    input.deposits -
    input.expensesPaid -
    input.advertisingPaid -
    input.payrollPaid -
    input.supplierPayments -
    input.withdrawals;
  return check("رصيد الخزنة", expected, input.currentBalance);
}

// ───────────────────────── المصنع ─────────────────────────

export type SupplierInputs = {
  openingBalance: number;
  goodsReceived: number;
  reworkFees: number;
  payments: number;
  returnCredits: number;
  /** إلغاء إذونات الاستلام — بيقلّل الدَّيْن. */
  reversals: number;
  currentBalance: number;
};

export function reconcileSupplier(name: string, input: SupplierInputs): Check {
  const expected =
    input.openingBalance +
    input.goodsReceived +
    input.reworkFees -
    input.payments -
    input.returnCredits -
    input.reversals;
  return check(`حساب ${name}`, expected, input.currentBalance);
}

// ───────────────────────── مرة واحدة بالظبط ─────────────────────────

export type OnceInputs = {
  label: string;
  /** عدد الأحداث الواقعية — دفعة مصروف، صرف مرتب، تسوية شحن… */
  events: number;
  /** عدد حركات الخزنة المقابلة ليها. */
  treasuryMovements: number;
  /** مجموع مبالغ الأحداث. */
  eventsTotal: number;
  /** مجموع مبالغ حركات الخزنة. */
  treasuryTotal: number;
};

/**
 * حركة واقعية واحدة = حركة خزنة واحدة، وبنفس المبلغ.
 *
 * الفحصين مع بعض عن قصد: العدد لوحده بيفوّت حركة اتسجّلت بمبلغ غلط، والمبلغ لوحده
 * بيفوّت حركتين بنص المبلغ لكل واحدة.
 */
export function reconcileOnce(input: OnceInputs): Check[] {
  return [
    check(`${input.label} — العدد`, input.events, input.treasuryMovements),
    check(`${input.label} — المبلغ`, input.eventsTotal, input.treasuryTotal),
  ];
}

// ───────────────────────── التقرير ─────────────────────────

export function buildReport(checks: Check[]): ReconciliationReport {
  const failures = checks.filter(c => !c.ok);
  return { checks, ok: failures.length === 0, failures };
}

/** التقرير كنص عربي للطرفية. */
export function formatReport(report: ReconciliationReport): string {
  const lines = report.checks.map(c => {
    const mark = c.ok ? "✅" : "❌";
    const money = (n: number) =>
      n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const diff = c.ok ? "" : `   (فرق ${money(c.difference)})`;
    return `${mark} ${c.label}: المتوقع ${money(c.expected)} · الفعلي ${money(c.actual)}${diff}`;
  });
  lines.push("");
  lines.push(
    report.ok
      ? `✅ كل الفحوص عدّت (${report.checks.length})`
      : `❌ ${report.failures.length} من ${report.checks.length} فحص فشلوا`
  );
  return lines.join("\n");
}
