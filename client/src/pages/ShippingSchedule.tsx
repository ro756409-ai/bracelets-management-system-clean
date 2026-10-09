import { useMemo } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Printer, Truck } from "lucide-react";
import { cairoArabicWeekday } from "@/lib/cairoDate";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/BrandMark";
import { LoadingSkeleton } from "@/components/shared";
import { ShippingRoutesBoard } from "@/components/operations/ShippingRoutesBoard";
import { parseShippingRouteRows } from "@/lib/shippingOperations";

// نسخة **بوابة الموظفين** (employee_token). جلسة الداشبورد بتشوف نفس اللوحة كتبويب داخل
// Operations workspace (pages/operations/ShippingScheduleWorkspace) — التحليل والعرض مشتركين.

export default function ShippingSchedule() {
  const [, setLocation] = useLocation();
  // الرجوع من حالة المنع بيحدّث صلاحيات الجلسة — فرابط الشحن يختفي من الشاشة فورًا لو الصلاحية اتسحبت.
  const permissionUtils = trpc.useUtils();
  const { data: employee, isLoading } = trpc.employeePortal.me.useQuery(undefined, { retry: false });
  // Was useOperationalOptions("shipping_schedule_route"), which goes through
  // accountingV2.configurationListForBusinesses — authenticated, but not permission-checked,
  // so a confirmation employee could read the whole shipping plan. This endpoint requires
  // shipping_ops.view and returns 403 otherwise, which is what the guard below renders.
  const routes = trpc.employeePortal.shippingRoutes.useQuery(undefined, { retry: false });
  const parsed = useMemo(() => parseShippingRouteRows(routes.data), [routes.data]);
  const today = cairoArabicWeekday();
  if (isLoading || routes.isLoading) return <main className="flex min-h-screen items-center justify-center p-6" dir="rtl"><LoadingSkeleton variant="cards" rows={3} className="w-full max-w-3xl" /></main>;
  if (!employee) return <main className="flex min-h-screen items-center justify-center"><Button data-readonly-safe className="min-h-11" onClick={() => setLocation("/employee-login")}>تسجيل الدخول</Button></main>;
  if (routes.error) return <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center" dir="rtl">
    <Truck className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
    <div>
      <p className="text-lg font-bold">جدول الشحن مش من مهامك</p>
      <p className="mt-1 text-sm text-muted-foreground">الشاشة دي لموظفي الشحن والإدارة. بيانات شحن أوردراتك موجودة جوه كل أوردر في شاشتك.</p>
    </div>
    <Button className="min-h-11" onClick={() => { permissionUtils.employeePortal.myPermissions.invalidate(); setLocation("/employee-dashboard"); }}>الرجوع لشاشتي</Button>
  </main>;
  return <div className="min-h-screen bg-background" dir="rtl">
    <header className="sticky top-0 z-40 border-b border-border bg-card/95 shadow-[var(--shadow-card)] backdrop-blur print:hidden"><div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-2"><div className="flex items-center gap-2"><Button data-readonly-safe variant="ghost" className="min-h-11 min-w-11 px-2" onClick={() => setLocation("/employee-dashboard")} aria-label="الرجوع لشاشتي"><ArrowRight className="h-5 w-5" aria-hidden="true" /></Button><BrandMark className="h-8 w-8" /><div><strong>جدول توزيع الشحن</strong><p className="text-xs text-muted-foreground">إعدادات مستقلة لكل نشاط</p></div></div><Button data-readonly-safe variant="ghost" className="min-h-11 min-w-11 px-2" onClick={() => window.print()} aria-label="طباعة"><Printer className="h-5 w-5" aria-hidden="true" /></Button></div></header>
    <main className="mx-auto max-w-5xl space-y-4 p-4"><div className="rounded-[var(--radius-brand-md)] border border-border bg-card p-5 shadow-[var(--shadow-card)]"><h1 className="text-2xl font-bold">مسارات شركات الشحن</h1><p className="mt-1 text-sm text-muted-foreground">اليوم: {today}. البيانات دي جاية من إعدادات الحسابات ومفيش جدول ثابت داخل الكود.</p></div>
      <ShippingRoutesBoard routes={parsed} today={today} />
    </main>
  </div>;
}
