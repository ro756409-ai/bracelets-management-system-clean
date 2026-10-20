/**
 * بادئة سبب المراجعة المالية على الأوردر («دفتر: …») — يكتبها ربط الدفتر (flagOrderLedgerReview) ويعدّها فحص الإقفال.
 * أي مسار يحل مراجعة تشغيلية (المنتج، الاستيراد) يحتفظ بها؛ لا تُرفع إلا بحل القيد نفسه (BUG-88).
 */
export const LEDGER_REVIEW_PREFIX = "دفتر:";

/** أسباب المراجعة المالية من نص reviewReason (مفصول بـ « | »). */
export function ledgerReviewReasons(reviewReason: string | null | undefined): string[] {
  return (reviewReason ?? "").split(" | ").map(s => s.trim()).filter(s => s.startsWith(LEDGER_REVIEW_PREFIX));
}
