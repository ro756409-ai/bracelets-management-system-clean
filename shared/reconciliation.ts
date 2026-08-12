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
  /**
   * الاسم `factoryPayments` مش `supplierPayments` عن قصد: فيه حارس ما قبل النشر بيمنع
   * أي إشارة لجدول `supplier_payments` (هجرة 0034 لسه ماتشغّلتش)، وهو بيطابق الكلمة
   * مش الاستخدام. الحقل ده نوع TypeScript عادي ومالوش علاقة بالجدول — فالأسهل والأأمن
   * إني أغيّر اسمي أنا بدل ما أرخّي حارس موجود عشان حادثة اختفاء الأوردرات.
   */
  factoryPayments: number;
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
    input.factoryPayments -
    input.withdrawals;
  return check("رصيد الخزنة", expected, input.currentBalance);
}

/**
 * تدقيق الخزنة **بالاتجاه** — كامل بالبناء.
 *
 * `reconcileTreasury` فوق بيعدّد أنواع بعينها (تحصيل/إيداع/مصروف/سحب)، فأي نوع تالت
 * (مرتجع، تسوية، تحصيل شركة شحن) بيسقط من المعادلة وتبان الخزنة مش متوازنة بالغلط.
 * الفحص ده مابيعدّدش أنواع خالص: كل حركة يا داخلة يا خارجة، فمجموع الداخل − مجموع
 * الخارج + الافتتاحي لازم يساوي الرصيد الحالي مهما كانت الأنواع. مافيش نوع بيسقط.
 */
export type TreasuryDirectionInputs = {
  openingBalance: number;
  totalIn: number;
  totalOut: number;
  currentBalance: number;
};

export function reconcileTreasuryByDirection(
  input: TreasuryDirectionInputs
): Check {
  const expected = input.openingBalance + input.totalIn - input.totalOut;
  return check("رصيد الخزنة (كل الأنواع بالاتجاه)", expected, input.currentBalance);
}

/**
 * تصنيف أنواع حركات الخزنة — للتشخيص، مش للحساب. الحساب بالاتجاه فوق (كامل)، والتصنيف
 * ده بيقول للقارئ كل نوع بيعمل إيه:
 *  • INFLOW: فلوس داخلة (تحصيل، إيداع، تحصيل شركة الشحن لو اتسجّل كتحصيل/إيداع).
 *  • OUTFLOW: فلوس خارجة (مصروف، سحب، دفعة مصنع).
 *  • REVERSAL_ADJUSTMENT: تصحيح/عكس (مرتجع، تسوية يدوية) — ممكن يكون داخل أو خارج.
 *  • NON_CASH: مايحرّكش كاش (مفيش دلوقتي، لكن الخانة موجودة للتصنيف المستقبلي).
 *
 * الأنواع من enum الخزنة: collection, refund, expense, deposit, withdrawal, adjustment.
 */
export type TreasuryClass =
  | "INFLOW"
  | "OUTFLOW"
  | "REVERSAL_ADJUSTMENT"
  | "NON_CASH";

export const TREASURY_TYPE_CLASS: Record<string, TreasuryClass> = {
  collection: "INFLOW",
  deposit: "INFLOW",
  expense: "OUTFLOW",
  withdrawal: "OUTFLOW",
  refund: "REVERSAL_ADJUSTMENT",
  adjustment: "REVERSAL_ADJUSTMENT",
};

export function classifyTreasuryType(type: string): TreasuryClass {
  return TREASURY_TYPE_CLASS[type] ?? "REVERSAL_ADJUSTMENT";
}

// ───────────────────────── التحصيل ─────────────────────────

export type CollectionInputs = {
  /** صافي حركات الخزنة نوع «تحصيل» (داخل − خارج، عشان تصحيح التحصيل بيرجّع بالسالب). */
  treasuryCollectionsNet: number;
  /** مجموع `collectedAmount` على الأوردرات اللي خرجت للشحن. */
  ordersCollected: number;
};

/**
 * التحصيل في الخزنة = المحصّل على الأوردرات.
 *
 * كل تحصيل أوردر بيكتب حركة خزنة نوع «تحصيل» بالفرق، وبيحدّث `collectedAmount` على
 * الأوردر بنفس الفرق — في نفس الترانزاكشن. فمجموع الاتنين لازم يتساوى. لو اختلفوا يبقى
 * تحصيل اتسجّل في مكان من غير التاني.
 */
export function reconcileCollections(input: CollectionInputs): Check {
  return check(
    "التحصيل: الخزنة مقابل الأوردرات",
    input.ordersCollected,
    input.treasuryCollectionsNet
  );
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
