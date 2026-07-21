import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DashboardLayout from "@/components/DashboardLayout";
import DateRangePicker, { type DateRange } from "@/components/DateRangePicker";
import { CalendarDays } from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";

const RETURN_REASON_LABELS: Record<string, string> = {
  customer_refused: "رفض العميل",
  wrong_product: "منتج خاطئ",
  damaged: "تالف",
  wrong_address: "عنوان خاطئ",
  customer_not_available: "العميل غير متاح",
  other: "أخرى",
};

const RETURN_REASON_COLORS: Record<string, string> = {
  customer_refused: "bg-red-100 text-red-700 border-red-200",
  wrong_product: "bg-orange-100 text-orange-700 border-orange-200",
  damaged: "bg-yellow-100 text-yellow-700 border-yellow-200",
  wrong_address: "bg-purple-100 text-purple-700 border-purple-200",
  customer_not_available: "bg-blue-100 text-blue-700 border-blue-200",
  other: "bg-gray-100 text-gray-700 border-gray-200",
};

export default function Returns() {
  const { currentBusinessIds } = useBusinessContext();
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

  const { data: listData, isLoading } = trpc.returns.list.useQuery(listParams);
  const { data: stats } = trpc.returns.stats.useQuery({
    businessId: currentBusinessIds && currentBusinessIds.length === 1 ? currentBusinessIds[0] : undefined,
  });

  const items = listData?.items ?? [];
  const total = listData?.total ?? 0;
  const totalPages = Math.ceil(total / LIMIT);

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6" dir="rtl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">تقرير المرتجعات</h1>
            <p className="text-muted-foreground text-sm mt-1">متابعة جميع الأوردرات المرتجعة وأسباب الإرجاع</p>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-2xl font-bold text-foreground">{stats?.total ?? 0}</div>
              <div className="text-sm text-muted-foreground">إجمالي المرتجعات</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-2xl font-bold text-red-600">
                {stats?.totalAmount ? Number(stats.totalAmount).toLocaleString("ar-EG") : 0} ج.م
              </div>
              <div className="text-sm text-muted-foreground">إجمالي قيمة المرتجعات</div>
            </CardContent>
          </Card>
          {stats?.byReason?.slice(0, 2).map((r: any) => (
            <Card key={r.reason}>
              <CardContent className="pt-4 pb-4">
                <div className="text-2xl font-bold text-foreground">{Number(r.count)}</div>
                <div className="text-sm text-muted-foreground">{RETURN_REASON_LABELS[r.reason] ?? r.reason}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Reason Breakdown */}
        {stats?.byReason && stats.byReason.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">توزيع أسباب الإرجاع</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                {stats.byReason.map((r: any) => (
                  <div key={r.reason} className="flex items-center gap-2">
                    <Badge className={`border ${RETURN_REASON_COLORS[r.reason] ?? "bg-gray-100 text-gray-700"}`}>
                      {RETURN_REASON_LABELS[r.reason] ?? r.reason}
                    </Badge>
                    <span className="text-sm font-semibold">{Number(r.count)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Filters */}
        <div className="flex gap-3 flex-wrap">
          <Select value={reasonFilter} onValueChange={v => { setReasonFilter(v); setPage(1); }}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="فلتر بسبب الإرجاع" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الأسباب</SelectItem>
              {Object.entries(RETURN_REASON_LABELS).map(([val, label]) => (
                <SelectItem key={val} value={val}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {(reasonFilter !== "all" || govFilter !== "all" || dateRange.from) && (
            <Button variant="outline" size="sm" onClick={() => { setReasonFilter("all"); setGovFilter("all"); setDateRange({ from: null, to: null }); setPage(1); }}>
              إلغاء الفلاتر
            </Button>
          )}
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">فلترة حسب التاريخ:</span>
            <DateRangePicker
              value={dateRange}
              onChange={(range) => { setDateRange(range); setPage(1); }}
            />
          </div>
        </div>

        {/* Table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              قائمة المرتجعات
              <span className="text-muted-foreground font-normal text-sm mr-2">({total} مرتجع)</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">جاري التحميل...</div>
            ) : items.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                <div className="text-4xl mb-3">📦</div>
                <div>لا توجد مرتجعات بعد</div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="text-right p-3 font-semibold">رقم الأوردر</th>
                      <th className="text-right p-3 font-semibold">العميل</th>
                      <th className="text-right p-3 font-semibold">المحافظة</th>
                      <th className="text-right p-3 font-semibold">المنتج</th>
                      <th className="text-right p-3 font-semibold">الكمية</th>
                      <th className="text-right p-3 font-semibold">المبلغ</th>
                      <th className="text-right p-3 font-semibold">سبب الإرجاع</th>
                      <th className="text-right p-3 font-semibold">المخزون</th>
                      <th className="text-right p-3 font-semibold">التاريخ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((r: any) => (
                      <tr key={r.id} className="border-b hover:bg-muted/20 transition-colors">
                        <td className="p-3 font-mono text-xs font-semibold text-amber-600">{r.orderNumber}</td>
                        <td className="p-3">
                          <div className="font-medium">{r.customerName}</div>
                          <div className="text-muted-foreground text-xs">{r.customerPhone}</div>
                        </td>
                        <td className="p-3 text-muted-foreground">{r.governorate}</td>
                        <td className="p-3">{r.productName}</td>
                        <td className="p-3 text-center">{r.quantity}</td>
                        <td className="p-3 font-semibold text-foreground">
                          {Number(r.totalAmount).toLocaleString("ar-EG")} ج.م
                        </td>
                        <td className="p-3">
                          <Badge className={`border text-xs ${RETURN_REASON_COLORS[r.returnReason] ?? "bg-gray-100 text-gray-700"}`}>
                            {RETURN_REASON_LABELS[r.returnReason] ?? r.returnReason}
                          </Badge>
                        </td>
                        <td className="p-3">
                          {r.stockRestored ? (
                            <Badge className="bg-green-100 text-green-700 border-green-200 border text-xs">أُعيد للمخزون</Badge>
                          ) : (
                            <Badge className="bg-gray-100 text-gray-500 border-gray-200 border text-xs">لم يُعَد</Badge>
                          )}
                        </td>
                        <td className="p-3 text-muted-foreground text-xs">
                          {new Date(r.createdAt).toLocaleDateString("ar-EG")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3">
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
              السابق
            </Button>
            <span className="text-sm text-muted-foreground">صفحة {page} من {totalPages}</span>
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
              التالي
            </Button>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
