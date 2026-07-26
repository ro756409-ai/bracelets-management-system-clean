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

export default function PrintLogs() {
  const { currentBusinessIds } = useBusinessContext();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: logs, isLoading, refetch } = trpc.printLogs.list.useQuery({
    limit: 50,
    businessId: currentBusinessIds && currentBusinessIds.length === 1 ? currentBusinessIds[0] : undefined,
  });

  const handleReExport = (log: any) => {
    if (!log.orderIds || log.orderIds.length === 0) {
      toast.error("لا توجد أوردرات في هذا السجل");
      return;
    }
    const params = new URLSearchParams();
    params.set("orderIds", log.orderIds.join(","));
    if (log.type === "shipping_sheet") {
      window.open(`/api/export/shipping?${params.toString()}`, "_blank");
      toast.success("جاري إعادة تصدير شيت الشحن...");
    } else {
      window.open(`/api/export/print-labels?${params.toString()}`, "_blank");
      toast.success("جاري إعادة طباعة اللابلات...");
    }
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
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b bg-background">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
            <Clock className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-bold">سجل الطباعات</h1>
            <p className="text-xs text-muted-foreground">تاريخ كل عمليات الطباعة والتصدير</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1.5">
          <RefreshCw className="w-3.5 h-3.5" />
          تحديث
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground">
            <RefreshCw className="w-5 h-5 animate-spin ml-2" />
            جاري التحميل...
          </div>
        ) : !logs || logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 gap-2 text-muted-foreground">
            <Clock className="w-10 h-10 opacity-30" />
            <p className="text-sm">لا توجد سجلات طباعة بعد</p>
            <p className="text-xs">سيتم تسجيل كل عملية طباعة أو تصدير شيت شحن هنا تلقائياً</p>
          </div>
        ) : (
          <div className="space-y-3">
            {logs.map((log: any) => {
              const isExpanded = expandedId === log.id;
              return (
                <div
                  key={log.id}
                  className="bg-background border rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow"
                >
                  {/* Log Header */}
                  <div
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                    onClick={() => setExpandedId(isExpanded ? null : log.id)}
                  >
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                      log.type === "shipping_sheet"
                        ? "bg-[var(--success)]/15 text-[var(--success)]"
                        : "bg-[var(--info)]/15 text-[var(--info)]"
                    }`}>
                      {log.type === "shipping_sheet"
                        ? <FileSpreadsheet className="w-4.5 h-4.5" />
                        : <Printer className="w-4.5 h-4.5" />
                      }
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">
                          {log.type === "shipping_sheet" ? "شيت شحن" : "طباعة لابلات"}
                        </span>
                        <Badge variant="secondary" className="text-xs">
                          <Package className="w-3 h-3 ml-1" />
                          {log.orderCount} أوردر
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDate(log.createdAt)} — {formatTime(log.createdAt)}
                        </span>
                        <span className="flex items-center gap-1">
                          <User className="w-3 h-3" />
                          {log.printedByName}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={(e) => { e.stopPropagation(); handleReExport(log); }}
                      >
                        <RotateCcw className="w-3 h-3" />
                        إعادة تصدير
                      </Button>
                      {isExpanded
                        ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                        : <ChevronDown className="w-4 h-4 text-muted-foreground" />
                      }
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {isExpanded && (
                    <div className="border-t px-4 py-3 bg-muted/20">
                      <div className="text-xs text-muted-foreground mb-2">
                        أرقام الأوردرات ({log.orderIds.length}):
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {log.orderIds.map((id: number) => (
                          <span
                            key={id}
                            className="inline-flex items-center px-2 py-0.5 rounded-md bg-background border text-xs font-mono"
                          >
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
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
