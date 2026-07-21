import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RefreshCw, Activity, Filter } from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";

const ACTION_LABELS: Record<string, string> = {
  confirm_order: "تأكيد أوردر",
  cancel_order: "إلغاء أوردر",
  postpone_order: "تأجيل أوردر",
  assign_orders: "توزيع أوردرات",
  delete_order: "حذف أوردر",
  bulk_delete_orders: "حذف أوردرات",
  edit_order: "تعديل أوردر",
  import_orders: "استيراد أوردرات",
  print_orders: "طباعة أوردرات",
  add_product: "إضافة منتج",
  reclaim_orders: "استرداد أوردرات",
};

const ENTITY_LABELS: Record<string, string> = {
  order: "أوردر",
  product: "منتج",
  employee: "موظف",
  inventory: "مخزون",
};

export default function ActivityLogPage() {
  const { currentBusinessIds } = useBusinessContext();
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState<string>("");
  const [entityFilter, setEntityFilter] = useState<string>("");

  const { data, isLoading, refetch } = trpc.activityLog.list.useQuery({
    page,
    limit: 50,
    action: actionFilter || undefined,
    entityType: entityFilter || undefined,
    businessId: currentBusinessIds && currentBusinessIds.length === 1 ? currentBusinessIds[0] : undefined,
  });

  const formatDate = (date: any) => {
    if (!date) return "-";
    return new Date(date).toLocaleString("ar-EG", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity className="h-6 w-6 text-amber-600" />
          <div>
            <h1 className="text-2xl font-bold">سجل الأنشطة</h1>
            <p className="text-sm text-muted-foreground">تتبع كل العمليات داخل النظام</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 ml-1" /> تحديث
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-4 flex-wrap">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="نوع العملية" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                {Object.entries(ACTION_LABELS).map(([key, label]) => (
                  <SelectItem key={key} value={key}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={entityFilter} onValueChange={setEntityFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="نوع الكيان" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                {Object.entries(ENTITY_LABELS).map(([key, label]) => (
                  <SelectItem key={key} value={key}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Log Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {data?.total ? `${data.total} عملية مسجلة` : "لا توجد عمليات مسجلة"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center py-8 text-muted-foreground">جاري التحميل...</div>
          ) : !data?.items.length ? (
            <div className="text-center py-8 text-muted-foreground">
              <Activity className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p>لا توجد أنشطة مسجلة بعد</p>
              <p className="text-xs mt-1">سيتم تسجيل كل عملية تأكيد أو إلغاء أو توزيع أو حذف تلقائياً</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-right">
                    <th className="py-3 px-2 font-medium">التاريخ</th>
                    <th className="py-3 px-2 font-medium">العملية</th>
                    <th className="py-3 px-2 font-medium">الوصف</th>
                    <th className="py-3 px-2 font-medium">بواسطة</th>
                    <th className="py-3 px-2 font-medium">الدور</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((log: any) => (
                    <tr key={log.id} className="border-b hover:bg-muted/50">
                      <td className="py-3 px-2 text-xs whitespace-nowrap">{formatDate(log.createdAt)}</td>
                      <td className="py-3 px-2">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
                          {ACTION_LABELS[log.action] || log.action}
                        </span>
                      </td>
                      <td className="py-3 px-2 max-w-[300px] truncate">{log.description}</td>
                      <td className="py-3 px-2 whitespace-nowrap">{log.performedByName}</td>
                      <td className="py-3 px-2">
                        <span className={`text-xs px-2 py-0.5 rounded ${log.performedByRole === 'admin' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>
                          {log.performedByRole === 'admin' ? 'مدير' : 'موظف'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {data && data.total > 50 && (
            <div className="flex justify-center gap-2 mt-4">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
              >
                السابق
              </Button>
              <span className="text-sm self-center">صفحة {page} من {Math.ceil(data.total / 50)}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= Math.ceil(data.total / 50)}
                onClick={() => setPage(p => p + 1)}
              >
                التالي
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
