import { useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton, ResponsiveDataTable, SectionCard, StatusBadge, toast, type Column } from "@/components/shared";
import { PERFORMANCE_RATE_LABEL } from "@/pages/Performance";
import { TOUCH, fmtNum, serverErrorText } from "../teamsUi";
import { PeriodPicker, usePeriod, type Preset } from "./PeriodPicker";
import { QueryError, type LedTeam, type LeaderPerms } from "./common";

/**
 * أداء الفريق (team.performance) من سجل الأحداث فقط: نشاط الفريق + عضوية لحظة الحدث (موظف في فريقين يُحسب لكلٍّ
 * بما تم وهو عضو فيه). الترتيب من السيرفر لمن قراراته ≥ الحد (20)؛ الأقل تظهر أرقامه بلا ترتيب.
 * التصدير (team.performanceCsv) فقط مع employee_performance.export، ويُنزَّل نص السيرفر باسم ملفه.
 */
const PRESETS: Preset[] = [{ key: "week", label: "أسبوعي", daysBack: 6 }, { key: "month", label: "شهري", daysBack: 29 }];
type Row = { employeeId: number; employeeName: string; isActive: boolean; decisionEligibleOrders: number; confirmedOrders: number; confirmationRate: number | null; noAnswerOrders: number; noAnswerAttempts: number; postponedOrders: number; cancelledOrders: number; rankable: boolean; rank: number | null };

export function PerformanceTab({ team, perms }: { team: LedTeam; perms: LeaderPerms }) {
  const period = usePeriod(PRESETS, "week");
  const q = trpc.employeePortal.team.performance.useQuery({ teamId: team.teamId, ...period.period }, { retry: false, placeholderData: keepPreviousData });
  const canExport = perms.has("team_performance.view") && perms.has("employee_performance.export");
  if (q.isLoading) return <LoadingSkeleton variant="table" rows={4} />;
  if (q.error && !q.data) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.enabled) return <p className="rounded-[var(--radius-brand-md)] border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">غير متاح حاليًا — سجل الأحداث غير مفعّل.</p>;
  const data = q.data as unknown as { minSample: number; rows: Row[] };
  const rows = [...data.rows].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || b.decisionEligibleOrders - a.decisionEligibleOrders);
  const rankCell = (r: Row) => (r.rankable && r.rank != null ? <span className="tabular-nums font-semibold">#{r.rank}</span> : <span className="text-xs text-muted-foreground">عينة أقل من {data.minSample}</span>);
  const columns: Column<Row>[] = [
    { id: "rank", header: "الترتيب", cell: rankCell },
    { id: "name", header: "العضو", cell: r => <span className="font-medium">{r.employeeName}{!r.isActive && <span className="ms-1 text-xs text-muted-foreground">(غير نشط)</span>}</span> },
    { id: "decisions", header: "إجمالي القرارات", numeric: true, cell: r => fmtNum(r.decisionEligibleOrders) },
    { id: "confirmed", header: "مؤكد", numeric: true, cell: r => fmtNum(r.confirmedOrders) },
    { id: "noanswer", header: "لم يرد", numeric: true, cell: r => <>{fmtNum(r.noAnswerOrders)} <span className="text-xs text-muted-foreground">({fmtNum(r.noAnswerAttempts)} محاولة)</span></> },
    { id: "postponed", header: "مؤجل", numeric: true, cell: r => fmtNum(r.postponedOrders) },
    { id: "cancelled", header: "ملغي", numeric: true, cell: r => fmtNum(r.cancelledOrders) },
    { id: "rate", header: PERFORMANCE_RATE_LABEL, numeric: true, cell: r => (r.confirmationRate == null ? "—" : `${r.confirmationRate}%`) },
  ];
  return (
    <div className="space-y-4" data-testid="leader-performance">
      <SectionCard title="أداء الأعضاء" description={`الترتيب لمن سجّل ${data.minSample} قرارًا على الأقل في الفترة؛ الأقل تظهر أرقامه بلا ترتيب. المحسوب: ما تم والموظف عضو في هذا الفريق فقط.`}
        action={canExport ? <ExportButton team={team} period={period.period} /> : undefined}>
        <PeriodPicker presets={PRESETS} state={period} testId="leader-performance-period" />
        {q.error && <p className="mt-2 text-sm text-destructive" role="alert">{serverErrorText(q.error)}</p>}
        <div className="mt-3" aria-busy={q.isFetching}>
          <ResponsiveDataTable
            rows={rows}
            columns={columns}
            rowKey={r => r.employeeId}
            empty={{ title: "لا قرارات في الفترة", description: "تظهر الأرقام بعد تسجيل قرارات على أوردرات نشاط الفريق." }}
            mobileRow={r => (
              <div className="space-y-2 rounded-[var(--radius-brand-md)] border border-border bg-card p-3">
                <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{r.employeeName}</span>{r.rankable && r.rank != null ? <StatusBadge status="rank" label={`#${r.rank}`} tone="primary" size="sm" icon={null} /> : <span className="text-xs text-muted-foreground">عينة أقل من {data.minSample}</span>}</div>
                <dl className="grid grid-cols-3 gap-2 text-xs">
                  {[["القرارات", r.decisionEligibleOrders], ["مؤكد", r.confirmedOrders], ["لم يرد", r.noAnswerOrders], ["مؤجل", r.postponedOrders], ["ملغي", r.cancelledOrders]].map(([l, v]) => (
                    <div key={l as string}><dt className="text-muted-foreground">{l}</dt><dd className="tabular-nums font-semibold">{fmtNum(v as number)}</dd></div>
                  ))}
                  <div><dt className="text-muted-foreground">نسبة التأكيد</dt><dd className="tabular-nums font-semibold">{r.confirmationRate == null ? "—" : `${r.confirmationRate}%`}</dd></div>
                </dl>
              </div>
            )}
          />
        </div>
      </SectionCard>
    </div>
  );
}

/** تنزيل CSV كما أرسله السيرفر (BOM وخلايا آمنة من الصيغ) باسم ملفه، ثم تحرير رابط الكائن. قراءة — مسموح في وضع القراءة فقط. */
function ExportButton({ team, period }: { team: LedTeam; period: { dateFrom: string; dateTo: string } }) {
  const utils = trpc.useUtils();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const run = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const r = await utils.employeePortal.team.performanceCsv.fetch({ teamId: team.teamId, ...period }, { staleTime: 0 });
      if (!r.enabled) { toast.error("التصدير غير متاح حاليًا."); return; }
      const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
      try {
        const a = document.createElement("a");
        a.href = url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove();
      } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
      toast.success(`صُدّر ${r.rowCount} صف`);
    } catch (e) { toast.error(serverErrorText(e)); }
    finally { lock.current = false; setBusy(false); }
  };
  return <Button variant="outline" className={TOUCH} onClick={run} disabled={busy} data-readonly-safe data-testid="leader-performance-export"><Download className="h-4 w-4" aria-hidden="true" /> {busy ? "جارٍ التصدير…" : "تصدير CSV"}</Button>;
}
