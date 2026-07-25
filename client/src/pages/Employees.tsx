import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Edit, Trash2, Users, UserCheck, UserX, KeyRound, Eye, EyeOff, Copy, CheckCircle2, CalendarDays, RotateCcw, Package, AlertTriangle } from "lucide-react";
import DateRangePicker, { type DateRange } from "@/components/DateRangePicker";
import { useBusinessContext } from "@/contexts/BusinessContext";

// يجب أن تطابق EMPLOYEE_ROLE_VALUES في server/permissions.ts
const EMPLOYEE_ROLES = [
  "agent", "warehouse", "manager", "facebook_entry", "scanner",
  "super_admin", "admin", "data_entry", "order_confirmation", "shipping", "accountant", "viewer",
] as const;

type EmployeeRoleValue = (typeof EMPLOYEE_ROLES)[number];

const ROLE_LABELS: Record<EmployeeRoleValue, string> = {
  agent: "موظف تأكيدات",
  warehouse: "موظف مخزن",
  manager: "مدير",
  facebook_entry: "إدخال فيسبوك",
  scanner: "موظف اسكان",
  super_admin: "مسؤول عام",
  admin: "مسؤول إداري",
  data_entry: "إدخال بيانات",
  order_confirmation: "تأكيد الطلبات",
  shipping: "شحن",
  accountant: "محاسب",
  viewer: "مشاهدة فقط",
};

const ROLE_COLORS: Record<EmployeeRoleValue, string> = {
  agent: "bg-blue-100 text-blue-700",
  warehouse: "bg-purple-100 text-purple-700",
  manager: "bg-amber-100 text-amber-700",
  facebook_entry: "bg-indigo-100 text-indigo-700",
  scanner: "bg-green-100 text-green-700",
  super_admin: "bg-red-100 text-red-700",
  admin: "bg-amber-100 text-amber-700",
  data_entry: "bg-cyan-100 text-cyan-700",
  order_confirmation: "bg-teal-100 text-teal-700",
  shipping: "bg-sky-100 text-sky-700",
  accountant: "bg-emerald-100 text-emerald-700",
  viewer: "bg-gray-100 text-gray-700",
};

const ALL_ROLES = EMPLOYEE_ROLES;

type EmployeeForm = {
  name: string;
  phone: string;
  email: string;
  role: EmployeeRoleValue;
};

const defaultForm: EmployeeForm = {
  name: "", phone: "", email: "", role: "agent",
};

function formatLastLogin(value: unknown): string {
  if (!value) return "لم يسجل الدخول بعد";
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return "لم يسجل الدخول بعد";
  return date.toLocaleString("ar-EG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function Employees() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const isAdmin = user?.role === 'admin';
  const { currentBusinessId } = useBusinessContext();

  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<EmployeeForm>(defaultForm);

  // Password dialog state
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [passwordEmpId, setPasswordEmpId] = useState<number | null>(null);
  const [passwordEmpName, setPasswordEmpName] = useState("");
  const [credUsername, setCredUsername] = useState("");
  const [credPassword, setCredPassword] = useState("");
  const [showCredPassword, setShowCredPassword] = useState(false);
  const [credSaved, setCredSaved] = useState(false);

  // Reclaim dialog state
  const [showReclaimDialog, setShowReclaimDialog] = useState(false);
  const [reclaimEmpId, setReclaimEmpId] = useState<number | null>(null);
  const [reclaimEmpName, setReclaimEmpName] = useState("");

  // فلاتر قائمة الموظفين
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");

  const { data: employees, isLoading } = trpc.employees.list.useQuery({
    businessId: currentBusinessId ?? undefined,
    search: search.trim() ? search.trim() : undefined,
    role: roleFilter !== "all" ? (roleFilter as EmployeeRoleValue) : undefined,
    isActive: statusFilter === "all" ? undefined : statusFilter === "active",
  });

  // جرد كل الموظفين
  const { data: allInventory, isLoading: invLoading } = trpc.employees.allInventory.useQuery(undefined, {
    enabled: isAdmin,
  });

  // أداء الموظفين - فلتر تاريخ
  const [perfDateRange, setPerfDateRange] = useState<DateRange>(() => {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const to = new Date(); to.setHours(23, 59, 59, 999);
    return { from, to };
  });
  const { data: todayPerf } = trpc.reports.employeePerformance.useQuery({
    dateFrom: perfDateRange.from ?? undefined,
    dateTo: perfDateRange.to ?? undefined,
    businessId: currentBusinessId,
  });

  const createMutation = trpc.employees.create.useMutation({
    onSuccess: () => {
      toast.success("تم إضافة الموظف");
      utils.employees.list.invalidate();
      setShowDialog(false);
      setForm(defaultForm);
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMutation = trpc.employees.update.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث بيانات الموظف");
      utils.employees.list.invalidate();
      setShowDialog(false);
      setEditingId(null);
      setForm(defaultForm);
    },
    onError: (e) => toast.error(e.message),
  });

  const toggleActiveMutation = trpc.employees.update.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث حالة الموظف");
      utils.employees.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const setCredentialsMutation = trpc.employees.setCredentials.useMutation({
    onSuccess: () => {
      toast.success("تم تعيين بيانات الدخول بنجاح");
      setCredSaved(true);
      utils.employees.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // Delete state
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteEmpId, setDeleteEmpId] = useState<number | null>(null);
  const [deleteEmpName, setDeleteEmpName] = useState("");

  const deleteMutation = trpc.employees.delete.useMutation({
    onSuccess: () => {
      toast.success("تم حذف الموظف نهائياً");
      utils.employees.list.invalidate();
      utils.employees.allInventory.invalidate();
      setShowDeleteDialog(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const handleOpenDeleteDialog = (emp: any) => {
    setDeleteEmpId(emp.id);
    setDeleteEmpName(emp.name);
    setShowDeleteDialog(true);
  };

  const reclaimMutation = trpc.orders.unassignEmployeeOrders.useMutation({
    onSuccess: (data) => {
      toast.success(`تم سحب ${data.count} أوردر بنجاح`);
      utils.employees.allInventory.invalidate();
      setShowReclaimDialog(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const handleEdit = (emp: any) => {
    setEditingId(emp.id);
    setForm({
      name: emp.name,
      phone: emp.phone ?? "",
      email: emp.email ?? "",
      role: emp.role,
    });
    setShowDialog(true);
  };

  const handleOpenPasswordDialog = (emp: any) => {
    setPasswordEmpId(emp.id);
    setPasswordEmpName(emp.name);
    setCredUsername(emp.username ?? "");
    setCredPassword("");
    setShowCredPassword(false);
    setCredSaved(false);
    setShowPasswordDialog(true);
  };

  const handleOpenReclaimDialog = (emp: any) => {
    setReclaimEmpId(emp.employeeId ?? emp.id);
    setReclaimEmpName(emp.employeeName ?? emp.name);
    setShowReclaimDialog(true);
  };

  const handleSubmit = () => {
    if (!form.name.trim()) { toast.error("اسم الموظف مطلوب"); return; }
    if (editingId) {
      updateMutation.mutate({ id: editingId, ...form });
    } else {
      createMutation.mutate(form);
    }
  };

  const handleSaveCredentials = () => {
    if (!credUsername.trim()) { toast.error("اسم المستخدم مطلوب"); return; }
    if (credPassword.length < 6) { toast.error("كلمة المرور يجب أن تكون 6 أحرف على الأقل"); return; }
    if (!passwordEmpId) return;
    setCredentialsMutation.mutate({
      id: passwordEmpId,
      username: credUsername.trim(),
      password: credPassword,
    });
  };

  const handleCopyCredentials = () => {
    const text = `رابط الدخول: ${window.location.origin}/employee-login\nاسم المستخدم: ${credUsername}\nكلمة المرور: ${credPassword}`;
    navigator.clipboard.writeText(text);
    toast.success("تم نسخ بيانات الدخول");
  };

  const generatePassword = () => {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let pass = "";
    for (let i = 0; i < 8; i++) pass += chars[Math.floor(Math.random() * chars.length)];
    setCredPassword(pass);
    setShowCredPassword(true);
  };

  const handleReclaim = () => {
    if (!reclaimEmpId) return;
    reclaimMutation.mutate({ employeeId: reclaimEmpId });
  };

  const activeCount = employees?.filter(e => e.isActive).length ?? 0;
  const agentCount = employees?.filter(e => e.role === 'agent' && e.isActive).length ?? 0;
  const warehouseCount = employees?.filter(e => e.role === 'warehouse' && e.isActive).length ?? 0;

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">هذه الصفحة للمديرين فقط</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">إدارة الموظفين</h1>
          <p className="text-muted-foreground text-sm mt-1">إدارة فريق العمل وبيانات الدخول</p>
        </div>
        <Button onClick={() => { setEditingId(null); setForm(defaultForm); setShowDialog(true); }}>
          <Plus className="h-4 w-4 ml-1" />
          إضافة موظف
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-3xl font-bold text-foreground">{activeCount}</p>
            <p className="text-xs text-muted-foreground mt-1">موظف نشط</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-3xl font-bold text-blue-600">{agentCount}</p>
            <p className="text-xs text-muted-foreground mt-1">موظف تأكيدات</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-3xl font-bold text-purple-600">{warehouseCount}</p>
            <p className="text-xs text-muted-foreground mt-1">موظف مخزن</p>
          </CardContent>
        </Card>
      </div>

      {/* جرد الموظفين الفعلي */}
      {allInventory && allInventory.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="h-4 w-4 text-primary" />
              جرد الموظفين (الأوردرات الموزعة حالياً)
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="p-3 text-right font-semibold text-muted-foreground">الموظف</th>
                    <th className="p-3 text-center font-semibold text-foreground">إجمالي</th>
                    <th className="p-3 text-center font-semibold text-blue-600">جديد</th>
                    <th className="p-3 text-center font-semibold text-green-600">مؤكد</th>
                    <th className="p-3 text-center font-semibold text-yellow-600">مؤجل</th>
                    <th className="p-3 text-center font-semibold text-orange-600">لم يرد</th>
                    <th className="p-3 text-center font-semibold text-red-600">ملغي</th>
                    <th className="p-3 text-center font-semibold text-muted-foreground">تاريخ أول توزيع</th>
                    <th className="p-3 text-center font-semibold text-muted-foreground">آخر توزيع</th>
                    <th className="p-3 text-center font-semibold text-muted-foreground">إجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {allInventory.map(emp => {
                    const pendingOrders = Number(emp.newOrders ?? 0) + Number(emp.postponed ?? 0) + Number(emp.noAnswer ?? 0);
                    return (
                      <tr key={emp.employeeId} className="border-b hover:bg-muted/30 transition-colors">
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                              <span className="text-xs font-bold text-primary">{emp.employeeName.charAt(0)}</span>
                            </div>
                            <span className="font-medium text-foreground">{emp.employeeName}</span>
                          </div>
                        </td>
                        <td className="p-3 text-center">
                          <span className="font-bold text-foreground">{Number(emp.total ?? 0)}</span>
                        </td>
                        <td className="p-3 text-center">
                          <span className="font-bold text-blue-600">{Number(emp.newOrders ?? 0)}</span>
                        </td>
                        <td className="p-3 text-center">
                          <span className="font-bold text-green-600">{Number(emp.confirmed ?? 0)}</span>
                        </td>
                        <td className="p-3 text-center">
                          <span className="font-bold text-yellow-600">{Number(emp.postponed ?? 0)}</span>
                        </td>
                        <td className="p-3 text-center">
                          <span className="font-bold text-orange-600">{Number(emp.noAnswer ?? 0)}</span>
                        </td>
                        <td className="p-3 text-center">
                          <span className="font-bold text-red-600">{Number(emp.cancelled ?? 0)}</span>
                        </td>
                        <td className="p-3 text-center text-xs text-muted-foreground">
                          {emp.firstAssigned ? new Date(emp.firstAssigned).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' }) : '—'}
                        </td>
                        <td className="p-3 text-center text-xs text-muted-foreground">
                          {emp.lastAssigned ? new Date(emp.lastAssigned).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' }) : '—'}
                        </td>
                        <td className="p-3 text-center">
                          {Number(emp.total ?? 0) > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs border-red-200 text-red-700 hover:bg-red-50 gap-1"
                              onClick={() => handleOpenReclaimDialog(emp)}
                            >
                              <RotateCcw className="h-3 w-3" />
                              سحب الكل ({Number(emp.total ?? 0)})
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/30">
                    <td className="p-3 font-semibold text-foreground">الإجمالي</td>
                    <td className="p-3 text-center font-bold text-foreground">{allInventory.reduce((s, e) => s + Number(e.total ?? 0), 0)}</td>
                    <td className="p-3 text-center font-bold text-blue-600">{allInventory.reduce((s, e) => s + Number(e.newOrders ?? 0), 0)}</td>
                    <td className="p-3 text-center font-bold text-green-600">{allInventory.reduce((s, e) => s + Number(e.confirmed ?? 0), 0)}</td>
                    <td className="p-3 text-center font-bold text-yellow-600">{allInventory.reduce((s, e) => s + Number(e.postponed ?? 0), 0)}</td>
                    <td className="p-3 text-center font-bold text-orange-600">{allInventory.reduce((s, e) => s + Number(e.noAnswer ?? 0), 0)}</td>
                    <td className="p-3 text-center font-bold text-red-600">{allInventory.reduce((s, e) => s + Number(e.cancelled ?? 0), 0)}</td>
                    <td className="p-3" colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* جدول أداء الموظفين */}
      {todayPerf && todayPerf.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <CardTitle className="text-base flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                أداء الموظفين (حسب تاريخ الإنشاء)
              </CardTitle>
              <div className="flex items-center gap-2">
                <CalendarDays className="h-4 w-4 text-muted-foreground" />
                <DateRangePicker
                  value={perfDateRange}
                  onChange={(range) => setPerfDateRange(range)}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="p-3 text-right font-semibold text-muted-foreground">الموظف</th>
                    <th className="p-3 text-center font-semibold text-muted-foreground">وُزِع عليه</th>
                    <th className="p-3 text-center font-semibold text-green-700">مؤكد</th>
                    <th className="p-3 text-center font-semibold text-red-600">ملغي</th>
                    <th className="p-3 text-center font-semibold text-yellow-600">مؤجل</th>
                    <th className="p-3 text-center font-semibold text-muted-foreground">نسبة التأكيد</th>
                  </tr>
                </thead>
                <tbody>
                  {todayPerf.map(emp => (
                    <tr key={emp.employeeId} className="border-b hover:bg-muted/30 transition-colors">
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                            <span className="text-xs font-bold text-primary">{emp.employeeName.charAt(0)}</span>
                          </div>
                          <span className="font-medium text-foreground">{emp.employeeName}</span>
                        </div>
                      </td>
                      <td className="p-3 text-center">
                        <span className="font-bold text-foreground">{emp.total}</span>
                      </td>
                      <td className="p-3 text-center">
                        <span className="font-bold text-green-600">{emp.confirmed}</span>
                      </td>
                      <td className="p-3 text-center">
                        <span className="font-bold text-red-500">{emp.cancelled}</span>
                      </td>
                      <td className="p-3 text-center">
                        <span className="font-bold text-yellow-600">{emp.postponed}</span>
                      </td>
                      <td className="p-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <div className="w-16 bg-muted rounded-full h-2">
                            <div
                              className="bg-green-500 h-2 rounded-full transition-all"
                              style={{ width: `${emp.confirmRate}%` }}
                            />
                          </div>
                          <span className={`text-xs font-bold ${
                            emp.confirmRate >= 60 ? 'text-green-600' :
                            emp.confirmRate >= 40 ? 'text-yellow-600' : 'text-red-500'
                          }`}>{emp.confirmRate}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/30">
                    <td className="p-3 font-semibold text-foreground">الإجمالي</td>
                    <td className="p-3 text-center font-bold text-foreground">{todayPerf.reduce((s, e) => s + e.total, 0)}</td>
                    <td className="p-3 text-center font-bold text-green-600">{todayPerf.reduce((s, e) => s + e.confirmed, 0)}</td>
                    <td className="p-3 text-center font-bold text-red-500">{todayPerf.reduce((s, e) => s + e.cancelled, 0)}</td>
                    <td className="p-3 text-center font-bold text-yellow-600">{todayPerf.reduce((s, e) => s + e.postponed, 0)}</td>
                    <td className="p-3 text-center">
                      <span className="text-xs font-bold text-muted-foreground">
                        {todayPerf.reduce((s, e) => s + e.total, 0) > 0
                          ? Math.round((todayPerf.reduce((s, e) => s + e.confirmed, 0) / todayPerf.reduce((s, e) => s + e.total, 0)) * 100)
                          : 0}%
                      </span>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Login link info */}
      <Card className="border-amber-200 bg-amber-50/50">
        <CardContent className="p-4 flex items-center gap-3">
          <KeyRound className="h-5 w-5 text-amber-600 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-800">رابط تسجيل دخول الموظفين</p>
            <p className="text-xs text-amber-700 mt-0.5 font-mono" dir="ltr">{window.location.origin}/employee-login</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="border-amber-300 text-amber-700 hover:bg-amber-100 shrink-0"
            onClick={() => {
              navigator.clipboard.writeText(`${window.location.origin}/employee-login`);
              toast.success("تم نسخ الرابط");
            }}
          >
            <Copy className="h-3.5 w-3.5 ml-1" />
            نسخ
          </Button>
        </CardContent>
      </Card>

      {/* Employees List */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-base">قائمة الموظفين</CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="بحث بالاسم أو اسم المستخدم أو البريد"
                className="h-8 w-56 text-sm"
              />
              <Select value={roleFilter} onValueChange={setRoleFilter}>
                <SelectTrigger className="h-8 w-40 text-sm">
                  <SelectValue placeholder="كل الأدوار" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل الأدوار</SelectItem>
                  {ALL_ROLES.map(role => (
                    <SelectItem key={role} value={role}>{ROLE_LABELS[role]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={v => setStatusFilter(v as typeof statusFilter)}>
                <SelectTrigger className="h-8 w-32 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل الحالات</SelectItem>
                  <SelectItem value="active">نشط فقط</SelectItem>
                  <SelectItem value="inactive">غير نشط فقط</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">جاري التحميل...</div>
          ) : (
            <div className="divide-y">
              {employees?.map(emp => (
                <div key={emp.id} className="flex items-center gap-4 p-4 hover:bg-muted/30 transition-colors">
                  {/* Avatar */}
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <span className="text-sm font-bold text-primary">
                      {emp.name.charAt(0)}
                    </span>
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-foreground">{emp.name}</p>
                      {!emp.isActive && (
                        <Badge variant="outline" className="text-xs text-muted-foreground">غير نشط</Badge>
                      )}
                      {(emp as any).username ? (
                        <Badge variant="outline" className="text-xs text-green-600 border-green-300 bg-green-50">
                          <CheckCircle2 className="h-3 w-3 ml-1" />
                          {(emp as any).username}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-orange-600 border-orange-300 bg-orange-50">
                          بدون بيانات دخول
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      {emp.phone && (
                        <p className="text-xs text-muted-foreground" dir="ltr">{emp.phone}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        آخر دخول: {formatLastLogin((emp as any).lastLoginAt)}
                      </p>
                    </div>
                  </div>

                  {/* Role Badge */}
                  <Badge className={`${ROLE_COLORS[emp.role] ?? "bg-gray-100 text-gray-700"} border-0 text-xs shrink-0`}>
                    {ROLE_LABELS[emp.role] ?? emp.role}
                  </Badge>

                  {/* Actions */}
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                      onClick={() => handleOpenPasswordDialog(emp)}
                      title="تعيين بيانات الدخول"
                    >
                      <KeyRound className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0"
                      onClick={() => handleEdit(emp)}
                      title="تعديل"
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={`h-8 w-8 p-0 ${emp.isActive ? 'text-destructive hover:text-destructive hover:bg-destructive/10' : 'text-green-600 hover:text-green-700 hover:bg-green-50'}`}
                      onClick={() => toggleActiveMutation.mutate({ id: emp.id, isActive: !emp.isActive })}
                      title={emp.isActive ? "تعطيل" : "تفعيل"}
                    >
                      {emp.isActive ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                      onClick={() => handleOpenDeleteDialog(emp)}
                      title="حذف نهائي"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
              {(!employees || employees.length === 0) && (
                <div className="p-8 text-center text-muted-foreground">
                  {search || roleFilter !== "all" || statusFilter !== "all"
                    ? "لا يوجد موظفون مطابقون لهذا البحث/الفلتر."
                    : "لا يوجد موظفون. أضف موظفاً جديداً للبدء."}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? "تعديل بيانات الموظف" : "إضافة موظف جديد"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>الاسم <span className="text-destructive">*</span></Label>
              <Input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="الاسم الكامل"
                className="mt-1"
              />
            </div>
            <div>
              <Label>رقم الهاتف</Label>
              <Input
                value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="01xxxxxxxxx"
                className="mt-1"
                dir="ltr"
              />
            </div>
            <div>
              <Label>البريد الإلكتروني</Label>
              <Input
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="example@email.com"
                className="mt-1"
                dir="ltr"
              />
            </div>
            <div>
              <Label>الدور الوظيفي</Label>
              <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v as any }))}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALL_ROLES.map(role => (
                    <SelectItem key={role} value={role}>{ROLE_LABELS[role]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowDialog(false); setEditingId(null); setForm(defaultForm); }}>
              إلغاء
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {editingId ? "حفظ التعديلات" : "إضافة الموظف"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password / Credentials Dialog */}
      <Dialog open={showPasswordDialog} onOpenChange={open => { setShowPasswordDialog(open); if (!open) setCredSaved(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-amber-600" />
              بيانات دخول: {passwordEmpName}
            </DialogTitle>
          </DialogHeader>

          {credSaved ? (
            <div className="space-y-4">
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
                <CheckCircle2 className="h-8 w-8 text-green-600 mx-auto mb-2" />
                <p className="font-semibold text-green-800">تم حفظ بيانات الدخول بنجاح!</p>
                <p className="text-sm text-green-700 mt-1">يمكن للموظف الآن تسجيل الدخول</p>
              </div>
              <div className="bg-muted rounded-lg p-3 space-y-2 text-sm font-mono">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">الرابط:</span>
                  <span className="text-xs" dir="ltr">{window.location.origin}/employee-login</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">اسم المستخدم:</span>
                  <span dir="ltr">{credUsername}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">كلمة المرور:</span>
                  <span dir="ltr">{credPassword}</span>
                </div>
              </div>
              <Button className="w-full" variant="outline" onClick={handleCopyCredentials}>
                <Copy className="h-4 w-4 ml-2" />
                نسخ بيانات الدخول
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                عيّن اسم مستخدم وكلمة مرور للموظف لتمكينه من الدخول لمساحة العمل.
              </p>

              {/* Username */}
              <div>
                <Label>اسم المستخدم <span className="text-destructive">*</span></Label>
                <Input
                  value={credUsername}
                  onChange={e => setCredUsername(e.target.value)}
                  placeholder="مثال: ahmed.agent"
                  className="mt-1"
                  dir="ltr"
                />
                <p className="text-xs text-muted-foreground mt-1">لاتين وأرقام ونقطة فقط، بدون مسافات</p>
              </div>

              {/* Password */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <Label>كلمة المرور <span className="text-destructive">*</span></Label>
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={generatePassword}
                  >
                    توليد تلقائي
                  </button>
                </div>
                <div className="relative">
                  <Input
                    type={showCredPassword ? "text" : "password"}
                    value={credPassword}
                    onChange={e => setCredPassword(e.target.value)}
                    placeholder="6 أحرف على الأقل"
                    className="pl-10"
                    dir="ltr"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCredPassword(!showCredPassword)}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showCredPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowPasswordDialog(false); setCredSaved(false); }}>
              {credSaved ? "إغلاق" : "إلغاء"}
            </Button>
            {!credSaved && (
              <Button
                onClick={handleSaveCredentials}
                disabled={setCredentialsMutation.isPending}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {setCredentialsMutation.isPending ? "جاري الحفظ..." : "حفظ بيانات الدخول"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Employee Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-red-500" />
              حذف الموظف: {deleteEmpName}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <p className="text-sm text-red-800 font-medium">
                سيتم حذف بيانات <strong>{deleteEmpName}</strong> نهائياً من النظام.
              </p>
              <p className="text-xs text-red-700 mt-2">
                تأكد أنك سحبت جميع أوردراته أولاً قبل الحذف. هذا الإجراء لا يمكن التراجع عنه.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              إلغاء
            </Button>
            <Button
              onClick={() => deleteEmpId && deleteMutation.mutate({ id: deleteEmpId })}
              disabled={deleteMutation.isPending}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleteMutation.isPending ? "جاري الحذف..." : "حذف نهائي"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reclaim Orders Dialog */}
      <Dialog open={showReclaimDialog} onOpenChange={setShowReclaimDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-orange-500" />
              استرداد أوردرات: {reclaimEmpName}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <p className="text-sm text-red-800 font-medium">
                سيتم سحب كل الأوردرات من هذا الموظف (بما فيها المؤكدة والمطبوعة) وإرجاعها للوحة التحكم بدون توزيع.
              </p>
              <p className="text-xs text-red-700 mt-2">
                هذا الإجراء لا يمكن التراجع عنه.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReclaimDialog(false)}>
              إلغاء
            </Button>
            <Button
              onClick={handleReclaim}
              disabled={reclaimMutation.isPending}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {reclaimMutation.isPending ? "جاري السحب..." : "تأكيد سحب الكل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
