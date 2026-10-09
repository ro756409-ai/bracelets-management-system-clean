import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BarChart3, Download, History } from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { usePermissions } from "@/hooks/usePermission";
import { businessDateKey } from "@shared/businessTime";
import { PERFORMANCE_RANKING_MIN_SAMPLE } from "@shared/orderEventsSpec";
import {
  PageHeader, SectionCard, StatCard, StatusBadge, ResponsiveDataTable, EmptyState, ErrorState, LoadingSkeleton, OfflineState, PermissionDeniedState, type Column,
} from "@/components/shared";

/**
 * أداء الموظفين من **سجل الأحداث** (0041) — بديل الملخص التقديري عند التفعيل.
 *  • `employee_performance.view_all` ⇒ مقارنة الفريق (ترتيب فقط لمن قراراته ≥ 20؛ الأقل بلا ترتيب).
 *  • `employee_performance.view_self` فقط ⇒ «أدائي» بلا أي مقارنة. لا Leaderboard عام.
 *  • العلم معطل ⇒ حالة «غير مفعّل بعد» (السيرفر لا يلمس الجدول).
 * الأيام بتوقيت Africa/Cairo؛ النطاق من نشاط الجلسة على السيرفر.
 */
const TZ = "Africa/Cairo";
type Preset = "today" | "week" | "month" | "custom";
const TOUCH = "min-h-11 md:min-h-9";
const dayKey = (d: Date) => businessDateKey(d, TZ);
const daysAgo = (n: number) => dayKey(new Date(Date.now() - n * 86_400_000));

export const PERFORMANCE_RATE_LABEL = "نسبة التأكيد من القرارات المسجلة";

function rangeFor(p: Preset, custom: { from: string; to: string }) {
  if (p === "today") return { dateFrom: daysAgo(0), dateTo: daysAgo(0) };
  if (p === "week") return { dateFrom: daysAgo(6), dateTo: daysAgo(0) };
  if (p === "month") return { dateFrom: daysAgo(29), dateTo: daysAgo(0) };
  return { dateFrom: custom.from, dateTo: custom.to };
}

type Row = {
  employeeId: number; employeeName: string; isActive: boolean; decisionEligibleOrders: number; confirmedOrders: number; confirmationRate: number | null;
  noAnswerOrders: number; noAnswerAttempts: number; postponedOrders: number; cancelledOrders: number; workloadOrders: number; assignedOrders: number;
  activeDays: number; rankable: boolean; rank: number | null;
};

export default function Performance() {
  const online = useOnlineStatus();
  const { has, isLoading: permsLoading } = usePermissions();
  const { currentBusinessIds } = useBusinessContext();
  const canTeam = has("employee_performance.view_all");
  const canSelf = has("employee_performance.view_self");
  const canExport = has("employee_performance.export");
  const [preset, setPreset] = useState<Preset>("week");
  const [custom, setCustom] = useState({ from: daysAgo(6), to: daysAgo(0) });
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);
  const validRange = /^\d{4}-\d{2}-\d{2}$/.test(range.dateFrom) && /^\d{4}-\d{2}-\d{2}$/.test(range.dateTo) && range.dateFrom <= range.dateTo;

  const status = trpc.performance.status.useQuery(undefined, { retry: false });
  const enabled = status.data?.enabled === true;
  const team = trpc.performance.team.useQuery({ ...range, businessIds: currentBusinessIds }, { enabled: enabled && canTeam && validRange, retry: false });
  const mine = trpc.performance.mine.useQuery(range, { enabled: enabled && !canTeam && canSelf && validRange, retry: false });
  const utils = trpc.useUtils();
  const [exporting, setExporting] = useState(false);

  const report = canTeam ? team : mine;
  const rows: Row[] = report.data && report.data.enabled ? (report.data.rows as Row[]) : [];

  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const r = await utils.performance.exportCsv.fetch({ ...range, businessIds: currentBusinessIds });
      if (!r.enabled) return;
      const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url; a.download = `performance-${range.dateFrom}-${range.dateTo}.csv`; a.click();
      URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  };

  const columns: Column<Row>[] = [
    { id: "employee", header: "الموظف", alwaysVisible: true, cell: r => <span className="flex items-center gap-2"><span className="font-medium">{r.employeeName}</span>{!r.isActive && <StatusBadge status="inactive" label="غير نشط" tone="neutral" size="sm" icon={null} />}</span> },
    { id: "decisions", header: "القرارات المسجلة", numeric: true, cell: r => <span className="tabular-nums">{r.decisionEligibleOrders}</span> },
    { id: "confirmed", header: "المؤكدة", numeric: true, cell: r => <span className="tabular-nums text-[var(--success)]">{r.confirmedOrders}</span> },
    { id: "rate", header: PERFORMANCE_RATE_LABEL, numeric: true, alwaysVisible: true, cell: r => <span className="font-bold tabular-nums">{r.confirmationRate == null ? "—" : `${r.confirmationRate}%`}</span> },
    { id: "noAnswer", header: "لم يرد (أوردرات / محاولات)", numeric: true, cell: r => <span className="tabular-nums">{r.noAnswerOrders} / {r.noAnswerAttempts}</span> },
    { id: "postponed", header: "مؤجل", numeric: true, cell: r => <span className="tabular-nums">{r.postponedOrders}</span> },
    { id: "cancelled", header: "ملغي", numeric: true, cell: r => <span className="tabular-nums">{r.cancelledOrders}</span> },
    { id: "workload", header: "حجم العمل", numeric: true, cell: r => <span className="tabular-nums">{r.workloadOrders}</span> },
    { id: "assigned", header: "الإسنادات", numeric: true, cell: r => <span className="tabular-nums">{r.assignedOrders}</span> },
    { id: "days", header: "أيام النشاط", numeric: true, cell: r => <span className="tabular-nums">{r.activeDays}</span> },
    { id: "rank", header: "الترتيب", numeric: true, cell: r => r.rank != null ? <span className="font-bold tabular-nums">#{r.rank}</span> : <StatusBadge status="sample" label={`عينة أقل من ${PERFORMANCE_RANKING_MIN_SAMPLE}`} tone="neutral" size="sm" icon={null} /> },
  ];

  const header = (
    <PageHeader
      title="أداء الموظفين"
      description="من سجل الأحداث — كل قرار منسوب لمن نفّذه وقت تنفيذه. الأيام بتوقيت القاهرة."
      icon={<History className="h-5 w-5" aria-hidden="true" />}
      actions={canExport && enabled ? <Button data-readonly-safe variant="outline" className={TOUCH} onClick={exportCsv} disabled={exporting || !validRange}><Download className="h-4 w-4" aria-hidden="true" /> تصدير CSV</Button> : undefined}
    />
  );

  if (permsLoading || status.isLoading) return <div className="space-y-6" dir="rtl">{header}<LoadingSkeleton variant="cards" rows={3} /></div>;
  if (!canTeam && !canSelf) return <div className="space-y-6" dir="rtl" data-testid="performance-page">{header}<PermissionDeniedState message="عرض الأداء يحتاج صلاحية «أدائي» أو «مقارنة أداء الموظفين»." /></div>;
  if (!enabled)
    return (
      <div className="space-y-6" dir="rtl" data-testid="performance-page">
        {header}
        <div data-testid="performance-disabled"><EmptyState title="تقرير الأداء من سجل الأحداث غير مفعّل بعد" description="يُفعَّل بعد تطبيق سجل الأحداث وتشغيله. حتى ذلك الحين يبقى «الملخص التشغيلي التقديري» في صفحة التقارير." /></div>
      </div>
    );

  const self = !canTeam ? rows[0] : undefined;
  return (
    <div className="space-y-6" dir="rtl" data-testid="performance-page">
      {header}
      {!online && <OfflineState message="لا يوجد اتصال — الأرقام المعروضة آخر ما تم تحميله." />}
      <SectionCard title="الفترة" testId="performance-range">
        <div className="flex flex-wrap items-end gap-2" role="group" aria-label="الفترة">
          {(["today", "week", "month", "custom"] as Preset[]).map(p => (
            <Button key={p} variant={preset === p ? "default" : "outline"} className={TOUCH} aria-pressed={preset === p} onClick={() => setPreset(p)}>
              {p === "today" ? "اليوم" : p === "week" ? "آخر 7 أيام" : p === "month" ? "آخر 30 يومًا" : "مخصص"}
            </Button>
          ))}
          {preset === "custom" && (
            <>
              <div><Label htmlFor="perf-from">من</Label><Input id="perf-from" type="date" className={TOUCH} value={custom.from} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} /></div>
              <div><Label htmlFor="perf-to">إلى</Label><Input id="perf-to" type="date" className={TOUCH} value={custom.to} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} /></div>
            </>
          )}
        </div>
        {!validRange && <p className="mt-2 text-sm text-destructive" role="alert">نطاق التاريخ غير صالح.</p>}
      </SectionCard>

      {canTeam ? (
        <SectionCard title={<span className="inline-flex items-center gap-2"><BarChart3 className="h-4 w-4 text-primary" aria-hidden="true" /> مقارنة الفريق</span>} description={`الترتيب لمن قراراته المسجلة ${PERFORMANCE_RANKING_MIN_SAMPLE} فأكثر؛ الأقل تظهر أرقامهم بلا ترتيب. حجم العمل والإسنادات مقاييس منفصلة عن النسبة.`} flush testId="performance-team">
          <ResponsiveDataTable<Row>
            rows={rows}
            columns={columns}
            rowKey={r => r.employeeId}
            loading={team.isLoading}
            error={team.isError ? (team.error?.message ?? "تعذّر تحميل التقرير") : null}
            onRetry={() => team.refetch()}
            empty={{ title: "لا أحداث مسجلة في هذه الفترة", description: "جرّب فترة أطول." }}
            cardsBelow="md"
            mobileRow={r => (
              <article className="space-y-2 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`performance-card-${r.employeeId}`}>
                <div className="flex items-center justify-between gap-2"><span className="font-semibold">{r.employeeName}</span>{r.rank != null ? <span className="font-bold tabular-nums">#{r.rank}</span> : <StatusBadge status="sample" label={`عينة أقل من ${PERFORMANCE_RANKING_MIN_SAMPLE}`} tone="neutral" size="sm" icon={null} />}</div>
                <dl className="grid grid-cols-3 gap-1 text-center text-xs">
                  <div><dt className="text-muted-foreground">القرارات</dt><dd className="font-bold tabular-nums">{r.decisionEligibleOrders}</dd></div>
                  <div><dt className="text-muted-foreground">المؤكدة</dt><dd className="font-bold tabular-nums">{r.confirmedOrders}</dd></div>
                  <div><dt className="text-muted-foreground">النسبة</dt><dd className="font-bold tabular-nums">{r.confirmationRate == null ? "—" : `${r.confirmationRate}%`}</dd></div>
                  <div><dt className="text-muted-foreground">لم يرد</dt><dd className="tabular-nums">{r.noAnswerOrders} / {r.noAnswerAttempts}</dd></div>
                  <div><dt className="text-muted-foreground">حجم العمل</dt><dd className="tabular-nums">{r.workloadOrders}</dd></div>
                  <div><dt className="text-muted-foreground">الإسنادات</dt><dd className="tabular-nums">{r.assignedOrders}</dd></div>
                </dl>
              </article>
            )}
          />
        </SectionCard>
      ) : mine.isLoading ? <LoadingSkeleton variant="cards" rows={2} /> : mine.isError ? <ErrorState message={mine.error?.message ?? "تعذّر تحميل أدائك"} onRetry={() => mine.refetch()} /> : (
        <SectionCard title="أدائي" description="أرقامك أنت فقط — بلا مقارنة بزملائك." testId="performance-self">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="القرارات المسجلة" value={self?.decisionEligibleOrders ?? 0} />
            <StatCard label="المؤكدة" value={self?.confirmedOrders ?? 0} tone="success" />
            <StatCard label={PERFORMANCE_RATE_LABEL} value={self?.confirmationRate == null ? "—" : `${self.confirmationRate}%`} />
            <StatCard label="حجم العمل" value={self?.workloadOrders ?? 0} />
          </div>
        </SectionCard>
      )}
    </div>
  );
}
