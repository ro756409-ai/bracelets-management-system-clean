import { useState, useMemo, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Printer, FileSpreadsheet, CheckSquare, Square, RefreshCw,
  Search, Package, MapPin, Phone, User, AlertCircle, Clock,
  ChevronLeft, ChevronRight, Filter, X
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { useBusinessContext } from "@/contexts/BusinessContext";

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  confirmed: { label: "مؤكد", color: "bg-green-100 text-green-800 border-green-200" },
  printed: { label: "مطبوع", color: "bg-blue-100 text-blue-800 border-blue-200" },
};

const ITEMS_PER_PAGE = 50;

export default function Preparation() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
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

  const orders = data?.orders ?? [];
  const totalCount = data?.total ?? 0;
  const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);

  // المحافظات المتاحة
  const governorates = useMemo(() => {
    const govs = new Set(orders.map((o: any) => o.governorate).filter(Boolean));
    return Array.from(govs).sort() as string[];
  }, [orders]);

  // إحصائيات
  const confirmedCount = orders.filter((o: any) => o.status === "confirmed").length;
  const printedCount = orders.filter((o: any) => o.status === "printed").length;

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
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b bg-background">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <Package className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold">التجهيز والطباعة</h1>
            <p className="text-xs text-muted-foreground">الأوردرات المؤكدة الجاهزة للشحن</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" />
            تحديث
          </Button>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-3 gap-3 px-6 py-3 border-b bg-muted/30">
        <div className="flex items-center gap-2 bg-background rounded-lg px-3 py-2 border">
          <div className="w-2 h-2 rounded-full bg-green-500" />
          <span className="text-sm text-muted-foreground">مؤكد</span>
          <span className="text-sm font-bold text-green-700 mr-auto">{confirmedCount}</span>
        </div>
        <div className="flex items-center gap-2 bg-background rounded-lg px-3 py-2 border">
          <div className="w-2 h-2 rounded-full bg-blue-500" />
          <span className="text-sm text-muted-foreground">مطبوع</span>
          <span className="text-sm font-bold text-blue-700 mr-auto">{printedCount}</span>
        </div>
        <div className="flex items-center gap-2 bg-background rounded-lg px-3 py-2 border">
          <div className="w-2 h-2 rounded-full bg-primary" />
          <span className="text-sm text-muted-foreground">الإجمالي</span>
          <span className="text-sm font-bold mr-auto">{totalCount}</span>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 px-6 py-3 border-b bg-background flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="بحث باسم العميل أو التليفون..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="pr-9 h-9 text-sm"
          />
        </div>
        <Select value={filterStatus} onValueChange={(v: any) => { setFilterStatus(v); setPage(1); }}>
          <SelectTrigger className="w-36 h-9 text-sm">
            <SelectValue placeholder="الحالة" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل الحالات</SelectItem>
            <SelectItem value="confirmed">مؤكد فقط</SelectItem>
            <SelectItem value="printed">مطبوع فقط</SelectItem>
          </SelectContent>
        </Select>
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
        {(search || filterStatus !== "all" || filterGovernorate !== "all") && (
          <Button variant="ghost" size="sm" className="h-9 gap-1 text-muted-foreground" onClick={() => {
            setSearch(""); setFilterStatus("all"); setFilterGovernorate("all"); setPage(1);
          }}>
            <X className="w-3.5 h-3.5" />
            مسح الفلاتر
          </Button>
        )}
      </div>

      {/* Quick Actions Bar */}
      <div className="flex items-center gap-2 px-6 py-2 border-b bg-muted/20 flex-wrap">
        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={toggleSelectAll}>
          {allCurrentSelected
            ? <><CheckSquare className="w-3.5 h-3.5" /> إلغاء تحديد الصفحة</>
            : <><Square className="w-3.5 h-3.5" /> تحديد الصفحة</>
          }
        </Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 text-green-700" onClick={selectAllConfirmed}>
          <CheckSquare className="w-3.5 h-3.5" />
          تحديد كل المؤكدة ({confirmedCount})
        </Button>
        {selectedIds.length > 0 && (
          <>
            <div className="w-px h-4 bg-border mx-1" />
            <span className="text-xs font-medium text-primary">
              {selectedIds.length} محدد
            </span>
            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={clearSelection}>
              <X className="w-3 h-3 ml-1" />
              إلغاء
            </Button>
          </>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground">
            <RefreshCw className="w-5 h-5 animate-spin ml-2" />
            جاري التحميل...
          </div>
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-muted-foreground">
            <Package className="w-10 h-10 opacity-30" />
            <p className="text-sm">لا توجد أوردرات مؤكدة حالياً</p>
            <p className="text-xs">الأوردرات المؤكدة ستظهر هنا تلقائياً</p>
          </div>
        ) : (
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
              {orders.map((order: any, idx: number) => {
                const isSelected = selectedIds.includes(order.id);
                const statusInfo = STATUS_LABELS[order.status] ?? { label: order.status, color: "bg-gray-100 text-gray-700" };
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
                    } ${isNew ? "border-r-2 border-r-green-400" : ""}`}
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
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${statusInfo.color}`}>
                        {statusInfo.label}
                      </span>
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
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-3 border-t bg-background">
          <span className="text-sm text-muted-foreground">
            صفحة {page} من {totalPages} — إجمالي {totalCount} أوردر
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              <ChevronRight className="w-4 h-4" />
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
          </div>
        </div>
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
    </div>
  );
}
