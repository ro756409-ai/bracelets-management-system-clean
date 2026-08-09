/**
 * كشف حساب المصنع — حساب جاري مفتوح.
 *
 * **الرصيد مش متخزّن في أي مكان.** بيتحسب هنا وقت القراءة من الحركات نفسها.
 *
 * ده مش اختصار — ده الفرق بين دفتر بيفضل صح ودفتر بيبوظ. `treasury_transactions`
 * بتخزّن `balanceAfter` وقت الإدخال عشان الكشوف القديمة تفضل مطابقة لنفسها، والثمن إن
 * حركة بتاريخ قديم بتتحط آخر السلسلة. مع المصانع الحركة القديمة بتيجي كتير — فاتورة
 * وصلت متأخر، دفعة اتسجّلت بعد أسبوع — فالحساب وقت القراءة بيخلي كل حركة تقع في مكانها
 * الزمني الصح والأرصدة تتعاد لوحدها.
 *
 * **الإشارة:** موجب = **عليك للمصنع**. سالب = **ليك عند المصنع**.
 */

export type SupplierMovementType =
  | "goods_received"
  | "payment"
  | "return_credit"
  | "rework_fee"
  | "opening_balance"
  | "adjustment"
  | "receipt_reversed";

/** الاسم اللي التاجر بيقراه. مفيش «مدين» ولا «دائن». */
export const MOVEMENT_LABELS: Record<SupplierMovementType, string> = {
  goods_received: "استلام بضاعة",
  payment: "دفعة للمصنع",
  return_credit: "مرتجع خصم من الحساب",
  rework_fee: "تكلفة إعادة تشطيب",
  opening_balance: "رصيد افتتاحي",
  adjustment: "تسوية يدوية",
  receipt_reversed: "إلغاء استلام",
};

/**
 * إشارة كل نوع على الرصيد.
 *
 * `goods_received` و`rework_fee` بيزوّدوا اللي عليك. `payment` و`return_credit`
 * و`receipt_reversed` بيقللوه. `opening_balance` و`adjustment` الاتجاه جاي مع المبلغ
 * نفسه لأن الاتنين ممكن يبقوا في أي اتجاه.
 */
export const MOVEMENT_SIGN: Record<SupplierMovementType, 1 | -1 | 0> = {
  goods_received: 1,
  rework_fee: 1,
  payment: -1,
  return_credit: -1,
  receipt_reversed: -1,
  opening_balance: 0,
  adjustment: 0,
};

export type SupplierMovement = {
  /** معرّف ثابت للترتيب عند تساوي الوقت — مفيش ترتيب عشوائي. */
  id: number;
  type: SupplierMovementType;
  occurredAt: Date;
  /** المبلغ دايمًا موجب للأنواع اللي ليها إشارة ثابتة، وبإشارته للافتتاحي والتسوية. */
  amount: number;
  reference: string | null;
  description: string;
  createdByName: string | null;
  createdAt: Date | null;
};

export type StatementRow = SupplierMovement & {
  /** الأثر على الرصيد بإشارته — ده اللي بيتعرض في عمود «القيمة». */
  signedAmount: number;
  balanceBefore: number;
  balanceAfter: number;
  label: string;
};

/** الأثر الموقّع لحركة واحدة. */
export function signedAmount(movement: {
  type: SupplierMovementType;
  amount: number;
}): number {
  const sign = MOVEMENT_SIGN[movement.type];
  // صفر معناها «الاتجاه جاي مع الرقم» مش «الحركة مالهاش أثر».
  return sign === 0 ? movement.amount : sign * Math.abs(movement.amount);
}

/**
 * ترتيب زمني ثابت.
 *
 * بالوقت، وبالـid عند التساوي. من غير كسر التعادل، حركتين في نفس اللحظة ممكن يترتبوا
 * بشكل مختلف في كل قراءة — والرصيد قبل/بعد يتبدّلوا بينهم قدام التاجر من غير سبب.
 */
export function compareMovements(a: SupplierMovement, b: SupplierMovement): number {
  const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
  return byTime !== 0 ? byTime : a.id - b.id;
}

/**
 * الكشف كامل: كل حركة ومعاها الرصيد قبلها وبعدها.
 *
 * بيرتّب الأول عن قصد — الحركات جاية من مصادر مختلفة (إذونات، أحداث) ومحدش يضمن إنها
 * وصلت مرتّبة. أي حركة بتاريخ قديم بتقع في مكانها الصح هنا، وكل الأرصدة بعدها بتتعاد.
 */
export function buildStatement(movements: SupplierMovement[]): StatementRow[] {
  const sorted = [...movements].sort(compareMovements);
  let running = 0;
  return sorted.map(movement => {
    const signed = signedAmount(movement);
    const before = running;
    running = round2(before + signed);
    return {
      ...movement,
      signedAmount: signed,
      balanceBefore: before,
      balanceAfter: running,
      label: MOVEMENT_LABELS[movement.type],
    };
  });
}

/** إجماليات الكشف — كل نوع لوحده، والرصيد النهائي. */
export function summariseStatement(rows: StatementRow[]) {
  const sum = (type: SupplierMovementType) =>
    round2(
      rows
        .filter(row => row.type === type)
        .reduce((total, row) => total + Math.abs(row.amount), 0)
    );
  return {
    openingBalance: round2(
      rows
        .filter(row => row.type === "opening_balance")
        .reduce((total, row) => total + row.signedAmount, 0)
    ),
    goodsReceived: sum("goods_received"),
    paid: sum("payment"),
    returns: sum("return_credit"),
    reworkFees: sum("rework_fee"),
    balance: rows.length > 0 ? rows[rows.length - 1].balanceAfter : 0,
    lastMovementAt: rows.length > 0 ? rows[rows.length - 1].occurredAt : null,
    movementCount: rows.length,
  };
}

/**
 * الرصيد بلغة التاجر.
 *
 * الرقم لوحده ملبّس: «٣٥٬٠٠٠» تحتمل إنها ليك أو عليك. الجملة بتقفل الاحتمال.
 */
export function describeBalance(balance: number): {
  text: string;
  tone: "owed" | "credit" | "settled";
} {
  const value = round2(balance);
  if (Math.abs(value) < 0.01) return { text: "الحساب متعادل", tone: "settled" };
  if (value > 0)
    return { text: `عليك للمصنع ${formatEgp(value)}`, tone: "owed" };
  return { text: `ليك عند المصنع ${formatEgp(-value)}`, tone: "credit" };
}

/** إجماليات كل المصانع — للوحة. مشتقّة من نفس الأرصدة، مش محفوظة على جنب. */
export function summariseSuppliers(balances: number[]) {
  let owedToFactories = 0;
  let owedByFactories = 0;
  for (const raw of balances) {
    const balance = round2(raw);
    if (balance > 0) owedToFactories = round2(owedToFactories + balance);
    else if (balance < 0) owedByFactories = round2(owedByFactories - balance);
  }
  return {
    owedToFactories,
    owedByFactories,
    net: round2(owedToFactories - owedByFactories),
  };
}

/** فترات الفلترة السريعة. بتتحسب من «دلوقتي» اللي بيتبعت عشان تبقى قابلة للاختبار. */
export function quickRange(
  key: "today" | "week" | "month" | "last_month" | "all",
  now: Date
): { from: Date | null; to: Date | null } {
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate());
  switch (key) {
    case "today":
      return { from: startOfDay(now), to: null };
    case "week": {
      // الأسبوع بيبدأ السبت في مصر، مش الأحد ولا الاثنين.
      const day = now.getDay();
      const back = (day + 1) % 7;
      const from = startOfDay(now);
      from.setDate(from.getDate() - back);
      return { from, to: null };
    }
    case "month":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: null };
    case "last_month":
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        to: new Date(now.getFullYear(), now.getMonth(), 1),
      };
    case "all":
      return { from: null, to: null };
  }
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatEgp(value: number): string {
  return `${value.toLocaleString("ar-EG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;
}
