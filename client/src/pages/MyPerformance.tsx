import { useMemo, useState } from "react";
import { History } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { EmployeeShell } from "@/components/shell/EmployeeShell";
import { businessDateKey } from "@shared/businessTime";
import { EmptyState, ErrorState, LoadingSkeleton, SectionCard, StatCard } from "@/components/shared";
import { PERFORMANCE_RATE_LABEL } from "./Performance";

/**
 * «أدائي» لموظف البوابة — من سجل الأحداث، بهوية كوكي الموظف فقط (لا صلاحيات جلسة مالك مفتوحة)،
 * أرقامه هو فقط بلا ترتيب ولا مقارنة. العلم معطل ⇒ «غير مفعّل بعد».
 */
const TZ = "Africa/Cairo";
const daysAgo = (n: number) => businessDateKey(new Date(Date.now() - n * 86_400_000), TZ);
type Preset = "today" | "week" | "month";
const TOUCH = "min-h-11 md:min-h-9";

export default function MyPerformance() {
  const [preset, setPreset] = useState<Preset>("week");
  const range = useMemo(() => ({ dateFrom: daysAgo(preset === "today" ? 0 : preset === "week" ? 6 : 29), dateTo: daysAgo(0) }), [preset]);
  const q = trpc.employeePortal.myPerformance.useQuery(range, { retry: false });
  const row = q.data && q.data.enabled ? q.data.rows[0] : undefined;
  return (
    <EmployeeShell title="أدائي" icon={History}>
      <div className="mx-auto max-w-3xl space-y-4" dir="rtl" data-testid="my-performance">
        <div className="flex flex-wrap gap-2" role="group" aria-label="الفترة">
          {(["today", "week", "month"] as Preset[]).map(p => (
            <Button key={p} variant={preset === p ? "default" : "outline"} className={TOUCH} aria-pressed={preset === p} onClick={() => setPreset(p)}>
              {p === "today" ? "اليوم" : p === "week" ? "آخر 7 أيام" : "آخر 30 يومًا"}
            </Button>
          ))}
        </div>
        {q.isLoading ? <LoadingSkeleton variant="cards" rows={2} />
          : q.isError ? <ErrorState message={q.error?.message ?? "تعذّر تحميل أدائك"} onRetry={() => q.refetch()} />
          : !q.data?.enabled ? <EmptyState title="«أدائي» غير مفعّل بعد" description="يظهر هنا بعد تفعيل سجل الأحداث." />
          : (
            <SectionCard title="أرقامك في الفترة" description="محسوبة من القرارات التي سجّلتها أنت — بلا مقارنة بزملائك.">
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="القرارات المسجلة" value={row?.decisionEligibleOrders ?? 0} />
                <StatCard label="المؤكدة" value={row?.confirmedOrders ?? 0} tone="success" />
                <StatCard label={PERFORMANCE_RATE_LABEL} value={row?.confirmationRate == null ? "—" : `${row.confirmationRate}%`} />
                <StatCard label="لم يرد (محاولات)" value={row?.noAnswerAttempts ?? 0} />
                <StatCard label="حجم العمل" value={row?.workloadOrders ?? 0} />
                <StatCard label="الإسنادات" value={row?.assignedOrders ?? 0} />
              </div>
            </SectionCard>
          )}
      </div>
    </EmployeeShell>
  );
}
