import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Download,
  Search,
  Filter,
  RotateCcw,
  Calendar,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ScanLog = {
  id: number;
  orderId: number;
  serialNumber: string;
  scannedBy: string;
  scannedByName: string;
  result: "success" | "failed" | "duplicate" | "cancelled";
  deviceInfo?: string | null;
  createdAt: string | Date;
  order?: {
    orderNumber: string;
    customerName: string;
    customerPhone: string;
    governorate: string;
  };
};

export default function ScanLogs() {
  const [search, setSearch] = useState("");
  const [resultFilter, setResultFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { data: scanLogsData, isLoading, refetch } = (trpc.employeePortal as any).scanLogs.useQuery(
    {
      limit: 500,
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
      result: resultFilter !== "all" ? (resultFilter as any) : undefined,
    },
    { enabled: true }
  )

  const scanLogs = (scanLogsData?.logs || []) as ScanLog[];
  const stats = scanLogsData?.stats || {
    total: 0,
    success: 0,
    failed: 0,
    duplicate: 0,
    cancelled: 0,
  };

  // Filter by search
  const filteredLogs = useMemo(() => {
    if (!search.trim()) return scanLogs;
    const q = search.toLowerCase();
    return scanLogs.filter(
      (log) =>
        log.serialNumber.toLowerCase().includes(q) ||
        log.order?.orderNumber.toLowerCase().includes(q) ||
        log.order?.customerName.toLowerCase().includes(q) ||
        log.order?.customerPhone.includes(q) ||
        log.scannedByName.toLowerCase().includes(q)
    );
  }, [scanLogs, search]);

  const resultColors = {
    success: { bg: "bg-green-50 border-green-200", text: "text-green-700", badge: "bg-green-100 text-green-700" },
    duplicate: { bg: "bg-yellow-50 border-yellow-200", text: "text-yellow-700", badge: "bg-yellow-100 text-yellow-700" },
    cancelled: { bg: "bg-red-50 border-red-200", text: "text-red-700", badge: "bg-red-100 text-red-700" },
    failed: { bg: "bg-red-50 border-red-200", text: "text-red-700", badge: "bg-red-100 text-red-700" },
  };

  const resultIcons = {
    success: <CheckCircle2 className="h-4 w-4 text-green-600" />,
    duplicate: <AlertTriangle className="h-4 w-4 text-yellow-600" />,
    cancelled: <XCircle className="h-4 w-4 text-red-600" />,
    failed: <XCircle className="h-4 w-4 text-red-600" />,
  };

  const resultLabels = {
    success: "✓ نجح",
    duplicate: "⚠️ مكرر",
    cancelled: "🚫 ملغي",
    failed: "❌ فشل",
  };

  const handleExportCSV = () => {
    if (filteredLogs.length === 0) {
      toast.error("لا توجد بيانات للتصدير");
      return;
    }

    const headers = ["التاريخ", "الرقم التسلسلي", "رقم الأوردر", "العميل", "الهاتف", "المحافظة", "النتيجة", "المسح بواسطة"];
    const rows = filteredLogs.map((log) => [
      new Date(log.createdAt).toLocaleString("ar-EG"),
      log.serialNumber,
      log.order?.orderNumber || "-",
      log.order?.customerName || "-",
      log.order?.customerPhone || "-",
      log.order?.governorate || "-",
      resultLabels[log.result],
      log.scannedByName,
    ]);

    const csv = [headers, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `scan-logs-${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    toast.success("تم تصدير البيانات بنجاح");
  };

  return (
    <div className="max-w-6xl mx-auto" dir="rtl">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">سجل المسحات</h1>
        <p className="text-gray-600">عرض كل مسحات QR الخاصة بك</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <Card className="bg-white border-0 shadow-sm">
          <CardContent className="pt-4 pb-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
              <p className="text-xs text-gray-500 mt-1">إجمالي المسحات</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-green-50 border-green-200">
          <CardContent className="pt-4 pb-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-green-700">{stats.success}</p>
              <p className="text-xs text-green-600 mt-1">نجح</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-yellow-50 border-yellow-200">
          <CardContent className="pt-4 pb-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-yellow-700">{stats.duplicate}</p>
              <p className="text-xs text-yellow-600 mt-1">مكرر</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-red-50 border-red-200">
          <CardContent className="pt-4 pb-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-red-700">{stats.failed}</p>
              <p className="text-xs text-red-600 mt-1">فشل</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-orange-50 border-orange-200">
          <CardContent className="pt-4 pb-4">
            <div className="text-center">
              <p className="text-2xl font-bold text-orange-700">{stats.cancelled}</p>
              <p className="text-xs text-orange-600 mt-1">ملغي</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card className="mb-6 border-0 shadow-sm">
        <CardHeader className="pb-3 pt-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Filter className="h-4 w-4" />
            الفلاتر
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            {/* Search */}
            <div className="relative">
              <Search className="absolute right-3 top-3 h-4 w-4 text-gray-400" />
              <Input
                placeholder="ابحث عن رقم أوردر أو رقم تسلسلي..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pr-10"
              />
            </div>

            {/* Result Filter */}
            <Select value={resultFilter} onValueChange={setResultFilter}>
              <SelectTrigger>
                <SelectValue placeholder="النتيجة" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                <SelectItem value="success">✓ نجح</SelectItem>
                <SelectItem value="duplicate">⚠️ مكرر</SelectItem>
                <SelectItem value="failed">❌ فشل</SelectItem>
                <SelectItem value="cancelled">🚫 ملغي</SelectItem>
              </SelectContent>
            </Select>

            {/* Date From */}
            <div className="relative">
              <Calendar className="absolute right-3 top-3 h-4 w-4 text-gray-400" />
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="pr-10"
              />
            </div>

            {/* Date To */}
            <div className="relative">
              <Calendar className="absolute right-3 top-3 h-4 w-4 text-gray-400" />
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="pr-10"
              />
            </div>
          </div>

          <div className="flex gap-2 mt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearch("");
                setResultFilter("all");
                setDateFrom("");
                setDateTo("");
              }}
              className="gap-1"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              إعادة تعيين
            </Button>
            <Button
              size="sm"
              onClick={handleExportCSV}
              className="gap-1 bg-green-600 hover:bg-green-700"
            >
              <Download className="h-3.5 w-3.5" />
              تصدير CSV
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Logs Table */}
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3 pt-4">
          <CardTitle className="text-base">
            {filteredLogs.length} مسح
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-gray-500">جاري التحميل...</div>
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-center">
                <p className="text-gray-500">لا توجد مسحات</p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="text-right py-3 px-4 font-semibold text-gray-700">التاريخ والوقت</th>
                    <th className="text-right py-3 px-4 font-semibold text-gray-700">الرقم التسلسلي</th>
                    <th className="text-right py-3 px-4 font-semibold text-gray-700">رقم الأوردر</th>
                    <th className="text-right py-3 px-4 font-semibold text-gray-700">العميل</th>
                    <th className="text-right py-3 px-4 font-semibold text-gray-700">النتيجة</th>
                    <th className="text-right py-3 px-4 font-semibold text-gray-700">المسح بواسطة</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.map((log) => {
                    const colors = resultColors[log.result];
                    return (
                      <tr
                        key={log.id}
                        className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${colors.bg}`}
                      >
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2 text-gray-700">
                            <Clock className="h-3.5 w-3.5 text-gray-400" />
                            {new Date(log.createdAt).toLocaleString("ar-EG")}
                          </div>
                        </td>
                        <td className="py-3 px-4 font-mono text-gray-700 dir-ltr">{log.serialNumber}</td>
                        <td className="py-3 px-4">
                          {log.order ? (
                            <Badge variant="outline" className="text-xs">
                              #{log.order.orderNumber}
                            </Badge>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-gray-700">
                            {log.order?.customerName || "-"}
                          </div>
                          <div className="text-xs text-gray-500 dir-ltr">
                            {log.order?.customerPhone || "-"}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-1.5">
                            {resultIcons[log.result]}
                            <Badge className={colors.badge}>
                              {resultLabels[log.result]}
                            </Badge>
                          </div>
                        </td>
                        <td className="py-3 px-4 text-gray-700">{log.scannedByName}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
