import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Download, RotateCcw, QrCode, Clock } from "lucide-react";
import {
  PageHeader, StatCard, StatusBadge, SearchInput, ResponsiveDataTable, SectionCard, OfflineState, type Column,
} from "@/components/shared";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
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

const TOUCH = "min-h-11 md:min-h-9";
const RESULT: Record<ScanLog["result"], { label: string; tone: "success" | "warning" | "danger" }> = {
  success: { label: "نجح", tone: "success" },
  duplicate: { label: "مكرر", tone: "warning" },
  cancelled: { label: "ملغي", tone: "danger" },
  failed: { label: "فشل", tone: "danger" },
};

/**
 * سجل المسحات — مسحات QR للموظف الحالي (employeePortal.scanLogs) بفلاتر النتيجة/التاريخ/بحث محلي وتصدير CSV.
 * المرحلة 7D (عرض فقط): بطاقات ملخص من إحصاءات الاستعلام نفسه، جدول Desktop/بطاقات Mobile، StatusBadge للنتيجة.
 */
export default function ScanLogs() {
  const online = useOnlineStatus();
  const [search, setSearch] = useState("");
  const [resultFilter, setResultFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { data: scanLogsData, isLoading, isError, error, refetch } = (trpc.employeePortal as any).scanLogs.useQuery(
    {
      limit: 500,
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
      result: resultFilter !== "all" ? (resultFilter as any) : undefined,
    },
    { enabled: true }
  );

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
      RESULT[log.result]?.label ?? log.result,
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

  const resultBadge = (r: ScanLog["result"]) => <StatusBadge status={r} label={RESULT[r]?.label ?? r} tone={RESULT[r]?.tone ?? "neutral"} size="sm" />;

  const columns: Column<ScanLog>[] = [
    { id: "at", header: "التاريخ والوقت", alwaysVisible: true, cell: l => <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs tabular-nums"><Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />{new Date(l.createdAt).toLocaleString("ar-EG")}</span> },
    { id: "serial", header: "الرقم التسلسلي", cell: l => <span className="font-mono text-xs" dir="ltr">{l.serialNumber}</span> },
    { id: "order", header: "رقم الأوردر", cell: l => l.order ? <span className="font-mono text-xs" dir="ltr">#{l.order.orderNumber}</span> : <span className="text-muted-foreground">-</span> },
    { id: "customer", header: "العميل", cell: l => <div className="min-w-0"><p className="text-sm">{l.order?.customerName || "-"}</p><p className="text-xs text-muted-foreground" dir="ltr">{l.order?.customerPhone || "-"}</p></div> },
    { id: "result", header: "النتيجة", alwaysVisible: true, cell: l => resultBadge(l.result) },
    { id: "by", header: "المسح بواسطة", cell: l => <span className="text-sm">{l.scannedByName}</span> },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-5" dir="rtl" data-testid="scan-logs-page">
      <PageHeader
        title="سجل المسحات"
        description="عرض كل مسحات QR الخاصة بك"
        icon={<QrCode className="h-5 w-5" aria-hidden="true" />}
        actions={
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => { setSearch(""); setResultFilter("all"); setDateFrom(""); setDateTo(""); }} className={`${TOUCH} gap-1`}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              إعادة تعيين
            </Button>
            <Button type="button" size="sm" onClick={handleExportCSV} className={`${TOUCH} gap-1`} disabled={filteredLogs.length === 0}>
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              تصدير CSV
            </Button>
          </>
        }
      >
        <section className="grid grid-cols-2 gap-3 md:grid-cols-5" aria-label="ملخص المسحات" data-testid="scan-summary">
          <StatCard label="إجمالي المسحات" value={Number(stats.total).toLocaleString("ar-EG")} hint="من stats الاستعلام" loading={isLoading} />
          <StatCard label="نجح" value={Number(stats.success).toLocaleString("ar-EG")} tone="success" loading={isLoading} />
          <StatCard label="مكرر" value={Number(stats.duplicate).toLocaleString("ar-EG")} tone="warning" loading={isLoading} />
          <StatCard label="فشل" value={Number(stats.failed).toLocaleString("ar-EG")} tone="danger" loading={isLoading} />
          <StatCard label="ملغي" value={Number(stats.cancelled).toLocaleString("ar-EG")} tone="danger" loading={isLoading} />
        </section>
      </PageHeader>

      {!online && <OfflineState onRetry={() => refetch()} className="py-6" />}

      {/* Filters */}
      <SectionCard title="الفلاتر" testId="scan-filters">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4 [&_input]:min-h-11 md:[&_input]:min-h-9 [&_[role=combobox]]:min-h-11 md:[&_[role=combobox]]:min-h-9">
          <SearchInput value={search} onChange={setSearch} placeholder="ابحث عن رقم أوردر أو رقم تسلسلي..." debounceMs={200} />
          <div>
            <Label htmlFor="scan-result" className="sr-only">النتيجة</Label>
            <Select value={resultFilter} onValueChange={setResultFilter}>
              <SelectTrigger id="scan-result" aria-label="النتيجة"><SelectValue placeholder="النتيجة" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل النتائج</SelectItem>
                <SelectItem value="success">نجح</SelectItem>
                <SelectItem value="duplicate">مكرر</SelectItem>
                <SelectItem value="failed">فشل</SelectItem>
                <SelectItem value="cancelled">ملغي</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="scan-from" className="sr-only">من تاريخ</Label>
            <Input id="scan-from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="من تاريخ" />
          </div>
          <div>
            <Label htmlFor="scan-to" className="sr-only">إلى تاريخ</Label>
            <Input id="scan-to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="إلى تاريخ" />
          </div>
        </div>
      </SectionCard>

      {/* Logs */}
      <SectionCard title={`${filteredLogs.length.toLocaleString("ar-EG")} مسح`} flush testId="scan-logs-list">
        <ResponsiveDataTable<ScanLog>
          rows={filteredLogs}
          columns={columns}
          rowKey={l => l.id}
          loading={isLoading}
          error={isError ? ((error as any)?.message || "تعذّر تحميل سجل المسحات") : null}
          onRetry={() => refetch()}
          empty={{ title: "لا توجد مسحات", description: "عدّل الفلاتر أو ابدأ المسح من شاشة التجهيز." }}
          cardsBelow="md"
          mobileRow={l => (
            <article className="space-y-1.5 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`scan-card-${l.id}`} data-result={l.result}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">{l.order?.customerName || "-"}</p>
                  <p className="font-mono text-xs text-muted-foreground" dir="ltr">{l.order ? `#${l.order.orderNumber} · ` : ""}{l.serialNumber}</p>
                </div>
                {resultBadge(l.result)}
              </div>
              <p className="text-xs tabular-nums text-muted-foreground">{new Date(l.createdAt).toLocaleString("ar-EG")} · {l.scannedByName}</p>
              {l.order?.customerPhone && <p className="text-xs text-muted-foreground" dir="ltr">{l.order.customerPhone}</p>}
            </article>
          )}
        />
      </SectionCard>
    </div>
  );
}
