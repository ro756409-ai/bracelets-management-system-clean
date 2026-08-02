import { useMemo } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Printer, Truck } from "lucide-react";
import { cairoArabicWeekday } from "@/lib/cairoDate";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/BrandMark";
import { useOperationalOptions } from "@/hooks/useOperationalOptions";

const dayNames = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

export default function ShippingSchedule() {
  const [, setLocation] = useLocation();
  const { data: employee, isLoading } = trpc.employeePortal.me.useQuery(undefined, { retry: false });
  const routes = useOperationalOptions("shipping_schedule_route");
  const parsed = useMemo(() => (routes.data ?? []).flatMap(row => {
    try {
      const value = JSON.parse(row.valueJson ?? "{}") as { providerName?: string; dayOfWeek?: number; governorates?: string[]; priority?: number; notes?: string };
      return value.providerName && Number.isInteger(value.dayOfWeek) && Array.isArray(value.governorates) ? [{ ...value, dayOfWeek: value.dayOfWeek!, providerName: value.providerName!, governorates: value.governorates!, priority: value.priority ?? 0 }] : [];
    } catch { return []; }
  }), [routes.data]);
  const today = cairoArabicWeekday();
  if (isLoading || routes.isLoading) return <div className="flex min-h-screen items-center justify-center">جاري تحميل جدول الشحن...</div>;
  if (!employee) return <div className="flex min-h-screen items-center justify-center"><Button onClick={() => setLocation("/employee-login")}>تسجيل الدخول</Button></div>;
  return <div className="min-h-screen bg-background" dir="rtl">
    <header className="sticky top-0 z-40 bg-slate-950 text-white shadow print:hidden"><div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3"><div className="flex items-center gap-3"><button onClick={() => setLocation("/employee-dashboard")}><ArrowRight className="h-5 w-5" /></button><BrandMark className="h-8 w-8" /><div><strong>جدول توزيع الشحن</strong><p className="text-xs text-slate-300">إعدادات مستقلة لكل Business</p></div></div><button onClick={() => window.print()}><Printer className="h-5 w-5" /></button></div></header>
    <main className="mx-auto max-w-5xl space-y-4 p-4"><div className="rounded-2xl border bg-card p-5"><h1 className="text-2xl font-black">مسارات شركات الشحن</h1><p className="mt-1 text-sm text-muted-foreground">اليوم: {today}. البيانات دي جاية من إعدادات الحسابات ومفيش جدول ثابت داخل الكود.</p></div>
      {parsed.length === 0 ? <div className="rounded-2xl border border-dashed p-10 text-center text-muted-foreground"><Truck className="mx-auto mb-3 h-8 w-8" />مفيش مسارات شحن متضبطة للنشاط الحالي.</div> : dayNames.map((day, dayOfWeek) => { const rows = parsed.filter(route => route.dayOfWeek === dayOfWeek).sort((a, b) => b.priority - a.priority); if (!rows.length) return null; return <section key={day} className={`overflow-hidden rounded-2xl border ${day === today ? "border-emerald-500" : ""}`}><h2 className="bg-muted px-4 py-3 font-bold">{day}{day === today ? " · اليوم" : ""}</h2><div className="grid gap-3 p-4 md:grid-cols-2">{rows.map((route, index) => <article key={`${route.providerName}-${index}`} className="rounded-xl border p-4"><div className="flex justify-between"><strong>{route.providerName}</strong><span className="text-xs text-muted-foreground">Priority {route.priority}</span></div><p className="mt-2 text-sm">{route.governorates.join(" · ")}</p>{route.notes && <p className="mt-2 text-xs text-muted-foreground">{route.notes}</p>}</article>)}</div></section>; })}
    </main>
  </div>;
}
