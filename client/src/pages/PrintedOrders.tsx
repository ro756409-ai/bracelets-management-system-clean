import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Download, Printer, RefreshCw, X } from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { cairoDateKey, cairoDayRange, previousDateKey } from "@/lib/cairoDate";
import {
  PageHeader, StatCard, SearchInput, StatusBadge, ResponsiveDataTable, StickyActionBar, OfflineState, type Column,
} from "@/components/shared";
import { PartnerLogo } from "@/components/brand";

const TOUCH = "min-h-11 md:min-h-9";

/**
 * المطبوعات — الأوردرات المطبوعة في يوم محدد (اليوم/أمس/تاريخ) بنطاق الجلسة، مع إعادة طباعة وتصدير Excel.
 * المرحلة 7D (عرض فقط): PageHeader + بطاقات ملخص حقيقية (من القائمة نفسها)، جدول Desktop/بطاقات Mobile
 * بنفس التحديد، شعار Bosta فقط للأوردرات التي سجّلتها بوسطة (نفس قاعدة bostaLastError السابقة)،
 * شريط إعادة طباعة ثابت على الهاتف مع حارس ضغط مكرر. نفس الاستعلام ونفس الروابط.
 */
export default function PrintedOrders() {
  const { currentBusinessIds } = useBusinessContext();
  const online = useOnlineStatus();
  const [dateFilter, setDateFilter] = useState<'today' | 'yesterday' | 'custom'>('today');
  const [customDate, setCustomDate] = useState('');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [printing, setPrinting] = useState(false);
  const utils = trpc.useUtils();

  // حساب نطاق التاريخ
  const dateRange = useMemo(() => {
    const todayStr = cairoDateKey();
    if (dateFilter === 'today') {
      return cairoDayRange(todayStr);
    }
    if (dateFilter === 'yesterday') {
      return cairoDayRange(previousDateKey(todayStr));
    }
    if (dateFilter === 'custom' && customDate) {
      return cairoDayRange(customDate);
    }
    return { from: undefined, to: undefined };
  }, [dateFilter, customDate]);

  const queryParams = useMemo(() => ({
    status: 'printed',
    printedDateFrom: dateRange.from,
    printedDateTo: dateRange.to,
    search: search || undefined,
    page: 1,
    limit: 1000,
    businessIds: currentBusinessIds,
  }), [dateRange, search, currentBusinessIds]);

  const { data, isLoading, isError, error, refetch } = trpc.orders.list.useQuery(queryParams);
  const orders = data?.orders ?? [];

  // إحصائيات (من القائمة المعروضة نفسها)
  const totalAmount = orders.reduce((s, o) => s + Number(o.totalAmount), 0);
  const totalQty = orders.reduce((s, o) => s + Number(o.quantity), 0);
  const bostaCount = orders.filter(o => o.bostaLastError?.includes('successfully')).length;
  const nonBostaCount = orders.length - bostaCount;

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const selectedKeys = useMemo(() => new Set<string | number>(selectedIds), [selectedIds]);

  const handleReprint = () => {
    if (selectedIds.length === 0) return;
    if (printing) return;
    setPrinting(true);
    const params = new URLSearchParams();
    params.set('orderIds', selectedIds.join(','));
    window.open(`/api/export/print-labels?${params.toString()}`, '_blank');
    toast.success(`جاري إعادة طباعة ${selectedIds.length} أوردر...`);
    setTimeout(() => {
      utils.orders.list.invalidate();
      setSelectedIds([]);
      setPrinting(false);
    }, 2000);
  };

  const handleExcelExport = () => {
    import('xlsx').then(XLSX => {
      const rows = orders.map((o, i) => ({
        '#': i + 1,
        'رقم الأوردر': o.easyOrderShortId || o.orderNumber,
        'العميل': o.customerName,
        'التليفون': o.customerPhone,
        'المحافظة': o.governorate || '',
        'العنوان': o.customerAddress || '',
        'المنتج': o.productName,
        'الكمية': o.quantity,
        'المبلغ': Number(o.totalAmount),
        'تاريخ الطباعة': o.printedAt ? new Date(o.printedAt).toLocaleString('ar-EG') : '',
        'تاريخ التأكيد': o.confirmedAt ? new Date(o.confirmedAt).toLocaleString('ar-EG') : '',
        'بوسطة': o.bostaLastError?.includes('successfully') ? 'نعم' : 'لا',
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'المطبوعات');
      const dateLabel = dateFilter === 'today' ? 'اليوم' : dateFilter === 'yesterday' ? 'أمس' : customDate;
      XLSX.writeFile(wb, `مطبوعات-${dateLabel}-${new Date().toISOString().slice(0, 10)}.xlsx`);
    });
  };

  const dateLabel = dateFilter === 'today'
    ? new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : dateFilter === 'yesterday'
    ? new Date(Date.now() - 86400000).toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : customDate ? new Date(customDate + 'T00:00:00').toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : 'اختر تاريخًا';

  const carrierCell = (o: any) => {
    const isBosta = o.bostaLastError?.includes('successfully');
    return isBosta ? (
      <span className="inline-flex items-center gap-1.5 text-xs"><PartnerLogo partner="bosta" size="xs" decorative /> بوسطة</span>
    ) : (
      <StatusBadge status="other" label="شركة أخرى" tone="warning" size="sm" icon={null} />
    );
  };

  const columns: Column<any>[] = [
    { id: "number", header: "رقم الأوردر", alwaysVisible: true, cell: o => <span className="font-mono text-xs font-medium" dir="ltr">{o.easyOrderShortId || o.orderNumber}</span> },
    { id: "customer", header: "العميل", alwaysVisible: true, cell: o => <div className="min-w-0"><p className="truncate text-sm font-medium">{o.customerName}</p><p className="font-mono text-xs text-muted-foreground" dir="ltr">{o.customerPhone}</p></div> },
    { id: "governorate", header: "المحافظة", cell: o => <span className="text-xs">{o.governorate || "—"}</span> },
    { id: "product", header: "المنتج", cell: o => <span className="block max-w-[180px] truncate text-xs" title={o.productName}>{o.productName}</span> },
    { id: "qty", header: "الكمية", numeric: true, cell: o => <span className="text-xs font-medium tabular-nums">{o.quantity}</span> },
    { id: "total", header: "المبلغ", numeric: true, cell: o => <span className="text-xs font-medium tabular-nums text-[var(--success)]">{Number(o.totalAmount).toLocaleString('ar-EG')} ج.م</span> },
    { id: "printedAt", header: "تاريخ الطباعة", cell: o => <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{o.printedAt ? new Date(o.printedAt).toLocaleString('ar-EG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</span> },
    { id: "carrier", header: "شحن", alwaysVisible: true, cell: carrierCell },
  ];

  const mobileRow = (o: any) => {
    const isSelected = selectedIds.includes(o.id);
    return (
      <article className={`rounded-[var(--radius-brand-md)] border bg-card p-3 ${isSelected ? "border-primary/50 bg-accent/40" : "border-border"}`} data-testid={`printed-card-${o.id}`}>
        <label className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center"><Checkbox checked={isSelected} onCheckedChange={() => toggleSelect(o.id)} aria-label={`تحديد الأوردر ${o.easyOrderShortId || o.orderNumber}`} /></span>
          <span className="min-w-0 flex-1">
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0"><span className="block truncate font-semibold">{o.customerName}</span><span className="block font-mono text-xs text-muted-foreground" dir="ltr">{o.easyOrderShortId || o.orderNumber}</span></span>
              {carrierCell(o)}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground" dir="ltr">{o.customerPhone}</span>
            <span className="mt-1 flex items-center justify-between text-xs"><span className="truncate">{o.productName} × {o.quantity}</span><span className="shrink-0 font-semibold tabular-nums text-[var(--success)]">{Number(o.totalAmount).toLocaleString('ar-EG')} ج.م</span></span>
            <span className="mt-1 block text-xs tabular-nums text-muted-foreground">{o.governorate || "—"} · طُبع {o.printedAt ? new Date(o.printedAt).toLocaleString('ar-EG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
          </span>
        </label>
      </article>
    );
  };

  const dateChip = (key: typeof dateFilter, label: string) => (
    <button
      type="button"
      key={key}
      onClick={() => setDateFilter(key)}
      className={`${TOUCH} rounded-[var(--radius-brand-pill)] border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${dateFilter === key ? "border-primary/40 bg-primary-soft text-primary-text" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}
      aria-pressed={dateFilter === key}
      data-testid={`printed-date-${key}`}
    >
      {label}
    </button>
  );

  return (
    <div className={`space-y-5 ${selectedIds.length > 0 ? "pb-[120px] md:pb-0" : ""}`} data-testid="printed-orders-page">
      <PageHeader
        title="المطبوعات"
        description={dateLabel}
        icon={<Printer className="h-5 w-5" aria-hidden="true" />}
        primaryAction={
          <Button size="sm" className={`${TOUCH} gap-1`} disabled={selectedIds.length === 0 || printing} onClick={handleReprint} aria-busy={printing || undefined} data-testid="printed-reprint">
            <Printer className="h-4 w-4" aria-hidden="true" />
            إعادة طباعة {selectedIds.length > 0 ? `(${selectedIds.length})` : ''}
          </Button>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => refetch()} className={`${TOUCH} gap-1`}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              تحديث
            </Button>
            <Button variant="outline" size="sm" className={`${TOUCH} gap-1`} onClick={handleExcelExport} disabled={orders.length === 0}>
              <Download className="h-4 w-4" aria-hidden="true" />
              تصدير Excel
            </Button>
          </>
        }
      >
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="ملخص المطبوعات" data-testid="printed-summary">
          <StatCard label="أوردرات مطبوعة" value={orders.length.toLocaleString('ar-EG')} hint="في التاريخ المختار (orders.list)" loading={isLoading} />
          <StatCard label="القطع" value={totalQty.toLocaleString('ar-EG')} hint="مجموع الكميات" loading={isLoading} />
          <StatCard label="المبالغ" value={`${totalAmount.toLocaleString('ar-EG')} ج.م`} hint="قيمة الأوردرات، ليست نقدًا محصّلًا" loading={isLoading} />
          <StatCard label="بوسطة / أخرى" value={`${bostaCount.toLocaleString('ar-EG')} / ${nonBostaCount.toLocaleString('ar-EG')}`} hint="سجّلتها بوسطة فعلًا / شركة أخرى" loading={isLoading} />
        </section>
      </PageHeader>

      {!online && <OfflineState onRetry={() => refetch()} className="py-6" />}

      {/* فلاتر التاريخ والبحث */}
      <div className="flex flex-wrap items-center gap-2" data-testid="printed-filters">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="التاريخ">
          {dateChip('today', 'اليوم')}{dateChip('yesterday', 'أمس')}{dateChip('custom', 'تاريخ مخصص')}
        </div>
        {dateFilter === 'custom' && (
          <Input type="date" value={customDate} onChange={e => setCustomDate(e.target.value)} className={`${TOUCH} w-44 text-sm`} aria-label="تاريخ الطباعة" />
        )}
        <div className="min-w-0 flex-1 sm:max-w-xs [&_input]:min-h-[max(2.75rem,44px)] md:[&_input]:min-h-9">
          <SearchInput value={search} onChange={setSearch} placeholder="بحث بالاسم أو الهاتف..." debounceMs={300} />
        </div>
      </div>

      {/* جدول Desktop / بطاقات Mobile */}
      <ResponsiveDataTable<any>
        rows={orders}
        columns={columns}
        rowKey={o => o.id}
        loading={isLoading}
        error={isError ? ((error as any)?.message || "تعذّر تحميل المطبوعات") : null}
        onRetry={() => refetch()}
        empty={{ title: "لا توجد أوردرات مطبوعة في هذا التاريخ", description: "اختر تاريخًا آخر أو عدّل البحث." }}
        selectedKeys={selectedKeys}
        onSelectionChange={keys => setSelectedIds([...keys].map(Number))}
        onRowClick={o => toggleSelect(o.id)}
        cardsBelow="md"
        mobileRow={mobileRow}
      />

      {/* شريط التحديد — ثابت فوق القائمة السفلية على الهاتف */}
      {selectedIds.length > 0 && (
        <StickyActionBar
          className="fixed inset-x-0 bottom-[var(--bottom-nav-h,0px)] z-30 mx-0 mt-0 mb-0 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:static md:mx-0 md:mt-4 md:rounded-[var(--radius-brand-md)] md:border md:px-4 md:pb-3"
          info={<span className="text-sm font-medium tabular-nums">{selectedIds.length} أوردر محدد</span>}
        >
          <Button type="button" size="sm" className={`${TOUCH} gap-1`} onClick={handleReprint} disabled={printing} data-testid="printed-reprint-bar">
            <Printer className="h-4 w-4" aria-hidden="true" />
            {printing ? "جاري الطباعة…" : "إعادة طباعة"}
          </Button>
          <Button type="button" size="sm" variant="ghost" className={`${TOUCH} min-w-11 px-2`} onClick={() => setSelectedIds([])} aria-label="إلغاء التحديد">
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </StickyActionBar>
      )}
    </div>
  );
}
