import { useMemo, useState } from "react";
import { Truck, RefreshCw, Printer, Calendar } from "lucide-react";
import { TRPCClientError } from "@trpc/client";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { cairoDateKey } from "@/lib/cairoDate";
import {
  WorkspaceShell, DataToolbar, StatusBadge,
  EmptyState, ErrorState, PermissionDeniedState, LoadingSkeleton,
} from "@/components/workspace";
import { ShipmentsManifest } from "@/components/operations/ShipmentsManifest";
import { WorkspacePrintStyles } from "@/components/operations/WorkspacePrintStyles";
import { filterShipmentAgents, totalShipmentOrders } from "@/lib/shippingOperations";

/**
 * Operations workspace — «شحنات اليوم» لجلسة الداشبورد (المالك/المدير) — Stage D.
 *
 * نفس كشف بوابة الموظفين (ShipmentsManifest + filterShipmentAgents) لكن من
 * `operations.todayShipments`: جلسة الداشبورد، shipping_ops.view، ومتقيّد بمبدّل الأنشطة
 * (currentBusinessIds). قراءة بس — مفيش كتابة فمفيش شرط نشاط واحد.
 */
export default function TodayShipmentsWorkspace() {
  const { currentBusinessIds } = useBusinessContext();
  // تاريخ القاهرة (مش UTC) — عشان بعد نص الليل مايفتحش على يوم امبارح.
  const [selectedDate, setSelectedDate] = useState(() => cairoDateKey());
  const [search, setSearch] = useState("");

  const shipments = trpc.operations.todayShipments.useQuery(
    { date: selectedDate || undefined, businessIds: currentBusinessIds },
    { refetchInterval: 120000 }
  );
  const shipmentsData = shipments.data;

  const filteredAgents = useMemo(
    () => filterShipmentAgents(shipmentsData?.agents, search),
    [shipmentsData, search]
  );
  const totalFilteredOrders = totalShipmentOrders(filteredAgents);
  const isToday = selectedDate === cairoDateKey();
  const forbidden =
    shipments.error instanceof TRPCClientError && shipments.error.data?.code === "FORBIDDEN";

  return (
    <WorkspaceShell
      title="شحنات اليوم"
      description="الأوردرات المؤكدة موزّعة على شركات الشحن حسب جدول اليوم."
      icon={<Truck className="h-5 w-5" />}
      primaryAction={
        <Button size="sm" className="gap-1.5 print:hidden" onClick={() => window.print()}>
          <Printer className="h-3.5 w-3.5" />
          طباعة
        </Button>
      }
      actions={
        <Button variant="outline" size="sm" className="gap-1.5 print:hidden" onClick={() => shipments.refetch()}>
          <RefreshCw className="h-3.5 w-3.5" />
          تحديث
        </Button>
      }
    >
      <WorkspacePrintStyles />

      <div className="print:hidden">
        <DataToolbar
          search={search}
          onSearch={setSearch}
          searchPlaceholder="بحث بالاسم أو التليفون أو رقم الأوردر..."
          filters={
            <label className="flex h-9 shrink-0 items-center gap-2 rounded-md border border-input bg-background px-3">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="bg-transparent text-sm font-medium outline-none"
                aria-label="تاريخ الشحن"
              />
            </label>
          }
          actions={
            <>
              {shipmentsData && (
                <StatusBadge status="day" tone="info" label={`${shipmentsData.dayName}${isToday ? " — اليوم" : ""}`} />
              )}
              <StatusBadge status="count" tone="neutral" label={`${totalFilteredOrders} أوردر`} />
            </>
          }
        />
      </div>

      {/* Print Header */}
      <div className="hidden print:block text-center">
        <h1 className="text-2xl font-bold">شحنات يوم {shipmentsData?.dayName} — {selectedDate}</h1>
        <p className="text-sm text-muted-foreground">إجمالي الأوردرات: {totalFilteredOrders}</p>
      </div>

      {shipments.isLoading ? (
        <LoadingSkeleton variant="cards" rows={3} />
      ) : forbidden ? (
        <PermissionDeniedState message="شحنات اليوم محتاجة صلاحية عمليات الشحن." />
      ) : shipments.error ? (
        <ErrorState message={shipments.error.message} onRetry={() => shipments.refetch()} retrying={shipments.isFetching} />
      ) : filteredAgents.length === 0 ? (
        <EmptyState
          icon={<Truck className="h-6 w-6" />}
          title="لا توجد شحنات لهذا اليوم"
          description="اختر تاريخ آخر أو تحقق من وجود أوردرات مؤكدة"
        />
      ) : (
        <ShipmentsManifest agents={filteredAgents} totalOrders={totalFilteredOrders} />
      )}
    </WorkspaceShell>
  );
}
