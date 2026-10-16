import { trpc } from "@/lib/trpc";
import * as XLSX from "xlsx";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { useState, useMemo } from "react";
import {
  ShoppingCart, CheckCircle, Clock, Package, TrendingUp, Users, RefreshCw,
  Phone, MapPin, CheckCircle2, Download, Truck, PackageCheck, BarChart3, Briefcase, Boxes, Wallet, Megaphone } from "lucide-react";
import DateRangePicker, { DateRange as PickerRange } from "@/components/DateRangePicker";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { NeedsAttention } from "@/components/dashboard/NeedsAttention";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import {
  PageHeader, ScopeBar, SectionCard, StatCard, EmptyState, ErrorState, LoadingSkeleton, OfflineState, PermissionDeniedState,
} from "@/components/shared";
import { SectionIcon } from "@/components/brand/SectionIcon";
import { PartnerLogo } from "@/components/brand/PartnerLogo";
import { usePermissions } from "@/hooks/usePermission";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { canSeeNav } from "@/config/navigation";
import { gateForPath } from "@/components/shell/CreateMenu";

/**
 * لوحة التحكم الرئيسية — Copper Signature × Clean Spatial (المرحلة 7A).
 *
 * **نفس الاستعلامات ونفس طريقة حساب كل رقم** كما كانت (راجع الـAudit في dashboard.phase7a.wiring.test.ts):
 *   reports.dashboard (الحالات/المحافظات/قيمة الموصَّل/المشحون في الفترة) · products.lowStock · reports.dailyChart(14) ·
 *   reports.mergeAlert · orders.todayConfirmed · broadcast.getActive/send/clear · seed.init.
 * ما تغيّر هو التنظيم والعرض فقط: ترويسة + نطاق النشاط، بطاقات المؤشرات بترتيب المالك مع مصدر كل رقم،
 * أقسام واضحة بحالاتها (تحميل/فارغ/خطأ/بلا اتصال/بلا صلاحية)، رسم recharts بألوان Tokens مع جدول بديل
 * لقارئ الشاشة، وإجراءات سريعة مفلترة بصلاحيات الجلسة (نفس بوابات التنقل).
 * لا مؤشر مخترع: «التحصيل الفعلي» غير متاح من استعلامات اللوحة الحالية فلا يُعرض كرقم.
 */
const STATUS_LABELS: Record<string, string> = {
  new: "جديد",
  confirmed: "مؤكد",
  postponed: "مؤجل",
  cancelled: "ملغي",
  preparing: "قيد التحضير",
  shipped: "تم الشحن",
  delivered: "تم التوصيل",
};

function todayRange(): PickerRange {
  const now = new Date();
  const from = new Date(now); from.setHours(0, 0, 0, 0);
  const to = new Date(now); to.setHours(23, 59, 59, 999);
  return { from, to };
}

const fmt = (n: number) => n.toLocaleString("ar-EG");

/** الإجراءات السريعة — وجهات موجودة فعلًا، تُفلتر بنفس بوابات التنقل (config/navigation) */
const QUICK_ACTIONS = [
  { key: "orders", label: "الأوردرات", path: "/orders", icon: ShoppingCart },
  { key: "workspace", label: "مساحة العمل", path: "/workspace", icon: Briefcase },
  { key: "inventory", label: "المخزون", path: "/inventory", icon: Package },
  { key: "reports", label: "التقارير", path: "/reports", icon: TrendingUp },
  { key: "employees", label: "الموظفون", path: "/employees", icon: Users },
] as const;

export default function Dashboard() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { permissions, has } = usePermissions();
  const online = useOnlineStatus();
  const [pickerRange, setPickerRange] = useState<PickerRange>(() => todayRange());

  const dateParams = useMemo(() => ({
    dateFrom: pickerRange.from ?? undefined,
    dateTo: pickerRange.to ?? undefined,
  }), [pickerRange]);

  const { currentBusinessIds, currentBusinessId, setCurrentBusinessId, businesses, activeBusiness } = useBusinessContext();
  const isAdmin = user?.role === 'admin';
  // بوابات السيرفر نفسها: reports.dashboard = accounting.view؛ todayConfirmed/المخزون = orders.view ونطاق الجلسة.
  // لا نجلب بيانات قسم غير مصرح به — والإخفاء البصري ليس حماية (السيرفر يرفض أيضًا).
  const canViewStats = has("accounting.view");
  const canViewOrders = has("orders.view");
  const { data: stats, isLoading, isError: statsFailed, error: statsError, refetch } = trpc.reports.dashboard.useQuery({
    ...dateParams,
    businessIds: currentBusinessIds,
  }, {
    enabled: isAdmin && canViewStats,
    retry: false,
  });
  const { data: lowStock, isLoading: lowStockLoading, isError: lowStockFailed, refetch: refetchLowStock } = trpc.products.lowStock.useQuery(
    currentBusinessIds && currentBusinessIds.length > 0 ? { businessIds: currentBusinessIds } : undefined,
    { enabled: isAdmin, retry: false }
  );
  const { data: chartData, isLoading: chartLoading, isError: chartFailed, refetch: refetchChart } = trpc.reports.dailyChart.useQuery({
    days: 14,
    businessIds: currentBusinessIds,
  }, {
    enabled: isAdmin,
    retry: false,
  });

  // Merge alert
  const { data: mergeAlert } = trpc.reports.mergeAlert.useQuery(undefined, {
    enabled: isAdmin,
    refetchInterval: 60_000, // refresh every minute
  });

  // مؤكدات اليوم
  const { data: todayConfirmedData, isLoading: todayLoading, isError: todayFailed, refetch: refetchToday } = trpc.orders.todayConfirmed.useQuery({
    businessIds: currentBusinessIds,
  }, {
    enabled: isAdmin && canViewOrders,
    refetchInterval: 30_000, // refresh every 30 seconds
    retry: false,
  });
  const todayConfirmedOrders = todayConfirmedData?.orders ?? [];
  const todayConfirmedCount = todayConfirmedData?.total ?? 0;
  const todayTotalRevenue = todayConfirmedOrders.reduce((sum, o) => sum + Number(o.totalAmount ?? 0), 0);

  function exportTodayConfirmedToExcel() {
    const today = new Date().toLocaleDateString('ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
    const rows = todayConfirmedOrders.map((o, idx) => ({
      '#': idx + 1,
      'رقم Easy Order': o.easyOrderShortId ?? '',
      'اسم العميل': o.customerName,
      'التليفون': o.customerPhone,
      'المحافظة': o.governorate,
      'العنوان الكامل': o.customerAddress ?? '',
      'المنتج': o.productName,
      'الكمية': o.quantity ?? 1,
      'المبلغ الإجمالي': Number(o.totalAmount),
      'وقت التأكيد': o.confirmedAt ? new Date(o.confirmedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    // عرض الأعمدة
    ws['!cols'] = [{ wch: 4 }, { wch: 14 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 40 }, { wch: 30 }, { wch: 8 }, { wch: 14 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'مؤكدات اليوم');
    XLSX.writeFile(wb, `مؤكدات-اليوم-${today}.xlsx`);
  }

  // Broadcast message
  const [broadcastMsg, setBroadcastMsg] = useState("");
  const utils = trpc.useUtils();
  const { data: activeBroadcast } = trpc.broadcast.getActive.useQuery(
    undefined,
    { enabled: isAdmin }
  );
  const sendBroadcastMutation = trpc.broadcast.send.useMutation({
    onSuccess: () => {
      toast.success("تم إرسال الرسالة لجميع الموظفين");
      setBroadcastMsg("");
      utils.broadcast.getActive.invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });
  const clearBroadcastMutation = trpc.broadcast.clear.useMutation({
    onSuccess: () => {
      toast.success("تم حذف الرسالة");
      utils.broadcast.getActive.invalidate();
    },
    onError: (e: any) => toast.error(e.message),
  });

  // Seed initial data
  const seedMutation = trpc.seed.init.useMutation();

  // ==================== الأرقام — نفس الحسابات السابقة حرفيًا ====================
  const totalOrders = stats?.statusStats.reduce((sum, s) => sum + Number(s.count), 0) ?? 0;
  const confirmedOnlyCount = Number(stats?.statusStats.find(s => s.status === 'confirmed')?.count ?? 0);
  const printedCount = Number(stats?.statusStats.find(s => s.status === 'printed')?.count ?? 0);
  const confirmedCount = confirmedOnlyCount + printedCount;
  const cancelledCount = Number(stats?.statusStats.find(s => s.status === 'cancelled')?.count ?? 0);
  const newCount = stats?.statusStats.find(s => s.status === 'new')?.count ?? 0;
  const confirmRate = totalOrders > 0 ? Math.round((Number(confirmedCount) / totalOrders) * 100) : 0;
  // من نفس الاستعلام: المشحون في الفترة (shippedAt) وعدد الموصَّل من أوردرات الفترة وقيمة الموصَّل (deliveredAt)
  const shippedCount = Number(stats?.shippedToday ?? 0);
  const deliveredCount = Number(stats?.statusStats.find(s => s.status === 'delivered')?.count ?? 0);
  const deliveredValue = Number(stats?.totalRevenue ?? 0);

  const barData = chartData?.map(d => ({
    date: d.date,
    total: Number(d.total),
    confirmed: Number(d.confirmed),
    cancelled: Number(d.cancelled),
  })) ?? [];
  const barTotals = barData.reduce((a, d) => ({ total: a.total + d.total, confirmed: a.confirmed + d.confirmed, cancelled: a.cancelled + d.cancelled }), { total: 0, confirmed: 0, cancelled: 0 });

  const statsForbidden = statsFailed && (statsError as any)?.data?.code === "FORBIDDEN";
  const quickActions = QUICK_ACTIONS.filter(a => canSeeNav(gateForPath(a.path), isAdmin, permissions));
  const canOpen = (path: string) => canSeeNav(gateForPath(path), isAdmin, permissions);
  const refreshAll = () => { void refetch(); void refetchChart(); void refetchLowStock(); void refetchToday(); };
  const dateLabel = new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className="space-y-6 brand-v2:space-y-8 brand-v2:pb-4" data-testid="dashboard-page">
      <PageHeader
        title={`أهلاً ${user?.name ?? ""}`}
        description={`${dateLabel} — ${activeBusiness ? `نشاط «${activeBusiness.name}»` : businesses.length > 1 ? "كل الأنشطة" : "ملخص اليوم"} · أهم ما يحتاج تدخّلك`}
        icon={<SectionIcon section="orders" fallback={ShoppingCart} size="md" className="!rounded-[var(--radius-brand-md)] !ring-0 !bg-transparent" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <DateRangePicker value={pickerRange} onChange={setPickerRange} placeholder="اختر نطاق زمني" />
            <Button data-readonly-safe type="button" variant="outline" size="sm" className="min-h-11 md:min-h-9" onClick={refreshAll} data-testid="dashboard-refresh">
              <RefreshCw className="ml-1 h-4 w-4" aria-hidden="true" />
              تحديث
            </Button>
          </div>
        }
      >
        {businesses.length > 1 && (
          <ScopeBar options={businesses.map(b => ({ id: b.id, label: b.name }))} value={currentBusinessId ?? null} onChange={id => setCurrentBusinessId(id == null ? undefined : Number(id))} />
        )}
      </PageHeader>

      {!online && <OfflineState onRetry={refreshAll} />}

      {/* ==================== 1. ملخص التشغيل اليومي ==================== */}
      <SectionCard
        title="ملخص التشغيل"
        description={`الفترة المختارة ضمن ${activeBusiness ? "النشاط الحالي" : "النطاق الحالي"}`}
        icon={<BarChart3 className="h-4 w-4" aria-hidden="true" />}
        className="border-0 bg-transparent shadow-none brand-v2:rounded-2xl brand-v2:border brand-v2:border-border/60 brand-v2:bg-card/50 brand-v2:p-4 brand-v2:sm:p-5 brand-v2:gap-3 brand-v2:[&>[data-slot=card-header]]:px-0"
        contentClassName="p-0"
      >
        {!isAdmin || !canViewStats ? (
          <PermissionDeniedState message="مؤشرات التشغيل تتطلب صلاحية «عرض المحاسبة». تواصل مع مالك الحساب لو محتاجها." />
        ) : statsForbidden ? (
          <PermissionDeniedState message="رفض السيرفر طلب المؤشرات لهذه الجلسة." />
        ) : statsFailed ? (
          online ? <ErrorState message={(statsError as any)?.message} onRetry={() => void refetch()} /> : null
        ) : isLoading ? (
          <LoadingSkeleton variant="cards" rows={5} />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 brand-v2:gap-4 brand-v2:xl:grid-cols-6 brand-v2:2xl:grid-cols-5 brand-v2:xl:max-2xl:[&>*]:col-span-2 brand-v2:xl:max-2xl:[&>*:nth-child(n+4)]:col-span-3 brand-v2:2xl:[&>*]:col-span-1" data-testid="dashboard-kpis">
            <StatCard label="أوردرات الفترة" value={fmt(totalOrders)} hint="أوردرات أُنشئت في الفترة المختارة (كل الحالات)" icon={<ShoppingCart className="h-5 w-5" aria-hidden="true" />} tone="info"
              onClick={canOpen("/orders") ? () => setLocation("/orders") : undefined} className="min-h-11" />
            <StatCard label="تحتاج قرار" value={fmt(Number(newCount))} hint="بحالة «جديد» — بانتظار التأكيد أو الإلغاء" icon={<Clock className="h-5 w-5" aria-hidden="true" />} tone="warning"
              onClick={canOpen("/orders") ? () => setLocation("/orders") : undefined} />
            <StatCard label="مؤكدة" value={fmt(Number(confirmedCount))} hint={`مؤكد + مطبوع · ${confirmRate}% من أوردرات الفترة`} icon={<CheckCircle className="h-5 w-5" aria-hidden="true" />} tone="success" />
            <StatCard label="تم شحنها" value={fmt(shippedCount)} hint="شُحنت في الفترة (تاريخ الشحن) — مشحون أو موصَّل" icon={<Truck className="h-5 w-5" aria-hidden="true" />} tone="primary" />
            <StatCard label="تم توصيلها" value={fmt(deliveredCount)} hint={`من أوردرات الفترة · قيمة الموصَّل في الفترة ${fmt(deliveredValue)} ج.م (قيمة أوردرات، ليست نقدًا محصّلًا)`} icon={<PackageCheck className="h-5 w-5" aria-hidden="true" />} tone="success" />
          </div>
        )}
      </SectionCard>

      {/* ==================== 2. الأوردرات التي تحتاج تدخلًا ==================== */}
      {isAdmin && (
        <NeedsAttention
          needsConfirmation={canViewStats ? Number(newCount) || 0 : 0}
          lowStock={lowStock?.length ?? 0}
          duplicates={mergeAlert?.hasAlert ? Number(mergeAlert.count) || 0 : 0}
        />
      )}

      {isAdmin && canViewOrders && (
        <SectionCard
          title={
            <span className="flex flex-wrap items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-[var(--success)]" aria-hidden="true" />
              مؤكدات اليوم
              <span className="rounded-[var(--radius-brand-pill)] bg-[var(--success)]/15 px-2 py-0.5 text-xs font-bold tabular-nums text-[var(--success)]">{fmt(todayConfirmedCount)}</span>
            </span>
          }
          description={`أوردرات أُكّدت اليوم ولم تُطبع بعد · ${todayConfirmedCount > 0 ? `قيمة متوقعة ${fmt(todayTotalRevenue)} ج.م — ليست تحصيلًا` : "جاهزة للطباعة والتجهيز"}`}
          action={todayConfirmedCount > 0 ? (
            <Button data-readonly-safe type="button" variant="outline" size="sm" onClick={exportTodayConfirmedToExcel} className="min-h-11 gap-1 border-[var(--success)]/40 text-[var(--success)] hover:bg-[var(--success)]/10 md:min-h-8 md:text-xs">
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              تصدير Excel
            </Button>
          ) : undefined}
          testId="dashboard-today-confirmed"
        >
          {todayLoading ? (
            <LoadingSkeleton variant="table" rows={3} />
          ) : todayFailed ? (
            online ? <ErrorState message="تعذّر تحميل مؤكدات اليوم" onRetry={() => void refetchToday()} /> : null
          ) : todayConfirmedOrders.length === 0 ? (
            <EmptyState title="لا توجد أوردرات مؤكدة اليوم حتى الآن" description="أول أوردر يُؤكَّد اليوم يظهر هنا فورًا." icon={<CheckCircle2 className="h-7 w-7" />} className="py-8" />
          ) : (
            <ul className="max-h-[480px] space-y-2 overflow-y-auto pr-1" aria-label="قائمة مؤكدات اليوم">
              {todayConfirmedOrders.map((order, idx) => (
                <li key={order.id} className="flex items-start gap-3 rounded-[var(--radius-brand-md)] border border-border bg-surface-2 p-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--success)]/15 text-xs font-bold tabular-nums text-[var(--success)]" aria-hidden="true">{idx + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-foreground">{order.customerName}</p>
                      <span className="shrink-0 font-en text-xs font-bold tabular-nums text-[var(--success)]">{fmt(Number(order.totalAmount))} ج.م</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Phone className="h-3 w-3" aria-hidden="true" /><span className="font-en" dir="ltr">{order.customerPhone}</span></span>
                      <span className="flex items-center gap-1"><MapPin className="h-3 w-3" aria-hidden="true" />{order.governorate}</span>
                      {order.easyOrderShortId && <span className="flex items-center gap-1"><PartnerLogo partner="easyorders" size="xs" decorative /> <span className="font-en" dir="ltr">#{order.easyOrderShortId}</span></span>}
                    </div>
                    {order.customerAddress && <p className="mt-0.5 truncate text-xs text-muted-foreground">{order.customerAddress}</p>}
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">{order.productName}</span>
                      <span className="font-en text-xs tabular-nums text-muted-foreground">{order.confirmedAt ? new Date(order.confirmedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {/* ==================== 3. أداء الحالات خلال الفترة ==================== */}
      {isAdmin && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 brand-v2:gap-5">
          <SectionCard
            title="أوردرات آخر 14 يومًا"
            description="عدد الأوردرات يوميًا حسب تاريخ الإنشاء — الإجمالي والمؤكد (شاملًا المطبوع/المجهّز/المشحون/الموصَّل) والملغي"
            icon={<BarChart3 className="h-4 w-4" aria-hidden="true" />}
            className="lg:col-span-2"
            testId="dashboard-chart"
          >
            {chartLoading ? (
              <LoadingSkeleton variant="form" rows={2} />
            ) : chartFailed ? (
              online ? <ErrorState message="تعذّر تحميل الرسم" onRetry={() => void refetchChart()} /> : null
            ) : barData.length === 0 ? (
              <EmptyState title="لا توجد بيانات كافية" description="يظهر الرسم عندما تُسجَّل أوردرات خلال آخر 14 يومًا." icon={<BarChart3 className="h-7 w-7" />} className="py-8" />
            ) : (
              <>
                <p className="mb-2 text-xs text-muted-foreground tabular-nums" data-testid="dashboard-chart-totals">
                  إجمالي الفترة <strong className="text-foreground">{fmt(barTotals.total)}</strong> · مؤكد <strong className="text-[var(--success)]">{fmt(barTotals.confirmed)}</strong> · ملغي <strong className="text-foreground">{fmt(barTotals.cancelled)}</strong>
                </p>
                <div className="w-full overflow-hidden" role="img" aria-label={`رسم أعمدة: أوردرات آخر 14 يومًا — الإجمالي ${fmt(barTotals.total)}، المؤكد ${fmt(barTotals.confirmed)}، الملغي ${fmt(barTotals.cancelled)}`}>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={barData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} stroke="var(--border)" />
                      <YAxis tick={{ fontSize: 10, fill: "var(--muted-foreground)" }} stroke="var(--border)" allowDecimals={false} />
                      <Tooltip
                        contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--foreground)' }}
                        labelStyle={{ color: 'var(--foreground)' }}
                        itemStyle={{ color: 'var(--foreground)' }}
                        cursor={{ fill: 'var(--muted)' }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12, color: 'var(--muted-foreground)' }} />
                      {/* لا أحمر كسلسلة افتراضية: الإجمالي أزرق، المؤكد أخضر، الملغي كهرماني من Tokens */}
                      <Bar dataKey="total" name="الإجمالي" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="confirmed" name="مؤكد" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="cancelled" name="ملغي" fill="var(--chart-4)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {/* الجدول البديل لقارئ الشاشة — نفس البيانات */}
                <table className="sr-only" data-testid="dashboard-chart-table">
                  <caption>أوردرات آخر 14 يومًا حسب اليوم</caption>
                  <thead><tr><th>اليوم</th><th>الإجمالي</th><th>مؤكد</th><th>ملغي</th></tr></thead>
                  <tbody>{barData.map(d => <tr key={d.date}><td>{d.date}</td><td>{d.total}</td><td>{d.confirmed}</td><td>{d.cancelled}</td></tr>)}</tbody>
                </table>
              </>
            )}
          </SectionCard>

          <SectionCard title="أكثر المحافظات طلبًا" description="من أوردرات الفترة المختارة" icon={<MapPin className="h-4 w-4" aria-hidden="true" />} testId="dashboard-governorates">
            {!canViewStats ? (
              <PermissionDeniedState message="يتطلب صلاحية «عرض المحاسبة»." />
            ) : isLoading ? (
              <LoadingSkeleton variant="table" rows={4} />
            ) : stats?.governorateStats && stats.governorateStats.length > 0 ? (
              <ol className="space-y-2" aria-label="ترتيب المحافظات">
                {stats.governorateStats.slice(0, 5).map((g, i) => {
                  const maxCount = Number(stats.governorateStats[0]?.count ?? 1);
                  const pct = Math.round((Number(g.count) / maxCount) * 100);
                  return (
                    <li key={g.governorate} className="flex items-center gap-3">
                      <span className="w-5 text-xs font-bold tabular-nums text-muted-foreground">{i + 1}</span>
                      <span className="w-24 shrink-0 truncate text-sm font-medium text-foreground">{g.governorate}</span>
                      <div className="h-2 flex-1 rounded-full bg-muted" aria-hidden="true">
                        <div className="h-2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-8 text-end font-en text-sm font-bold tabular-nums text-foreground">{fmt(Number(g.count))}</span>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <EmptyState title="لا توجد بيانات كافية" icon={<MapPin className="h-7 w-7" />} className="py-8" />
            )}
          </SectionCard>
        </div>
      )}

      {/* ==================== 4. المخزون والتنبيهات الحقيقية ==================== */}
      {isAdmin && (
        <SectionCard
          title="المخزون والتنبيهات"
          description="منتجات وصل مخزونها إلى حد التنبيه أو أقل ضمن النطاق الحالي"
          icon={<SectionIcon section="inventory" fallback={Boxes} size="md" className="!h-7 !w-7 !rounded-md" />}
          action={canOpen("/inventory") ? <Button data-readonly-safe type="button" variant="outline" size="sm" className="min-h-11 md:min-h-8" onClick={() => setLocation("/inventory")}>فتح المخزون</Button> : undefined}
          testId="dashboard-inventory"
        >
          {lowStockLoading ? (
            <LoadingSkeleton variant="table" rows={3} />
          ) : lowStockFailed ? (
            online ? <ErrorState message="تعذّر تحميل تنبيهات المخزون" onRetry={() => void refetchLowStock()} /> : null
          ) : !lowStock || lowStock.length === 0 ? (
            <EmptyState title="لا تنبيهات مخزون" description="كل المنتجات النشطة فوق حد التنبيه." icon={<Package className="h-7 w-7" />} className="py-8" />
          ) : (
            <ul className="divide-y divide-border" aria-label="منتجات منخفضة المخزون">
              {lowStock.slice(0, 5).map((p: any) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate font-medium text-foreground">{p.name}</span>
                  <span className="shrink-0 font-en text-xs tabular-nums text-muted-foreground">المتاح {fmt(Number(p.currentStock ?? 0))} · الحد {fmt(Number(p.minStockLevel ?? 0))}</span>
                </li>
              ))}
              {lowStock.length > 5 && <li className="pt-2 text-xs text-muted-foreground">و{fmt(lowStock.length - 5)} منتجات أخرى — راجع صفحة المخزون.</li>}
            </ul>
          )}
        </SectionCard>
      )}

      {/* ==================== 5. الشحن والتحصيل ==================== */}
      {isAdmin && canViewStats && !statsFailed && (
        <SectionCard
          title="الشحن والتحصيل"
          description="ما تدعمه بيانات اللوحة الحالية فقط: المشحون في الفترة وقيمة الموصَّل — التحصيل النقدي الفعلي غير متاح من استعلامات هذه اللوحة"
          icon={<SectionIcon section="shipping" fallback={Truck} size="md" className="!h-7 !w-7 !rounded-md" />}
          testId="dashboard-shipping"
        >
          {isLoading ? (
            <LoadingSkeleton variant="cards" rows={3} />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatCard label="شُحنت في الفترة" value={fmt(shippedCount)} hint="حسب تاريخ الشحن" icon={<Truck className="h-5 w-5" aria-hidden="true" />} tone="primary" />
              <StatCard label="قيمة الموصَّل في الفترة" value={<>{fmt(deliveredValue)} <span className="text-sm font-normal text-muted-foreground">ج.م</span></>} hint="مجموع قيمة الأوردرات الموصَّلة حسب تاريخ التسليم — ليست نقدًا محصّلًا" icon={<PackageCheck className="h-5 w-5" aria-hidden="true" />} tone="success" />
              <Card className="shadow-[var(--shadow-card)]" data-testid="dashboard-collection-unavailable">
                <CardContent className="flex items-start justify-between gap-3 p-4">
                  <div className="min-w-0 space-y-1 text-right">
                    <p className="text-xs font-medium text-muted-foreground">التحصيل النقدي الفعلي</p>
                    <p className="text-sm font-semibold text-muted-foreground">غير متاح</p>
                    <p className="text-[11px] text-muted-foreground/80">لا يوجد استعلام تحصيل في لوحة التحكم؛ الذمم والمبالغ المتوقعة لا تُعرض كنقد.</p>
                  </div>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-brand-md)] bg-muted text-muted-foreground" aria-hidden="true"><Wallet className="h-5 w-5" /></span>
                </CardContent>
              </Card>
            </div>
          )}
        </SectionCard>
      )}

      {/* ==================== 6. إجراءات سريعة بصلاحيات المستخدم ==================== */}
      {quickActions.length > 0 && (
        <section aria-label="إجراءات سريعة" data-testid="dashboard-quick-actions">
          <h2 className="mb-3 text-sm font-semibold text-foreground">إجراءات سريعة</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            {quickActions.map(a => (
              <Button data-readonly-safe key={a.key} type="button" variant="outline" className="h-16 flex-col gap-1" onClick={() => setLocation(a.path)} data-testid={`quick-${a.key}`}>
                <a.icon className="h-5 w-5" aria-hidden="true" />
                <span className="text-xs">{a.label}</span>
              </Button>
            ))}
          </div>
        </section>
      )}

      {/* أدوات المالك (هادية، تحت) — رسالة للفريق + تهيئة البيانات. نفس الوظائف بالظبط. */}
      {isAdmin && (
        <details className="rounded-[var(--radius-brand-lg)] border border-border bg-card" data-testid="dashboard-owner-tools">
          <summary className="flex min-h-11 cursor-pointer list-none items-center px-5 py-3 text-sm font-semibold text-foreground">
            <span className="inline-flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-primary" aria-hidden="true" /> رسالة للفريق وأدوات
            </span>
          </summary>
          <div className="space-y-3 border-t border-border p-5">
            {activeBroadcast && (
              <div className="rounded-[var(--radius-brand-md)] border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <p className="mb-1 text-xs font-medium text-[var(--warning)]">الرسالة الحالية:</p>
                    <p className="text-sm text-foreground">{activeBroadcast.message}</p>
                    <p className="mt-1 text-xs text-muted-foreground">بواسطة: {activeBroadcast.sentByName} • {new Date(activeBroadcast.createdAt).toLocaleString('ar-EG')}</p>
                  </div>
                  <Button
                    type="button" size="sm" variant="outline"
                    className="min-h-11 shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10 md:min-h-9"
                    onClick={() => clearBroadcastMutation.mutate()}
                    disabled={clearBroadcastMutation.isPending}
                  >
                    حذف
                  </Button>
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <Input
                value={broadcastMsg}
                onChange={e => setBroadcastMsg(e.target.value)}
                placeholder="اكتب رسالة لجميع الموظفين..."
                className="min-h-11 flex-1 md:min-h-9"
                maxLength={500}
                onKeyDown={e => {
                  if (e.key === 'Enter' && broadcastMsg.trim()) {
                    sendBroadcastMutation.mutate({ message: broadcastMsg.trim() });
                  }
                }}
              />
              <Button
                type="button"
                onClick={() => { if (broadcastMsg.trim()) sendBroadcastMutation.mutate({ message: broadcastMsg.trim() }); }}
                disabled={!broadcastMsg.trim() || sendBroadcastMutation.isPending}
                className="min-h-11 shrink-0 md:min-h-9"
              >
                {sendBroadcastMutation.isPending ? 'جاري...' : 'إرسال'}
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <p className="text-xs text-muted-foreground">ستظهر الرسالة لجميع الموظفين في لوحة تحكمهم فورًا.</p>
              <Button
                type="button" variant="ghost" size="sm" className="min-h-11 text-xs text-muted-foreground md:min-h-9"
                onClick={() => seedMutation.mutate()}
                disabled={seedMutation.isPending}
              >
                تهيئة البيانات
              </Button>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
