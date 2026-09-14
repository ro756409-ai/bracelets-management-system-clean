import { useMemo } from "react";
import { CalendarRange, Printer } from "lucide-react";
import { TRPCClientError } from "@trpc/client";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { cairoArabicWeekday } from "@/lib/cairoDate";
import {
  WorkspaceShell, ErrorState, PermissionDeniedState, LoadingSkeleton,
} from "@/components/workspace";
import { ShippingRoutesBoard } from "@/components/operations/ShippingRoutesBoard";
import { WorkspacePrintStyles } from "@/components/operations/WorkspacePrintStyles";
import { parseShippingRouteRows } from "@/lib/shippingOperations";

/**
 * Operations workspace — «جدول الشحن» لجلسة الداشبورد (المالك/المدير) — Stage D.
 *
 * نفس لوحة بوابة الموظفين (ShippingRoutesBoard + parseShippingRouteRows) من
 * `operations.shippingRoutes`: shipping_ops.view ومتقيّد بمبدّل الأنشطة. قراءة بس —
 * تعديل المسارات نفسه مكانه إعدادات النشاط زي ما هو.
 */
export default function ShippingScheduleWorkspace() {
  const { currentBusinessIds } = useBusinessContext();
  const routes = trpc.operations.shippingRoutes.useQuery({ businessIds: currentBusinessIds });
  const parsed = useMemo(() => parseShippingRouteRows(routes.data), [routes.data]);
  const today = cairoArabicWeekday();
  const forbidden =
    routes.error instanceof TRPCClientError && routes.error.data?.code === "FORBIDDEN";

  return (
    <WorkspaceShell
      title="جدول الشحن"
      description={`مسارات شركات الشحن لكل يوم — اليوم: ${today}. البيانات من إعدادات كل نشاط، مش جدول ثابت في الكود.`}
      icon={<CalendarRange className="h-5 w-5" />}
      primaryAction={
        <Button size="sm" variant="outline" className="gap-1.5 print:hidden" onClick={() => window.print()}>
          <Printer className="h-3.5 w-3.5" />
          طباعة
        </Button>
      }
    >
      <WorkspacePrintStyles />

      {/* Print Header */}
      <div className="hidden print:block text-center">
        <h1 className="text-2xl font-bold">جدول توزيع الشحن</h1>
        <p className="text-sm text-muted-foreground">اليوم: {today}</p>
      </div>

      {routes.isLoading ? (
        <LoadingSkeleton variant="cards" rows={3} />
      ) : forbidden ? (
        <PermissionDeniedState message="جدول الشحن محتاج صلاحية عمليات الشحن." />
      ) : routes.error ? (
        <ErrorState message={routes.error.message} onRetry={() => routes.refetch()} retrying={routes.isFetching} />
      ) : (
        <ShippingRoutesBoard routes={parsed} today={today} />
      )}
    </WorkspaceShell>
  );
}
