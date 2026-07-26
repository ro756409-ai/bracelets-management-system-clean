import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Download, Printer, Search, RefreshCw } from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";

const STATUS_LABELS: Record<string, string> = {
  printed: "مطبوع",
  confirmed: "مؤكد",
  preparing: "قيد التحضير",
  shipped: "تم الشحن",
  delivered: "تم التوصيل",
};

export default function PrintedOrders() {
  const { currentBusinessIds } = useBusinessContext();
  const [dateFilter, setDateFilter] = useState<'today' | 'yesterday' | 'custom'>('today');
  const [customDate, setCustomDate] = useState('');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const utils = trpc.useUtils();

  // حساب نطاق التاريخ
  const dateRange = useMemo(() => {
    const now = new Date(Date.now() + 2 * 60 * 60 * 1000); // Cairo +2
    const todayStr = now.toISOString().slice(0, 10);
    if (dateFilter === 'today') {
      return { from: new Date(todayStr + 'T00:00:00Z'), to: new Date(todayStr + 'T23:59:59Z') };
    }
    if (dateFilter === 'yesterday') {
      const y = new Date(now);
      y.setUTCDate(y.getUTCDate() - 1);
      const yStr = y.toISOString().slice(0, 10);
      return { from: new Date(yStr + 'T00:00:00Z'), to: new Date(yStr + 'T23:59:59Z') };
    }
    if (dateFilter === 'custom' && customDate) {
      return { from: new Date(customDate + 'T00:00:00Z'), to: new Date(customDate + 'T23:59:59Z') };
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

  const { data, isLoading, refetch } = trpc.orders.list.useQuery(queryParams);
  const orders = data?.orders ?? [];

  // إحصائيات
  const totalAmount = orders.reduce((s, o) => s + Number(o.totalAmount), 0);
  const totalQty = orders.reduce((s, o) => s + Number(o.quantity), 0);
  const bostaCount = orders.filter(o => o.bostaLastError?.includes('successfully')).length;
  const nonBostaCount = orders.length - bostaCount;

  const currentPageIds = orders.map(o => o.id);
  const allSelected = currentPageIds.length > 0 && selectedIds.length === currentPageIds.length;

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleAll = () => {
    if (allSelected) setSelectedIds([]);
    else setSelectedIds(currentPageIds);
  };

  const handleReprint = () => {
    if (selectedIds.length === 0) return;
    const params = new URLSearchParams();
    params.set('orderIds', selectedIds.join(','));
    window.open(`/api/export/print-labels?${params.toString()}`, '_blank');
    toast.success(`جاري إعادة طباعة ${selectedIds.length} أوردر...`);
    setTimeout(() => {
      utils.orders.list.invalidate();
      setSelectedIds([]);
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
    : customDate ? new Date(customDate + 'T00:00:00').toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Printer className="h-6 w-6 text-[var(--info)]" />
            المطبوعات
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{dateLabel}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1">
            <RefreshCw className="h-4 w-4" />
            تحديث
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-[var(--success)]/30 text-[var(--success)] hover:bg-[var(--success)]/10 gap-1"
            onClick={handleExcelExport}
            disabled={orders.length === 0}
          >
            <Download className="h-4 w-4" />
            تصدير Excel
          </Button>
          <Button
            size="sm"
            className="bg-[var(--info)] hover:bg-[var(--info)] text-white gap-1"
            disabled={selectedIds.length === 0}
            onClick={handleReprint}
          >
            <Printer className="h-4 w-4" />
            إعادة طباعة {selectedIds.length > 0 ? `(${selectedIds.length})` : ''}
          </Button>
        </div>
      </div>

      {/* فلاتر التاريخ والبحث */}
      <div className="flex flex-col gap-3 bg-[var(--info)]/10 border border-[var(--info)]/30 rounded-xl px-4 py-3">
        <div className="flex items-center gap-3 flex-wrap">
          {/* فلتر التاريخ */}
          <div className="flex gap-1 bg-card rounded-lg border border-[var(--info)]/40 p-0.5">
            {(['today', 'yesterday', 'custom'] as const).map(f => (
              <button
                key={f}
                onClick={() => setDateFilter(f)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  dateFilter === f ? 'bg-[var(--info)] text-white' : 'text-[var(--info)] hover:bg-[var(--info)]/15'
                }`}
              >
                {f === 'today' ? 'اليوم' : f === 'yesterday' ? 'أمس' : 'تاريخ مخصص'}
              </button>
            ))}
          </div>
          {dateFilter === 'custom' && (
            <input
              type="date"
              value={customDate}
              onChange={e => setCustomDate(e.target.value)}
              className="text-xs border border-[var(--info)]/40 bg-card rounded-lg px-3 py-1.5 text-[var(--info)] focus:outline-none focus:ring-2 focus:ring-[var(--info)]"
            />
          )}
          {/* بحث */}
          <div className="relative flex-1 min-w-48 max-w-xs">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="بحث بالاسم أو الهاتف..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pr-8 text-xs h-8"
            />
          </div>
        </div>

        {/* إحصائيات */}
        <div className="flex items-center gap-4 flex-wrap text-xs">
          <span className="text-[var(--info)] font-semibold">إجمالي: {orders.length} أوردر</span>
          <span className="text-[var(--info)]">الكمية: {totalQty} قطعة</span>
          <span className="text-[var(--info)]">المبالغ: {totalAmount.toLocaleString('ar-EG')} ج.م</span>
          <span className="text-[var(--info)] font-medium">في بوسطة: {bostaCount}</span>
          <span className="text-[var(--warning)] font-medium">شركة أخرى: {nonBostaCount}</span>
        </div>
      </div>

      {/* الجدول */}
      <div className="bg-background border rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin ml-2" />
            جاري التحميل...
          </div>
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Printer className="h-12 w-12 mb-3 opacity-20" />
            <p className="text-sm">لا توجد أوردرات مطبوعة في هذا التاريخ</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[var(--info)]/10 border-b border-[var(--info)]/20">
                  <th className="p-3 text-right w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="rounded"
                    />
                  </th>
                  <th className="p-3 text-right text-xs font-semibold text-[var(--info)]">#</th>
                  <th className="p-3 text-right text-xs font-semibold text-[var(--info)]">رقم الأوردر</th>
                  <th className="p-3 text-right text-xs font-semibold text-[var(--info)]">العميل</th>
                  <th className="p-3 text-right text-xs font-semibold text-[var(--info)]">التليفون</th>
                  <th className="p-3 text-right text-xs font-semibold text-[var(--info)]">المحافظة</th>
                  <th className="p-3 text-right text-xs font-semibold text-[var(--info)]">المنتج</th>
                  <th className="p-3 text-right text-xs font-semibold text-[var(--info)]">الكمية</th>
                  <th className="p-3 text-right text-xs font-semibold text-[var(--info)]">المبلغ</th>
                  <th className="p-3 text-right text-xs font-semibold text-[var(--info)]">تاريخ الطباعة</th>
                  <th className="p-3 text-right text-xs font-semibold text-[var(--info)]">شحن</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order, idx) => {
                  const isBosta = order.bostaLastError?.includes('successfully');
                  const isSelected = selectedIds.includes(order.id);
                  return (
                    <tr
                      key={order.id}
                      className={`border-b transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-[var(--info)]/10'
                          : idx % 2 === 0
                          ? 'bg-background hover:bg-muted/30'
                          : 'bg-muted/10 hover:bg-muted/30'
                      }`}
                      onClick={() => toggleSelect(order.id)}
                    >
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(order.id)}
                          className="rounded"
                        />
                      </td>
                      <td className="p-3 text-muted-foreground text-xs">{idx + 1}</td>
                      <td className="p-3 font-mono text-xs font-medium">
                        {order.easyOrderShortId || order.orderNumber}
                      </td>
                      <td className="p-3 font-medium text-xs">{order.customerName}</td>
                      <td className="p-3 text-xs font-mono text-muted-foreground">{order.customerPhone}</td>
                      <td className="p-3 text-xs">{order.governorate || '—'}</td>
                      <td className="p-3 text-xs max-w-[180px] truncate" title={order.productName}>
                        {order.productName}
                      </td>
                      <td className="p-3 text-center text-xs font-medium">{order.quantity}</td>
                      <td className="p-3 text-xs font-medium text-[var(--success)]">
                        {Number(order.totalAmount).toLocaleString('ar-EG')} ج.م
                      </td>
                      <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                        {order.printedAt
                          ? new Date(order.printedAt).toLocaleString('ar-EG', {
                              month: 'short', day: 'numeric',
                              hour: '2-digit', minute: '2-digit'
                            })
                          : '—'}
                      </td>
                      <td className="p-3">
                        {isBosta ? (
                          <Badge className="bg-[var(--info)]/15 text-[var(--info)] text-xs px-1.5 py-0.5">بوسطة</Badge>
                        ) : (
                          <Badge className="bg-[var(--warning)]/15 text-[var(--warning)] text-xs px-1.5 py-0.5">أخرى</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* شريط التحديد */}
      {selectedIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-[var(--info)] text-white rounded-2xl shadow-2xl px-6 py-3 flex items-center gap-4">
          <span className="text-sm font-medium">{selectedIds.length} أوردر محدد</span>
          <Button
            size="sm"
            className="bg-card text-[var(--info)] hover:bg-[var(--info)]/10 gap-1"
            onClick={handleReprint}
          >
            <Printer className="h-4 w-4" />
            إعادة طباعة
          </Button>
          <button
            onClick={() => setSelectedIds([])}
            className="text-white/70 hover:text-white text-xs underline"
          >
            إلغاء
          </button>
        </div>
      )}
    </div>
  );
}
