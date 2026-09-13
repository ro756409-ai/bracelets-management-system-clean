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
  EmptyState, LoadingSkeleton, Pagination, type StatusChipItem,
} from "@/components/workspace";
import type { FilterChip } from "@/components/shared";

const ITEMS_PER_PAGE = 50;

/**
 * Operations workspace — التجهيز والطباعة (Stage D).
 *
 * مبني على toolkit المرحلة A (عرض بس): رأس موحّد + شرائح حالة (مصدر واحد للحالة والعدّادات)
 * + DataToolbar (بحث + محافظة + chips + reset). تبويبات التشغيل (التجهيز/شحنات اليوم/جدول
 * الشحن) بيعرضها الشل من NavConfig — مفيش شريط تبويبات تاني جوه الصفحة.
 *
 * التحديد والطباعة وشيت الشحن وسجل الطباعة زي ما هم. النطاق currentBusinessIds (قراءة).
 */
export default function Preparation() {
  const { currentBusinessIds } = useBusinessContext();

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "confirmed" | "printed">("all");
  const [filterGovernorate, setFilterGovernorate] = useState("all");
  const [page, setPage] = useState(1);

  const utils = trpc.useUtils();

  // جلب الأوردرات المؤكدة والمطبوعة
  const { data, isLoading, refetch } = trpc.orders.list.useQuery(
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
  const someCurrentSelected = currentPageIds.some((id: number) => selectedIds.includes(id));

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
    }, 2500);
  };

  // شيت الشحن مع validation
  const handleShippingSheet = async () => {
    if (selectedIds.length === 0) {
      toast.error("يرجى تحديد أوردر واحد على الأقل");
      return;
    }
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
      toast.error(`⚠️ ${incompleteOrders.length} أوردر ببيانات ناقصة (هاتف/عنوان/محافظة): ${names}${more}. يرجى إكمال البيانات أولاً.`, { duration: 8000 });
      return;
    }
    const params = new URLSearchParams();
    params.set("orderIds", selectedIds.join(","));
    window.open(`/api/export/shipping?${params.toString()}`, "_blank");
    // حفظ سجل الطباعة
    savePrintLogMutation.mutate({ type: "shipping_sheet", orderIds: [...selectedIds] });
    toast.success(`جاري تصدير شيت الشحن لـ ${selectedIds.length} أوردر...`);
  };

  return (
    <WorkspaceShell
      title="التجهيز والطباعة"
      description="الأوردرات المؤكدة الجاهزة للشحن — حدّد، اطبع البوالص، وصدّر شيت الشحن."
      icon={<Package className="h-5 w-5" />}
      actions={
        <Button variant="outline" size="sm" onClick={() => { refetch(); refetchCounts(); }} className="gap-1.5">
          <RefreshCw className="w-3.5 h-3.5" />
          تحديث
        </Button>
      }
    >
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
            <SelectTrigger className="w-40 h-9 text-sm">
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

      {/* التحديد السريع */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" className="h-8 text-xs gap-1" onClick={toggleSelectAll}>
          {allCurrentSelected
            ? <><CheckSquare className="w-3.5 h-3.5" /> إلغاء تحديد الصفحة</>
            : <><Square className="w-3.5 h-3.5" /> تحديد الصفحة</>
          }
        </Button>
        <Button variant="ghost" size="sm" className="h-8 text-xs gap-1 text-[var(--success)]" onClick={selectAllConfirmed}>
          <CheckSquare className="w-3.5 h-3.5" />
          تحديد كل المؤكدة ({pageConfirmedCount})
        </Button>
        {selectedIds.length > 0 && (
          <>
            <div className="w-px h-4 bg-border mx-1" />
            <span className="text-xs font-medium text-primary">
              {selectedIds.length} محدد
            </span>
            <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={clearSelection}>
              <X className="w-3 h-3 ml-1" />
              إلغاء
            </Button>
          </>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <LoadingSkeleton variant="table" rows={8} />
      ) : orders.length === 0 ? (
        <EmptyState
          icon={<Package className="h-6 w-6" />}
          title="لا توجد أوردرات مؤكدة حالياً"
          description="الأوردرات المؤكدة ستظهر هنا تلقائياً"
        />
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-brand-md)] border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm z-10">
              <tr className="border-b">
                <th className="w-10 p-3 text-center">
                  <Checkbox
                    checked={allCurrentSelected}
                    onCheckedChange={toggleSelectAll}
                    className="data-[state=indeterminate]:bg-primary/50"
                    ref={(el) => {
                      if (el) (el as any).indeterminate = someCurrentSelected && !allCurrentSelected;
                    }}
                  />
                </th>
                <th className="p-3 text-right font-medium text-muted-foreground">#</th>
                <th className="p-3 text-right font-medium text-muted-foreground">العميل</th>
                <th className="p-3 text-right font-medium text-muted-foreground">التليفون</th>
                <th className="p-3 text-right font-medium text-muted-foreground">المحافظة</th>
                <th className="p-3 text-right font-medium text-muted-foreground">العنوان</th>
                <th className="p-3 text-right font-medium text-muted-foreground">المنتج</th>
                <th className="p-3 text-center font-medium text-muted-foreground">الإجمالي</th>
                <th className="p-3 text-center font-medium text-muted-foreground">الحالة</th>
                <th className="p-3 text-center font-medium text-muted-foreground">وقت التأكيد</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order: any) => {
                const isSelected = selectedIds.includes(order.id);
                const confirmedAt = order.confirmedAt ? new Date(order.confirmedAt) : null;
                const isNew = order.status === "confirmed";

                return (
                  <tr
                    key={order.id}
                    onClick={() => toggleOrder(order.id)}
                    className={`border-b cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-primary/8 hover:bg-primary/12"
                        : "hover:bg-muted/30"
                    } ${isNew ? "border-r-2 border-r-[var(--success)]/60" : ""}`}
                  >
                    <td className="p-3 text-center" onClick={e => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleOrder(order.id)}
                      />
                    </td>
                    <td className="p-3 text-muted-foreground font-mono text-xs">
                      {order.orderNumber || order.id}
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span className="font-medium truncate max-w-[140px]">{order.customerName}</span>
                      </div>
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1 text-muted-foreground">
                        <Phone className="w-3 h-3 shrink-0" />
                        <span className="font-mono text-xs">{order.customerPhone}</span>
                      </div>
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1">
                        <MapPin className="w-3 h-3 text-muted-foreground shrink-0" />
                        <span className="text-xs truncate max-w-[100px]">{order.governorate}</span>
                      </div>
                    </td>
                    <td className="p-3">
                      <span className="text-xs text-muted-foreground truncate max-w-[160px] block" title={order.customerAddress}>
                        {order.customerAddress}
                      </span>
                    </td>
                    <td className="p-3">
                      <span className="text-xs truncate max-w-[120px] block" title={order.productName}>
                        {order.productName || "—"}
                      </span>
                    </td>
                    <td className="p-3 text-center font-medium text-sm">
                      {order.totalAmount ? `${Number(order.totalAmount).toLocaleString()} ج` : "—"}
                    </td>
                    <td className="p-3 text-center">
                      <StatusBadge status={order.status} size="sm" />
                    </td>
                    <td className="p-3 text-center">
                      {confirmedAt ? (
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-xs text-muted-foreground">
                            {confirmedAt.toLocaleDateString("ar-EG")}
                          </span>
                          <span className="text-xs text-muted-foreground/70">
                            {confirmedAt.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                      ) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* الترقيم — بيوضّح كمان إجمالي النتائج بعد الفلترة. */}
      {totalCount > 0 && (
        <Pagination page={page} pageSize={ITEMS_PER_PAGE} total={totalCount} onPageChange={setPage} />
      )}

      {/* Floating Action Bar */}
      {selectedIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 duration-200">
          <div className="flex items-center gap-3 bg-foreground text-background rounded-2xl shadow-2xl px-5 py-3 border border-border/20">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center">
                <span className="text-xs font-bold text-primary-foreground">{selectedIds.length}</span>
              </div>
              <span className="text-sm font-medium">أوردر محدد</span>
            </div>
            <div className="w-px h-5 bg-background/20" />
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-3 text-background hover:text-background hover:bg-background/20 text-xs font-medium"
              onClick={handlePrint}
            >
              <Printer className="h-3.5 w-3.5 ml-1" />
              طباعة
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-3 text-background hover:text-background hover:bg-background/20 text-xs font-medium"
              onClick={handleShippingSheet}
            >
              <FileSpreadsheet className="h-3.5 w-3.5 ml-1" />
              شيت الشحن
            </Button>
            <div className="w-px h-5 bg-background/20" />
            <button
              onClick={clearSelection}
              className="w-7 h-7 rounded-full hover:bg-background/20 flex items-center justify-center text-background/70 hover:text-background transition-colors"
              title="إلغاء التحديد"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </WorkspaceShell>
  );
}
