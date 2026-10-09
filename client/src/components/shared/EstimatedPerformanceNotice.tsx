import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * تقرير «أداء الموظفين» الحالي (`reports.employeePerformance` / `employeePortal.employeePerformance`)
 * بيتحسب حسب **الموظف المُسند حاليًا** و**الحالة الحالية** للأوردر — مش من سجل أحداث. فلو الأوردر
 * اتنقل من موظف لموظف، أو اتأكد ثم اتلغى، الرقم بيتنسب للي ماسكه دلوقتي. لحد ما يتبني سجل الأحداث
 * (Migration 0041 المقترحة)، العرض لازم يقول كده بوضوح ومايتقدّمش كتقرير أداء تاريخي ولا ترتيب.
 * الحسابات نفسها ماتغيّرتش.
 */
export const ESTIMATED_PERFORMANCE_TITLE = "ملخص تشغيلي تقديري حسب التعيين والحالة الحالية";
export const ESTIMATED_PERFORMANCE_WARNING = "قد لا يعكس الموظف الذي نفّذ كل إجراء فعليًا.";
export const ESTIMATED_PERFORMANCE_USAGE =
  "ليس تقرير أداء تاريخيًا، ولا يُستخدم لترتيب الموظفين أو مكافأتهم أو الخصم منهم.";

/** ترتيب محايد بالاسم — بدل الترتيب بنسبة التأكيد (اللي كان بيقدّم الملخص كترتيب للموظفين). */
export function sortByEmployeeName<T extends { employeeName?: string | null }>(rows: readonly T[] | null | undefined): T[] {
  return [...(rows ?? [])].sort((a, b) => (a.employeeName ?? "").localeCompare(b.employeeName ?? "", "ar"));
}

export function EstimatedPerformanceNotice({ className }: { className?: string }) {
  return (
    <div
      role="note"
      data-testid="estimated-performance-notice"
      className={cn(
        "flex items-start gap-2 rounded-[var(--radius-brand-md)] border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-3 text-sm text-foreground",
        className
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />
      <div className="space-y-0.5">
        <p className="font-semibold">{ESTIMATED_PERFORMANCE_WARNING}</p>
        <p className="text-xs text-muted-foreground">{ESTIMATED_PERFORMANCE_USAGE}</p>
      </div>
    </div>
  );
}
