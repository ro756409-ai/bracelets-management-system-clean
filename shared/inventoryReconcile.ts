/**
 * مصالحة المخزون القديم — **منطق التصنيف بس، بلا قاعدة بيانات**.
 *
 * السؤال: الرصيد المخزّن (`currentStock`) بيطابق مجموع الحركات؟ الفخ إن **الرصيد
 * الافتتاحي مابيتسجّلش كحركة** — المنتج بيتخلق برصيد مباشر، والاستيراد القديم بيحطّ
 * الرصيد على طول. فـ`stored ≠ netMovements` مش بالضرورة غلط: ممكن يكون افتتاحي شرعي
 * مش متسجّل.
 *
 * عشان كده القرار مبني على «الافتتاحي المُستنتَج» = المخزّن − صافي الحركات:
 *
 *   impliedOpening == 0   → MATCH       (الرصيد متفسّر بالكامل بالحركات)
 *   impliedOpening  > 0   → AMBIGUOUS   (ممكن افتتاحي شرعي — محتاج مراجعة بشرية)
 *   impliedOpening  < 0   → MISMATCH    (مستحيل: مفيش افتتاحي موجب بيفسّره → drift حقيقي)
 *
 * والرصيد السالب MISMATCH على طول.
 *
 * **مفيش رقم بيتخترع.** لو الافتتاحي/السجلات القديمة بتمنع إعادة البناء بثقة، بيتصنّف
 * AMBIGUOUS مش بيتحسب رقم مفروض.
 */

export type ReconcileStatus = "MATCH" | "AMBIGUOUS" | "MISMATCH";

export type MovementSums = {
  /** مجموع الكميات الداخلة (`type = "in"`). */
  totalIn: number;
  /** مجموع الكميات الخارجة (`type = "out"`). */
  totalOut: number;
};

export type ReconcileVerdict = {
  status: ReconcileStatus;
  storedBalance: number;
  netMovements: number;
  /** المخزّن − صافي الحركات. الأساس اللي القرار مبني عليه. */
  impliedOpening: number;
  reason: string;
};

/** القرار لصنف/نوع واحد. */
export function classifyBalance(
  storedBalance: number,
  sums: MovementSums
): ReconcileVerdict {
  const netMovements = sums.totalIn - sums.totalOut;
  const impliedOpening = storedBalance - netMovements;
  const base = { storedBalance, netMovements, impliedOpening };

  if (storedBalance < 0) {
    return {
      ...base,
      status: "MISMATCH",
      reason: "رصيد مخزّن سالب — مستحيل",
    };
  }
  if (impliedOpening === 0) {
    return {
      ...base,
      status: "MATCH",
      reason: "الرصيد متفسّر بالكامل بالحركات",
    };
  }
  if (impliedOpening < 0) {
    return {
      ...base,
      status: "MISMATCH",
      reason: `افتتاحي مُستنتَج سالب (${impliedOpening}) — مفيش افتتاحي موجب بيفسّر الرصيد`,
    };
  }
  return {
    ...base,
    status: "AMBIGUOUS",
    reason: `فرق ${impliedOpening} ممكن يكون رصيد افتتاحي مش متسجّل كحركة — محتاج مراجعة`,
  };
}

export function summariseReconcile(verdicts: ReconcileVerdict[]) {
  return {
    total: verdicts.length,
    match: verdicts.filter(v => v.status === "MATCH").length,
    ambiguous: verdicts.filter(v => v.status === "AMBIGUOUS").length,
    mismatch: verdicts.filter(v => v.status === "MISMATCH").length,
  };
}
