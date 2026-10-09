import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  FileSpreadsheet, Printer, Clock, User, Package,
  RefreshCw, ChevronDown, ChevronUp, RotateCcw
} from "lucide-react";
import { toast } from "sonner";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { PageHeader, EmptyState, ErrorState, LoadingSkeleton, OfflineState } from "@/components/shared";

const TOUCH = "min-h-11 md:min-h-9";

/**
 * سجل الطباعات — كل عمليات طباعة اللابلات وتصدير شيت الشحن بنطاق الجلسة، مع إعادة تصدير بنفس الروابط.
 * المرحلة 7D (عرض فقط): PageHeader + حالات مشتركة + بطاقات بأهداف لمس 44px + حارس ضغط مكرر على إعادة التصدير.
 */
export default function PrintLogs() {
  const { currentBusinessIds } = useBusinessContext();
  const online = useOnlineStatus();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [exportingId, setExportingId] = useState<number | null>(null);

  const { data: logs, isLoading, isError, error, refetch } = trpc.printLogs.list.useQuery({
    limit: 50,
    businessId: currentBusinessIds && currentBusinessIds.length === 1 ? currentBusinessIds[0] : undefined,
  });

  const handleReExport = (log: any) => {
    if (!log.orderIds || log.orderIds.length === 0) {
      toast.error("لا توجد أوردرات في هذا السجل");
      return;
    }
    if (exportingId != null) return;
    setExportingId(log.id);
    const params = new URLSearchParams();
    params.set("orderIds", log.orderIds.join(","));
    if (log.type === "shipping_sheet") {
      window.open(`/api/export/shipping?${params.toString()}`, "_blank");
      toast.success("جاري إعادة تصدير شيت الشحن...");
    } else {
      window.open(`/api/export/print-labels?${params.toString()}`, "_blank");
      toast.success("جاري إعادة طباعة اللابلات...");
    }
    setTimeout(() => setExportingId(null), 1500);
  };

  const formatDate = (date: string | Date) => {
    const d = new Date(date);
    return d.toLocaleDateString("ar-EG", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const formatTime = (date: string | Date) => {
    const d = new Date(date);
    return d.toLocaleTimeString("ar-EG", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="space-y-5" data-testid="print-logs-page">
      <PageHeader
        title="سجل الطباعات"
        description="تاريخ كل عمليات الطباعة والتصدير"
        icon={<Clock className="h-5 w-5" aria-hidden="true" />}
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()} className={`${TOUCH} gap-1.5`}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            تحديث
          </Button>
        }
      />

      {!online && <OfflineState onRetry={() => refetch()} className="py-6" />}

      {isLoading ? (
        <LoadingSkeleton variant="cards" rows={4} />
      ) : isError ? (
        <ErrorState message={(error as any)?.message || "تعذّر تحميل سجل الطباعات"} onRetry={() => refetch()} />
      ) : !logs || logs.length === 0 ? (
        <EmptyState
          icon={<Clock className="h-6 w-6" aria-hidden="true" />}
          title="لا توجد سجلات طباعة بعد"
          description="سيتم تسجيل كل عملية طباعة أو تصدير شيت شحن هنا تلقائياً"
        />
      ) : (
        <ul className="space-y-3" aria-label="سجل الطباعات">
          {logs.map((log: any) => {
            const isExpanded = expandedId === log.id;
            const isSheet = log.type === "shipping_sheet";
            return (
              <li
                key={log.id}
                className="overflow-hidden rounded-[var(--radius-brand-md)] border border-border bg-card shadow-[var(--shadow-card)]"
                data-testid={`print-log-${log.id}`}
              >
                <div className="flex items-center gap-3 px-3 py-2">
                  <button
                    type="button"
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-3 text-start"
                    onClick={() => setExpandedId(isExpanded ? null : log.id)}
                    aria-expanded={isExpanded}
                    aria-controls={`print-log-details-${log.id}`}
                  >
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-brand-md)] ${isSheet ? "bg-[var(--success)]/15 text-[var(--success)]" : "bg-[var(--info)]/15 text-[var(--info)]"}`} aria-hidden="true">
                      {isSheet ? <FileSpreadsheet className="h-4 w-4" /> : <Printer className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{isSheet ? "شيت شحن" : "طباعة لابلات"}</span>
                        <Badge variant="secondary" className="text-xs tabular-nums">
                          <Package className="ml-1 h-3 w-3" aria-hidden="true" />
                          {log.orderCount} أوردر
                        </Badge>
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1 tabular-nums"><Clock className="h-3 w-3" aria-hidden="true" />{formatDate(log.createdAt)} — {formatTime(log.createdAt)}</span>
                        <span className="flex items-center gap-1"><User className="h-3 w-3" aria-hidden="true" />{log.printedByName}</span>
                      </span>
                    </span>
                    {isExpanded ? <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  </button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={`${TOUCH} shrink-0 gap-1 text-xs`}
                    disabled={exportingId != null}
                    onClick={() => handleReExport(log)}
                    data-testid={`print-log-reexport-${log.id}`}
                  >
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    إعادة تصدير
                  </Button>
                </div>

                {isExpanded && (
                  <div id={`print-log-details-${log.id}`} className="border-t border-border bg-muted/20 px-4 py-3">
                    <div className="mb-2 text-xs text-muted-foreground">
                      أرقام الأوردرات ({log.orderIds.length}):
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {log.orderIds.map((id: number) => (
                        <span key={id} className="inline-flex items-center rounded-md border border-border bg-background px-2 py-0.5 font-mono text-xs" dir="ltr">
                          #{id}
                        </span>
                      ))}
                    </div>
                    {log.notes && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        <span className="font-medium">ملاحظات:</span> {log.notes}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
