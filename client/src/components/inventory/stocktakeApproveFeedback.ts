/**
 * BUG-55: رسالة اعتماد الجرد حسب حالة قيد الدفتر الفعلية (`ledger` من stocktakeApprove) — بدل «نجاح كامل» ثابت حتى لو
 * القيد فشل. الاعتماد نفسه وحركة المخزون حصلوا في كل الحالات؛ اللي بيختلف هو هل الفروق اتسجّلت في دفتر الحسابات.
 */
export type StocktakeApproveFeedback =
  | { kind: "success"; title: string; description?: string }
  | { kind: "warning"; title: string; description: string };

export const STOCKTAKE_APPROVED_POSTED = "تم الاعتماد — العجز اتسجّل خسارة مخزون والزيادة ربح مخزون، والمخزون اتحرّك.";
export const STOCKTAKE_APPROVED_SKIPPED = "تم الاعتماد — المخزون اتحرّك.";
export const STOCKTAKE_APPROVED_REVIEW = "تم اعتماد الجرد وتحريك المخزون، لكن قيد الفروق في دفتر الحسابات لم يُسجَّل.";

export function stocktakeApproveFeedback(result: unknown): StocktakeApproveFeedback {
  const ledger = (result as { ledger?: { status?: unknown; reason?: unknown } } | null | undefined)?.ledger;
  const status = ledger?.status;
  const reason = typeof ledger?.reason === "string" && ledger.reason.trim() ? ledger.reason.trim() : null;
  if (status === "review")
    return {
      kind: "warning",
      title: STOCKTAKE_APPROVED_REVIEW,
      description: `${reason ? `السبب: ${reason}. ` : ""}اتسجّل في سجل النشاط — راجع القيد مع المحاسب، ومتعيدش اعتماد الجرد.`,
    };
  if (status === "skipped")
    return { kind: "success", title: STOCKTAKE_APPROVED_SKIPPED, description: `قيد الدفتر: لم يُسجَّل${reason ? ` — ${reason}` : ""}.` };
  return { kind: "success", title: STOCKTAKE_APPROVED_POSTED };
}
