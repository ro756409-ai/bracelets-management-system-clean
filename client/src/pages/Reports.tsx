import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { EstimatedPerformanceNotice, ESTIMATED_PERFORMANCE_TITLE, sortByEmployeeName } from "@/components/shared/EstimatedPerformanceNotice";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell
} from "recharts";
import { TrendingUp, Users, XCircle, BarChart3 } from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import {
  PageHeader, StatCard, SectionCard, StatusBadge, ResponsiveDataTable, EmptyState, LoadingSkeleton, OfflineState, PermissionDeniedState, type Column,
} from "@/components/shared";

type DateRange = "today" | "week" | "month";

function getDateRange(range: DateRange): { dateFrom?: Date; dateTo?: Date } {
  const now = new Date();
  if (range === "today") {
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(now); end.setHours(23, 59, 59, 999);
    return { dateFrom: start, dateTo: end };
  }
  if (range === "week") {
    const start = new Date(now); start.setDate(now.getDate() - 7); start.setHours(0, 0, 0, 0);
    return { dateFrom: start };
  }
  if (range === "month") {
    const start = new Date(now); start.setDate(now.getDate() - 30); start.setHours(0, 0, 0, 0);
    return { dateFrom: start };
  }
  return {};
}

const CANCEL_REASON_LABELS: Record<string, string> = {
  price: "السعر",
  not_serious: "غير جاد",
  wrong_number: "رقم خاطئ",
  duplicate: "مكرر",
};

// ألوان الرسوم من tokens الهوية (تتبدّل مع الوضع الداكن واللون المميز) — لا أحمر افتراضيًا
const CANCEL_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const TOOLTIP_STYLE = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: "var(--radius-brand-md)", color: "var(--foreground)" } as const;
const TOUCH = "min-h-11 md:min-h-9";

/**
 * التقارير والأداء — نفس الاستعلامات الثلاثة (reports.employeePerformance / cancellationReasons / dailyChart)
 * بنفس الفترات (اليوم / 7 أيام / 30 يومًا) ونطاق الأنشطة. المرحلة 7G (عرض فقط): كل رقم يذكر مصدره، رسوم
 * بألوان tokens مع جدول بديل لقارئ الشاشة، جدول الأداء عبر ResponsiveDataTable (بطاقات على الهاتف)،
 * وحالات Loading/Empty/Offline/PermissionDenied. لا حساب جديد: النِّسَب كما يرجعها السيرفر.
 */
export default function Reports() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const online = useOnlineStatus();
  const { currentBusinessIds } = useBusinessContext();
  const [dateRange, setDateRange] = useState<DateRange>("month");

  const dateParams = useMemo(() => ({
    ...getDateRange(dateRange),
    businessIds: currentBusinessIds,
  }), [dateRange, currentBusinessIds]);

  const { data: perfData, isLoading: perfLoading, isError: perfError, error: perfErr, refetch: refetchPerf } = trpc.reports.employeePerformance.useQuery(dateParams, {
    enabled: isAdmin,
  });
  const { data: cancelData, isLoading: cancelLoading } = trpc.reports.cancellationReasons.useQuery(dateParams, {
    enabled: isAdmin,
  });
  const { data: chartData, isLoading: chartLoading } = trpc.reports.dailyChart.useQuery({ days: dateRange === 'today' ? 1 : dateRange === 'week' ? 7 : 30, businessIds: currentBusinessIds }, {
    enabled: isAdmin,
  });
  // رابط التقرير التاريخي من سجل الأحداث — يظهر فقط بعد تفعيله (العلم معطل = لا تغيير في الصفحة).
  const { data: eventLedger } = trpc.performance.status.useQuery(undefined, { enabled: isAdmin, retry: false });
  const [, navigate] = useLocation();

  const dateRangeLabels: Record<DateRange, string> = {
    today: "اليوم",
    week: "آخر 7 أيام",
    month: "آخر 30 يوم",
  };

  const cancelPieData = cancelData?.map((c, i) => ({
    name: CANCEL_REASON_LABELS[c.reason ?? ''] ?? c.reason ?? 'غير محدد',
    value: Number(c.count),
    color: CANCEL_COLORS[i % CANCEL_COLORS.length],
  })) ?? [];

  const totalCancelled = cancelPieData.reduce((sum, c) => sum + c.value, 0);

  const barData = chartData?.map(d => ({
    date: d.date,
    total: Number(d.total),
    confirmed: Number(d.confirmed),
    cancelled: Number(d.cancelled),
  })) ?? [];
  // مجاميع أيام الفترة من dailyChart نفسه (لا تقدير)
  const sums = barData.reduce((a, d) => ({ total: a.total + d.total, confirmed: a.confirmed + d.confirmed, cancelled: a.cancelled + d.cancelled }), { total: 0, confirmed: 0, cancelled: 0 });

  // الترتيب للعرض فقط على نسخة — لا تعديل في بيانات الاستعلام
  // ترتيب محايد بالاسم — الملخص تقديري ومايُستخدمش لترتيب الموظفين (كان مرتّب بنسبة التأكيد).
  const perfRows = useMemo(() => sortByEmployeeName(perfData), [perfData]);

  if (!isAdmin) {
    return (
      <div className="space-y-6" dir="rtl" data-testid="reports-page">
        <PageHeader title="التقارير والأداء" description="تحليل أداء الفريق وأسباب الإلغاء" icon={<BarChart3 className="h-5 w-5" aria-hidden="true" />} />
        <PermissionDeniedState message="التقارير متاحة للمديرين فقط." />
      </div>
    );
  }

  const rateTone = (rate: number) => rate >= 70 ? "text-[var(--success)]" : rate >= 50 ? "text-[var(--warning)]" : "text-destructive";
  const RateBar = ({ rate }: { rate: number }) => (
    <span className="flex items-center justify-end gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true"><span className="block h-1.5 rounded-full bg-[var(--success)]" style={{ width: `${Math.max(0, Math.min(100, rate))}%` }} /></span>
      <span className={`text-xs font-bold tabular-nums ${rateTone(rate)}`}>{rate}%</span>
    </span>
  );
  const cancelBadge = (rate: number) => <StatusBadge status="cancel_rate" label={`${rate}%`} tone={rate <= 20 ? "success" : rate <= 40 ? "warning" : "danger"} size="sm" icon={null} />;

  const perfColumns: Column<any>[] = [
    { id: "employee", header: "الموظف", alwaysVisible: true, cell: e => <span className="flex items-center gap-2"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground" aria-hidden="true">{e.employeeName.charAt(0)}</span><span className="font-medium">{e.employeeName}</span></span> },
    { id: "total", header: "الإجمالي", numeric: true, cell: e => <span className="font-bold tabular-nums">{e.total}</span> },
    { id: "confirmed", header: "مؤكد", numeric: true, cell: e => <span className="font-semibold tabular-nums text-[var(--success)]">{e.confirmed}</span> },
    { id: "cancelled", header: "ملغي", numeric: true, cell: e => <span className="font-semibold tabular-nums text-destructive">{e.cancelled}</span> },
    { id: "postponed", header: "مؤجل", numeric: true, cell: e => <span className="font-semibold tabular-nums text-[var(--warning)]">{e.postponed}</span> },
    { id: "confirmRate", header: "نسبة التأكيد", numeric: true, alwaysVisible: true, cell: e => <RateBar rate={e.confirmRate} /> },
    { id: "cancelRate", header: "نسبة الإلغاء", numeric: true, cell: e => cancelBadge(e.cancelRate) },
  ];

  return (
    <div className="space-y-6" dir="rtl" data-testid="reports-page">
      <PageHeader
        title="التقارير والأداء"
        description="تحليل أداء الفريق وأسباب الإلغاء"
        icon={<BarChart3 className="h-5 w-5" aria-hidden="true" />}
      >
        <section className="grid grid-cols-3 gap-3" aria-label="ملخص الفترة" data-testid="reports-summary">
          <StatCard label={`أوردرات ${dateRangeLabels[dateRange]}`} value={sums.total.toLocaleString("ar-EG")} hint="مجموع أيام الفترة" loading={chartLoading} />
          <StatCard label="مؤكد" value={sums.confirmed.toLocaleString("ar-EG")} tone="success" hint="حسب تاريخ الإنشاء" loading={chartLoading} />
          <StatCard label="ملغي" value={sums.cancelled.toLocaleString("ar-EG")} tone="danger" hint="حسب تاريخ الإنشاء" loading={chartLoading} />
        </section>
      </PageHeader>

      {!online && <OfflineState onRetry={() => refetchPerf()} className="py-6" />}

      {/* Date Range Filter — نفس الفترات الثلاث */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="الفترة" data-testid="reports-range">
        {(["today", "week", "month"] as DateRange[]).map(r => (
          <Button
            key={r}
            variant={dateRange === r ? "default" : "outline"}
            size="sm"
            className={`${TOUCH} rounded-[var(--radius-brand-pill)]`}
            aria-pressed={dateRange === r}
            onClick={() => setDateRange(r)}
            data-testid={`reports-range-${r}`}
          >
            {dateRangeLabels[r]}
          </Button>
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Daily Orders Chart */}
        <SectionCard title={<span className="inline-flex items-center gap-2"><TrendingUp className="h-4 w-4 text-primary" aria-hidden="true" /> أوردرات {dateRangeLabels[dateRange]}</span>} description="حسب تاريخ إنشاء الأوردر" testId="reports-daily-chart">
          {chartLoading ? <LoadingSkeleton variant="cards" rows={1} className="h-[220px]" /> : barData.length > 0 ? (
            <>
              <div aria-hidden="true">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={barData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                    <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "var(--muted)" }} />
                    <Bar dataKey="total" name="الإجمالي" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="confirmed" name="مؤكد" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="cancelled" name="ملغي" fill="var(--chart-4)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <table className="sr-only" data-testid="reports-daily-table">
                <caption>أوردرات {dateRangeLabels[dateRange]} يومًا بيوم</caption>
                <thead><tr><th scope="col">التاريخ</th><th scope="col">الإجمالي</th><th scope="col">مؤكد</th><th scope="col">ملغي</th></tr></thead>
                <tbody>{barData.map(d => <tr key={d.date}><td>{d.date}</td><td>{d.total}</td><td>{d.confirmed}</td><td>{d.cancelled}</td></tr>)}</tbody>
              </table>
              <ul className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground" aria-hidden="true">
                <li className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-[var(--chart-2)]" /> الإجمالي</li>
                <li className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-[var(--chart-3)]" /> مؤكد</li>
                <li className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-[var(--chart-4)]" /> ملغي</li>
              </ul>
            </>
          ) : (
            <EmptyState title="لا توجد بيانات كافية" description="اختر فترة أطول أو انتظر أوردرات جديدة." className="py-8" />
          )}
        </SectionCard>

        {/* Cancellation Reasons Pie */}
        <SectionCard title={<span className="inline-flex items-center gap-2"><XCircle className="h-4 w-4 text-destructive" aria-hidden="true" /> أسباب الإلغاء <span className="text-sm font-normal text-muted-foreground tabular-nums">({totalCancelled.toLocaleString("ar-EG")} إلغاء)</span></span>} description="حسب السبب المسجّل عند الإلغاء" testId="reports-cancel-chart">
          {cancelLoading ? <LoadingSkeleton variant="cards" rows={1} className="h-[220px]" /> : cancelPieData.length > 0 ? (
            <>
              <div aria-hidden="true">
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie data={cancelPieData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value" stroke="var(--card)">
                      {cancelPieData.map((entry, index) => (
                        <Cell key={index} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <table className="sr-only" data-testid="reports-cancel-table">
                <caption>أسباب الإلغاء</caption>
                <thead><tr><th scope="col">السبب</th><th scope="col">العدد</th><th scope="col">النسبة</th></tr></thead>
                <tbody>{cancelPieData.map((c, i) => <tr key={i}><td>{c.name}</td><td>{c.value}</td><td>{totalCancelled > 0 ? Math.round((c.value / totalCancelled) * 100) : 0}%</td></tr>)}</tbody>
              </table>
              <ul className="mt-2 grid grid-cols-2 gap-2" aria-hidden="true">
                {cancelPieData.map((c, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: c.color }} />
                    <span className="text-xs">{c.name}</span>
                    <span className="mr-auto text-xs font-bold tabular-nums">{c.value}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      ({totalCancelled > 0 ? Math.round((c.value / totalCancelled) * 100) : 0}%)
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <EmptyState title="لا توجد إلغاءات في هذه الفترة" className="py-8" />
          )}
        </SectionCard>
      </div>

      {/* Employee Performance Table — النِّسَب من السيرفر كما هي */}
      <SectionCard title={<span className="inline-flex items-center gap-2"><Users className="h-4 w-4 text-primary" aria-hidden="true" /> {ESTIMATED_PERFORMANCE_TITLE}</span>} description="حسب الموظف المُسند حاليًا وحالة الأوردر الحالية — مرتّب أبجديًا بالاسم" flush testId="reports-performance">
        <EstimatedPerformanceNotice className="m-3" />
        {eventLedger?.enabled && (
          <div className="mx-3 mb-3">
            <Button variant="outline" className={TOUCH} onClick={() => navigate("/performance")} data-testid="reports-open-performance">
              عرض الأداء التاريخي من سجل الأحداث
            </Button>
          </div>
        )}
        <ResponsiveDataTable<any>
          rows={perfRows}
          columns={perfColumns}
          rowKey={e => e.employeeId ?? e.employeeName}
          loading={perfLoading}
          error={perfError ? ((perfErr as any)?.message || "تعذّر تحميل الأداء") : null}
          onRetry={() => refetchPerf()}
          empty={{ title: "لا توجد بيانات أداء في هذه الفترة", description: "جرّب فترة أطول." }}
          cardsBelow="md"
          mobileRow={e => (
            <article className="space-y-2 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`reports-perf-card-${e.employeeId ?? e.employeeName}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{e.employeeName}</span>
                <RateBar rate={e.confirmRate} />
              </div>
              <dl className="grid grid-cols-4 gap-1 text-center text-xs">
                <div><dt className="text-muted-foreground">الإجمالي</dt><dd className="font-bold tabular-nums">{e.total}</dd></div>
                <div><dt className="text-muted-foreground">مؤكد</dt><dd className="font-bold tabular-nums text-[var(--success)]">{e.confirmed}</dd></div>
                <div><dt className="text-muted-foreground">ملغي</dt><dd className="font-bold tabular-nums text-destructive">{e.cancelled}</dd></div>
                <div><dt className="text-muted-foreground">مؤجل</dt><dd className="font-bold tabular-nums text-[var(--warning)]">{e.postponed}</dd></div>
              </dl>
              <div className="flex items-center justify-between text-xs text-muted-foreground"><span>نسبة الإلغاء</span>{cancelBadge(e.cancelRate)}</div>
            </article>
          )}
        />
      </SectionCard>

      {/* Performance Legend — نفس العتبات */}
      <SectionCard title="دلالة ألوان نسبة التأكيد" description="عتبات التلوين أعلاه فقط — ليست تقييمًا للموظف" testId="reports-legend">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-[var(--radius-brand-md)] bg-[var(--success)]/10 p-3 text-center">
            <p className="text-lg font-bold text-[var(--success)]">70%+</p>
            <p className="text-xs text-[var(--success)]">نسبة مرتفعة</p>
          </div>
          <div className="rounded-[var(--radius-brand-md)] bg-[var(--warning)]/10 p-3 text-center">
            <p className="text-lg font-bold text-[var(--warning)]">50-70%</p>
            <p className="text-xs text-[var(--warning)]">نسبة متوسطة</p>
          </div>
          <div className="rounded-[var(--radius-brand-md)] bg-destructive/10 p-3 text-center">
            <p className="text-lg font-bold text-destructive">أقل من 50%</p>
            <p className="text-xs text-destructive">نسبة منخفضة</p>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
