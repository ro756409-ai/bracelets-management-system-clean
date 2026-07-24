import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { BrandMark } from "@/components/BrandMark";
import { toast } from "sonner";
import {
  LayoutDashboard, ShoppingCart, Package, BarChart3, Users,
  LogOut, RefreshCw, Search, Plus, CheckCircle2, XCircle, Clock,
  Phone, MapPin, ChevronDown, ChevronUp, TrendingUp, AlertTriangle,
  UserPlus, Key, ArrowRight, ArrowLeft, Menu, X, Eye, EyeOff,
  Briefcase, FileText, Hash, Calendar, User, Lock
} from "lucide-react";

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  new:       { label: "جديد",    color: "text-blue-700",   bg: "bg-blue-50 border-blue-200" },
  confirmed: { label: "مؤكد",    color: "text-green-700",  bg: "bg-green-50 border-green-200" },
  postponed: { label: "مؤجل",    color: "text-amber-700",  bg: "bg-amber-50 border-amber-200" },
  cancelled: { label: "ملغي",    color: "text-red-700",    bg: "bg-red-50 border-red-200" },
  preparing: { label: "جاري التجهيز", color: "text-purple-700", bg: "bg-purple-50 border-purple-200" },
  shipped:   { label: "تم الشحن", color: "text-indigo-700", bg: "bg-indigo-50 border-indigo-200" },
  delivered: { label: "تم التسليم", color: "text-teal-700", bg: "bg-teal-50 border-teal-200" },
};

const CANCEL_REASONS = [
  { value: "price",        label: "السعر مرتفع" },
  { value: "not_serious",  label: "غير جاد" },
  { value: "wrong_number", label: "رقم خطأ" },
  { value: "duplicate",    label: "طلب مكرر" },
];

const ROLE_LABELS: Record<string, string> = {
  agent: "موظف خدمة عملاء",
  warehouse: "مخزن",
  manager: "مدير",
};

const GOVERNORATES = [
  "القاهرة","الجيزة","الإسكندرية","الدقهلية","البحيرة","الشرقية","المنوفية","الغربية",
  "كفر الشيخ","القليوبية","الفيوم","بني سويف","المنيا","أسيوط","سوهاج","قنا","الأقصر",
  "أسوان","البحر الأحمر","الوادي الجديد","مطروح","شمال سيناء","جنوب سيناء","بورسعيد",
  "الإسماعيلية","السويس","دمياط"
];

type TabKey = "dashboard" | "orders" | "inventory" | "reports" | "employees" | "tasks";

export default function ManagerDashboard() {
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

  return (
    <div className="min-h-screen bg-gray-50 flex" dir="rtl">
      {/* Sidebar - Desktop */}
      <aside className="hidden md:flex flex-col w-64 bg-sidebar text-sidebar-foreground min-h-screen sticky top-0">
        <div className="p-4 border-b border-sidebar-border">
          <div className="flex items-center gap-3">
            <BrandMark className="w-10 h-10" />
            <div>
              <p className="font-bold text-sm">متجرك</p>
              <p className="text-sidebar-foreground/70 text-xs">لوحة تحكم المدير</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {tabs.map(tab => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  isActive
                    ? "bg-sidebar-accent text-sidebar-primary"
                    : "text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/90"
                }`}
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-sidebar-border">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-8 h-8 rounded-full bg-sidebar-accent flex items-center justify-center text-sidebar-primary text-sm font-bold">
              {managerName.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sidebar-foreground truncate">{managerName}</p>
              <p className="text-xs text-sidebar-foreground/50">مدير</p>
            </div>
            <button onClick={handleLogout} className="text-sidebar-foreground/40 hover:text-red-400 transition-colors" title="تسجيل الخروج">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute right-0 top-0 bottom-0 w-64 bg-sidebar text-sidebar-foreground flex flex-col">
            <div className="p-4 border-b border-sidebar-border flex items-center justify-between">
              <div className="flex items-center gap-3">
                <BrandMark className="w-7 h-7" />
                <p className="font-bold text-sm">متجرك</p>
              </div>
              <button onClick={() => setSidebarOpen(false)} className="text-sidebar-foreground/60 hover:text-sidebar-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {tabs.map(tab => {
                const isActive = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    onClick={() => { setActiveTab(tab.key); setSidebarOpen(false); }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                      isActive ? "bg-sidebar-accent text-sidebar-primary" : "text-sidebar-foreground/60 hover:bg-sidebar-accent/50"
                    }`}
                  >
                    <tab.icon className="h-4 w-4" />
                    {tab.label}
                  </button>
                );
              })}
            </nav>
            <div className="p-3 border-t border-sidebar-border">
              <button onClick={handleLogout} className="w-full flex items-center gap-2 px-3 py-2 text-red-400 hover:bg-red-500/10 rounded-lg text-sm">
                <LogOut className="h-4 w-4" />
                تسجيل الخروج
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 min-w-0">
        {/* Mobile Header */}
        <header className="md:hidden sticky top-0 z-40 shadow-md" style={{ background: "linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 100%)" }}>
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-3">
              <button onClick={() => setSidebarOpen(true)} className="text-white">
                <Menu className="h-5 w-5" />
              </button>
              <p className="text-white font-bold text-sm">{tabs.find(t => t.key === activeTab)?.label}</p>
            </div>
            <p className="text-white/70 text-xs">أهلاً، {managerName}</p>
          </div>
        </header>

        <main className="p-4 md:p-6">
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

  const { data: stats } = trpc.employeePortal.dashboardStats.useQuery(dateParams);
  const { data: lowStock } = trpc.employeePortal.lowStockProducts.useQuery();
  const { data: dailyChart } = trpc.employeePortal.dailyChart.useQuery({ days: 30 });

  const lowStockCount = lowStock?.length ?? 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">لوحة التحكم</h1>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="إجمالي الأوردرات" value={stats?.statusStats?.reduce((s: number, x: any) => s + Number(x.count), 0) ?? 0} color="text-gray-900" bg="bg-white" />
        <StatCard label="أوردرات جديدة" value={Number(stats?.statusStats?.find((s: any) => s.status === 'new')?.count ?? 0)} color="text-blue-600" bg="bg-blue-50" />
        <StatCard label="مؤكدة" value={Number(stats?.statusStats?.find((s: any) => s.status === 'confirmed')?.count ?? 0)} color="text-green-600" bg="bg-green-50" />
        <StatCard label="ملغية" value={Number(stats?.statusStats?.find((s: any) => s.status === 'cancelled')?.count ?? 0)} color="text-red-600" bg="bg-red-50" />
      </div>

      {/* Broadcast Message Section - محسّن */}
      <Card className="border-amber-200 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center">
              <span className="text-sm">📢</span>
            </div>
            إرسال رسالة لجميع الموظفين
          </CardTitle>
          <p className="text-xs text-muted-foreground">ستظهر الرسالة كإشعار احترافي لجميع الموظفين في لوحة تحكمهم</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {activeBroadcast && (
            <div className="relative overflow-hidden bg-gradient-to-l from-amber-50 to-orange-50 border border-amber-200 rounded-lg p-3">
              <div className="absolute top-0 left-0 w-1 h-full bg-amber-500"></div>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 mr-2">
                  <p className="text-xs text-amber-700 font-bold mb-1">الرسالة الحالية:</p>
                  <p className="text-sm text-gray-800 leading-relaxed">{activeBroadcast.message}</p>
                  <div className="flex items-center gap-2 mt-2 text-xs text-gray-500">
                    <span className="font-medium text-amber-700">{activeBroadcast.sentByName}</span>
                    <span>•</span>
                    <span>{new Date(activeBroadcast.createdAt).toLocaleString('ar-EG')}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-red-600 border-red-200 hover:bg-red-50 shrink-0"
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
              className="bg-amber-700 hover:bg-amber-800 text-white shrink-0"
            >
              {sendBroadcastMutation.isPending ? 'جاري...' : 'إرسال'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Low Stock Alert */}
      {lowStockCount > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <div className="flex items-center gap-2 text-red-700 font-bold mb-2">
            <AlertTriangle className="h-5 w-5" />
            تنبيه نقص المخزون ({lowStockCount} صنف)
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {lowStock?.map((p: any) => (
              <div key={p.id} className="flex items-center justify-between bg-white rounded-lg px-3 py-2 border border-red-100">
                <span className="text-sm font-medium text-gray-700">{p.name}</span>
                <span className="text-sm font-bold text-red-600">{p.currentStock} / {p.minStockLevel}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily Chart */}
      {dailyChart && dailyChart.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">الأوردرات اليومية (آخر 30 يوم)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-1 h-40 overflow-x-auto">
              {dailyChart.map((d: any, i: number) => {
                const maxVal = Math.max(...dailyChart.map((x: any) => Number(x.count)), 1);
                const height = (Number(d.count) / maxVal) * 100;
                return (
                  <div key={i} className="flex flex-col items-center flex-shrink-0" style={{ width: "20px" }}>
                    <span className="text-[10px] text-gray-400 mb-1">{Number(d.count)}</span>
                    <div
                      className="w-3 rounded-t bg-amber-500"
                      style={{ height: `${Math.max(height, 4)}%` }}
                    />
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatCard({ label, value, color, bg }: { label: string; value: number; color: string; bg: string }) {
  return (
    <div className={`${bg} rounded-xl p-4 border border-gray-100 shadow-sm`}>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-sm text-gray-500 mt-1">{label}</p>
    </div>
  );
}

// ==================== ORDERS TAB ====================
function ManagerOrdersTab() {
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
  const { data: ordersData, isLoading } = trpc.employeePortal.allOrders.useQuery({
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
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-900">الأوردرات</h1>
        {selectedOrders.length > 0 && (
          <Button onClick={() => setAssignDialog(true)} className="bg-amber-600 hover:bg-amber-700 text-white">
            <Users className="h-4 w-4 ml-2" />
            توزيع {selectedOrders.length} أوردر
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="بحث بالاسم أو الهاتف أو رقم الأوردر..." className="pr-10 bg-white" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px] bg-white"><SelectValue placeholder="الحالة" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل الحالات</SelectItem>
            {Object.entries(STATUS_CONFIG).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={govFilter} onValueChange={setGovFilter}>
          <SelectTrigger className="w-[140px] bg-white"><SelectValue placeholder="المحافظة" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل المحافظات</SelectItem>
            {GOVERNORATES.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={groupFilter} onValueChange={setGroupFilter}>
          <SelectTrigger className="w-[160px] bg-white"><SelectValue placeholder="القسم" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل الأقسام</SelectItem>
            {(groupsList ?? []).map((g: any) => <SelectItem key={g.id} value={String(g.id)}>{g.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Select All for new orders */}
      {orders.some((o: any) => o.status === 'new') && (
        <div className="flex items-center gap-2">
          <Checkbox
            checked={selectedOrders.length > 0 && selectedOrders.length === orders.filter((o: any) => o.status === 'new').length}
            onCheckedChange={toggleSelectAll}
          />
          <span className="text-sm text-gray-600">تحديد كل الأوردرات الجديدة</span>
        </div>
      )}

      {/* Orders List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => (
            <div key={i} className="bg-white rounded-xl p-4 animate-pulse border">
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
              <div className="h-3 bg-gray-100 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className="bg-white rounded-xl p-10 text-center border shadow-sm">
          <ShoppingCart className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 font-medium">لا توجد أوردرات</p>
        </div>
      ) : (
        <div className="space-y-2">
          {orders.map((order: any) => {
            const statusConf = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.new;
            const isExpanded = expandedOrder === order.id;
            const canAct = order.status === "new" || order.status === "postponed";
            const isSelected = selectedOrders.includes(order.id);

            return (
              <div key={order.id} className={`bg-white rounded-xl border shadow-sm overflow-hidden ${isSelected ? 'ring-2 ring-amber-400' : ''}`}>
                <div className="p-4 cursor-pointer" onClick={() => setExpandedOrder(isExpanded ? null : order.id)}>
                  <div className="flex items-start gap-3">
                    {order.status === 'new' && (
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleSelect(order.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-gray-900">{order.customerName}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${statusConf.bg} ${statusConf.color}`}>
                          {statusConf.label}
                        </span>
                        {order.assignedEmployeeId && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                            {(employeesList ?? []).find((e: any) => e.id === order.assignedEmployeeId)?.name ?? "—"}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1.5 text-sm text-gray-500">
                        <span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" /><span dir="ltr">{order.customerPhone}</span></span>
                        <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{order.governorate}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-sm">
                        <span className="text-gray-600"><Package className="h-3.5 w-3.5 inline ml-1" />{order.productName}</span>
                        <span className="font-semibold text-amber-700">{Number(order.totalAmount).toLocaleString()} ج.م</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className="text-xs text-gray-400 font-mono">{order.orderNumber}</span>
                      {isExpanded ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t bg-gray-50 px-4 py-3 space-y-3">
                    <div>
                      <p className="text-xs text-gray-400 mb-1">العنوان</p>
                      <p className="text-sm text-gray-700">{order.customerAddress}</p>
                    </div>
                    {order.notes && (
                      <div>
                        <p className="text-xs text-gray-400 mb-1">ملاحظات</p>
                        <p className="text-sm text-gray-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">{order.notes}</p>
                      </div>
                    )}

                    {/* Assign to employee */}
                    {order.status === 'new' && !order.assignedEmployeeId && (
                      <div className="flex items-center gap-2">
                        <Select onValueChange={(val) => {
                          assignMutation.mutate({ orderId: order.id, employeeId: parseInt(val) });
                        }}>
                          <SelectTrigger className="flex-1 bg-white"><SelectValue placeholder="توزيع على موظف..." /></SelectTrigger>
                          <SelectContent>
                            {agents.map((emp: any) => (
                              <SelectItem key={emp.id} value={emp.id.toString()}>{emp.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {canAct && (
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" className="flex-1 bg-green-600 hover:bg-green-700 text-white h-9" onClick={() => confirmMutation.mutate({ orderId: order.id })} disabled={confirmMutation.isPending}>
                          <CheckCircle2 className="h-4 w-4 ml-1" />تأكيد
                        </Button>
                        <Button size="sm" variant="outline" className="flex-1 border-amber-300 text-amber-700 hover:bg-amber-50 h-9" onClick={() => { setPostponeDialog({ open: true, orderId: order.id }); setPostponeDate(""); setPostponeNotes(""); }}>
                          <Clock className="h-4 w-4 ml-1" />تأجيل
                        </Button>
                        <Button size="sm" variant="outline" className="flex-1 border-red-300 text-red-600 hover:bg-red-50 h-9" onClick={() => { setCancelDialog({ open: true, orderId: order.id }); setCancelReason(""); setCancelNotes(""); }}>
                          <XCircle className="h-4 w-4 ml-1" />إلغاء
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
          <DialogHeader><DialogTitle>توزيع {selectedOrders.length} أوردر</DialogTitle></DialogHeader>
          <div>
            <Label>اختر الموظف</Label>
            <Select value={assignEmployeeId} onValueChange={setAssignEmployeeId}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="اختر موظف..." /></SelectTrigger>
              <SelectContent>
                {agents.map((emp: any) => (
                  <SelectItem key={emp.id} value={emp.id.toString()}>{emp.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignDialog(false)}>إلغاء</Button>
            <Button onClick={handleBulkAssign} disabled={bulkAssignMutation.isPending} className="bg-amber-600 hover:bg-amber-700 text-white">
              {bulkAssignMutation.isPending ? "جاري..." : "توزيع"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Postpone Dialog */}
      <Dialog open={postponeDialog.open} onOpenChange={open => setPostponeDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Clock className="h-5 w-5 text-amber-600" />تأجيل الأوردر</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>تاريخ الاتصال مرة أخرى <span className="text-destructive">*</span></Label>
              <Input type="date" value={postponeDate} onChange={e => setPostponeDate(e.target.value)} min={new Date().toISOString().split("T")[0]} className="mt-1" />
            </div>
            <div>
              <Label>ملاحظة (اختياري)</Label>
              <Input value={postponeNotes} onChange={e => setPostponeNotes(e.target.value)} placeholder="سبب التأجيل..." className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPostponeDialog({ open: false, orderId: null })}>إلغاء</Button>
            <Button onClick={() => {
              if (!postponeDate) { toast.error("حدد التاريخ"); return; }
              if (!postponeDialog.orderId) return;
              postponeMutation.mutate({ orderId: postponeDialog.orderId, postponedTo: new Date(postponeDate), notes: postponeNotes || undefined });
            }} disabled={postponeMutation.isPending} className="bg-amber-600 hover:bg-amber-700 text-white">
              {postponeMutation.isPending ? "جاري..." : "تأجيل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Dialog */}
      <Dialog open={cancelDialog.open} onOpenChange={open => setCancelDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><XCircle className="h-5 w-5 text-red-600" />إلغاء الأوردر</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>سبب الإلغاء <span className="text-destructive">*</span></Label>
              <Select value={cancelReason} onValueChange={setCancelReason}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="اختر السبب..." /></SelectTrigger>
                <SelectContent>
                  {CANCEL_REASONS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>ملاحظة (اختياري)</Label>
              <Input value={cancelNotes} onChange={e => setCancelNotes(e.target.value)} placeholder="تفاصيل..." className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelDialog({ open: false, orderId: null })}>رجوع</Button>
            <Button onClick={() => {
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
  const [movementDialog, setMovementDialog] = useState<{ open: boolean; productId: number | null; type: "in" | "out" }>({ open: false, productId: null, type: "in" });
  const [movementQty, setMovementQty] = useState("");
  const [movementReason, setMovementReason] = useState("");

  const utils = trpc.useUtils();

  const { data: products, isLoading } = trpc.employeePortal.productsList.useQuery();
  const { data: lowStock } = trpc.employeePortal.lowStockProducts.useQuery();
  const { data: movements } = trpc.employeePortal.inventoryMovements.useQuery({ limit: 50 });

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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">المخزون</h1>

      {/* Products Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1,2,3].map(i => <div key={i} className="bg-white rounded-xl p-4 animate-pulse border h-32" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {(products ?? []).map((p: any) => {
            const isLow = p.currentStock <= p.minStockLevel;
            return (
              <Card key={p.id} className={isLow ? "border-red-200 bg-red-50/50" : ""}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="font-bold text-gray-900">{p.name}</p>
                      <p className="text-xs text-gray-400 font-mono">{p.sku}</p>
                    </div>
                    {isLow && <AlertTriangle className="h-5 w-5 text-red-500" />}
                  </div>
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-2xl font-bold text-gray-900">{p.currentStock}</p>
                      <p className="text-xs text-gray-500">الحد الأدنى: {p.minStockLevel}</p>
                    </div>
                    <p className="text-sm font-semibold text-amber-700">{Number(p.price).toLocaleString()} ج.م</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="flex-1 text-green-700 border-green-300 hover:bg-green-50" onClick={() => setMovementDialog({ open: true, productId: p.id, type: "in" })}>
                      + وارد
                    </Button>
                    <Button size="sm" variant="outline" className="flex-1 text-red-700 border-red-300 hover:bg-red-50" onClick={() => setMovementDialog({ open: true, productId: p.id, type: "out" })}>
                      - صادر
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Recent Movements */}
      {movements && movements.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-lg">آخر الحركات</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {movements.map((m: any) => (
                <div key={m.id} className="flex items-center justify-between text-sm py-2 border-b last:border-0">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${m.type === 'in' ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span className="text-gray-700">{(products ?? []).find((p: any) => p.id === m.productId)?.name ?? "—"}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`font-bold ${m.type === 'in' ? 'text-green-600' : 'text-red-600'}`}>
                      {m.type === 'in' ? '+' : '-'}{m.quantity}
                    </span>
                    {m.reason && <span className="text-xs text-gray-400">{m.reason}</span>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Movement Dialog */}
      <Dialog open={movementDialog.open} onOpenChange={open => setMovementDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle>{movementDialog.type === "in" ? "إضافة وارد" : "تسجيل صادر"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>الكمية <span className="text-destructive">*</span></Label>
              <Input type="number" min="1" value={movementQty} onChange={e => setMovementQty(e.target.value)} className="mt-1" />
            </div>
            <div>
              <Label>السبب (اختياري)</Label>
              <Input value={movementReason} onChange={e => setMovementReason(e.target.value)} placeholder="مثال: شحنة جديدة..." className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMovementDialog({ open: false, productId: null, type: "in" })}>إلغاء</Button>
            <Button onClick={() => {
              if (!movementQty || parseInt(movementQty) < 1) { toast.error("أدخل كمية صحيحة"); return; }
              if (!movementDialog.productId) return;
              addMovementMutation.mutate({
                productId: movementDialog.productId,
                type: movementDialog.type,
                quantity: parseInt(movementQty),
                reason: movementReason || undefined,
              });
            }} disabled={addMovementMutation.isPending} className={movementDialog.type === "in" ? "bg-green-600 hover:bg-green-700 text-white" : "bg-red-600 hover:bg-red-700 text-white"}>
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
  const [dateRange, setDateRange] = useState<"today" | "week" | "month">("month");

  const dateParams = useMemo(() => {
    const now = new Date();
    const from = new Date();
    if (dateRange === "today") from.setHours(0, 0, 0, 0);
    else if (dateRange === "week") from.setDate(now.getDate() - 7);
    else from.setMonth(now.getMonth() - 1);
    return { dateFrom: from, dateTo: now };
  }, [dateRange]);

  const { data: performance } = trpc.employeePortal.employeePerformance.useQuery(dateParams);
  const { data: cancellations } = trpc.employeePortal.cancellationReasons.useQuery(dateParams);
  const { data: dailyChart } = trpc.employeePortal.dailyChart.useQuery({ days: 30 });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-900">التقارير</h1>
        <div className="flex gap-2">
          {[
            { key: "today", label: "اليوم" },
            { key: "week", label: "أسبوع" },
            { key: "month", label: "شهر" },
          ].map(d => (
            <button
              key={d.key}
              onClick={() => setDateRange(d.key as any)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                dateRange === d.key ? "bg-amber-600 text-white" : "bg-white text-gray-600 border hover:border-amber-300"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Employee Performance */}
      {performance && performance.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-lg">أداء الموظفين</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-gray-500">
                    <th className="text-right py-2 px-3">الموظف</th>
                    <th className="text-center py-2 px-3">الإجمالي</th>
                    <th className="text-center py-2 px-3">مؤكد</th>
                    <th className="text-center py-2 px-3">ملغي</th>
                    <th className="text-center py-2 px-3">مؤجل</th>
                    <th className="text-center py-2 px-3">نسبة التأكيد</th>
                  </tr>
                </thead>
                <tbody>
                  {performance.map((p: any, i: number) => (
                    <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="py-2 px-3 font-medium">{p.employeeName}</td>
                      <td className="text-center py-2 px-3">{p.total}</td>
                      <td className="text-center py-2 px-3 text-green-600 font-semibold">{p.confirmed}</td>
                      <td className="text-center py-2 px-3 text-red-600">{p.cancelled}</td>
                      <td className="text-center py-2 px-3 text-amber-600">{p.postponed}</td>
                      <td className="text-center py-2 px-3">
                        <span className={`font-bold ${p.confirmRate >= 50 ? 'text-green-600' : 'text-red-600'}`}>
                          {p.confirmRate}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Cancellation Reasons */}
      {cancellations && cancellations.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-lg">أسباب الإلغاء</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-3">
              {cancellations.map((c: any, i: number) => {
                const total = cancellations.reduce((s: number, x: any) => s + Number(x.count), 0);
                const pct = total > 0 ? Math.round((Number(c.count) / total) * 100) : 0;
                const reasonLabel = CANCEL_REASONS.find(r => r.value === c.cancelReason)?.label ?? c.cancelReason;
                return (
                  <div key={i}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-gray-700">{reasonLabel}</span>
                      <span className="font-bold text-gray-900">{c.count} ({pct}%)</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div className="bg-red-400 h-2 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ==================== EMPLOYEES TAB ====================
function ManagerEmployeesTab() {
  const [addDialog, setAddDialog] = useState(false);
  const [credDialog, setCredDialog] = useState<{ open: boolean; empId: number | null; empName: string }>({ open: false, empId: null, empName: "" });
  const [newEmp, setNewEmp] = useState({ name: "", phone: "", role: "agent" as "agent" | "warehouse" | "manager" });
  const [credUsername, setCredUsername] = useState("");
  const [credPassword, setCredPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const utils = trpc.useUtils();

  const { data: employeesList, isLoading } = trpc.employeePortal.employeesList.useQuery();

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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">الموظفين</h1>
        <Button onClick={() => setAddDialog(true)} className="bg-amber-600 hover:bg-amber-700 text-white">
          <UserPlus className="h-4 w-4 ml-2" />
          إضافة موظف
        </Button>
      </div>

      {/* Employee Login Link */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <p className="text-sm text-amber-800 font-medium mb-1">رابط دخول الموظفين:</p>
        <code className="text-sm bg-white px-3 py-1 rounded border border-amber-200 text-amber-900 select-all" dir="ltr">
          {window.location.origin}/employee-login
        </code>
      </div>

      {/* Employees List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => <div key={i} className="bg-white rounded-xl p-4 animate-pulse border h-20" />)}
        </div>
      ) : (
        <div className="space-y-3">
          {(employeesList ?? []).map((emp: any) => (
            <Card key={emp.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm ${
                      emp.role === 'manager' ? 'bg-purple-500' : emp.role === 'warehouse' ? 'bg-blue-500' : 'bg-amber-600'
                    }`}>
                      {emp.name.charAt(0)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-gray-900">{emp.name}</span>
                        <Badge variant={emp.isActive ? "default" : "secondary"} className="text-xs">
                          {emp.isActive ? "نشط" : "موقوف"}
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {ROLE_LABELS[emp.role] ?? emp.role}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
                        {emp.phone && <span>{emp.phone}</span>}
                        {emp.username && <span className="font-mono text-xs bg-gray-100 px-2 py-0.5 rounded">@{emp.username}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!emp.username && (
                      <Button size="sm" variant="outline" onClick={() => {
                        setCredDialog({ open: true, empId: emp.id, empName: emp.name });
                        setCredUsername(""); setCredPassword("");
                      }}>
                        <Key className="h-3.5 w-3.5 ml-1" />
                        تعيين دخول
                      </Button>
                    )}
                    {emp.username && (
                      <Button size="sm" variant="outline" onClick={() => {
                        setCredDialog({ open: true, empId: emp.id, empName: emp.name });
                        setCredUsername(emp.username); setCredPassword("");
                      }}>
                        <Key className="h-3.5 w-3.5 ml-1" />
                        تغيير كلمة المرور
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={emp.isActive ? "destructive" : "default"}
                      onClick={() => updateMutation.mutate({ id: emp.id, isActive: !emp.isActive })}
                    >
                      {emp.isActive ? "إيقاف" : "تفعيل"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add Employee Dialog */}
      <Dialog open={addDialog} onOpenChange={setAddDialog}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader><DialogTitle>إضافة موظف جديد</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>الاسم <span className="text-destructive">*</span></Label>
              <Input value={newEmp.name} onChange={e => setNewEmp(p => ({ ...p, name: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label>الهاتف</Label>
              <Input value={newEmp.phone} onChange={e => setNewEmp(p => ({ ...p, phone: e.target.value }))} className="mt-1" dir="ltr" />
            </div>
            <div>
              <Label>الدور</Label>
              <Select value={newEmp.role} onValueChange={(v: any) => setNewEmp(p => ({ ...p, role: v }))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">موظف خدمة عملاء</SelectItem>
                  <SelectItem value="warehouse">مخزن</SelectItem>
                  <SelectItem value="manager">مدير</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialog(false)}>إلغاء</Button>
            <Button onClick={() => {
              if (!newEmp.name.trim()) { toast.error("أدخل اسم الموظف"); return; }
              createMutation.mutate({ name: newEmp.name, phone: newEmp.phone || undefined, role: newEmp.role });
            }} disabled={createMutation.isPending} className="bg-amber-600 hover:bg-amber-700 text-white">
              {createMutation.isPending ? "جاري..." : "إضافة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Credentials Dialog */}
      <Dialog open={credDialog.open} onOpenChange={open => setCredDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader><DialogTitle>بيانات دخول {credDialog.empName}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>اسم المستخدم <span className="text-destructive">*</span></Label>
              <Input value={credUsername} onChange={e => setCredUsername(e.target.value)} className="mt-1" dir="ltr" />
            </div>
            <div>
              <Label>كلمة المرور <span className="text-destructive">*</span></Label>
              <div className="relative mt-1">
                <Input
                  type={showPassword ? "text" : "password"}
                  value={credPassword}
                  onChange={e => setCredPassword(e.target.value)}
                  className="pl-10"
                  dir="ltr"
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCredDialog({ open: false, empId: null, empName: "" })}>إلغاء</Button>
            <Button onClick={() => {
              if (!credUsername.trim() || !credPassword.trim()) { toast.error("أدخل اسم المستخدم وكلمة المرور"); return; }
              if (!credDialog.empId) return;
              setCredMutation.mutate({ id: credDialog.empId, username: credUsername.trim(), password: credPassword });
            }} disabled={setCredMutation.isPending} className="bg-amber-600 hover:bg-amber-700 text-white">
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
  const utils = trpc.useUtils();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [newTask, setNewTask] = useState({ title: "", description: "", assignedTo: "" });

  const { data: employeesList } = trpc.employeePortal.employeesList.useQuery();
  const { data: tasksList, isLoading } = trpc.tasks.list.useQuery({ status: statusFilter });

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

  const TASK_STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
    new: { label: "جديدة", color: "text-blue-700", bg: "bg-blue-50 border-blue-200" },
    in_progress: { label: "قيد التنفيذ", color: "text-amber-700", bg: "bg-amber-50 border-amber-200" },
    done: { label: "تمت", color: "text-green-700", bg: "bg-green-50 border-green-200" },
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold text-gray-900">توزيع المهام</h1>
        <Button onClick={() => setShowCreateDialog(true)} className="bg-amber-600 hover:bg-amber-700 text-white">
          <Plus className="h-4 w-4 ml-2" />
          إنشاء مهمة جديدة
        </Button>
      </div>

      {/* Status Filter */}
      <div className="flex gap-2 flex-wrap">
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
            onClick={() => setStatusFilter(f.key)}
            className={statusFilter === f.key ? "bg-amber-600 hover:bg-amber-700 text-white" : ""}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {/* Tasks List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => <div key={i} className="bg-white rounded-xl p-4 animate-pulse border h-24" />)}
        </div>
      ) : (tasksList ?? []).length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <FileText className="h-12 w-12 mx-auto mb-3 text-gray-300" />
          <p className="font-medium">لا توجد مهام</p>
          <p className="text-sm">أنشئ مهمة جديدة لتوزيعها على الموظفين</p>
        </div>
      ) : (
        <div className="space-y-3">
          {(tasksList ?? []).map((task: any) => {
            const statusConf = TASK_STATUS_CONFIG[task.status] ?? TASK_STATUS_CONFIG.new;
            return (
              <Card key={task.id} className="hover:shadow-sm transition-shadow">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h3 className="font-bold text-gray-900">{task.title}</h3>
                        <Badge className={`${statusConf.bg} ${statusConf.color} border text-xs`}>
                          {statusConf.label}
                        </Badge>
                      </div>
                      {task.description && (
                        <p className="text-sm text-gray-600 mb-2 leading-relaxed">{task.description}</p>
                      )}
                      <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
                        <span className="flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {task.assignedToName ?? "جميع الموظفين"}
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {new Date(task.createdAt).toLocaleDateString('ar-EG')}
                        </span>
                        <span className="text-gray-400">بواسطة: {task.createdByName}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {/* Status change dropdown */}
                      <Select
                        value={task.status}
                        onValueChange={(v: any) => updateStatusMutation.mutate({ taskId: task.id, status: v })}
                      >
                        <SelectTrigger className="w-32 text-xs h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="new">جديدة</SelectItem>
                          <SelectItem value="in_progress">قيد التنفيذ</SelectItem>
                          <SelectItem value="done">تمت</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-600 border-red-200 hover:bg-red-50 h-8"
                        onClick={() => {
                          if (confirm("هل أنت متأكد من حذف هذه المهمة؟")) {
                            deleteMutation.mutate({ taskId: task.id });
                          }
                        }}
                      >
                        <XCircle className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create Task Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle>إنشاء مهمة جديدة</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>عنوان المهمة <span className="text-destructive">*</span></Label>
              <Input
                value={newTask.title}
                onChange={e => setNewTask(p => ({ ...p, title: e.target.value }))}
                placeholder="أدخل عنوان المهمة"
                className="mt-1"
              />
            </div>
            <div>
              <Label>وصف المهمة</Label>
              <textarea
                value={newTask.description}
                onChange={e => setNewTask(p => ({ ...p, description: e.target.value }))}
                placeholder="وصف تفصيلي للمهمة المطلوبة..."
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[80px] resize-y"
                rows={3}
              />
            </div>
            <div>
              <Label>تعيين لموظف</Label>
              <Select value={newTask.assignedTo} onValueChange={v => setNewTask(p => ({ ...p, assignedTo: v }))}>
                <SelectTrigger className="mt-1">
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
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>إلغاء</Button>
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
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {createMutation.isPending ? "جاري..." : "إنشاء المهمة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
