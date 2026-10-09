import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { BrandMark } from "@/components/BrandMark";
import {
  PageHeader, SectionCard, StatCard, StatusBadge, ResponsiveDataTable, SearchInput,
  EmptyState, ErrorState, LoadingSkeleton, OfflineState, type Column, type StatusTone,
} from "@/components/shared";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { toast } from "sonner";
import { useOperationalOptions } from "@/hooks/useOperationalOptions";
import { useGovernorateOptions } from "@/hooks/useGovernorateOptions";
import {
  LayoutDashboard, ShoppingCart, Package, BarChart3, Users,
  LogOut, Plus, CheckCircle2, XCircle, Clock, Sparkles,
  Phone, MapPin, ChevronDown, ChevronUp, AlertTriangle,
  UserPlus, Key, Menu, X, Eye, EyeOff,
  FileText, Calendar, User, Megaphone, ArrowLeftRight } from "lucide-react";

/**
 * بوابة المدير (/manager-dashboard) — طبقة العرض فقط على نظام التصميم المشترك (Copper Signature × Clean Spatial).
 * نفس الـhooks بنفس الترتيب ونفس الـpayloads؛ لا تغيير في الصلاحيات أو منطق العمل.
 */

/** عرض فقط: تسمية ونغمة كل حالة أوردر (canAct لا يعتمد على هذه الخريطة). */
const STATUS_CONFIG: Record<string, { label: string; tone: StatusTone }> = {
  new:       { label: "جديد",         tone: "info" },
  confirmed: { label: "مؤكد",         tone: "success" },
  no_answer: { label: "لم يرد",       tone: "amber" },
  postponed: { label: "مؤجل",         tone: "warning" },
  cancelled: { label: "ملغي",         tone: "danger" },
  preparing: { label: "جاري التجهيز", tone: "info" },
  shipped:   { label: "تم الشحن",     tone: "info" },
  delivered: { label: "تم التسليم",   tone: "success" },
};

const ROLE_LABELS: Record<string, string> = {
  agent: "موظف خدمة عملاء",
  warehouse: "مخزن",
  manager: "مدير",
};

type TabKey = "dashboard" | "orders" | "inventory" | "reports" | "employees" | "tasks";

export default function ManagerDashboard() {
  const { values: GOVERNORATES } = useGovernorateOptions();
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<TabKey>("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Check employee session
  const empSession = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("employee_session") || "null"); } catch { return null; }
  }, []);

  useEffect(() => {
    if (!empSession || empSession.role !== 'manager') {
      setLocation("/employee-login");
    }
  }, [empSession]);

  const { data: meData, error: meError } = trpc.employeePortal.me.useQuery(undefined, { retry: false });

  useEffect(() => {
    if (meError) {
      localStorage.removeItem("employee_session");
      setLocation("/employee-login");
    }
  }, [meError]);

  // Redirect non-managers
  useEffect(() => {
    if (meData && meData.role !== 'manager') {
      setLocation("/employee-dashboard");
    }
  }, [meData]);

  const handleLogout = async () => {
    await fetch("/api/employee/logout", { method: "POST", credentials: "include" });
    localStorage.removeItem("employee_session");
    setLocation("/employee-login");
  };

  const managerName = meData?.name ?? empSession?.name ?? "المدير";

  const tabs: { key: TabKey; label: string; icon: any }[] = [
    { key: "dashboard", label: "لوحة التحكم", icon: LayoutDashboard },
    { key: "orders", label: "الأوردرات", icon: ShoppingCart },
    { key: "inventory", label: "المخزون", icon: Package },
    { key: "reports", label: "التقارير", icon: BarChart3 },
    { key: "employees", label: "الموظفين", icon: Users },
    { key: "tasks", label: "توزيع المهام", icon: FileText },
  ];

  // بوابة الدور (عرض فقط): لا نرسم محتوى التبويبات — ولا تنطلق استعلاماتها — إلا بعد تأكيد أن الجلسة
  // لمدير من البيانات الموجودة أصلًا (الجلسة المحلية + me). التوجيهات أعلاه كما هي.
  const isManagerSession =
    empSession?.role === "manager" && !meError && (!meData || meData.role === "manager");

  if (!isManagerSession) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4" dir="rtl">
        <LoadingSkeleton variant="form" rows={2} className="w-full max-w-sm" />
      </div>
    );
  }

  const navItemCls = (isActive: boolean) =>
    cn(
      "w-full justify-start gap-3 rounded-[var(--radius-brand-md)] px-3 text-sm font-medium",
      isActive
        ? "bg-sidebar-accent text-sidebar-primary hover:bg-sidebar-accent hover:text-sidebar-primary"
        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
    );

  return (
    <div className="min-h-screen bg-background flex" dir="rtl">
      {/* Sidebar - Desktop */}
      <aside className="hidden md:flex flex-col w-64 bg-sidebar text-sidebar-foreground min-h-screen sticky top-0 h-screen">
        <div className="p-4 border-b border-sidebar-border">
          <div className="flex items-center gap-3">
            <BrandMark className="w-10 h-10" />
            <div>
              <p className="font-bold text-sm">متجرك</p>
              <p className="text-sidebar-foreground/70 text-xs">لوحة تحكم المدير</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1" aria-label="أقسام بوابة المدير">
          {tabs.map(tab => {
            const isActive = activeTab === tab.key;
            return (
              <Button
                key={tab.key}
                type="button"
                variant="ghost"
                className={`min-h-11 md:min-h-10 ${navItemCls(isActive)}`}
                aria-current={isActive ? "page" : undefined}
                onClick={() => setActiveTab(tab.key)}
              >
                <tab.icon className="h-4 w-4" aria-hidden="true" />
                {tab.label}
              </Button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-sidebar-border">
          <div className="flex items-center gap-3 px-2 py-1">
            <div className="w-8 h-8 rounded-full bg-sidebar-accent flex items-center justify-center text-sidebar-primary text-sm font-bold" aria-hidden="true">
              {managerName.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sidebar-foreground truncate">{managerName}</p>
              <p className="text-xs text-sidebar-foreground/60">مدير</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11 md:min-h-9 md:min-w-9 text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-destructive"
              onClick={handleLogout}
              aria-label="تسجيل الخروج"
              title="تسجيل الخروج"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </aside>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-foreground/50" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
          <aside className="absolute right-0 top-0 bottom-0 w-64 bg-sidebar text-sidebar-foreground flex flex-col shadow-[var(--shadow-card)]" aria-label="القائمة">
            <div className="p-4 border-b border-sidebar-border flex items-center justify-between">
              <div className="flex items-center gap-3">
                <BrandMark className="w-7 h-7" />
                <p className="font-bold text-sm">متجرك</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11 text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                onClick={() => setSidebarOpen(false)}
                aria-label="إغلاق القائمة"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </Button>
            </div>
            <nav className="flex-1 p-3 space-y-1" aria-label="أقسام بوابة المدير">
              {tabs.map(tab => {
                const isActive = activeTab === tab.key;
                return (
                  <Button
                    key={tab.key}
                    type="button"
                    variant="ghost"
                    className={`min-h-11 ${navItemCls(isActive)}`}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => { setActiveTab(tab.key); setSidebarOpen(false); }}
                  >
                    <tab.icon className="h-4 w-4" aria-hidden="true" />
                    {tab.label}
                  </Button>
                );
              })}
            </nav>
            <div className="p-3 border-t border-sidebar-border">
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 w-full justify-start gap-2 px-3 text-sm text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={handleLogout}
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                تسجيل الخروج
              </Button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 min-w-0">
        {/* Mobile Header */}
        <header className="md:hidden sticky top-0 z-40 shadow-[var(--shadow-card)]" style={{ background: "linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 100%)" }}>
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <div className="flex min-w-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
                onClick={() => setSidebarOpen(true)}
                aria-label="فتح القائمة"
                aria-expanded={sidebarOpen}
              >
                <Menu className="h-5 w-5" aria-hidden="true" />
              </Button>
              <p className="truncate text-primary-foreground font-bold text-sm">{tabs.find(t => t.key === activeTab)?.label}</p>
            </div>
            <p className="truncate px-2 text-primary-foreground/80 text-xs">أهلاً، {managerName}</p>
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl p-4 md:p-6">
          {activeTab === "dashboard" && <ManagerDashboardTab />}
          {activeTab === "orders" && <ManagerOrdersTab />}
          {activeTab === "inventory" && <ManagerInventoryTab />}
          {activeTab === "reports" && <ManagerReportsTab />}
          {activeTab === "employees" && <ManagerEmployeesTab />}
          {activeTab === "tasks" && <ManagerTasksTab />}
        </main>
      </div>
    </div>
  );
}

// ==================== DASHBOARD TAB ====================
function ManagerDashboardTab() {
  const online = useOnlineStatus();
  const [dateRange] = useState<"today" | "week" | "month">("month");
  const [broadcastMsg, setBroadcastMsg] = useState("");
  const utils = trpc.useUtils();

  const { data: activeBroadcast } = trpc.employeePortal.activeBroadcast.useQuery();

  const sendBroadcastMutation = trpc.employeePortal.sendBroadcast.useMutation({
    onSuccess: () => {
      toast.success("تم إرسال الرسالة لجميع الموظفين");
      setBroadcastMsg("");
      utils.employeePortal.activeBroadcast.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const clearBroadcastMutation = trpc.employeePortal.clearBroadcast.useMutation({
    onSuccess: () => {
      toast.success("تم حذف الرسالة");
      utils.employeePortal.activeBroadcast.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const dateParams = useMemo(() => {
    const now = new Date();
    const from = new Date();
    if (dateRange === "today") from.setHours(0, 0, 0, 0);
    else if (dateRange === "week") from.setDate(now.getDate() - 7);
    else from.setMonth(now.getMonth() - 1);
    return { dateFrom: from, dateTo: now };
  }, [dateRange]);

  const { data: stats, isLoading: statsLoading, error: statsError, refetch: refetchStats } = trpc.employeePortal.dashboardStats.useQuery(dateParams);
  const { data: lowStock } = trpc.employeePortal.lowStockProducts.useQuery();
  const { data: dailyChart } = trpc.employeePortal.dailyChart.useQuery({ days: 30 });

  const lowStockCount = lowStock?.length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader title="لوحة التحكم" description="ملخص أوردرات آخر شهر، رسالة الفريق وتنبيهات المخزون." />

      {!online && <OfflineState onRetry={() => refetchStats()} className="py-6" />}

      {/* Stats Cards */}
      {statsError ? (
        <ErrorState message="تعذّر تحميل إحصائيات الأوردرات." onRetry={() => refetchStats()} />
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          <StatCard label="إجمالي الأوردرات" value={stats?.statusStats?.reduce((s: number, x: any) => s + Number(x.count), 0) ?? 0} tone="default" icon={<ShoppingCart className="h-5 w-5" aria-hidden="true" />} loading={statsLoading} />
          <StatCard label="أوردرات جديدة" value={Number(stats?.statusStats?.find((s: any) => s.status === 'new')?.count ?? 0)} tone="info" icon={<Sparkles className="h-5 w-5" aria-hidden="true" />} loading={statsLoading} />
          <StatCard label="مؤكدة" value={Number(stats?.statusStats?.find((s: any) => s.status === 'confirmed')?.count ?? 0)} tone="success" icon={<CheckCircle2 className="h-5 w-5" aria-hidden="true" />} loading={statsLoading} />
          <StatCard label="ملغية" value={Number(stats?.statusStats?.find((s: any) => s.status === 'cancelled')?.count ?? 0)} tone="danger" icon={<XCircle className="h-5 w-5" aria-hidden="true" />} loading={statsLoading} />
        </div>
      )}

      {/* Broadcast Message Section */}
      <SectionCard
        title="إرسال رسالة لجميع الموظفين"
        description="ستظهر الرسالة كإشعار لجميع الموظفين في لوحة تحكمهم."
        icon={
          <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-brand-md)] bg-accent" aria-hidden="true">
            <Megaphone className="h-4 w-4 text-accent-foreground" />
          </span>
        }
        testId="manager-broadcast"
      >
        <div className="space-y-3">
          {activeBroadcast && (
            <div className="relative overflow-hidden rounded-[var(--radius-brand-md)] border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-3">
              <div className="absolute top-0 left-0 w-1 h-full bg-[var(--warning)]" aria-hidden="true" />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-[var(--warning)] font-bold mb-1">الرسالة الحالية:</p>
                  <p className="text-sm text-foreground leading-relaxed break-words">{activeBroadcast.message}</p>
                  <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-muted-foreground">
                    <span className="font-medium text-[var(--warning)]">{activeBroadcast.sentByName}</span>
                    <span aria-hidden="true">•</span>
                    <span>{new Date(activeBroadcast.createdAt).toLocaleString('ar-EG')}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-11 md:min-h-9 text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive shrink-0"
                  onClick={() => clearBroadcastMutation.mutate()}
                  disabled={clearBroadcastMutation.isPending}
                >
                  حذف
                </Button>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={broadcastMsg}
              onChange={e => setBroadcastMsg(e.target.value)}
              placeholder="اكتب رسالة لجميع الموظفين..."
              aria-label="نص الرسالة لجميع الموظفين"
              className="min-h-11 md:min-h-9 flex-1"
              maxLength={500}
              onKeyDown={e => {
                if (e.key === 'Enter' && broadcastMsg.trim() && !sendBroadcastMutation.isPending) {
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
              className="min-h-11 md:min-h-9 bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
            >
              {sendBroadcastMutation.isPending ? 'جاري...' : 'إرسال'}
            </Button>
          </div>
        </div>
      </SectionCard>

      {/* Low Stock Alert */}
      {lowStockCount > 0 && (
        <SectionCard
          className="border-destructive/30 bg-destructive/5"
          title={<span className="text-destructive">تنبيه نقص المخزون ({lowStockCount} صنف)</span>}
          icon={<AlertTriangle className="h-5 w-5 text-destructive" aria-hidden="true" />}
          testId="manager-low-stock"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {lowStock?.map((p: any) => (
              <div key={p.id} className="flex items-center justify-between gap-2 rounded-[var(--radius-brand-md)] border border-destructive/20 bg-card px-3 py-2">
                <span className="min-w-0 truncate text-sm font-medium text-foreground">{p.name}</span>
                <span className="shrink-0 text-sm font-bold tabular-nums text-destructive" dir="ltr">{p.currentStock} / {p.minStockLevel}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Daily Chart */}
      {dailyChart && dailyChart.length > 0 && (
        <SectionCard title="الأوردرات اليومية (آخر 30 يوم)" testId="manager-daily-chart">
          <div className="flex items-end gap-1 h-40 overflow-x-auto" role="img" aria-label="عدد الأوردرات اليومية لآخر 30 يوم">
            {/* `getDailyOrdersChart` بيرجّع `total` (مش `count`) — القراءة القديمة كانت بتعرض «NaN» وأعمدة مسطّحة. */}
            {dailyChart.map((d: any, i: number) => {
              const maxVal = Math.max(...dailyChart.map((x: any) => Number(x.total) || 0), 1);
              const total = Number(d.total) || 0;
              const height = (total / maxVal) * 100;
              return (
                <div key={i} className="flex h-full flex-col items-center justify-end flex-shrink-0" style={{ width: "20px" }}>
                  <span className="text-[10px] text-muted-foreground mb-1 tabular-nums">{total}</span>
                  <div
                    className="w-3 rounded-t bg-primary/80"
                    style={{ height: `${Math.max(height, 4)}%` }}
                  />
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ==================== ORDERS TAB ====================
function ManagerOrdersTab() {
  const online = useOnlineStatus();
  const { values: GOVERNORATES } = useGovernorateOptions();
  const statusOptions = useOperationalOptions("order_status").options;
  const cancelReasonOptions = useOperationalOptions("cancellation_reason").options;
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [govFilter, setGovFilter] = useState<string>("all");
  const [groupFilter, setGroupFilter] = useState<string>("all");
  const [selectedOrders, setSelectedOrders] = useState<number[]>([]);
  const [expandedOrder, setExpandedOrder] = useState<number | null>(null);

  // Dialogs
  const [assignDialog, setAssignDialog] = useState(false);
  const [assignEmployeeId, setAssignEmployeeId] = useState<string>("");
  const [postponeDialog, setPostponeDialog] = useState<{ open: boolean; orderId: number | null }>({ open: false, orderId: null });
  const [cancelDialog, setCancelDialog] = useState<{ open: boolean; orderId: number | null }>({ open: false, orderId: null });
  const [postponeDate, setPostponeDate] = useState("");
  const [postponeNotes, setPostponeNotes] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelNotes, setCancelNotes] = useState("");

  const utils = trpc.useUtils();

  const { data: groupsList } = trpc.businesses.groupsWithBusinesses.useQuery();
  const selectedGroupBusinessIds = useMemo(() => {
    if (groupFilter === "all") return undefined;
    const group = (groupsList ?? []).find((g: any) => String(g.id) === groupFilter);
    return group ? group.businesses.map((b: any) => b.id) : undefined;
  }, [groupFilter, groupsList]);
  const { data: ordersData, isLoading, error: ordersError, refetch: refetchOrders } = trpc.employeePortal.allOrders.useQuery({
    status: statusFilter === "all" ? undefined : statusFilter,
    governorate: govFilter === "all" ? undefined : govFilter,
    businessIds: selectedGroupBusinessIds,
    search: search || undefined,
    limit: 200,
  });

  const { data: employeesList } = trpc.employeePortal.activeEmployeesList.useQuery();

  const assignMutation = trpc.employeePortal.assignOrder.useMutation({
    onSuccess: () => {
      toast.success("تم التوزيع بنجاح");
      utils.employeePortal.allOrders.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const bulkAssignMutation = trpc.employeePortal.bulkAssignOrders.useMutation({
    onSuccess: () => {
      toast.success("تم توزيع الأوردرات بنجاح");
      setSelectedOrders([]);
      setAssignDialog(false);
      utils.employeePortal.allOrders.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const confirmMutation = trpc.employeePortal.confirm.useMutation({
    onSuccess: () => {
      toast.success("تم تأكيد الأوردر");
      utils.employeePortal.allOrders.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const postponeMutation = trpc.employeePortal.postpone.useMutation({
    onSuccess: () => {
      toast.success("تم تأجيل الأوردر");
      setPostponeDialog({ open: false, orderId: null });
      utils.employeePortal.allOrders.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const cancelMutation = trpc.employeePortal.cancel.useMutation({
    onSuccess: () => {
      toast.success("تم إلغاء الأوردر");
      setCancelDialog({ open: false, orderId: null });
      utils.employeePortal.allOrders.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const orders = ordersData?.orders ?? [];
  const agents = (employeesList ?? []).filter((e: any) => e.role === 'agent' && e.isActive);

  const toggleSelect = (id: number) => {
    setSelectedOrders(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleSelectAll = () => {
    const newOrders = orders.filter((o: any) => o.status === 'new');
    if (selectedOrders.length === newOrders.length) {
      setSelectedOrders([]);
    } else {
      setSelectedOrders(newOrders.map((o: any) => o.id));
    }
  };

  const handleBulkAssign = () => {
    if (!assignEmployeeId) { toast.error("اختر الموظف أولاً"); return; }
    bulkAssignMutation.mutate({
      orderIds: selectedOrders,
      employeeId: parseInt(assignEmployeeId),
    });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="الأوردرات"
        description="كل أوردرات الفريق: فلترة، توزيع على الموظفين، وتأكيد أو تأجيل أو إلغاء."
        primaryAction={selectedOrders.length > 0 ? (
          <Button onClick={() => setAssignDialog(true)} className="min-h-11 md:min-h-9 bg-primary hover:bg-primary/90 text-primary-foreground">
            <Users className="h-4 w-4 ml-2" aria-hidden="true" />
            توزيع {selectedOrders.length} أوردر
          </Button>
        ) : undefined}
      />

      {!online && <OfflineState onRetry={() => refetchOrders()} className="py-6" />}

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        <SearchInput
          value={search}
          onChange={setSearch}
          debounceMs={0}
          placeholder="بحث بالاسم أو الهاتف أو رقم الأوردر..."
          className="flex-1 sm:min-w-[200px] [&_input]:bg-card"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="min-h-11 md:min-h-9 w-full sm:w-[140px] bg-card" aria-label="فلترة بالحالة"><SelectValue placeholder="الحالة" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل الحالات</SelectItem>
            {statusOptions.map(option => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={govFilter} onValueChange={setGovFilter}>
          <SelectTrigger className="min-h-11 md:min-h-9 w-full sm:w-[140px] bg-card" aria-label="فلترة بالمحافظة"><SelectValue placeholder="المحافظة" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل المحافظات</SelectItem>
            {GOVERNORATES.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={groupFilter} onValueChange={setGroupFilter}>
          <SelectTrigger className="min-h-11 md:min-h-9 w-full sm:w-[160px] bg-card" aria-label="فلترة بالقسم"><SelectValue placeholder="القسم" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل الأقسام</SelectItem>
            {(groupsList ?? []).map((g: any) => <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Select All for new orders */}
      {orders.some((o: any) => o.status === 'new') && (
        <label className="flex w-fit min-h-11 md:min-h-9 cursor-pointer items-center gap-2">
          <Checkbox
            checked={selectedOrders.length > 0 && selectedOrders.length === orders.filter((o: any) => o.status === 'new').length}
            onCheckedChange={toggleSelectAll}
          />
          <span className="text-sm text-muted-foreground">تحديد كل الأوردرات الجديدة</span>
        </label>
      )}

      {/* Orders List */}
      {ordersError ? (
        <ErrorState message="تعذّر تحميل الأوردرات." onRetry={() => refetchOrders()} />
      ) : isLoading ? (
        <LoadingSkeleton variant="table" rows={4} />
      ) : orders.length === 0 ? (
        <EmptyState
          icon={<ShoppingCart className="h-7 w-7" />}
          title="لا توجد أوردرات"
          description="غيّر الفلاتر أو البحث لعرض أوردرات أخرى."
        />
      ) : (
        <div className="space-y-2">
          {orders.map((order: any) => {
            const statusConf = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.new;
            const isExpanded = expandedOrder === order.id;
            const canAct = order.status === "new" || order.status === "postponed";
            const isSelected = selectedOrders.includes(order.id);
            const toggleExpanded = () => setExpandedOrder(isExpanded ? null : order.id);

            return (
              <div key={order.id} className={cn("overflow-hidden rounded-[var(--radius-brand-md)] border border-border bg-card shadow-[var(--shadow-card)]", isSelected && "ring-2 ring-primary")}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  className="cursor-pointer p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={toggleExpanded}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpanded(); }
                  }}
                >
                  <div className="flex items-start gap-3">
                    {order.status === 'new' && (
                      <label
                        className="-m-2 flex min-h-11 min-w-11 shrink-0 cursor-pointer items-start justify-center pt-3 md:m-0 md:min-h-0 md:min-w-0 md:pt-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleSelect(order.id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`تحديد الأوردر ${order.orderNumber}`}
                        />
                      </label>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-foreground">{order.customerName}</span>
                        <StatusBadge status={order.status} label={statusConf.label} tone={statusConf.tone} size="sm" />
                        {order.assignedEmployeeId && (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                            <User className="h-3 w-3" aria-hidden="true" />
                            {(employeesList ?? []).find((e: any) => e.id === order.assignedEmployeeId)?.name ?? "—"}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" aria-hidden="true" /><span dir="ltr">{order.customerPhone}</span></span>
                        <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" aria-hidden="true" />{order.governorate}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-sm">
                        <span className="text-muted-foreground"><Package className="h-3.5 w-3.5 inline ml-1" aria-hidden="true" />{order.productName}</span>
                        <span className="font-semibold tabular-nums text-primary">{Number(order.totalAmount).toLocaleString()} ج.م</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="text-xs text-muted-foreground font-mono">{order.orderNumber}</span>
                      {isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-border bg-muted/40 px-4 py-3 space-y-3">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">العنوان</p>
                      <p className="text-sm text-foreground">{order.customerAddress}</p>
                    </div>
                    {order.notes && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">ملاحظات</p>
                        <p className="text-sm text-foreground bg-[var(--warning)]/10 border border-[var(--warning)]/20 rounded-[var(--radius-brand-md)] px-3 py-2">{order.notes}</p>
                      </div>
                    )}

                    {/* Assign to employee */}
                    {order.status === 'new' && !order.assignedEmployeeId && (
                      <div className="flex items-center gap-2">
                        <Select onValueChange={(val) => {
                          assignMutation.mutate({ orderId: order.id, employeeId: parseInt(val) });
                        }}>
                          <SelectTrigger className="min-h-11 md:min-h-9 w-full flex-1 bg-card" aria-label="توزيع على موظف"><SelectValue placeholder="توزيع على موظف..." /></SelectTrigger>
                          <SelectContent>
                            {agents.map((emp: any) => (
                              <SelectItem key={emp.id} value={emp.id.toString()}>{emp.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {canAct && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button size="sm" className="min-h-11 md:min-h-9 flex-1 bg-[var(--success)] hover:bg-[var(--success)]/90 text-primary-foreground" onClick={() => confirmMutation.mutate({ orderId: order.id })} disabled={confirmMutation.isPending}>
                          <CheckCircle2 className="h-4 w-4 ml-1" aria-hidden="true" />تأكيد
                        </Button>
                        <Button size="sm" variant="outline" className="min-h-11 md:min-h-9 flex-1 border-[var(--warning)]/40 text-[var(--warning)] hover:bg-[var(--warning)]/10 hover:text-[var(--warning)]" onClick={() => { setPostponeDialog({ open: true, orderId: order.id }); setPostponeDate(""); setPostponeNotes(""); }}>
                          <Clock className="h-4 w-4 ml-1" aria-hidden="true" />تأجيل
                        </Button>
                        <Button size="sm" variant="outline" className="min-h-11 md:min-h-9 flex-1 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => { setCancelDialog({ open: true, orderId: order.id }); setCancelReason(""); setCancelNotes(""); }}>
                          <XCircle className="h-4 w-4 ml-1" aria-hidden="true" />إلغاء
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Bulk Assign Dialog */}
      <Dialog open={assignDialog} onOpenChange={setAssignDialog}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle>توزيع {selectedOrders.length} أوردر</DialogTitle>
            <DialogDescription>اختر موظف خدمة العملاء الذي ستُسند إليه الأوردرات المحددة.</DialogDescription>
          </DialogHeader>
          <div>
            <Label>اختر الموظف</Label>
            <Select value={assignEmployeeId} onValueChange={setAssignEmployeeId}>
              <SelectTrigger className="min-h-11 md:min-h-9 mt-1 w-full"><SelectValue placeholder="اختر موظف..." /></SelectTrigger>
              <SelectContent>
                {agents.map((emp: any) => (
                  <SelectItem key={emp.id} value={emp.id.toString()}>{emp.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={() => setAssignDialog(false)}>إلغاء</Button>
            <Button onClick={handleBulkAssign} disabled={bulkAssignMutation.isPending} className="min-h-11 md:min-h-9 bg-primary hover:bg-primary/90 text-primary-foreground">
              {bulkAssignMutation.isPending ? "جاري..." : "توزيع"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Postpone Dialog */}
      <Dialog open={postponeDialog.open} onOpenChange={open => setPostponeDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Clock className="h-5 w-5 text-[var(--warning)]" aria-hidden="true" />تأجيل الأوردر</DialogTitle>
            <DialogDescription>حدّد موعد الاتصال بالعميل مرة أخرى.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>تاريخ الاتصال مرة أخرى <span className="text-destructive">*</span></Label>
              <Input type="date" value={postponeDate} onChange={e => setPostponeDate(e.target.value)} min={new Date().toISOString().split("T")[0]} className="min-h-11 md:min-h-9 mt-1" />
            </div>
            <div>
              <Label>ملاحظة (اختياري)</Label>
              <Input value={postponeNotes} onChange={e => setPostponeNotes(e.target.value)} placeholder="سبب التأجيل..." className="min-h-11 md:min-h-9 mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={() => setPostponeDialog({ open: false, orderId: null })}>إلغاء</Button>
            <Button onClick={() => {
              if (!postponeDate) { toast.error("حدد التاريخ"); return; }
              if (!postponeDialog.orderId) return;
              postponeMutation.mutate({ orderId: postponeDialog.orderId, postponedTo: new Date(postponeDate), notes: postponeNotes || undefined });
            }} disabled={postponeMutation.isPending} className="min-h-11 md:min-h-9 bg-primary hover:bg-primary/90 text-primary-foreground">
              {postponeMutation.isPending ? "جاري..." : "تأجيل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Dialog */}
      <Dialog open={cancelDialog.open} onOpenChange={open => setCancelDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><XCircle className="h-5 w-5 text-destructive" aria-hidden="true" />إلغاء الأوردر</DialogTitle>
            <DialogDescription>اختر سبب الإلغاء؛ يمكنك إضافة ملاحظة توضيحية.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>سبب الإلغاء <span className="text-destructive">*</span></Label>
              <Select value={cancelReason} onValueChange={setCancelReason}>
                <SelectTrigger className="min-h-11 md:min-h-9 mt-1 w-full"><SelectValue placeholder="اختر السبب..." /></SelectTrigger>
                <SelectContent>
              {cancelReasonOptions.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>ملاحظة (اختياري)</Label>
              <Input value={cancelNotes} onChange={e => setCancelNotes(e.target.value)} placeholder="تفاصيل..." className="min-h-11 md:min-h-9 mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={() => setCancelDialog({ open: false, orderId: null })}>رجوع</Button>
            <Button className="min-h-11 md:min-h-9" onClick={() => {
              if (!cancelReason) { toast.error("اختر سبب الإلغاء"); return; }
              if (!cancelDialog.orderId) return;
              cancelMutation.mutate({ orderId: cancelDialog.orderId, cancelReason: cancelReason as any, notes: cancelNotes || undefined });
            }} disabled={cancelMutation.isPending} variant="destructive">
              {cancelMutation.isPending ? "جاري..." : "تأكيد الإلغاء"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ==================== INVENTORY TAB ====================
function ManagerInventoryTab() {
  const online = useOnlineStatus();
  const [movementDialog, setMovementDialog] = useState<{ open: boolean; productId: number | null; type: "in" | "out" }>({ open: false, productId: null, type: "in" });
  const [movementQty, setMovementQty] = useState("");
  const [movementReason, setMovementReason] = useState("");

  const utils = trpc.useUtils();

  const { data: products, isLoading, error: productsError, refetch: refetchProducts } = trpc.employeePortal.productsList.useQuery();
  const { data: lowStock } = trpc.employeePortal.lowStockProducts.useQuery();
  const { data: movements, isLoading: movementsLoading } = trpc.employeePortal.inventoryMovements.useQuery({ limit: 50 });

  const addMovementMutation = trpc.employeePortal.addInventoryMovement.useMutation({
    onSuccess: () => {
      toast.success("تم تسجيل الحركة");
      setMovementDialog({ open: false, productId: null, type: "in" });
      setMovementQty(""); setMovementReason("");
      utils.employeePortal.productsList.invalidate();
      utils.employeePortal.lowStockProducts.invalidate();
      utils.employeePortal.inventoryMovements.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const lowStockCount = lowStock?.length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="المخزون"
        description={lowStockCount > 0 ? `أرصدة المنتجات وتسجيل الوارد والصادر — ${lowStockCount} صنف تحت الحد الأدنى.` : "أرصدة المنتجات وتسجيل الوارد والصادر."}
      />

      {!online && <OfflineState onRetry={() => refetchProducts()} className="py-6" />}

      {/* Products Grid */}
      {productsError ? (
        <ErrorState message="تعذّر تحميل المنتجات." onRetry={() => refetchProducts()} />
      ) : isLoading ? (
        <LoadingSkeleton variant="cards" rows={3} />
      ) : (products ?? []).length === 0 ? (
        <EmptyState
          icon={<Package className="h-7 w-7" />}
          title="لا توجد منتجات"
          description="المنتجات المضافة لنشاطك ستظهر هنا مع أرصدتها."
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
          {(products ?? []).map((p: any) => {
            const isLow = p.currentStock <= p.minStockLevel;
            return (
              <SectionCard key={p.id} className={isLow ? "border-destructive/30 bg-destructive/5" : ""}>
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <p className="font-bold text-foreground">{p.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{p.sku}</p>
                  </div>
                  {isLow && <StatusBadge kind="stock" status="low" size="sm" />}
                </div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-2xl font-bold tabular-nums text-foreground">{p.currentStock}</p>
                    <p className="text-xs text-muted-foreground">الحد الأدنى: {p.minStockLevel}</p>
                  </div>
                  <p className="text-sm font-semibold tabular-nums text-primary">{Number(p.price).toLocaleString()} ج.م</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="min-h-11 md:min-h-9 flex-1 text-[var(--success)] border-[var(--success)]/40 hover:bg-[var(--success)]/10 hover:text-[var(--success)]" onClick={() => setMovementDialog({ open: true, productId: p.id, type: "in" })}>
                    + وارد
                  </Button>
                  <Button size="sm" variant="outline" className="min-h-11 md:min-h-9 flex-1 text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive" onClick={() => setMovementDialog({ open: true, productId: p.id, type: "out" })}>
                    - صادر
                  </Button>
                </div>
              </SectionCard>
            );
          })}
        </div>
      )}

      {/* Recent Movements */}
      <SectionCard title="آخر الحركات" icon={<ArrowLeftRight className="h-4 w-4 text-primary" aria-hidden="true" />} testId="manager-movements">
        {movementsLoading ? (
          <LoadingSkeleton variant="table" rows={3} />
        ) : !movements || movements.length === 0 ? (
          <EmptyState
            className="py-8"
            icon={<ArrowLeftRight className="h-7 w-7" />}
            title="لا توجد حركات مخزون بعد"
            description="سجّل واردًا أو صادرًا من بطاقة المنتج لتظهر الحركة هنا."
          />
        ) : (
          <ul className="max-h-72 overflow-y-auto divide-y divide-border">
            {movements.map((m: any) => (
              <li key={m.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${m.type === 'in' ? 'bg-[var(--success)]' : 'bg-destructive'}`} aria-hidden="true" />
                  <span className="truncate text-foreground">{(products ?? []).find((p: any) => p.id === m.productId)?.name ?? "—"}</span>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className={`font-bold tabular-nums ${m.type === 'in' ? 'text-[var(--success)]' : 'text-destructive'}`} dir="ltr">
                    {m.type === 'in' ? '+' : '-'}{m.quantity}
                  </span>
                  {m.reason && <span className="max-w-[10rem] truncate text-xs text-muted-foreground">{m.reason}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* Movement Dialog */}
      <Dialog open={movementDialog.open} onOpenChange={open => setMovementDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle>{movementDialog.type === "in" ? "إضافة وارد" : "تسجيل صادر"}</DialogTitle>
            <DialogDescription>{movementDialog.type === "in" ? "الكمية تُضاف إلى رصيد المنتج." : "الكمية تُخصم من رصيد المنتج."}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>الكمية <span className="text-destructive">*</span></Label>
              <Input type="number" min="1" inputMode="numeric" value={movementQty} onChange={e => setMovementQty(e.target.value)} className="min-h-11 md:min-h-9 mt-1" />
            </div>
            <div>
              <Label>السبب (اختياري)</Label>
              <Input value={movementReason} onChange={e => setMovementReason(e.target.value)} placeholder="مثال: شحنة جديدة..." className="min-h-11 md:min-h-9 mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={() => setMovementDialog({ open: false, productId: null, type: "in" })}>إلغاء</Button>
            <Button onClick={() => {
              if (!movementQty || parseInt(movementQty) < 1) { toast.error("أدخل كمية صحيحة"); return; }
              if (!movementDialog.productId) return;
              addMovementMutation.mutate({
                productId: movementDialog.productId,
                type: movementDialog.type,
                quantity: parseInt(movementQty),
                reason: movementReason || undefined,
              });
            }} disabled={addMovementMutation.isPending} className={`min-h-11 md:min-h-9 text-primary-foreground ${movementDialog.type === "in" ? "bg-[var(--success)] hover:bg-[var(--success)]/90" : "bg-destructive hover:bg-destructive/90"}`}>
              {addMovementMutation.isPending ? "جاري..." : "تأكيد"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ==================== REPORTS TAB ====================
function ManagerReportsTab() {
  const online = useOnlineStatus();
  const cancelReasonOptions = useOperationalOptions("cancellation_reason").options;
  const [dateRange, setDateRange] = useState<"today" | "week" | "month">("month");

  const dateParams = useMemo(() => {
    const now = new Date();
    const from = new Date();
    if (dateRange === "today") from.setHours(0, 0, 0, 0);
    else if (dateRange === "week") from.setDate(now.getDate() - 7);
    else from.setMonth(now.getMonth() - 1);
    return { dateFrom: from, dateTo: now };
  }, [dateRange]);

  const { data: performance, isLoading: perfLoading, error: perfError, refetch: refetchPerf } = trpc.employeePortal.employeePerformance.useQuery(dateParams);
  const { data: cancellations, isLoading: cancellationsLoading } = trpc.employeePortal.cancellationReasons.useQuery(dateParams);
  const { data: dailyChart } = trpc.employeePortal.dailyChart.useQuery({ days: 30 });

  type PerfRow = NonNullable<typeof performance>[number];
  const rateCls = (rate: number) => (rate >= 50 ? "text-[var(--success)]" : "text-destructive");
  const perfColumns: Column<PerfRow>[] = [
    { id: "employee", header: "الموظف", alwaysVisible: true, cell: (p) => <span className="font-medium">{p.employeeName}</span> },
    { id: "total", header: "الإجمالي", numeric: true, cell: (p) => p.total },
    { id: "confirmed", header: "مؤكد", numeric: true, cell: (p) => <span className="font-semibold text-[var(--success)]">{p.confirmed}</span> },
    { id: "cancelled", header: "ملغي", numeric: true, cell: (p) => <span className="text-destructive">{p.cancelled}</span> },
    { id: "postponed", header: "مؤجل", numeric: true, cell: (p) => <span className="text-[var(--warning)]">{p.postponed}</span> },
    { id: "confirmRate", header: "نسبة التأكيد", numeric: true, cell: (p) => <span className={`font-bold ${rateCls(p.confirmRate)}`}>{p.confirmRate}%</span> },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="التقارير"
        description="أداء الموظفين وأسباب الإلغاء خلال الفترة المختارة."
        actions={
          <div className="flex gap-2" role="group" aria-label="الفترة">
            {[
              { key: "today", label: "اليوم" },
              { key: "week", label: "أسبوع" },
              { key: "month", label: "شهر" },
            ].map(d => (
              <Button
                key={d.key}
                type="button"
                size="sm"
                variant={dateRange === d.key ? "default" : "outline"}
                className={`min-h-11 md:min-h-9 flex-1 sm:flex-none ${dateRange === d.key ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-card text-muted-foreground hover:border-primary/40"}`}
                aria-pressed={dateRange === d.key}
                onClick={() => setDateRange(d.key as any)}
              >
                {d.label}
              </Button>
            ))}
          </div>
        }
      />

      {!online && <OfflineState onRetry={() => refetchPerf()} className="py-6" />}

      {/* Employee Performance */}
      <SectionCard title="أداء الموظفين" icon={<BarChart3 className="h-4 w-4 text-primary" aria-hidden="true" />} testId="manager-perf">
        <ResponsiveDataTable<PerfRow>
          rows={performance ?? []}
          columns={perfColumns}
          rowKey={(p) => p.employeeId ?? p.employeeName}
          loading={perfLoading}
          error={perfError ? "تعذّر تحميل أداء الموظفين." : null}
          onRetry={() => refetchPerf()}
          empty={{ title: "لا توجد بيانات أداء في هذه الفترة", description: "جرّب فترة أطول." }}
          cardsBelow="md"
          mobileRow={(p) => (
            <article className="space-y-2 rounded-[var(--radius-brand-md)] border border-border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{p.employeeName}</span>
                <span className={`font-bold tabular-nums ${rateCls(p.confirmRate)}`}>{p.confirmRate}%</span>
              </div>
              <dl className="grid grid-cols-4 gap-2 text-center text-xs">
                <div><dt className="text-muted-foreground">الإجمالي</dt><dd className="font-semibold tabular-nums">{p.total}</dd></div>
                <div><dt className="text-muted-foreground">مؤكد</dt><dd className="font-semibold tabular-nums text-[var(--success)]">{p.confirmed}</dd></div>
                <div><dt className="text-muted-foreground">ملغي</dt><dd className="font-semibold tabular-nums text-destructive">{p.cancelled}</dd></div>
                <div><dt className="text-muted-foreground">مؤجل</dt><dd className="font-semibold tabular-nums text-[var(--warning)]">{p.postponed}</dd></div>
              </dl>
            </article>
          )}
        />
      </SectionCard>

      {/* Cancellation Reasons */}
      <SectionCard title="أسباب الإلغاء" icon={<XCircle className="h-4 w-4 text-destructive" aria-hidden="true" />} testId="manager-cancellations">
        {cancellationsLoading ? (
          <LoadingSkeleton variant="table" rows={3} />
        ) : !cancellations || cancellations.length === 0 ? (
          <EmptyState className="py-8" title="لا توجد إلغاءات في هذه الفترة" description="أسباب الإلغاء ستظهر هنا عند وجود أوردرات ملغاة." />
        ) : (
          <div className="space-y-3">
            {cancellations.map((c: any, i: number) => {
              const total = cancellations.reduce((s: number, x: any) => s + Number(x.count), 0);
              const pct = total > 0 ? Math.round((Number(c.count) / total) * 100) : 0;
              const reasonLabel = cancelReasonOptions.find(r => r.value === c.cancelReason)?.label ?? c.cancelReason;
              return (
                <div key={i}>
                  <div className="flex items-center justify-between gap-2 text-sm mb-1">
                    <span className="min-w-0 truncate text-foreground">{reasonLabel}</span>
                    <span className="shrink-0 font-bold tabular-nums text-foreground">{c.count} ({pct}%)</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2" aria-hidden="true">
                    <div className="bg-destructive/70 h-2 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ==================== EMPLOYEES TAB ====================
function ManagerEmployeesTab() {
  const online = useOnlineStatus();
  const [addDialog, setAddDialog] = useState(false);
  const [credDialog, setCredDialog] = useState<{ open: boolean; empId: number | null; empName: string }>({ open: false, empId: null, empName: "" });
  const [newEmp, setNewEmp] = useState({ name: "", phone: "", role: "agent" as "agent" | "warehouse" | "manager" });
  const [credUsername, setCredUsername] = useState("");
  const [credPassword, setCredPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const utils = trpc.useUtils();

  const { data: employeesList, isLoading, error: employeesError, refetch: refetchEmployees } = trpc.employeePortal.employeesList.useQuery();

  const createMutation = trpc.employeePortal.createEmployee.useMutation({
    onSuccess: () => {
      toast.success("تم إضافة الموظف");
      setAddDialog(false);
      setNewEmp({ name: "", phone: "", role: "agent" });
      utils.employeePortal.employeesList.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const setCredMutation = trpc.employeePortal.setEmployeeCredentials.useMutation({
    onSuccess: () => {
      toast.success("تم تعيين بيانات الدخول");
      setCredDialog({ open: false, empId: null, empName: "" });
      setCredUsername(""); setCredPassword("");
      utils.employeePortal.employeesList.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMutation = trpc.employeePortal.updateEmployee.useMutation({
    onSuccess: () => {
      toast.success("تم التحديث");
      utils.employeePortal.employeesList.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="الموظفين"
        description="فريق خدمة العملاء والمخزن: إضافة، بيانات دخول، وإيقاف أو تفعيل."
        primaryAction={
          <Button onClick={() => setAddDialog(true)} className="min-h-11 md:min-h-9 bg-primary hover:bg-primary/90 text-primary-foreground">
            <UserPlus className="h-4 w-4 ml-2" aria-hidden="true" />
            إضافة موظف
          </Button>
        }
      />

      {!online && <OfflineState onRetry={() => refetchEmployees()} className="py-6" />}

      {/* Employee Login Link */}
      <div className="rounded-[var(--radius-brand-md)] border border-primary/20 bg-accent p-4">
        <p className="text-sm text-accent-foreground font-medium mb-1">رابط دخول الموظفين:</p>
        <code className="block w-fit max-w-full break-all text-sm bg-card px-3 py-1 rounded border border-border text-primary select-all" dir="ltr">
          {window.location.origin}/employee-login
        </code>
      </div>

      {/* Employees List */}
      {employeesError ? (
        <ErrorState message="تعذّر تحميل قائمة الموظفين." onRetry={() => refetchEmployees()} />
      ) : isLoading ? (
        <LoadingSkeleton variant="table" rows={3} />
      ) : (employeesList ?? []).length === 0 ? (
        <EmptyState
          icon={<Users className="h-7 w-7" />}
          title="لا يوجد موظفون بعد"
          description="أضف أول موظف ثم عيّن له بيانات الدخول."
        />
      ) : (
        <div className="space-y-3">
          {(employeesList ?? []).map((emp: any) => (
            <SectionCard key={emp.id}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center text-primary-foreground font-bold text-sm ${
                    emp.role === 'manager' ? 'bg-[var(--chart-3)]' : emp.role === 'warehouse' ? 'bg-[var(--info)]' : 'bg-primary'
                  }`} aria-hidden="true">
                    {emp.name.charAt(0)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-foreground">{emp.name}</span>
                      <StatusBadge
                        status={emp.isActive ? "active" : "inactive"}
                        label={emp.isActive ? "نشط" : "موقوف"}
                        tone={emp.isActive ? "success" : "neutral"}
                        size="sm"
                        icon={null}
                      />
                      <Badge variant="outline" className="text-xs">
                        {ROLE_LABELS[emp.role] ?? emp.role}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 mt-1 text-sm text-muted-foreground">
                      {emp.phone && <span dir="ltr">{emp.phone}</span>}
                      {emp.username && <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded" dir="ltr">@{emp.username}</span>}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {!emp.username && (
                    <Button className="min-h-11 md:min-h-9 flex-1 sm:flex-none" size="sm" variant="outline" onClick={() => {
                      setCredDialog({ open: true, empId: emp.id, empName: emp.name });
                      setCredUsername(""); setCredPassword("");
                    }}>
                      <Key className="h-3.5 w-3.5 ml-1" aria-hidden="true" />
                      تعيين دخول
                    </Button>
                  )}
                  {emp.username && (
                    <Button className="min-h-11 md:min-h-9 flex-1 sm:flex-none" size="sm" variant="outline" onClick={() => {
                      setCredDialog({ open: true, empId: emp.id, empName: emp.name });
                      setCredUsername(emp.username); setCredPassword("");
                    }}>
                      <Key className="h-3.5 w-3.5 ml-1" aria-hidden="true" />
                      تغيير كلمة المرور
                    </Button>
                  )}
                  <Button className="min-h-11 md:min-h-9 flex-1 sm:flex-none"
                    size="sm"
                    variant={emp.isActive ? "destructive" : "default"}
                    disabled={updateMutation.isPending}
                    onClick={() => updateMutation.mutate({ id: emp.id, isActive: !emp.isActive })}
                  >
                    {emp.isActive ? "إيقاف" : "تفعيل"}
                  </Button>
                </div>
              </div>
            </SectionCard>
          ))}
        </div>
      )}

      {/* Add Employee Dialog */}
      <Dialog open={addDialog} onOpenChange={setAddDialog}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle>إضافة موظف جديد</DialogTitle>
            <DialogDescription>بعد الإضافة عيّن له بيانات الدخول من قائمة الموظفين.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>الاسم <span className="text-destructive">*</span></Label>
              <Input value={newEmp.name} onChange={e => setNewEmp(p => ({ ...p, name: e.target.value }))} className="min-h-11 md:min-h-9 mt-1" />
            </div>
            <div>
              <Label>الهاتف</Label>
              <Input value={newEmp.phone} onChange={e => setNewEmp(p => ({ ...p, phone: e.target.value }))} className="min-h-11 md:min-h-9 mt-1" dir="ltr" inputMode="tel" />
            </div>
            <div>
              <Label>الدور</Label>
              <Select value={newEmp.role} onValueChange={(v: any) => setNewEmp(p => ({ ...p, role: v }))}>
                <SelectTrigger className="min-h-11 md:min-h-9 mt-1 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">موظف خدمة عملاء</SelectItem>
                  <SelectItem value="warehouse">مخزن</SelectItem>
                  <SelectItem value="manager">مدير</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={() => setAddDialog(false)}>إلغاء</Button>
            <Button onClick={() => {
              if (!newEmp.name.trim()) { toast.error("أدخل اسم الموظف"); return; }
              createMutation.mutate({ name: newEmp.name, phone: newEmp.phone || undefined, role: newEmp.role });
            }} disabled={createMutation.isPending} className="min-h-11 md:min-h-9 bg-primary hover:bg-primary/90 text-primary-foreground">
              {createMutation.isPending ? "جاري..." : "إضافة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Credentials Dialog */}
      <Dialog open={credDialog.open} onOpenChange={open => setCredDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle>بيانات دخول {credDialog.empName}</DialogTitle>
            <DialogDescription>اسم المستخدم وكلمة المرور التي سيدخل بها الموظف من رابط دخول الموظفين.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>اسم المستخدم <span className="text-destructive">*</span></Label>
              <Input value={credUsername} onChange={e => setCredUsername(e.target.value)} className="min-h-11 md:min-h-9 mt-1" dir="ltr" autoComplete="off" />
            </div>
            <div>
              <Label>كلمة المرور <span className="text-destructive">*</span></Label>
              <div className="relative mt-1">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={credPassword}
                  onChange={e => setCredPassword(e.target.value)}
                  className="min-h-11 md:min-h-9 pl-12 md:pl-10"
                  dir="ltr"
                  autoComplete="new-password"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="min-h-11 min-w-11 md:min-h-9 md:min-w-9 absolute left-0 top-1/2 -translate-y-1/2 text-muted-foreground hover:bg-transparent hover:text-foreground"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
                  aria-pressed={showPassword}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={() => setCredDialog({ open: false, empId: null, empName: "" })}>إلغاء</Button>
            <Button onClick={() => {
              if (!credUsername.trim() || !credPassword.trim()) { toast.error("أدخل اسم المستخدم وكلمة المرور"); return; }
              if (!credDialog.empId) return;
              setCredMutation.mutate({ id: credDialog.empId, username: credUsername.trim(), password: credPassword });
            }} disabled={setCredMutation.isPending} className="min-h-11 md:min-h-9 bg-primary hover:bg-primary/90 text-primary-foreground">
              {setCredMutation.isPending ? "جاري..." : "حفظ"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ==================== TASKS TAB ====================
function ManagerTasksTab() {
  const online = useOnlineStatus();
  const utils = trpc.useUtils();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [newTask, setNewTask] = useState({ title: "", description: "", assignedTo: "" });

  const { data: employeesList } = trpc.employeePortal.employeesList.useQuery();
  const { data: tasksList, isLoading, error: tasksError, refetch: refetchTasks } = trpc.tasks.list.useQuery({ status: statusFilter });

  const createMutation = trpc.tasks.create.useMutation({
    onSuccess: () => {
      toast.success("تم إنشاء المهمة بنجاح");
      setShowCreateDialog(false);
      setNewTask({ title: "", description: "", assignedTo: "" });
      utils.tasks.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const updateStatusMutation = trpc.tasks.updateStatus.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث حالة المهمة");
      utils.tasks.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteMutation = trpc.tasks.delete.useMutation({
    onSuccess: () => {
      toast.success("تم حذف المهمة");
      utils.tasks.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const TASK_STATUS_CONFIG: Record<string, { label: string; tone: StatusTone }> = {
    new: { label: "جديدة", tone: "primary" },
    in_progress: { label: "قيد التنفيذ", tone: "warning" },
    done: { label: "تمت", tone: "success" },
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="توزيع المهام"
        description="مهام للفريق: لموظف بعينه أو لجميع الموظفين، مع متابعة حالتها."
        primaryAction={
          <Button onClick={() => setShowCreateDialog(true)} className="min-h-11 md:min-h-9 bg-primary hover:bg-primary/90 text-primary-foreground">
            <Plus className="h-4 w-4 ml-2" aria-hidden="true" />
            إنشاء مهمة جديدة
          </Button>
        }
      />

      {!online && <OfflineState onRetry={() => refetchTasks()} className="py-6" />}

      {/* Status Filter */}
      <div className="flex gap-2 flex-wrap" role="group" aria-label="فلترة المهام بالحالة">
        {[
          { key: "all", label: "الكل" },
          { key: "new", label: "جديدة" },
          { key: "in_progress", label: "قيد التنفيذ" },
          { key: "done", label: "تمت" },
        ].map(f => (
          <Button
            key={f.key}
            size="sm"
            variant={statusFilter === f.key ? "default" : "outline"}
            aria-pressed={statusFilter === f.key}
            onClick={() => setStatusFilter(f.key)}
            className={`min-h-11 md:min-h-9 ${statusFilter === f.key ? "bg-primary hover:bg-primary/90 text-primary-foreground" : ""}`}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {/* Tasks List */}
      {tasksError ? (
        <ErrorState message="تعذّر تحميل المهام." onRetry={() => refetchTasks()} />
      ) : isLoading ? (
        <LoadingSkeleton variant="table" rows={3} />
      ) : (tasksList ?? []).length === 0 ? (
        <EmptyState
          icon={<FileText className="h-7 w-7" />}
          title="لا توجد مهام"
          description="أنشئ مهمة جديدة لتوزيعها على الموظفين."
        />
      ) : (
        <div className="space-y-3">
          {(tasksList ?? []).map((task: any) => {
            const statusConf = TASK_STATUS_CONFIG[task.status] ?? TASK_STATUS_CONFIG.new;
            return (
              <SectionCard key={task.id}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <h3 className="font-bold text-foreground">{task.title}</h3>
                      <StatusBadge status={task.status} label={statusConf.label} tone={statusConf.tone} size="sm" icon={null} />
                    </div>
                    {task.description && (
                      <p className="text-sm text-muted-foreground mb-2 leading-relaxed">{task.description}</p>
                    )}
                    <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                      <span className="flex items-center gap-1">
                        <User className="h-3 w-3" aria-hidden="true" />
                        {task.assignedToName ?? "جميع الموظفين"}
                      </span>
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" aria-hidden="true" />
                        {new Date(task.createdAt).toLocaleDateString('ar-EG')}
                      </span>
                      <span>بواسطة: {task.createdByName}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Status change dropdown */}
                    <Select
                      value={task.status}
                      onValueChange={(v: any) => updateStatusMutation.mutate({ taskId: task.id, status: v })}
                    >
                      <SelectTrigger className="min-h-11 md:min-h-8 w-full sm:w-32 text-xs" aria-label="حالة المهمة">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="new">جديدة</SelectItem>
                        <SelectItem value="in_progress">قيد التنفيذ</SelectItem>
                        <SelectItem value="done">تمت</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon"
                      variant="outline"
                      className="min-h-11 min-w-11 md:min-h-8 md:min-w-8 shrink-0 text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                      aria-label="حذف المهمة"
                      title="حذف المهمة"
                      onClick={() => {
                        if (confirm("هل أنت متأكد من حذف هذه المهمة؟")) {
                          deleteMutation.mutate({ taskId: task.id });
                        }
                      }}
                    >
                      <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </SectionCard>
            );
          })}
        </div>
      )}

      {/* Create Task Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle>إنشاء مهمة جديدة</DialogTitle>
            <DialogDescription>اترك «تعيين لموظف» فارغًا لإرسال المهمة لجميع الموظفين.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>عنوان المهمة <span className="text-destructive">*</span></Label>
              <Input
                value={newTask.title}
                onChange={e => setNewTask(p => ({ ...p, title: e.target.value }))}
                placeholder="أدخل عنوان المهمة"
                className="min-h-11 md:min-h-9 mt-1"
              />
            </div>
            <div>
              <Label>وصف المهمة</Label>
              <Textarea
                value={newTask.description}
                onChange={e => setNewTask(p => ({ ...p, description: e.target.value }))}
                placeholder="وصف تفصيلي للمهمة المطلوبة..."
                className="mt-1 min-h-[80px] resize-y"
                rows={3}
              />
            </div>
            <div>
              <Label>تعيين لموظف</Label>
              <Select value={newTask.assignedTo} onValueChange={v => setNewTask(p => ({ ...p, assignedTo: v }))}>
                <SelectTrigger className="min-h-11 md:min-h-9 mt-1 w-full">
                  <SelectValue placeholder="جميع الموظفين" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">جميع الموظفين</SelectItem>
                  {(employeesList ?? []).filter((e: any) => e.role === 'agent').map((e: any) => (
                    <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">اتركه فارغ لإرسال المهمة لجميع الموظفين</p>
            </div>
          </div>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={() => setShowCreateDialog(false)}>إلغاء</Button>
            <Button
              onClick={() => {
                if (!newTask.title.trim()) { toast.error("أدخل عنوان المهمة"); return; }
                createMutation.mutate({
                  title: newTask.title.trim(),
                  description: newTask.description.trim() || undefined,
                  assignedTo: newTask.assignedTo && newTask.assignedTo !== "all" ? Number(newTask.assignedTo) : undefined,
                });
              }}
              disabled={createMutation.isPending}
              className="min-h-11 md:min-h-9 bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {createMutation.isPending ? "جاري..." : "إنشاء المهمة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
