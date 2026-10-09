import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Edit, Trash2, Users, UserCheck, UserX, KeyRound, Eye, EyeOff, Copy, CheckCircle2, CalendarDays, RotateCcw, Package, AlertTriangle, Activity } from "lucide-react";
import {
  PageHeader, StatCard, SectionCard, StatusBadge, SearchInput, ResponsiveDataTable, EmptyState, LoadingSkeleton, OfflineState, PermissionDeniedState, type Column, type StatusTone,
} from "@/components/shared";
import DateRangePicker, { type DateRange } from "@/components/DateRangePicker";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useBrandOptions } from "@/hooks/useBrandOptions";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { createInFlightGuard } from "@/components/orders/confirmGuard";

// يجب أن تطابق EMPLOYEE_ROLE_VALUES في server/permissions.ts
const EMPLOYEE_ROLES = [
  "agent", "warehouse", "manager", "facebook_entry", "scanner",
  "super_admin", "admin", "data_entry", "order_confirmation", "shipping", "accountant", "viewer",
  "moderator",
] as const;

type EmployeeRoleValue = (typeof EMPLOYEE_ROLES)[number];

const ROLE_LABELS: Record<EmployeeRoleValue, string> = {
  agent: "تأكيدات",
  warehouse: "موظف مخزن",
  manager: "مدير",
  facebook_entry: "إدخال فيسبوك",
  scanner: "موظف اسكان",
  // "المالك" is the owner tier (server/permissions.ts OWNER_ROLES) — the only role
  // allowed to permanently delete orders, lock a closing period, or rewrite the
  // permission map. Named for what it means to the merchant, not for the enum value.
  super_admin: "المالك (كل الصلاحيات)",
  admin: "مسؤول إداري",
  data_entry: "إدخال بيانات",
  order_confirmation: "تأكيد الطلبات",
  shipping: "شحن",
  accountant: "محاسب",
  viewer: "مشاهدة فقط",
  moderator: "مودريتور",
};

// نغمات الهوية بدل الألوان الخام (المرحلة 7F) — الدور نفسه لا يتغيّر
const ROLE_TONES: Record<EmployeeRoleValue, StatusTone> = {
  agent: "info", warehouse: "purple", manager: "amber", facebook_entry: "cyan", scanner: "success",
  super_admin: "danger", admin: "amber", data_entry: "cyan", order_confirmation: "primary", shipping: "orange",
  accountant: "success", viewer: "neutral", moderator: "purple",
};

/**
 * الأدوار الوظيفية الخمسة اللي المالك بيختار منها عند إنشاء/تعديل موظف (طلب المالك).
 * باقي القيم في `EMPLOYEE_ROLES` قديمة — بتفضل صالحة وبتتعرض للموظفين القدام، بس مش
 * بتتعرض كخيار جديد. لو الموظف اللي بتعدّله دوره قديم، بنضيفه للقايمة عشان مايتغيّرش بالغلط.
 */
const ASSIGNABLE_ROLES = [
  "moderator", "agent", "data_entry", "accountant", "manager",
] as const satisfies readonly EmployeeRoleValue[];

const ALL_ROLES = EMPLOYEE_ROLES;

type EmployeeForm = {
  name: string;
  phone: string;
  email: string;
  role: EmployeeRoleValue;
  /** النشاط اللي هيتبعله الموظف — إجباري لما يكون فيه أكتر من نشاط (P0). */
  businessId: number | null;
};

const defaultForm: EmployeeForm = {
  name: "", phone: "", email: "", role: "agent", businessId: null,
};

const TOUCH = "min-h-11 md:min-h-9";
const ICON_BTN = "min-h-11 min-w-11 p-0 md:min-h-9 md:min-w-9 md:h-9 md:w-9";

function formatLastLogin(value: unknown): string {
  if (!value) return "لم يسجل الدخول بعد";
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return "لم يسجل الدخول بعد";
  return date.toLocaleString("ar-EG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const fmtDay = (v: unknown) => v ? new Date(v as string).toLocaleDateString("ar-EG", { day: "numeric", month: "short" }) : "—";
const n = (v: unknown) => Number(v ?? 0);

function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-full bg-accent font-bold text-accent-foreground ${size === "sm" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm"}`} aria-hidden="true">
      {name.charAt(0)}
    </span>
  );
}

function RoleBadge({ role }: { role: EmployeeRoleValue | string }) {
  return <StatusBadge status={role} label={ROLE_LABELS[role as EmployeeRoleValue] ?? role} tone={ROLE_TONES[role as EmployeeRoleValue] ?? "neutral"} size="sm" icon={null} />;
}

/**
 * إدارة الموظفين — نفس الاستعلامات والـmutations والتحقق (employees.list/allInventory/create/update/
 * setCredentials/delete + reports.employeePerformance + orders.unassignEmployeeOrders).
 * المرحلة 7F (عرض فقط): PageHeader + StatCards، جرد الموظفين والأداء عبر ResponsiveDataTable (بطاقات على
 * الهاتف)، قائمة الموظفين ببطاقات وأهداف لمس 44px، شارات الأدوار بنغمات الهوية، حوارات بمساحة زر الإغلاق،
 * حارس ضغط مكرر على كل إجراء كتابة، وحالات Loading/Empty/Offline/PermissionDenied. لا دور جديد ولا تغيير
 * في حساب الأداء — الأرقام كما يرجعها السيرفر.
 */
export default function Employees() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const isAdmin = user?.role === 'admin';
  const online = useOnlineStatus();
  const { currentBusinessId } = useBusinessContext();
  // مصدر البراند الواحد (useBrandOptions): بيختار النشاط لوحده لو واحد، وبيدّي قائمة لو
  // أكتر — مفيش اشتقاق يدوي هنا. `singleActiveBrandId` = النشاط النشط الوحيد (أو undefined).
  const { brands, selectedId: singleActiveBrandId } = useBrandOptions();
  const multiBusiness = brands.length > 1;
  const guard = useRef(createInFlightGuard<string>()).current;

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

  const { data: employees, isLoading, isError, error, refetch } = trpc.employees.list.useQuery({
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
  const { data: todayPerf, isLoading: perfLoading } = trpc.reports.employeePerformance.useQuery({
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
      businessId: emp.businessId ?? null,
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
    // بنبعت businessId **صراحةً دايمًا** لما يكون فيه نشاط نشط واحد على الأقل — عشان الباك
    // (resolveEmployeeBusinessId) ياخد فرع "requested != null" ويتخطّى فحص التعدّد. مهم:
    // قايمة activeList نشطة بس، بينما الباك بيعدّ كل الأنشطة (حتى المعطّلة) — فلو فيه نشاط
    // نشط واحد + نشاط معطّل، الباك بيشوف "أكتر من نشاط" ويرفض لو مابعتناش الـid صراحةً.
    const resolvedBusinessId = form.businessId ?? singleActiveBrandId ?? null;
    if (multiBusiness && resolvedBusinessId == null) {
      toast.error("اختر النشاط اللي هيتبعله الموظف");
      return;
    }
    const payload = {
      name: form.name, phone: form.phone, email: form.email, role: form.role,
      businessId: resolvedBusinessId ?? undefined,
    };
    if (editingId) {
      guard.run("save", updateMutation.isPending, done => updateMutation.mutate({ id: editingId, ...payload }, { onSettled: done }));
    } else {
      guard.run("save", createMutation.isPending, done => createMutation.mutate(payload, { onSettled: done }));
    }
  };

  const handleSaveCredentials = () => {
    if (!credUsername.trim()) { toast.error("اسم المستخدم مطلوب"); return; }
    if (credPassword.length < 6) { toast.error("كلمة المرور يجب أن تكون 6 أحرف على الأقل"); return; }
    if (!passwordEmpId) return;
    guard.run("cred", setCredentialsMutation.isPending, done => setCredentialsMutation.mutate({
      id: passwordEmpId,
      username: credUsername.trim(),
      password: credPassword,
    }, { onSettled: done }));
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
    guard.run("reclaim", reclaimMutation.isPending, done => reclaimMutation.mutate({ employeeId: reclaimEmpId }, { onSettled: done }));
  };

  const handleDelete = () => {
    if (!deleteEmpId) return;
    guard.run("delete", deleteMutation.isPending, done => deleteMutation.mutate({ id: deleteEmpId }, { onSettled: done }));
  };

  const handleToggleActive = (emp: any) => {
    guard.run(`toggle:${emp.id}`, toggleActiveMutation.isPending, done => toggleActiveMutation.mutate({ id: emp.id, isActive: !emp.isActive }, { onSettled: done }));
  };

  const activeCount = employees?.filter(e => e.isActive).length ?? 0;
  const agentCount = employees?.filter(e => e.role === 'agent' && e.isActive).length ?? 0;
  const warehouseCount = employees?.filter(e => e.role === 'warehouse' && e.isActive).length ?? 0;
  const hasFilters = !!search || roleFilter !== "all" || statusFilter !== "all";

  if (!isAdmin) {
    return <div className="p-4" dir="rtl"><PermissionDeniedState message="هذه الصفحة للمديرين فقط" /></div>;
  }

  const inventoryColumns: Column<any>[] = [
    { id: "employee", header: "الموظف", alwaysVisible: true, cell: e => <span className="flex items-center gap-2"><Avatar name={e.employeeName} size="sm" /><span className="font-medium">{e.employeeName}</span></span> },
    { id: "total", header: "إجمالي", numeric: true, alwaysVisible: true, cell: e => <span className="font-bold tabular-nums">{n(e.total)}</span> },
    { id: "new", header: "جديد", numeric: true, cell: e => <span className="font-bold tabular-nums text-primary">{n(e.newOrders)}</span> },
    { id: "confirmed", header: "مؤكد", numeric: true, cell: e => <span className="font-bold tabular-nums text-[var(--success)]">{n(e.confirmed)}</span> },
    { id: "postponed", header: "مؤجل", numeric: true, cell: e => <span className="font-bold tabular-nums text-[var(--warning)]">{n(e.postponed)}</span> },
    { id: "noAnswer", header: "لم يرد", numeric: true, cell: e => <span className="font-bold tabular-nums text-[var(--warning)]">{n(e.noAnswer)}</span> },
    { id: "cancelled", header: "ملغي", numeric: true, cell: e => <span className="font-bold tabular-nums text-destructive">{n(e.cancelled)}</span> },
    { id: "first", header: "تاريخ أول توزيع", cell: e => <span className="text-xs text-muted-foreground">{fmtDay(e.firstAssigned)}</span> },
    { id: "last", header: "آخر توزيع", cell: e => <span className="text-xs text-muted-foreground">{fmtDay(e.lastAssigned)}</span> },
    { id: "actions", header: <span className="sr-only">إجراء</span>, alwaysVisible: true, sticky: "end", cell: e => n(e.total) > 0 ? (
      <Button variant="outline" size="sm" className={`${TOUCH} gap-1 border-destructive/30 text-xs text-destructive hover:bg-destructive/10`} onClick={() => handleOpenReclaimDialog(e)} data-testid={`emp-reclaim-${e.employeeId}`}>
        <RotateCcw className="h-3 w-3" aria-hidden="true" /> سحب الكل ({n(e.total)})
      </Button>
    ) : null },
  ];
  const invTotals = (allInventory ?? []).reduce((acc, e) => ({ total: acc.total + n(e.total), newOrders: acc.newOrders + n(e.newOrders), confirmed: acc.confirmed + n(e.confirmed), postponed: acc.postponed + n(e.postponed), noAnswer: acc.noAnswer + n(e.noAnswer), cancelled: acc.cancelled + n(e.cancelled) }), { total: 0, newOrders: 0, confirmed: 0, postponed: 0, noAnswer: 0, cancelled: 0 });

  const rateTone = (rate: number) => rate >= 60 ? "text-[var(--success)]" : rate >= 40 ? "text-[var(--warning)]" : "text-destructive";
  const RateBar = ({ rate }: { rate: number }) => (
    <span className="flex items-center justify-end gap-2">
      <span className="h-2 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true"><span className="block h-2 rounded-full bg-[var(--success)] transition-all duration-[var(--duration-base,200ms)]" style={{ width: `${Math.max(0, Math.min(100, rate))}%` }} /></span>
      <span className={`text-xs font-bold tabular-nums ${rateTone(rate)}`}>{rate}%</span>
    </span>
  );
  const perfColumns: Column<any>[] = [
    { id: "employee", header: "الموظف", alwaysVisible: true, cell: e => <span className="flex items-center gap-2"><Avatar name={e.employeeName} size="sm" /><span className="font-medium">{e.employeeName}</span></span> },
    { id: "total", header: "وُزِع عليه", numeric: true, cell: e => <span className="font-bold tabular-nums">{e.total}</span> },
    { id: "confirmed", header: "مؤكد", numeric: true, cell: e => <span className="font-bold tabular-nums text-[var(--success)]">{e.confirmed}</span> },
    { id: "cancelled", header: "ملغي", numeric: true, cell: e => <span className="font-bold tabular-nums text-destructive">{e.cancelled}</span> },
    { id: "postponed", header: "مؤجل", numeric: true, cell: e => <span className="font-bold tabular-nums text-[var(--warning)]">{e.postponed}</span> },
    { id: "rate", header: "نسبة التأكيد", numeric: true, alwaysVisible: true, cell: e => <RateBar rate={e.confirmRate} /> },
  ];
  const perfTotal = (todayPerf ?? []).reduce((s, e) => s + e.total, 0);
  const perfConfirmed = (todayPerf ?? []).reduce((s, e) => s + e.confirmed, 0);

  return (
    <div className="space-y-6" dir="rtl" data-testid="employees-page">
      <PageHeader
        title="إدارة الموظفين"
        description="إدارة فريق العمل وبيانات الدخول"
        icon={<Users className="h-5 w-5" aria-hidden="true" />}
        primaryAction={
          <Button className={TOUCH} onClick={() => { setEditingId(null); setForm(defaultForm); setShowDialog(true); }} data-testid="emp-add">
            <Plus className="h-4 w-4 ml-1" aria-hidden="true" />
            إضافة موظف
          </Button>
        }
      >
        <section className="grid grid-cols-3 gap-3" aria-label="ملخص الفريق" data-testid="emp-summary">
          <StatCard label="موظف نشط" value={activeCount.toLocaleString("ar-EG")} loading={isLoading} hint="من قائمة الموظفين الحالية" />
          <StatCard label="موظف تأكيدات" value={agentCount.toLocaleString("ar-EG")} tone="primary" loading={isLoading} />
          <StatCard label="موظف مخزن" value={warehouseCount.toLocaleString("ar-EG")} tone="info" loading={isLoading} />
        </section>
      </PageHeader>

      {!online && <OfflineState onRetry={() => refetch()} className="py-6" />}

      {/* جرد الموظفين الفعلي */}
      {(invLoading || (allInventory && allInventory.length > 0)) && (
        <SectionCard title={<span className="inline-flex items-center gap-2"><Package className="h-4 w-4 text-primary" aria-hidden="true" /> جرد الموظفين (الأوردرات الموزعة حالياً)</span>} flush testId="emp-inventory">
          <ResponsiveDataTable<any>
            rows={allInventory ?? []}
            columns={inventoryColumns}
            rowKey={e => e.employeeId}
            loading={invLoading}
            cardsBelow="md"
            mobileRow={e => (
              <article className="space-y-2 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`emp-inventory-card-${e.employeeId}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2"><Avatar name={e.employeeName} size="sm" /><span className="font-semibold">{e.employeeName}</span></span>
                  <span className="text-sm font-bold tabular-nums">إجمالي {n(e.total)}</span>
                </div>
                <dl className="grid grid-cols-5 gap-1 text-center text-xs">
                  <div><dt className="text-muted-foreground">جديد</dt><dd className="font-bold text-primary">{n(e.newOrders)}</dd></div>
                  <div><dt className="text-muted-foreground">مؤكد</dt><dd className="font-bold text-[var(--success)]">{n(e.confirmed)}</dd></div>
                  <div><dt className="text-muted-foreground">مؤجل</dt><dd className="font-bold text-[var(--warning)]">{n(e.postponed)}</dd></div>
                  <div><dt className="text-muted-foreground">لم يرد</dt><dd className="font-bold text-[var(--warning)]">{n(e.noAnswer)}</dd></div>
                  <div><dt className="text-muted-foreground">ملغي</dt><dd className="font-bold text-destructive">{n(e.cancelled)}</dd></div>
                </dl>
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>أول توزيع {fmtDay(e.firstAssigned)} · آخر {fmtDay(e.lastAssigned)}</span>
                  {n(e.total) > 0 && <Button variant="outline" size="sm" className={`${TOUCH} gap-1 border-destructive/30 text-xs text-destructive`} onClick={() => handleOpenReclaimDialog(e)} data-testid={`emp-reclaim-${e.employeeId}`}><RotateCcw className="h-3 w-3" aria-hidden="true" /> سحب الكل</Button>}
                </div>
              </article>
            )}
          />
          {allInventory && allInventory.length > 0 && (
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-muted/30 px-4 py-2.5 text-xs" data-testid="emp-inventory-totals">
              <span className="font-semibold">الإجمالي</span>
              <span className="tabular-nums">الكل <b>{invTotals.total}</b></span>
              <span className="tabular-nums text-primary">جديد <b>{invTotals.newOrders}</b></span>
              <span className="tabular-nums text-[var(--success)]">مؤكد <b>{invTotals.confirmed}</b></span>
              <span className="tabular-nums text-[var(--warning)]">مؤجل <b>{invTotals.postponed}</b></span>
              <span className="tabular-nums text-[var(--warning)]">لم يرد <b>{invTotals.noAnswer}</b></span>
              <span className="tabular-nums text-destructive">ملغي <b>{invTotals.cancelled}</b></span>
            </p>
          )}
        </SectionCard>
      )}

      {/* جدول أداء الموظفين — الأرقام من reports.employeePerformance كما هي */}
      {(perfLoading || (todayPerf && todayPerf.length > 0)) && (
        <SectionCard
          title={<span className="inline-flex items-center gap-2"><Activity className="h-4 w-4 text-primary" aria-hidden="true" /> أداء الموظفين (حسب تاريخ الإنشاء)</span>}
          action={<span className="flex items-center gap-2 [&_button]:min-h-11 md:[&_button]:min-h-9"><CalendarDays className="h-4 w-4 text-muted-foreground" aria-hidden="true" /><DateRangePicker value={perfDateRange} onChange={(range) => setPerfDateRange(range)} /></span>}
          flush
          testId="emp-performance"
        >
          <ResponsiveDataTable<any>
            rows={todayPerf ?? []}
            columns={perfColumns}
            rowKey={e => e.employeeId}
            loading={perfLoading}
            cardsBelow="md"
            mobileRow={e => (
              <article className="space-y-2 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`emp-perf-card-${e.employeeId}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2"><Avatar name={e.employeeName} size="sm" /><span className="font-semibold">{e.employeeName}</span></span>
                  <RateBar rate={e.confirmRate} />
                </div>
                <dl className="grid grid-cols-4 gap-1 text-center text-xs">
                  <div><dt className="text-muted-foreground">وُزِع</dt><dd className="font-bold">{e.total}</dd></div>
                  <div><dt className="text-muted-foreground">مؤكد</dt><dd className="font-bold text-[var(--success)]">{e.confirmed}</dd></div>
                  <div><dt className="text-muted-foreground">ملغي</dt><dd className="font-bold text-destructive">{e.cancelled}</dd></div>
                  <div><dt className="text-muted-foreground">مؤجل</dt><dd className="font-bold text-[var(--warning)]">{e.postponed}</dd></div>
                </dl>
              </article>
            )}
          />
          {todayPerf && todayPerf.length > 0 && (
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-muted/30 px-4 py-2.5 text-xs" data-testid="emp-performance-totals">
              <span className="font-semibold">الإجمالي</span>
              <span className="tabular-nums">وُزِع <b>{perfTotal}</b></span>
              <span className="tabular-nums text-[var(--success)]">مؤكد <b>{perfConfirmed}</b></span>
              <span className="tabular-nums text-destructive">ملغي <b>{(todayPerf ?? []).reduce((s, e) => s + e.cancelled, 0)}</b></span>
              <span className="tabular-nums text-[var(--warning)]">مؤجل <b>{(todayPerf ?? []).reduce((s, e) => s + e.postponed, 0)}</b></span>
              <span className="tabular-nums text-muted-foreground">نسبة التأكيد <b>{perfTotal > 0 ? Math.round((perfConfirmed / perfTotal) * 100) : 0}%</b></span>
            </p>
          )}
        </SectionCard>
      )}

      {/* Login link info */}
      <div className="flex items-center gap-3 rounded-[var(--radius-brand-md)] border border-[var(--info)]/30 bg-[var(--info)]/5 p-4" data-testid="emp-login-link">
        <KeyRound className="h-5 w-5 shrink-0 text-[var(--info)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">رابط تسجيل دخول الموظفين</p>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" dir="ltr">{window.location.origin}/employee-login</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className={`${TOUCH} shrink-0`}
          onClick={() => {
            navigator.clipboard.writeText(`${window.location.origin}/employee-login`);
            toast.success("تم نسخ الرابط");
          }}
        >
          <Copy className="h-3.5 w-3.5 ml-1" aria-hidden="true" />
          نسخ
        </Button>
      </div>

      {/* Employees List */}
      <SectionCard
        title="قائمة الموظفين"
        action={
          <div className="flex flex-wrap items-center gap-2 [&_[role=combobox]]:min-h-11 md:[&_[role=combobox]]:min-h-9" data-testid="emp-filters">
            <SearchInput value={search} onChange={setSearch} placeholder="بحث بالاسم أو اسم المستخدم أو البريد" className="w-full sm:w-56" />
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="w-40 text-sm" aria-label="فلتر الدور">
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
              <SelectTrigger className="w-32 text-sm" aria-label="فلتر الحالة">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل الحالات</SelectItem>
                <SelectItem value="active">نشط فقط</SelectItem>
                <SelectItem value="inactive">غير نشط فقط</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
        flush
        testId="emp-list"
      >
        {isLoading ? (
          <LoadingSkeleton variant="table" rows={4} className="p-4" />
        ) : isError ? (
          <div className="p-4 text-sm text-destructive" role="alert">{(error as any)?.message ?? "تعذّر تحميل الموظفين"}</div>
        ) : !employees || employees.length === 0 ? (
          <EmptyState
            title={hasFilters ? "لا يوجد موظفون مطابقون لهذا البحث/الفلتر." : "لا يوجد موظفون"}
            description={hasFilters ? "عدّل البحث أو الفلاتر." : "أضف موظفاً جديداً للبدء."}
            icon={<Users className="h-6 w-6" aria-hidden="true" />}
          />
        ) : (
          <ul className="divide-y divide-border">
            {employees.map(emp => (
              <li key={emp.id} className="flex flex-wrap items-center gap-3 p-3 transition-colors duration-[var(--duration-fast)] hover:bg-muted/30 sm:flex-nowrap sm:p-4" data-testid={`emp-row-${emp.id}`}>
                <Avatar name={emp.name} />

                {/* Info */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{emp.name}</p>
                    <RoleBadge role={emp.role} />
                    {!emp.isActive && <StatusBadge status="inactive" label="غير نشط" tone="neutral" size="sm" icon={null} />}
                    {(emp as any).username ? (
                      <StatusBadge status="has_login" label={(emp as any).username} tone="success" size="sm" icon={<CheckCircle2 className="h-3 w-3" aria-hidden="true" />} />
                    ) : (
                      <StatusBadge status="no_login" label="بدون بيانات دخول" tone="warning" size="sm" icon={null} />
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {emp.phone && <span dir="ltr">{emp.phone}</span>}
                    <span>آخر دخول: {formatLastLogin((emp as any).lastLoginAt)}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex w-full shrink-0 justify-end gap-1 sm:w-auto" role="group" aria-label={`إجراءات ${emp.name}`}>
                  <Button variant="ghost" size="sm" className={`${ICON_BTN} text-[var(--info)] hover:bg-[var(--info)]/10 hover:text-[var(--info)]`} onClick={() => handleOpenPasswordDialog(emp)} aria-label="تعيين بيانات الدخول" title="تعيين بيانات الدخول" data-testid={`emp-cred-${emp.id}`}>
                    <KeyRound className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button variant="ghost" size="sm" className={ICON_BTN} onClick={() => handleEdit(emp)} aria-label="تعديل" title="تعديل" data-testid={`emp-edit-${emp.id}`}>
                    <Edit className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`${ICON_BTN} ${emp.isActive ? 'text-destructive hover:bg-destructive/10 hover:text-destructive' : 'text-[var(--success)] hover:bg-[var(--success)]/10 hover:text-[var(--success)]'}`}
                    onClick={() => handleToggleActive(emp)}
                    disabled={toggleActiveMutation.isPending}
                    aria-label={emp.isActive ? "تعطيل" : "تفعيل"}
                    title={emp.isActive ? "تعطيل" : "تفعيل"}
                    data-testid={`emp-toggle-${emp.id}`}
                  >
                    {emp.isActive ? <UserX className="h-4 w-4" aria-hidden="true" /> : <UserCheck className="h-4 w-4" aria-hidden="true" />}
                  </Button>
                  <Button variant="ghost" size="sm" className={`${ICON_BTN} text-destructive hover:bg-destructive/10 hover:text-destructive`} onClick={() => handleOpenDeleteDialog(emp)} aria-label="حذف نهائي" title="حذف نهائي" data-testid={`emp-delete-${emp.id}`}>
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* Add/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md" dir="rtl" data-testid="emp-form-dialog">
          <DialogHeader>
            <DialogTitle>{editingId ? "تعديل بيانات الموظف" : "إضافة موظف جديد"}</DialogTitle>
            <DialogDescription>{editingId ? "تعديل الاسم والتواصل والدور — بيانات الدخول من زر المفتاح." : "موظف جديد في الفريق؛ بيانات الدخول تُعيَّن بعد الإضافة."}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="emp-name">الاسم <span className="text-destructive">*</span></Label>
              <Input
                id="emp-name"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="الاسم الكامل"
                className={`mt-1 ${TOUCH}`}
                data-testid="emp-field-name"
              />
            </div>
            <div>
              <Label htmlFor="emp-phone">رقم الهاتف</Label>
              <Input
                id="emp-phone"
                value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="01xxxxxxxxx"
                className={`mt-1 ${TOUCH}`}
                dir="ltr"
                inputMode="tel"
              />
            </div>
            <div>
              <Label htmlFor="emp-email">البريد الإلكتروني</Label>
              <Input
                id="emp-email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="example@email.com"
                className={`mt-1 ${TOUCH}`}
                dir="ltr"
                inputMode="email"
              />
            </div>
            <div>
              <Label htmlFor="emp-role">الدور الوظيفي</Label>
              <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v as any }))}>
                <SelectTrigger id="emp-role" className={`mt-1 ${TOUCH}`} data-testid="emp-field-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* الأدوار الخمسة القياسية — وبنضيف دور الموظف الحالي لو كان قديمًا عشان مايتغيّرش بالغلط */}
                  {[...ASSIGNABLE_ROLES, ...(ASSIGNABLE_ROLES.includes(form.role as any) ? [] : [form.role])]
                    .map(role => (
                      <SelectItem key={role} value={role}>{ROLE_LABELS[role as EmployeeRoleValue]}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            {/* النشاط — بيظهر بس لما يكون فيه أكتر من نشاط (نشاط واحد بيتحدّد تلقائيًا).
                إجباري ساعتها عشان الموظف يتقيّد بنشاط واحد (P0 business isolation). */}
            {multiBusiness && (
              <div>
                <Label htmlFor="emp-business">النشاط <span className="text-destructive">*</span></Label>
                <Select
                  value={form.businessId != null ? String(form.businessId) : ""}
                  onValueChange={v => setForm(f => ({ ...f, businessId: Number(v) }))}
                >
                  <SelectTrigger id="emp-business" className={`mt-1 ${TOUCH}`} data-testid="emp-field-business">
                    <SelectValue placeholder="اختر النشاط اللي هيتبعله الموظف" />
                  </SelectTrigger>
                  <SelectContent>
                    {brands.map(b => (
                      <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className={TOUCH} onClick={() => { setShowDialog(false); setEditingId(null); setForm(defaultForm); }}>
              إلغاء
            </Button>
            <Button
              className={TOUCH}
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
              data-testid="emp-save"
            >
              {editingId ? "حفظ التعديلات" : "إضافة الموظف"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password / Credentials Dialog */}
      <Dialog open={showPasswordDialog} onOpenChange={open => { setShowPasswordDialog(open); if (!open) setCredSaved(false); }}>
        <DialogContent className="max-w-md" dir="rtl" data-testid="emp-cred-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-[var(--info)]" aria-hidden="true" />
              بيانات دخول: {passwordEmpName}
            </DialogTitle>
            <DialogDescription>عيّن اسم مستخدم وكلمة مرور للموظف لتمكينه من الدخول لمساحة العمل.</DialogDescription>
          </DialogHeader>

          {credSaved ? (
            <div className="space-y-4">
              <div className="rounded-[var(--radius-brand-md)] border border-[var(--success)]/30 bg-[var(--success)]/10 p-4 text-center" role="status">
                <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-[var(--success)]" aria-hidden="true" />
                <p className="font-semibold text-[var(--success)]">تم حفظ بيانات الدخول بنجاح!</p>
                <p className="mt-1 text-sm text-muted-foreground">يمكن للموظف الآن تسجيل الدخول — تظهر البيانات مرة واحدة هنا فقط.</p>
              </div>
              <dl className="space-y-2 rounded-[var(--radius-brand-md)] bg-muted p-3 font-mono text-sm">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">الرابط:</dt>
                  <dd className="truncate text-xs" dir="ltr">{window.location.origin}/employee-login</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">اسم المستخدم:</dt>
                  <dd dir="ltr">{credUsername}</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">كلمة المرور:</dt>
                  <dd dir="ltr">{credPassword}</dd>
                </div>
              </dl>
              <Button className={`w-full ${TOUCH}`} variant="outline" onClick={handleCopyCredentials}>
                <Copy className="h-4 w-4 ml-2" aria-hidden="true" />
                نسخ بيانات الدخول
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Username */}
              <div>
                <Label htmlFor="emp-cred-username">اسم المستخدم <span className="text-destructive">*</span></Label>
                <Input
                  id="emp-cred-username"
                  value={credUsername}
                  onChange={e => setCredUsername(e.target.value)}
                  placeholder="مثال: ahmed.agent"
                  className={`mt-1 ${TOUCH}`}
                  dir="ltr"
                  autoComplete="off"
                  data-testid="emp-cred-username"
                />
                <p className="mt-1 text-xs text-muted-foreground">لاتين وأرقام ونقطة فقط، بدون مسافات</p>
              </div>

              {/* Password */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <Label htmlFor="emp-cred-password">كلمة المرور <span className="text-destructive">*</span></Label>
                  <button
                    type="button"
                    className="min-h-11 px-2 text-xs text-primary hover:underline md:min-h-0"
                    onClick={generatePassword}
                  >
                    توليد تلقائي
                  </button>
                </div>
                <div className="relative">
                  <Input
                    id="emp-cred-password"
                    type={showCredPassword ? "text" : "password"}
                    value={credPassword}
                    onChange={e => setCredPassword(e.target.value)}
                    placeholder="6 أحرف على الأقل"
                    className={`pl-12 ${TOUCH}`}
                    dir="ltr"
                    autoComplete="new-password"
                    data-testid="emp-cred-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCredPassword(!showCredPassword)}
                    className="absolute left-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-foreground"
                    aria-label={showCredPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
                    aria-pressed={showCredPassword}
                  >
                    {showCredPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                  </button>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" className={TOUCH} onClick={() => { setShowPasswordDialog(false); setCredSaved(false); }}>
              {credSaved ? "إغلاق" : "إلغاء"}
            </Button>
            {!credSaved && (
              <Button
                className={TOUCH}
                onClick={handleSaveCredentials}
                disabled={setCredentialsMutation.isPending}
                data-testid="emp-cred-save"
              >
                {setCredentialsMutation.isPending ? "جاري الحفظ..." : "حفظ بيانات الدخول"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Employee Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent className="max-w-md" dir="rtl" data-testid="emp-delete-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="h-5 w-5 text-destructive" aria-hidden="true" />
              حذف الموظف: {deleteEmpName}
            </DialogTitle>
            <DialogDescription>حذف نهائي لا يمكن التراجع عنه.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-[var(--radius-brand-md)] border border-destructive/30 bg-destructive/10 p-4" role="alert">
              <p className="text-sm font-medium text-destructive">
                سيتم حذف بيانات <strong>{deleteEmpName}</strong> نهائياً من النظام.
              </p>
              <p className="mt-2 text-xs text-destructive">
                تأكد أنك سحبت جميع أوردراته أولاً قبل الحذف. هذا الإجراء لا يمكن التراجع عنه.
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className={TOUCH} onClick={() => setShowDeleteDialog(false)}>
              إلغاء
            </Button>
            <Button
              variant="destructive"
              className={TOUCH}
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              data-testid="emp-delete-confirm"
            >
              {deleteMutation.isPending ? "جاري الحذف..." : "حذف نهائي"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reclaim Orders Dialog */}
      <Dialog open={showReclaimDialog} onOpenChange={setShowReclaimDialog}>
        <DialogContent className="max-w-md" dir="rtl" data-testid="emp-reclaim-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-[var(--warning)]" aria-hidden="true" />
              استرداد أوردرات: {reclaimEmpName}
            </DialogTitle>
            <DialogDescription>سحب كل الأوردرات الموزّعة على هذا الموظف.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-[var(--radius-brand-md)] border border-destructive/30 bg-destructive/10 p-4" role="alert">
              <p className="text-sm font-medium text-destructive">
                سيتم سحب كل الأوردرات من هذا الموظف (بما فيها المؤكدة والمطبوعة) وإرجاعها للوحة التحكم بدون توزيع.
              </p>
              <p className="mt-2 text-xs text-destructive">
                هذا الإجراء لا يمكن التراجع عنه.
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className={TOUCH} onClick={() => setShowReclaimDialog(false)}>
              إلغاء
            </Button>
            <Button
              variant="destructive"
              className={TOUCH}
              onClick={handleReclaim}
              disabled={reclaimMutation.isPending}
              data-testid="emp-reclaim-confirm"
            >
              {reclaimMutation.isPending ? "جاري السحب..." : "تأكيد سحب الكل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
