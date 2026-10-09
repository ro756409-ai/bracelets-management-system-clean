import { useState, useMemo, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Printer, FileSpreadsheet, CheckSquare, Square, RefreshCw,
  Package, MapPin, Phone, User, X
} from "lucide-react";
import { toast } from "sonner";
import { useBusinessContext } from "@/contexts/BusinessContext";
import {
  WorkspaceShell, StatusFilterChips, DataToolbar, StatusBadge, ORDER_STATUS,
  Pagination, type StatusChipItem,
} from "@/components/workspace";
import { ResponsiveDataTable, StickyActionBar, type Column, type FilterChip } from "@/components/shared";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { OfflineState } from "@/components/shared";

const ITEMS_PER_PAGE = 50;
const TOUCH = "min-h-11 md:min-h-9";
/** أهداف لمس 44px للمكوّنات المشتركة داخل هذه الصفحة فقط (شرائح الفلتر/البحث/المحافظة). */
const TOUCH_SCOPE = "[&_button]:min-h-[max(2.75rem,44px)] [&_input]:min-h-[max(2.75rem,44px)] [&_[role=combobox]]:min-h-[max(2.75rem,44px)] md:[&_button]:min-h-9 md:[&_input]:min-h-9 md:[&_[role=combobox]]:min-h-9";

/**
 * Operations workspace — التجهيز والطباعة (Stage D).
 *
 * مبني على toolkit المرحلة A (عرض بس): رأس موحّد + شرائح حالة (مصدر واحد للحالة والعدّادات)
 * + DataToolbar (بحث + محافظة + chips + reset). تبويبات التشغيل (التجهيز/شحنات اليوم/جدول
 * الشحن) بيعرضها الشل من NavConfig — مفيش شريط تبويبات تاني جوه الصفحة.
 *
 * التحديد والطباعة وشيت الشحن وسجل الطباعة زي ما هم. النطاق currentBusinessIds (قراءة).
 * المرحلة 7D (عرض فقط): جدول Desktop/بطاقات Mobile عبر ResponsiveDataTable بنفس التحديد الجماعي،
 * شريط إجراءات ثابت فوق القائمة السفلية على الهاتف، وحارس ضغط مكرر على الطباعة/الشيت.
 */
export default function Preparation() {
  const { currentBusinessIds } = useBusinessContext();
  const online = useOnlineStatus();

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "confirmed" | "printed">("all");
  const [filterGovernorate, setFilterGovernorate] = useState("all");
  const [page, setPage] = useState(1);
  /** قفل الطباعة/الشيت أثناء فتح النافذة وتسجيل السجل — ضغطتان = عملية واحدة */
  const [printing, setPrinting] = useState(false);

  const utils = trpc.useUtils();

  // جلب الأوردرات المؤكدة والمطبوعة
  const { data, isLoading, isError, error, refetch } = trpc.orders.list.useQuery(
    {
      statuses: filterStatus === "all" ? ["confirmed", "printed"] : [filterStatus],
      search: search || undefined,
      governorate: filterGovernorate !== "all" ? filterGovernorate : undefined,
      page,
      limit: ITEMS_PER_PAGE,
      businessIds: currentBusinessIds,
    },
    { refetchInterval: 30000 }
  );

  // عدّادات الحالات من السيرفر (نفس مصدر Orders workspace، متقيّدة بالنشاط) — كانت
  // بتتعدّ من صفحة الـ50 أوردر الحالية فبتبان أقل من الحقيقة.
  const { data: statusCounts, refetch: refetchCounts } = trpc.orders.statusCounts.useQuery(
    { businessIds: currentBusinessIds },
    { refetchInterval: 30000 }
  );
  const confirmedTotal = statusCounts?.byStatus?.confirmed ?? 0;
  const printedTotal = statusCounts?.byStatus?.printed ?? 0;

  const orders = data?.orders ?? [];
  const totalCount = data?.total ?? 0;

  // المحافظات المتاحة
  const governorates = useMemo(() => {
    const govs = new Set(orders.map((o: any) => o.governorate).filter(Boolean));
    return Array.from(govs).sort() as string[];
  }, [orders]);

  // المؤكدة في الصفحة الحالية — ده اللي «تحديد كل المؤكدة» بيحدده فعلًا.
  const pageConfirmedCount = orders.filter((o: any) => o.status === "confirmed").length;

  const statusChips: StatusChipItem[] = [
    { key: "confirmed", label: ORDER_STATUS.confirmed.label, count: confirmedTotal, tone: ORDER_STATUS.confirmed.tone },
    { key: "printed", label: ORDER_STATUS.printed.label, count: printedTotal, tone: ORDER_STATUS.printed.tone },
  ];

  const filterChips: FilterChip[] = [
    ...(search ? [{ key: "search", label: "بحث", value: search }] : []),
    ...(filterGovernorate !== "all" ? [{ key: "governorate", label: "المحافظة", value: filterGovernorate }] : []),
  ];

  const clearFilterChip = (key: string) => {
    if (key === "search") setSearch("");
    if (key === "governorate") setFilterGovernorate("all");
    setPage(1);
  };

  const resetFilters = () => {
    setSearch(""); setFilterStatus("all"); setFilterGovernorate("all"); setPage(1);
  };

  // تحديد الكل في الصفحة الحالية
  const currentPageIds = orders.map((o: any) => o.id);
  const allCurrentSelected = currentPageIds.length > 0 && currentPageIds.every((id: number) => selectedIds.includes(id));

  const toggleSelectAll = useCallback(() => {
    if (allCurrentSelected) {
      setSelectedIds(prev => prev.filter(id => !currentPageIds.includes(id)));
    } else {
      setSelectedIds(prev => {
        const newIds = currentPageIds.filter((id: number) => !prev.includes(id));
        return [...prev, ...newIds];
      });
    }
  }, [allCurrentSelected, currentPageIds]);

  const toggleOrder = useCallback((id: number) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }, []);

  const clearSelection = () => setSelectedIds([]);

  // تحديد كل المؤكدة
  const selectAllConfirmed = () => {
    const confirmedIds = orders.filter((o: any) => o.status === "confirmed").map((o: any) => o.id);
    setSelectedIds(prev => {
      const newIds = confirmedIds.filter((id: number) => !prev.includes(id));
      return [...prev, ...newIds];
    });
    toast.success(`تم تحديد ${confirmedIds.length} أوردر مؤكد`);
  };

  // حفظ سجل الطباعة
  const savePrintLogMutation = trpc.printLogs.create.useMutation({
    onSuccess: () => {
      utils.printLogs.list.invalidate();
    },
  });

  // طباعة
  const handlePrint = () => {
    if (selectedIds.length === 0) {
      toast.error("يرجى تحديد أوردر واحد على الأقل");
      return;
    }
    if (printing || savePrintLogMutation.isPending) return;
    setPrinting(true);
    const params = new URLSearchParams();
    params.set("orderIds", selectedIds.join(","));
    window.open(`/api/export/print-labels?${params.toString()}`, "_blank");
    // حفظ سجل الطباعة
    savePrintLogMutation.mutate({ type: "labels", orderIds: [...selectedIds] });
    toast.success(`جاري طباعة ${selectedIds.length} أوردر...`);
    setTimeout(() => {
      utils.orders.list.invalidate();
      // الطباعة بتحوّل المؤكد لمطبوع — العدّادات لازم تتحدّث معاها.
      utils.orders.statusCounts.invalidate();
      setSelectedIds([]);
      setPrinting(false);
    }, 2500);
  };

  // شيت الشحن مع validation
  const handleShippingSheet = async () => {
    if (selectedIds.length === 0) {
      toast.error("يرجى تحديد أوردر واحد على الأقل");
      return;
    }
    if (printing || savePrintLogMutation.isPending) return;
    // التحقق من البيانات الناقصة قبل التصدير
    const selectedOrders = orders.filter(o => selectedIds.includes(o.id));
    const incompleteOrders = selectedOrders.filter(o =>
      !o.customerPhone || String(o.customerPhone).length < 10 ||
      !o.governorate || !o.governorate.trim() ||
      !o.customerAddress || String(o.customerAddress).trim().length < 5
    );
    if (incompleteOrders.length > 0) {
      const names = incompleteOrders.slice(0, 5).map(o => `#${o.orderNumber}`).join(", ");
      const more = incompleteOrders.length > 5 ? ` و${incompleteOrders.length - 5} آخرين` : "";
      toast.error(`${incompleteOrders.length} أوردر ببيانات ناقصة (هاتف/عنوان/محافظة): ${names}${more}. يرجى إكمال البيانات أولاً.`, { duration: 8000 });
      return;
    }
    setPrinting(true);
    const params = new URLSearchParams();
    params.set("orderIds", selectedIds.join(","));
    window.open(`/api/export/shipping?${params.toString()}`, "_blank");
    // حفظ سجل الطباعة
    savePrintLogMutation.mutate({ type: "shipping_sheet", orderIds: [...selectedIds] });
    toast.success(`جاري تصدير شيت الشحن لـ ${selectedIds.length} أوردر...`);
    setTimeout(() => setPrinting(false), 1500);
  };

  const selectedKeys = useMemo(() => new Set<string | number>(selectedIds), [selectedIds]);
  const onSelectionChange = (keys: Set<string | number>) => setSelectedIds([...keys].map(Number));
  const busy = printing || savePrintLogMutation.isPending;

  const fmtDate = (d: Date) => d.toLocaleDateString("ar-EG");
  const fmtTime = (d: Date) => d.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });

  const columns: Column<any>[] = [
    { id: "number", header: "#", alwaysVisible: true, cell: o => <span className="font-mono text-xs text-muted-foreground" dir="ltr">{o.orderNumber || o.id}</span> },
    { id: "customer", header: "العميل", alwaysVisible: true, cell: o => <span className="inline-flex max-w-[160px] items-center gap-1.5"><User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /><span className="truncate font-medium">{o.customerName}</span></span> },
    { id: "phone", header: "التليفون", cell: o => <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground" dir="ltr"><Phone className="h-3 w-3 shrink-0" aria-hidden="true" />{o.customerPhone}</span> },
    { id: "governorate", header: "المحافظة", cell: o => <span className="inline-flex items-center gap-1 text-xs"><MapPin className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />{o.governorate || "—"}</span> },
    { id: "address", header: "العنوان", cell: o => <span className="block max-w-[180px] truncate text-xs text-muted-foreground" title={o.customerAddress}>{o.customerAddress || "—"}</span> },
    { id: "product", header: "المنتج", cell: o => <span className="block max-w-[140px] truncate text-xs" title={o.productName}>{o.productName || "—"}</span> },
    { id: "total", header: "الإجمالي", numeric: true, cell: o => <span className="text-sm font-medium tabular-nums">{o.totalAmount ? `${Number(o.totalAmount).toLocaleString("ar-EG")} ج.م` : "—"}</span> },
    { id: "status", header: "الحالة", alwaysVisible: true, cell: o => <StatusBadge status={o.status} size="sm" /> },
    { id: "confirmedAt", header: "وقت التأكيد", cell: o => o.confirmedAt ? <span className="block text-xs tabular-nums text-muted-foreground">{fmtDate(new Date(o.confirmedAt))}<span className="block opacity-70">{fmtTime(new Date(o.confirmedAt))}</span></span> : <span className="text-xs text-muted-foreground">—</span> },
  ];

  const mobileRow = (o: any) => {
    const isSelected = selectedIds.includes(o.id);
    return (
      <article className={`rounded-[var(--radius-brand-md)] border bg-card p-3 ${isSelected ? "border-primary/50 bg-accent/40" : "border-border"} ${o.status === "confirmed" ? "border-s-4 border-s-[var(--success)]/60" : ""}`} data-testid={`prep-card-${o.id}`} data-selected={isSelected || undefined}>
        <label className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center"><Checkbox checked={isSelected} onCheckedChange={() => toggleOrder(o.id)} aria-label={`تحديد الأوردر ${o.orderNumber || o.id}`} /></span>
          <span className="min-w-0 flex-1">
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0"><span className="block truncate font-semibold">{o.customerName}</span><span className="block font-mono text-xs text-muted-foreground" dir="ltr">{o.orderNumber || o.id}</span></span>
              <StatusBadge status={o.status} size="sm" />
            </span>
            <span className="mt-1 block text-xs text-muted-foreground" dir="ltr">{o.customerPhone}</span>
            <span className="mt-1 block text-xs">{o.governorate || "—"} · <span className="text-muted-foreground">{o.customerAddress || "—"}</span></span>
            <span className="mt-1 flex items-center justify-between text-xs"><span className="truncate">{o.productName || "—"}</span><span className="shrink-0 font-semibold tabular-nums">{o.totalAmount ? `${Number(o.totalAmount).toLocaleString("ar-EG")} ج.م` : "—"}</span></span>
            {o.confirmedAt && <span className="mt-1 block text-xs tabular-nums text-muted-foreground">تأكيد: {fmtDate(new Date(o.confirmedAt))} {fmtTime(new Date(o.confirmedAt))}</span>}
          </span>
        </label>
      </article>
    );
  };

  return (
    <WorkspaceShell
      title="التجهيز والطباعة"
      description="الأوردرات المؤكدة الجاهزة للشحن — حدّد، اطبع البوالص، وصدّر شيت الشحن."
      icon={<Package className="h-5 w-5" />}
      actions={
        <Button data-readonly-safe variant="outline" size="sm" onClick={() => { refetch(); refetchCounts(); }} className={`${TOUCH} gap-1.5`}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          تحديث
        </Button>
      }
    >
      <div className={`space-y-4 ${selectedIds.length > 0 ? "pb-[120px] md:pb-0" : ""}`} data-testid="preparation-page">
        {!online && <OfflineState onRetry={() => { refetch(); refetchCounts(); }} className="py-6" />}

        <div className={`space-y-4 ${TOUCH_SCOPE}`} data-testid="preparation-filters">
          {/* الحالة — مصدر واحد: الفلترة + العدّادات (بدل شريط الإحصائيات + Select الحالة). */}
          <StatusFilterChips
            chips={statusChips}
            value={filterStatus === "all" ? null : filterStatus}
            onChange={(key) => { setFilterStatus((key ?? "all") as typeof filterStatus); setPage(1); }}
            totalCount={statusCounts ? confirmedTotal + printedTotal : undefined}
          />

          <DataToolbar
            search={search}
            onSearch={(value) => { setSearch(value); setPage(1); }}
            searchPlaceholder="بحث باسم العميل أو التليفون..."
            filters={
              <Select value={filterGovernorate} onValueChange={(v) => { setFilterGovernorate(v); setPage(1); }}>
                <SelectTrigger className="w-40 text-sm" aria-label="المحافظة">
                  <SelectValue placeholder="المحافظة" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل المحافظات</SelectItem>
                  {governorates.map(g => (
                    <SelectItem key={g} value={g}>{g}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
            chips={filterChips}
            onClearChip={clearFilterChip}
            onReset={resetFilters}
          />
        </div>

        {/* التحديد السريع */}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="sm" className={`${TOUCH} gap-1 text-xs`} onClick={toggleSelectAll} data-testid="prep-select-page">
            {allCurrentSelected
              ? <><CheckSquare className="h-3.5 w-3.5" aria-hidden="true" /> إلغاء تحديد الصفحة</>
              : <><Square className="h-3.5 w-3.5" aria-hidden="true" /> تحديد الصفحة</>
            }
          </Button>
          <Button type="button" variant="ghost" size="sm" className={`${TOUCH} gap-1 text-xs text-[var(--success)]`} onClick={selectAllConfirmed} data-testid="prep-select-confirmed">
            <CheckSquare className="h-3.5 w-3.5" aria-hidden="true" />
            تحديد كل المؤكدة ({pageConfirmedCount})
          </Button>
          {selectedIds.length > 0 && (
            <>
              <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
              <span className="text-xs font-medium text-primary-text tabular-nums" data-testid="prep-selected-count">
                {selectedIds.length} محدد
              </span>
              <Button type="button" variant="ghost" size="sm" className={`${TOUCH} text-xs text-muted-foreground`} onClick={clearSelection}>
                <X className="ml-1 h-3 w-3" aria-hidden="true" />
                إلغاء
              </Button>
            </>
          )}
        </div>

        {/* جدول Desktop / بطاقات Mobile — نفس التحديد الجماعي */}
        <ResponsiveDataTable<any>
          rows={orders}
          columns={columns}
          rowKey={o => o.id}
          loading={isLoading}
          error={isError ? ((error as any)?.message || "تعذّر تحميل الأوردرات") : null}
          onRetry={() => refetch()}
          empty={{ title: "لا توجد أوردرات مؤكدة حالياً", description: "الأوردرات المؤكدة ستظهر هنا تلقائياً" }}
          selectedKeys={selectedKeys}
          onSelectionChange={onSelectionChange}
          onRowClick={o => toggleOrder(o.id)}
          cardsBelow="md"
          mobileRow={mobileRow}
        />

        {/* الترقيم — بيوضّح كمان إجمالي النتائج بعد الفلترة. */}
        {totalCount > 0 && (
          <Pagination page={page} pageSize={ITEMS_PER_PAGE} total={totalCount} onPageChange={setPage} />
        )}

        {/* شريط إجراءات التحديد: ثابت فوق القائمة السفلية على الهاتف، شريط عادي على md+ */}
        {selectedIds.length > 0 && (
          <StickyActionBar
            className="fixed inset-x-0 bottom-[var(--bottom-nav-h,0px)] z-30 mx-0 mt-0 mb-0 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:static md:mx-0 md:mt-4 md:rounded-[var(--radius-brand-md)] md:border md:px-4 md:pb-3"
            info={
              <span className="flex items-center gap-2 text-sm">
                <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1 text-xs font-bold text-primary-foreground tabular-nums">{selectedIds.length}</span>
                <span className="font-medium">أوردر محدد</span>
              </span>
            }
          >
            <Button type="button" size="sm" className={`${TOUCH} gap-1`} onClick={handlePrint} disabled={busy} aria-busy={busy || undefined} data-testid="prep-print">
              <Printer className="h-3.5 w-3.5" aria-hidden="true" />
              {printing ? "جاري الطباعة…" : "طباعة"}
            </Button>
            <Button type="button" size="sm" variant="outline" className={`${TOUCH} gap-1`} onClick={handleShippingSheet} disabled={busy} data-testid="prep-sheet">
              <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
              شيت الشحن
            </Button>
            <Button type="button" size="sm" variant="ghost" className={`${TOUCH} min-w-11 px-2`} onClick={clearSelection} aria-label="إلغاء التحديد" title="إلغاء التحديد">
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </StickyActionBar>
        )}
      </div>
    </WorkspaceShell>
  );
}
