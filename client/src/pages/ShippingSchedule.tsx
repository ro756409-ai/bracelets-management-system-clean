import { useMemo } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Printer, Truck } from "lucide-react";
import { cairoArabicWeekday } from "@/lib/cairoDate";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/BrandMark";
import { ShippingRoutesBoard } from "@/components/operations/ShippingRoutesBoard";
import { parseShippingRouteRows } from "@/lib/shippingOperations";

// نسخة **بوابة الموظفين** (employee_token). جلسة الداشبورد بتشوف نفس اللوحة كتبويب داخل
// Operations workspace (pages/operations/ShippingScheduleWorkspace) — التحليل والعرض مشتركين.

export default function ShippingSchedule() {
  const [, setLocation] = useLocation();
  const { data: employee, isLoading } = trpc.employeePortal.me.useQuery(undefined, { retry: false });
  // Was useOperationalOptions("shipping_schedule_route"), which goes through
  // accountingV2.configurationListForBusinesses — authenticated, but not permission-checked,
  // so a confirmation employee could read the whole shipping plan. This endpoint requires
  // shipping_ops.view and returns 403 otherwise, which is what the guard below renders.
  const routes = trpc.employeePortal.shippingRoutes.useQuery(undefined, { retry: false });
  const parsed = useMemo(() => parseShippingRouteRows(routes.data), [routes.data]);
  const today = cairoArabicWeekday();
  if (isLoading || routes.isLoading) return <div className="flex min-h-screen items-center justify-center">جاري تحميل جدول الشحن...</div>;
  if (!employee) return <div className="flex min-h-screen items-center justify-center"><Button onClick={() => setLocation("/employee-login")}>تسجيل الدخول</Button></div>;
  if (routes.error) return <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center" dir="rtl">
    <Truck className="h-10 w-10 text-muted-foreground" />
    <div>
      <p className="text-lg font-bold">جدول الشحن مش من مهامك</p>
      <p className="mt-1 text-sm text-muted-foreground">الشاشة دي لموظفي الشحن والإدارة. بيانات شحن أوردراتك موجودة جوه كل أوردر في شاشتك.</p>
    </div>
    <Button onClick={() => setLocation("/employee-dashboard")}>الرجوع لشاشتي</Button>
  </div>;
  return <div className="min-h-screen bg-background" dir="rtl">
    <header className="sticky top-0 z-40 bg-slate-950 text-white shadow print:hidden"><div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3"><div className="flex items-center gap-3"><button onClick={() => setLocation("/employee-dashboard")}><ArrowRight className="h-5 w-5" /></button><BrandMark className="h-8 w-8" /><div><strong>جدول توزيع الشحن</strong><p className="text-xs text-slate-300">إعدادات مستقلة لكل Business</p></div></div><button onClick={() => window.print()}><Printer className="h-5 w-5" /></button></div></header>
    <main className="mx-auto max-w-5xl space-y-4 p-4"><div className="rounded-2xl border bg-card p-5"><h1 className="text-2xl font-black">مسارات شركات الشحن</h1><p className="mt-1 text-sm text-muted-foreground">اليوم: {today}. البيانات دي جاية من إعدادات الحسابات ومفيش جدول ثابت داخل الكود.</p></div>
      <ShippingRoutesBoard routes={parsed} today={today} />
    </main>
  </div>;
}
