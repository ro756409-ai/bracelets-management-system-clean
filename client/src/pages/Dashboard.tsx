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
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">لوحة التحكم</h1>
          <p className="text-muted-foreground text-sm mt-1">
            أهلاً {user?.name}، هذا ملخص أداء اليوم
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <DateRangePicker
            value={pickerRange}
            onChange={setPickerRange}
            placeholder="اختر نطاق زمني"
          />
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 ml-1" />
            تحديث
          </Button>
          {user?.role === 'admin' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => seedMutation.mutate()}
              disabled={seedMutation.isPending}
            >
              تهيئة البيانات
            </Button>
          )}
        </div>
      </div>

      {/* Merge Alert */}
      {mergeAlert?.hasAlert && (
        <div className="bg-[var(--warning)]/10 border border-[var(--warning)]/30 rounded-xl p-4 flex items-center gap-3">
          <GitMerge className="h-5 w-5 text-[var(--warning)] shrink-0" />
          <div className="flex-1">
            <p className="font-semibold text-[var(--warning)] text-sm">
              تم دمج {mergeAlert.count} أوردر مكرر تلقائياً في آخر 24 ساعة
            </p>
            <p className="text-xs text-[var(--warning)]/80 mt-0.5">
              إجمالي الكميات المدمجة: {mergeAlert.totalMergedQty} وحدة
            </p>
          </div>
          <Button variant="outline" size="sm" className="border-[var(--warning)]/40 text-[var(--warning)] hover:bg-[var(--warning)]/15" onClick={() => setLocation("/merge-logs")}>
            عرض التقرير
          </Button>
        </div>
      )}

      {/* Low Stock Alert */}
      {lowStock && lowStock.length > 0 && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
          <div className="flex-1">
            <p className="font-semibold text-destructive text-sm">تنبيه: مخزون منخفض</p>
            <p className="text-xs text-destructive/80 mt-0.5">
              {lowStock.map(p => p.name).join(" • ")}
            </p>
          </div>
          <Button variant="destructive" size="sm" onClick={() => setLocation("/inventory")}>
            عرض المخزون
          </Button>
        </div>
      )}

      {/* Broadcast Message Section */}
      {isAdmin && (
        <Card className="border-[var(--warning)]/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <span className="text-lg">📢</span>
              إرسال رسالة لجميع الموظفين
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {activeBroadcast && (
              <div className="bg-[var(--warning)]/10 border border-[var(--warning)]/40 rounded-lg p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <p className="text-xs text-[var(--warning)] font-medium mb-1">الرسالة الحالية:</p>
                    <p className="text-sm text-foreground">{activeBroadcast.message}</p>
                    <p className="text-xs text-muted-foreground mt-1">بواسطة: {activeBroadcast.sentByName} • {new Date(activeBroadcast.createdAt).toLocaleString('ar-EG')}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive border-destructive/30 hover:bg-destructive/10 shrink-0"
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
                onClick={() => {
                  if (broadcastMsg.trim()) {
                    sendBroadcastMutation.mutate({ message: broadcastMsg.trim() });
                  }
                }}
                disabled={!broadcastMsg.trim() || sendBroadcastMutation.isPending}
                className="bg-[var(--warning)] hover:bg-[var(--warning)] text-white shrink-0"
              >
                {sendBroadcastMutation.isPending ? 'جاري...' : 'إرسال'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">ستظهر الرسالة لجميع الموظفين في لوحة تحكمهم فوراً</p>
          </CardContent>
        </Card>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard
          title="إجمالي الأوردرات"
          value={totalOrders}
          icon={<ShoppingCart className="h-5 w-5" />}
          color="blue"
          loading={isLoading}
        />
        <StatCard
          title="مؤكدة (لم تُطبع)"
          value={confirmedOnlyCount}
          icon={<CheckCircle className="h-5 w-5" />}
          color="green"
          subtitle={`${confirmRate}% نسبة التأكيد`}
          loading={isLoading}
        />
        <StatCard
          title="مطبوعة"
          value={printedCount}
          icon={<Printer className="h-5 w-5" />}
          color="purple"
          loading={isLoading}
        />
        <StatCard
          title="ملغية"
          value={Number(cancelledCount)}
          icon={<XCircle className="h-5 w-5" />}
          color="red"
          loading={isLoading}
        />
        <StatCard
          title="جديدة (لم تُعالج)"
          value={Number(newCount)}
          icon={<Clock className="h-5 w-5" />}
          color="orange"
          loading={isLoading}
        />
      </div>

      {/* Revenue & Extra Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">الإيرادات (مُسلَّم)</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-foreground">
              {stats?.totalRevenue ? `${Number(stats.totalRevenue).toLocaleString('ar-EG')} ج.م` : '0 ج.م'}
            </p>
            <p className="text-xs text-muted-foreground mt-1">من الأوردرات المُسلَّمة</p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">مصادر الأوردرات</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {stats?.sourceStats.map(s => (
                <div key={s.source} className="flex items-center gap-2 bg-muted rounded-lg px-3 py-2">
                  <span className="text-sm font-semibold text-foreground">{Number(s.count)}</span>
                  <span className="text-xs text-muted-foreground">{SOURCE_LABELS[s.source] ?? s.source}</span>
                </div>
              ))}
              {(!stats?.sourceStats || stats.sourceStats.length === 0) && (
                <p className="text-sm text-muted-foreground">لا توجد بيانات</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bar Chart - Daily Orders */}
        <Card>
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
              <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">
                لا توجد بيانات كافية
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pie Chart - Status Distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">توزيع حالات الأوردرات</CardTitle>
          </CardHeader>
          <CardContent>
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={90}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={index} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px' }}
                  />
                  <Legend
                    formatter={(value) => <span style={{ fontSize: '12px', color: 'var(--foreground)' }}>{value}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">
                لا توجد بيانات كافية
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Top Governorates */}
      {stats?.governorateStats && stats.governorateStats.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">أكثر المحافظات طلباً</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {stats.governorateStats.slice(0, 5).map((g, i) => {
                const maxCount = Number(stats.governorateStats[0]?.count ?? 1);
                const pct = Math.round((Number(g.count) / maxCount) * 100);
                return (
                  <div key={g.governorate} className="flex items-center gap-3">
                    <span className="text-xs font-bold text-muted-foreground w-5">{i + 1}</span>
                    <span className="text-sm font-medium text-foreground w-28 shrink-0">{g.governorate}</span>
                    <div className="flex-1 bg-muted rounded-full h-2">
                      <div
                        className="h-2 rounded-full bg-primary transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-sm font-bold text-foreground w-10 text-left">{Number(g.count)}</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

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
