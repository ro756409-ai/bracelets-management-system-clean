import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GitMerge, RefreshCw, Phone, Package, Hash, Calendar, TrendingUp } from "lucide-react";
import { PageHeader, StatCard, SectionCard, StatusBadge, SearchInput, ResponsiveDataTable, OfflineState, type Column } from "@/components/shared";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

const TOUCH = "min-h-11 md:min-h-9";

/**
 * تقرير الدمج التلقائي — نفس الاستعلام (reports.mergeLogs بحد 200) ونفس البحث والفلاتر والإحصاءات
 * (مجاميع السجل المعروض). المرحلة 7I (عرض فقط): PageHeader + StatCards بمصدرها، جدول Desktop/بطاقات
 * Mobile عبر ResponsiveDataTable، حقول معنونة 44px، وحالات Loading/Empty/Error/Offline.
 */
export default function MergeLogs() {
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  const online = useOnlineStatus();

  const { data, isLoading, isError, error, refetch } = trpc.reports.mergeLogs.useQuery({
    dateFrom,
    dateTo,
    limit: 200,
  });

  const logs = data?.logs ?? [];

  // Filter by search
  const filtered = logs.filter((log: any) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      log.customerName?.toLowerCase().includes(q) ||
      log.customerPhone?.includes(q) ||
      log.productName?.toLowerCase().includes(q) ||
      log.keptOrderNumber?.includes(q)
    );
  });

  // Stats
  const totalMerges = logs.length;
  const totalQtyMerged = logs.reduce((sum: number, l: any) => sum + Number(l.mergedQty || 0), 0);
  const uniqueCustomers = new Set(logs.map((l: any) => l.customerPhone)).size;
  const todayMerges = logs.filter((l: any) => {
    const d = new Date(l.createdAt);
    const today = new Date();
    return d.toDateString() === today.toDateString();
  }).length;

  const formatDate = (d: any) => {
    if (!d) return "-";
    return new Date(d).toLocaleString("ar-EG", {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  };

  const hasFilters = !!(search || dateFrom || dateTo);

  const columns: Column<any>[] = [
    { id: "order", header: <span className="inline-flex items-center gap-1"><Hash className="h-3.5 w-3.5" aria-hidden="true" /> رقم الأوردر</span>, alwaysVisible: true, cell: l => <StatusBadge status="kept" label={`#${l.keptOrderNumber}`} tone="warning" size="sm" icon={null} className="font-mono" /> },
    { id: "customer", header: <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" aria-hidden="true" /> العميل</span>, alwaysVisible: true, cell: l => <div className="min-w-0"><p className="font-medium">{l.customerName}</p><p className="text-xs text-muted-foreground" dir="ltr">{l.customerPhone}</p></div> },
    { id: "product", header: <span className="inline-flex items-center gap-1"><Package className="h-3.5 w-3.5" aria-hidden="true" /> المنتج</span>, cell: l => <span className="block max-w-[220px] truncate" title={l.productName}>{l.productName}</span> },
    { id: "merged", header: <span className="inline-flex items-center gap-1"><TrendingUp className="h-3.5 w-3.5" aria-hidden="true" /> الكمية المضافة</span>, numeric: true, cell: l => <StatusBadge status="merged" label={`+${l.mergedQty}`} tone="info" size="sm" icon={null} /> },
    { id: "after", header: "الكمية بعد الدمج", numeric: true, cell: l => <span className="font-semibold tabular-nums text-[var(--success)]">{l.totalQtyAfter}</span> },
    { id: "date", header: <span className="inline-flex items-center gap-1"><Calendar className="h-3.5 w-3.5" aria-hidden="true" /> التاريخ</span>, cell: l => <span className="text-xs tabular-nums text-muted-foreground">{formatDate(l.createdAt)}</span> },
  ];

  return (
    <div className="space-y-6" dir="rtl" data-testid="merge-logs-page">
      <PageHeader
        title="تقرير الدمج التلقائي"
        description="سجل كامل بكل أوردر تم دمجه تلقائياً بسبب التكرار"
        icon={<GitMerge className="h-5 w-5" aria-hidden="true" />}
        actions={<Button data-readonly-safe variant="outline" size="sm" onClick={() => refetch()} className={`${TOUCH} gap-2`} data-testid="merge-refresh"><RefreshCw className="h-4 w-4" aria-hidden="true" /> تحديث</Button>}
      >
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="إحصاءات الدمج" data-testid="merge-stats">
          <StatCard label="إجمالي عمليات الدمج" value={totalMerges.toLocaleString("ar-EG")} tone="warning" hint="آخر 200 عملية دمج" loading={isLoading} />
          <StatCard label="إجمالي الكميات المدمجة" value={totalQtyMerged.toLocaleString("ar-EG")} tone="info" loading={isLoading} />
          <StatCard label="عملاء فريدون" value={uniqueCustomers.toLocaleString("ar-EG")} tone="success" loading={isLoading} />
          <StatCard label="دمج اليوم" value={todayMerges.toLocaleString("ar-EG")} tone="primary" loading={isLoading} />
        </section>
      </PageHeader>

      {!online && <OfflineState onRetry={() => refetch()} className="py-6" />}

      {/* Filters */}
      <SectionCard testId="merge-filters">
        <div className="flex flex-wrap items-end gap-3">
          <SearchInput value={search} onChange={setSearch} placeholder="بحث بالاسم أو الهاتف أو المنتج..." className="min-w-[200px] flex-1" />
          <div>
            <Label htmlFor="merge-from" className="mb-1 block text-xs text-muted-foreground">من</Label>
            <Input id="merge-from" type="date" className={`${TOUCH} w-40`} dir="ltr" onChange={e => setDateFrom(e.target.value ? new Date(e.target.value) : undefined)} />
          </div>
          <div>
            <Label htmlFor="merge-to" className="mb-1 block text-xs text-muted-foreground">إلى</Label>
            <Input id="merge-to" type="date" className={`${TOUCH} w-40`} dir="ltr" onChange={e => setDateTo(e.target.value ? new Date(e.target.value + "T23:59:59") : undefined)} />
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" className={TOUCH} onClick={() => { setSearch(""); setDateFrom(undefined); setDateTo(undefined); }}>
              مسح الفلاتر
            </Button>
          )}
        </div>
      </SectionCard>

      {/* Table */}
      <SectionCard title={<span className="inline-flex items-center gap-2"><GitMerge className="h-4 w-4 text-primary" aria-hidden="true" /> سجل عمليات الدمج <StatusBadge status="count" label={`${filtered.length.toLocaleString("ar-EG")} عملية`} tone="neutral" size="sm" icon={null} /></span>} flush testId="merge-list">
        <ResponsiveDataTable<any>
          rows={filtered}
          columns={columns}
          rowKey={l => l.id}
          loading={isLoading}
          error={isError ? ((error as any)?.message || "تعذّر تحميل سجل الدمج") : null}
          onRetry={() => refetch()}
          empty={{ title: "لا توجد عمليات دمج", description: hasFilters ? "عدّل البحث أو نطاق التاريخ." : "لم يتم دمج أي أوردرات مكررة حتى الآن" }}
          cardsBelow="md"
          mobileRow={l => (
            <article className="space-y-1.5 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`merge-card-${l.id}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0"><p className="font-semibold">{l.customerName}</p><p className="text-xs text-muted-foreground" dir="ltr">{l.customerPhone}</p></div>
                <StatusBadge status="kept" label={`#${l.keptOrderNumber}`} tone="warning" size="sm" icon={null} className="font-mono" />
              </div>
              <p className="truncate text-sm">{l.productName}</p>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-2"><StatusBadge status="merged" label={`+${l.mergedQty}`} tone="info" size="sm" icon={null} /> بعد الدمج <b className="tabular-nums text-[var(--success)]">{l.totalQtyAfter}</b></span>
                <span className="tabular-nums">{formatDate(l.createdAt)}</span>
              </div>
            </article>
          )}
        />
      </SectionCard>
    </div>
  );
}
