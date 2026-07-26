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
  QrCode,
} from "lucide-react";
import { PageHeader, StatCard } from "@/components/shared";
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
    success: { bg: "bg-[var(--success)]/5 border-[var(--success)]/20", text: "text-[var(--success)]", badge: "bg-[var(--success)]/10 text-[var(--success)]" },
    duplicate: { bg: "bg-[var(--warning)]/5 border-[var(--warning)]/20", text: "text-[var(--warning)]", badge: "bg-[var(--warning)]/10 text-[var(--warning)]" },
    cancelled: { bg: "bg-destructive/5 border-destructive/20", text: "text-destructive", badge: "bg-destructive/10 text-destructive" },
    failed: { bg: "bg-destructive/5 border-destructive/20", text: "text-destructive", badge: "bg-destructive/10 text-destructive" },
  };

  const resultIcons = {
    success: <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />,
    duplicate: <AlertTriangle className="h-4 w-4 text-[var(--warning)]" />,
    cancelled: <XCircle className="h-4 w-4 text-destructive" />,
    failed: <XCircle className="h-4 w-4 text-destructive" />,
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
    <div className="max-w-6xl mx-auto space-y-6" dir="rtl">
      <PageHeader
        title="سجل المسحات"
        description="عرض كل مسحات QR الخاصة بك"
        icon={<QrCode className="h-5 w-5" />}
      />

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="إجمالي المسحات" value={stats.total} />
        <StatCard label="نجح" value={stats.success} tone="success" />
        <StatCard label="مكرر" value={stats.duplicate} tone="warning" />
        <StatCard label="فشل" value={stats.failed} tone="danger" />
        <StatCard label="ملغي" value={stats.cancelled} tone="danger" />
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
              <Search className="absolute right-3 top-3 h-4 w-4 text-muted-foreground" />
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
              <Calendar className="absolute right-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="pr-10"
              />
            </div>

            {/* Date To */}
            <div className="relative">
              <Calendar className="absolute right-3 top-3 h-4 w-4 text-muted-foreground" />
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
              className="gap-1"
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
              <div className="text-muted-foreground">جاري التحميل...</div>
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-center">
                <p className="text-muted-foreground">لا توجد مسحات</p>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="text-right py-3 px-4 font-semibold text-muted-foreground">التاريخ والوقت</th>
                    <th className="text-right py-3 px-4 font-semibold text-muted-foreground">الرقم التسلسلي</th>
                    <th className="text-right py-3 px-4 font-semibold text-muted-foreground">رقم الأوردر</th>
                    <th className="text-right py-3 px-4 font-semibold text-muted-foreground">العميل</th>
                    <th className="text-right py-3 px-4 font-semibold text-muted-foreground">النتيجة</th>
                    <th className="text-right py-3 px-4 font-semibold text-muted-foreground">المسح بواسطة</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.map((log) => {
                    const colors = resultColors[log.result];
                    return (
                      <tr
                        key={log.id}
                        className={`border-b border-border hover:bg-muted/30 transition-colors ${colors.bg}`}
                      >
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2 text-foreground">
                            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                            {new Date(log.createdAt).toLocaleString("ar-EG")}
                          </div>
                        </td>
                        <td className="py-3 px-4 font-mono text-foreground dir-ltr">{log.serialNumber}</td>
                        <td className="py-3 px-4">
                          {log.order ? (
                            <Badge variant="outline" className="text-xs">
                              #{log.order.orderNumber}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-foreground">
                            {log.order?.customerName || "-"}
                          </div>
                          <div className="text-xs text-muted-foreground dir-ltr">
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
                        <td className="py-3 px-4 text-foreground">{log.scannedByName}</td>
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
