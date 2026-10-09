import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DateRangePicker, { type DateRange } from "@/components/DateRangePicker";
import { CalendarDays, RotateCcw } from "lucide-react";
import {
  PageHeader, StatCard, StatusBadge, SectionCard, ResponsiveDataTable, Pagination, OfflineState, type Column,
} from "@/components/shared";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

const RETURN_REASON_LABELS: Record<string, string> = {
  customer_refused: "رفض العميل",
  wrong_product: "منتج خاطئ",
  damaged: "تالف",
  wrong_address: "عنوان خاطئ",
  customer_not_available: "العميل غير متاح",
  other: "أخرى",
};

const RETURN_REASON_TONE: Record<string, "danger" | "warning" | "primary" | "info" | "neutral"> = {
  customer_refused: "danger",
  wrong_product: "warning",
  damaged: "warning",
  wrong_address: "primary",
  customer_not_available: "info",
  other: "neutral",
};

const TOUCH = "min-h-11 md:min-h-9";

/**
 * تقرير المرتجعات — القائمة والإحصاءات من returns.list / returns.stats بنطاق النشاط الواحد.
 * المرحلة 7D (عرض فقط): بطاقات ملخص من stats، StatusBadge للسبب والمخزون، جدول Desktop/بطاقات Mobile،
 * ترقيم مشترك، وحالات Loading/Empty/Error/Offline. نفس الفلاتر ونفس الاستعلامات.
 */
export default function Returns() {
  const { currentBusinessIds } = useBusinessContext();
  const online = useOnlineStatus();
  const [page, setPage] = useState(1);
  const [reasonFilter, setReasonFilter] = useState<string>("all");
  const [govFilter, setGovFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });
  const LIMIT = 50;

  const listParams = useMemo(() => ({
    page,
    limit: LIMIT,
    returnReason: reasonFilter !== "all" ? reasonFilter : undefined,
    governorate: govFilter !== "all" ? govFilter : undefined,
    dateFrom: dateRange.from ?? undefined,
    dateTo: dateRange.to ?? undefined,
    businessId: currentBusinessIds && currentBusinessIds.length === 1 ? currentBusinessIds[0] : undefined,
  }), [page, reasonFilter, govFilter, dateRange, currentBusinessIds]);

  const { data: listData, isLoading, isError, error, refetch } = trpc.returns.list.useQuery(listParams);
  const { data: stats, isLoading: statsLoading } = trpc.returns.stats.useQuery({
    businessId: currentBusinessIds && currentBusinessIds.length === 1 ? currentBusinessIds[0] : undefined,
  });

  const items = listData?.items ?? [];
  const total = listData?.total ?? 0;
  const hasFilters = reasonFilter !== "all" || govFilter !== "all" || !!dateRange.from;

  const reasonBadge = (reason: string) => <StatusBadge status={reason} label={RETURN_REASON_LABELS[reason] ?? reason} tone={RETURN_REASON_TONE[reason] ?? "neutral"} size="sm" icon={null} />;
  const stockBadge = (restored: boolean) => restored
    ? <StatusBadge status="restored" label="أُعيد للمخزون" tone="success" size="sm" />
    : <StatusBadge status="not_restored" label="لم يُعَد" tone="neutral" size="sm" icon={null} />;

  const columns: Column<any>[] = [
    { id: "number", header: "رقم الأوردر", alwaysVisible: true, cell: r => <span className="font-mono text-xs font-semibold text-[var(--warning)]" dir="ltr">{r.orderNumber}</span> },
    { id: "customer", header: "العميل", alwaysVisible: true, cell: r => <div className="min-w-0"><p className="font-medium">{r.customerName}</p><p className="text-xs text-muted-foreground" dir="ltr">{r.customerPhone}</p></div> },
    { id: "governorate", header: "المحافظة", cell: r => <span className="text-muted-foreground">{r.governorate || "—"}</span> },
    { id: "product", header: "المنتج", cell: r => <span className="block max-w-[180px] truncate" title={r.productName}>{r.productName}</span> },
    { id: "qty", header: "الكمية", numeric: true, cell: r => <span className="tabular-nums">{r.quantity}</span> },
    { id: "total", header: "المبلغ", numeric: true, cell: r => <span className="font-semibold tabular-nums">{Number(r.totalAmount).toLocaleString("ar-EG")} ج.م</span> },
    { id: "reason", header: "سبب الإرجاع", alwaysVisible: true, cell: r => reasonBadge(r.returnReason) },
    { id: "stock", header: "المخزون", cell: r => stockBadge(!!r.stockRestored) },
    { id: "date", header: "التاريخ", cell: r => <span className="text-xs tabular-nums text-muted-foreground">{new Date(r.createdAt).toLocaleDateString("ar-EG")}</span> },
  ];

  return (
    <div className="space-y-5" dir="rtl" data-testid="returns-page">
      <PageHeader
        title="تقرير المرتجعات"
        description="متابعة جميع الأوردرات المرتجعة وأسباب الإرجاع"
        icon={<RotateCcw className="h-5 w-5" aria-hidden="true" />}
      >
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="ملخص المرتجعات" data-testid="returns-summary">
          <StatCard label="إجمالي المرتجعات" value={Number(stats?.total ?? 0).toLocaleString("ar-EG")} hint="حسب الفترة المختارة" loading={statsLoading} />
          <StatCard
            label="إجمالي قيمة المرتجعات"
            value={`${stats?.totalAmount ? Number(stats.totalAmount).toLocaleString("ar-EG") : "٠"} ج.م`}
            tone="danger"
            hint="قيمة الأوردرات المرتجعة"
            loading={statsLoading}
          />
          {stats?.byReason?.slice(0, 2).map((r: any) => (
            <StatCard key={r.reason} label={RETURN_REASON_LABELS[r.reason] ?? r.reason} value={Number(r.count).toLocaleString("ar-EG")} hint="أكثر الأسباب" />
          ))}
        </section>
      </PageHeader>

      {!online && <OfflineState onRetry={() => refetch()} className="py-6" />}

      {/* Reason Breakdown */}
      {stats?.byReason && stats.byReason.length > 0 && (
        <SectionCard title="توزيع أسباب الإرجاع" testId="returns-reasons">
          <ul className="flex flex-wrap gap-3" aria-label="أسباب الإرجاع">
            {stats.byReason.map((r: any) => (
              <li key={r.reason} className="flex items-center gap-2">
                {reasonBadge(r.reason)}
                <span className="text-sm font-semibold tabular-nums">{Number(r.count).toLocaleString("ar-EG")}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 [&_[role=combobox]]:min-h-[max(2.75rem,44px)] md:[&_[role=combobox]]:min-h-9" data-testid="returns-filters">
        <div>
          <Label htmlFor="returns-reason" className="mb-1 block text-xs text-muted-foreground">سبب الإرجاع</Label>
          <Select value={reasonFilter} onValueChange={v => { setReasonFilter(v); setPage(1); }}>
            <SelectTrigger id="returns-reason" className="w-48"><SelectValue placeholder="فلتر بسبب الإرجاع" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الأسباب</SelectItem>
              {Object.entries(RETURN_REASON_LABELS).map(([val, label]) => (
                <SelectItem key={val} value={val}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm text-muted-foreground">التاريخ:</span>
          <DateRangePicker value={dateRange} onChange={(range) => { setDateRange(range); setPage(1); }} />
        </div>
        {hasFilters && (
          <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={() => { setReasonFilter("all"); setGovFilter("all"); setDateRange({ from: null, to: null }); setPage(1); }}>
            إلغاء الفلاتر
          </Button>
        )}
      </div>

      {/* List */}
      <SectionCard title={<span>قائمة المرتجعات <span className="text-sm font-normal text-muted-foreground tabular-nums">({total.toLocaleString("ar-EG")} مرتجع)</span></span>} flush testId="returns-list">
        <ResponsiveDataTable<any>
          rows={items}
          columns={columns}
          rowKey={r => r.id}
          loading={isLoading}
          error={isError ? ((error as any)?.message || "تعذّر تحميل المرتجعات") : null}
          onRetry={() => refetch()}
          empty={{ title: "لا توجد مرتجعات بعد", description: hasFilters ? "عدّل الفلاتر الحالية." : "المرتجعات المسجلة ستظهر هنا." }}
          cardsBelow="md"
          mobileRow={r => (
            <article className="space-y-1.5 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`return-card-${r.id}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">{r.customerName}</p>
                  <p className="font-mono text-xs text-[var(--warning)]" dir="ltr">{r.orderNumber}</p>
                </div>
                {reasonBadge(r.returnReason)}
              </div>
              <p className="text-xs text-muted-foreground" dir="ltr">{r.customerPhone}</p>
              <p className="flex items-center justify-between text-sm"><span className="truncate">{r.productName} × {r.quantity}</span><span className="shrink-0 font-semibold tabular-nums">{Number(r.totalAmount).toLocaleString("ar-EG")} ج.م</span></p>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{r.governorate || "—"} · {new Date(r.createdAt).toLocaleDateString("ar-EG")}</span>{stockBadge(!!r.stockRestored)}</div>
            </article>
          )}
        />
      </SectionCard>

      {total > LIMIT && (
        <Pagination page={page} pageSize={LIMIT} total={total} onPageChange={setPage} />
      )}
    </div>
  );
}
