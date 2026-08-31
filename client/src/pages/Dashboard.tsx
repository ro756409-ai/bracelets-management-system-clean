import { trpc } from "@/lib/trpc";
import * as XLSX from "xlsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { useState, useMemo } from "react";
import {
  ShoppingCart, CheckCircle, XCircle, Clock, Package,
  TrendingUp, Users, AlertTriangle, RefreshCw, GitMerge,
  Phone, MapPin, CheckCircle2, Download, Printer
} from "lucide-react";
import DateRangePicker, { DateRange as PickerRange } from "@/components/DateRangePicker";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { NeedsAttention } from "@/components/dashboard/NeedsAttention";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from "recharts";

const STATUS_LABELS: Record<string, string> = {
  new: "جديد",
  confirmed: "مؤكد",
  postponed: "مؤجل",
  cancelled: "ملغي",
  preparing: "قيد التحضير",
  shipped: "تم الشحن",
  delivered: "تم التوصيل",
};

const STATUS_COLORS: Record<string, string> = {
  new: "#3b82f6",
  confirmed: "#22c55e",
  postponed: "#f59e0b",
  cancelled: "#ef4444",
  preparing: "#a855f7",
  shipped: "#6366f1",
  delivered: "#10b981",
};

const SOURCE_LABELS: Record<string, string> = {
  easyorder: "Easy Order",
  shopify: "Shopify",
  whatsapp: "واتساب",
  manual: "يدوي",
};

function todayRange(): PickerRange {
  const now = new Date();
  const from = new Date(now); from.setHours(0, 0, 0, 0);
  const to = new Date(now); to.setHours(23, 59, 59, 999);
  return { from, to };
}

export default function Dashboard() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [pickerRange, setPickerRange] = useState<PickerRange>(() => todayRange());

  const dateParams = useMemo(() => ({
    dateFrom: pickerRange.from ?? undefined,
    dateTo: pickerRange.to ?? undefined,
  }), [pickerRange]);

  const { currentBusinessIds } = useBusinessContext();
  const isAdmin = user?.role === 'admin';
  const { data: stats, isLoading, refetch } = trpc.reports.dashboard.useQuery({
    ...dateParams,
    businessIds: currentBusinessIds,
  }, {
    enabled: isAdmin,
  });
  const { data: lowStock } = trpc.products.lowStock.useQuery(
    currentBusinessIds && currentBusinessIds.length > 0 ? { businessIds: currentBusinessIds } : undefined,
    { enabled: isAdmin }
  );
  const { data: chartData } = trpc.reports.dailyChart.useQuery({
    days: 14,
    businessIds: currentBusinessIds,
  }, {
    enabled: isAdmin,
  });

  // Merge alert
  const { data: mergeAlert } = trpc.reports.mergeAlert.useQuery(undefined, {
    enabled: isAdmin,
    refetchInterval: 60_000, // refresh every minute
  });

  // مؤكدات اليوم
  const { data: todayConfirmedData, isLoading: todayLoading } = trpc.orders.todayConfirmed.useQuery({
    businessIds: currentBusinessIds,
  }, {
    enabled: isAdmin,
    refetchInterval: 30_000, // refresh every 30 seconds
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

  const totalOrders = stats?.statusStats.reduce((sum, s) => sum + Number(s.count), 0) ?? 0;
  const confirmedOnlyCount = Number(stats?.statusStats.find(s => s.status === 'confirmed')?.count ?? 0);
  const printedCount = Number(stats?.statusStats.find(s => s.status === 'printed')?.count ?? 0);
  const confirmedCount = confirmedOnlyCount + printedCount;
  const cancelledCount = stats?.statusStats.find(s => s.status === 'cancelled')?.count ?? 0;
  const newCount = stats?.statusStats.find(s => s.status === 'new')?.count ?? 0;
  const confirmRate = totalOrders > 0 ? Math.round((Number(confirmedCount) / totalOrders) * 100) : 0;

  const pieData = stats?.statusStats.map(s => ({
    name: STATUS_LABELS[s.status] ?? s.status,
    value: Number(s.count),
    color: STATUS_COLORS[s.status] ?? '#888',
  })) ?? [];

  const barData = chartData?.map(d => ({
    date: d.date,
    total: Number(d.total),
    confirmed: Number(d.confirmed),
    cancelled: Number(d.cancelled),
  })) ?? [];

  return (
    <div className="space-y-6">
      {/* V2 Header — تحية + سياق اليوم. الإجراءات هادية (نطاق زمني + تحديث). */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-foreground">أهلاً {user?.name} 👋</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
            {' — '}ملخص اليوم وأهم ما يحتاج تدخّلك
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker value={pickerRange} onChange={setPickerRange} placeholder="اختر نطاق زمني" />
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="ml-1 h-4 w-4" />
            تحديث
          </Button>
        </div>
      </div>

      {/* V2 — يحتاج انتباهك: أول حاجة، actionable. بيجمّع (تأكيد/مخزون/مكررات) بدل ٣ بانرات
          منفصلة كانت بتزحم أعلى الصفحة — نفس البيانات، مكان واحد يوديك للإجراء. */}
      {isAdmin && (
        <NeedsAttention
          needsConfirmation={Number(newCount) || 0}
          lowStock={lowStock?.length ?? 0}
          duplicates={mergeAlert?.hasAlert ? Number(mergeAlert.count) || 0 : 0}
        />
      )}

      {/* KPIs — ٤ أرقام تشغيلية أساسية بس (بدل ٥ + كروت متفرقة). */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="إجمالي الأوردرات"
          value={totalOrders}
          icon={<ShoppingCart className="h-5 w-5" />}
          color="blue"
          loading={isLoading}
        />
        <StatCard
          title="تم التأكيد"
          value={Number(confirmedCount)}
          icon={<CheckCircle className="h-5 w-5" />}
          color="green"
          subtitle={`${confirmRate}% نسبة التأكيد`}
          loading={isLoading}
        />
        <StatCard
          title="جديدة (لم تُعالج)"
          value={Number(newCount)}
          icon={<Clock className="h-5 w-5" />}
          color="orange"
          loading={isLoading}
        />
        <StatCard
          title="مؤكدات اليوم"
          value={todayConfirmedCount}
          icon={<CheckCircle2 className="h-5 w-5" />}
          color="green"
          subtitle={`${todayTotalRevenue.toLocaleString('ar-EG')} ج.م`}
          loading={todayLoading}
        />
      </div>

      {/* اتجاه ١٤ يوم + أكثر المحافظات — صفّ واحد هادي (بدون pie مكرر). */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">أوردرات آخر 14 يوم</CardTitle>
          </CardHeader>
          <CardContent>
            {barData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={barData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px' }}
                    labelStyle={{ color: 'var(--foreground)' }}
                  />
                  <Bar dataKey="total" name="الإجمالي" fill="var(--chart-4)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="confirmed" name="مؤكد" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="cancelled" name="ملغي" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
                لا توجد بيانات كافية
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">أكثر المحافظات طلبًا</CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.governorateStats && stats.governorateStats.length > 0 ? (
              <div className="space-y-2">
                {stats.governorateStats.slice(0, 5).map((g, i) => {
                  const maxCount = Number(stats.governorateStats[0]?.count ?? 1);
                  const pct = Math.round((Number(g.count) / maxCount) * 100);
                  return (
                    <div key={g.governorate} className="flex items-center gap-3">
                      <span className="w-5 text-xs font-bold text-muted-foreground">{i + 1}</span>
                      <span className="w-24 shrink-0 truncate text-sm font-medium text-foreground">{g.governorate}</span>
                      <div className="h-2 flex-1 rounded-full bg-muted">
                        <div className="h-2 rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-8 text-left text-sm font-bold text-foreground">{Number(g.count)}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
                لا توجد بيانات كافية
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* مؤكدات اليوم */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                <CheckCircle2 className="h-5 w-5 text-[var(--success)]" />
                مؤكدات اليوم
                <span className="bg-[var(--success)]/15 text-[var(--success)] text-xs font-bold px-2 py-0.5 rounded-full">
                  {todayConfirmedCount}
                </span>
                <span className="text-xs text-muted-foreground font-normal">
                  (<span className="text-[var(--success)] font-semibold">{todayConfirmedOrders.filter(o => o.status === 'confirmed').length} مؤكدة</span>
                  {' • '}
                  <span className="text-primary font-semibold">{todayConfirmedOrders.filter(o => o.status === 'printed').length} مطبوعة</span>)
                </span>
              </CardTitle>
              {todayConfirmedCount > 0 && (
                <span className="text-xs font-semibold text-[var(--success)] bg-[var(--success)]/10 border border-[var(--success)]/30 rounded-lg px-2 py-1">
                  إجمالي: {todayTotalRevenue.toLocaleString('ar-EG')} ج.م
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
              </span>
              {todayConfirmedCount > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportTodayConfirmedToExcel}
                  className="h-7 text-xs gap-1 border-[var(--success)]/40 text-[var(--success)] hover:bg-[var(--success)]/10"
                >
                  <Download className="h-3.5 w-3.5" />
                  تصدير Excel
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {todayLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />
              ))}
            </div>
          ) : todayConfirmedOrders.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <CheckCircle2 className="h-10 w-10 mx-auto mb-2 opacity-30" />
              <p className="text-sm">لا توجد أوردرات مؤكدة اليوم حتى الآن</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
              {todayConfirmedOrders.map((order, idx) => (
                <div key={order.id} className="flex items-start gap-3 p-3 rounded-lg border border-[var(--success)]/20 bg-[var(--success)]/10/50 hover:bg-[var(--success)]/10 transition-colors">
                  {/* رقم تسلسلي */}
                  <span className="text-xs font-bold text-[var(--success)] bg-[var(--success)]/15 rounded-full w-6 h-6 flex items-center justify-center shrink-0 mt-0.5">
                    {idx + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-foreground text-sm truncate">{order.customerName}</p>
                      <span className="text-xs font-bold text-[var(--success)] shrink-0">
                        {Number(order.totalAmount).toLocaleString('ar-EG')} ج.م
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Phone className="h-3 w-3" />
                        <span dir="ltr">{order.customerPhone}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {order.governorate}
                      </span>
                    </div>
                    {order.customerAddress && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{order.customerAddress}</p>
                    )}
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-xs text-muted-foreground">{order.productName}</span>
                      <span className="text-xs text-muted-foreground">
                        {order.confirmedAt ? new Date(order.confirmedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : ''}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Button variant="outline" className="h-16 flex-col gap-1" onClick={() => setLocation("/orders")}>
          <ShoppingCart className="h-5 w-5" />
          <span className="text-xs">إضافة أوردر</span>
        </Button>
        <Button variant="outline" className="h-16 flex-col gap-1" onClick={() => setLocation("/workspace")}>
          <Package className="h-5 w-5" />
          <span className="text-xs">مساحة العمل</span>
        </Button>
        <Button variant="outline" className="h-16 flex-col gap-1" onClick={() => setLocation("/reports")}>
          <TrendingUp className="h-5 w-5" />
          <span className="text-xs">التقارير</span>
        </Button>
        <Button variant="outline" className="h-16 flex-col gap-1" onClick={() => setLocation("/employees")}>
          <Users className="h-5 w-5" />
          <span className="text-xs">الموظفين</span>
        </Button>
      </div>

      {/* أدوات المالك (هادية، تحت) — رسالة للفريق + تهيئة البيانات. اتنقلت من أعلى الصفحة
          لتقليل الزحام؛ نفس الوظائف بالظبط، مكان أقل بروزًا. */}
      {isAdmin && (
        <details className="rounded-[var(--radius-brand-lg)] border border-border bg-card">
          <summary className="cursor-pointer list-none px-5 py-3 text-sm font-semibold text-foreground">
            <span className="inline-flex items-center gap-2">
              <span className="text-base">📢</span> رسالة للفريق وأدوات
            </span>
          </summary>
          <div className="space-y-3 border-t border-border p-5">
            {activeBroadcast && (
              <div className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <p className="mb-1 text-xs font-medium text-[var(--warning)]">الرسالة الحالية:</p>
                    <p className="text-sm text-foreground">{activeBroadcast.message}</p>
                    <p className="mt-1 text-xs text-muted-foreground">بواسطة: {activeBroadcast.sentByName} • {new Date(activeBroadcast.createdAt).toLocaleString('ar-EG')}</p>
                  </div>
                  <Button
                    size="sm" variant="outline"
                    className="shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10"
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
                className="flex-1"
                maxLength={500}
                onKeyDown={e => {
                  if (e.key === 'Enter' && broadcastMsg.trim()) {
                    sendBroadcastMutation.mutate({ message: broadcastMsg.trim() });
                  }
                }}
              />
              <Button
                onClick={() => { if (broadcastMsg.trim()) sendBroadcastMutation.mutate({ message: broadcastMsg.trim() }); }}
                disabled={!broadcastMsg.trim() || sendBroadcastMutation.isPending}
                className="shrink-0"
              >
                {sendBroadcastMutation.isPending ? 'جاري...' : 'إرسال'}
              </Button>
            </div>
            <div className="flex items-center justify-between pt-1">
              <p className="text-xs text-muted-foreground">ستظهر الرسالة لجميع الموظفين في لوحة تحكمهم فورًا.</p>
              <Button
                variant="ghost" size="sm" className="text-xs text-muted-foreground"
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

function StatCard({
  title, value, icon, color, subtitle, loading
}: {
  title: string;
  value: number;
  icon: React.ReactNode;
  color: "blue" | "green" | "red" | "orange" | "purple";
  subtitle?: string;
  loading?: boolean;
}) {
  // Tokens already carry their own dark-mode values (see :root vs .dark in index.css),
  // so a single class list works in both themes without a `dark:` override.
  const colorMap = {
    blue: "bg-[var(--info)]/10 text-[var(--info)]",
    green: "bg-[var(--success)]/10 text-[var(--success)]",
    red: "bg-destructive/10 text-destructive",
    orange: "bg-[var(--warning)]/10 text-[var(--warning)]",
    purple: "bg-accent text-accent-foreground",
  };

  return (
    <Card className="transition-all hover:shadow-md">
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">{title}</p>
            {loading ? (
              <div className="h-8 w-16 bg-muted animate-pulse rounded" />
            ) : (
              <p className="text-2xl font-bold text-foreground">{value.toLocaleString('ar-EG')}</p>
            )}
            {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
          </div>
          <div className={`p-2 rounded-xl ${colorMap[color]}`}>
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
