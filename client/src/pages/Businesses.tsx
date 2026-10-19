import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, Edit, Building2, ToggleLeft, ToggleRight } from "lucide-react";
import { SetupJourney } from "@/components/SetupJourney";
import { BusinessAvatar } from "@/components/BusinessAvatar";
import { BusinessLogoField } from "@/components/BusinessLogoField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ORDER_ENTRY_MODES,
  ORDER_ENTRY_MODE_LABEL,
  type OrderEntryMode,
} from "@shared/orderEntryMode";
import { PageHeader, SectionCard, StatusBadge, ResponsiveDataTable, EmptyState, LoadingSkeleton, OfflineState, type Column } from "@/components/shared";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { createInFlightGuard } from "@/components/orders/confirmGuard";
import { toast } from "sonner";
import { AR_LOCALE } from "@/lib/format";

const TOUCH = "min-h-11 md:min-h-9";
const ICON_BTN = "min-h-11 min-w-11 p-0 md:min-h-9 md:min-w-9 md:h-9 md:w-9";

/**
 * قالب شاشة إدخال الأوردر لنشاط واحد — إعداد المالك. الموظف مالوش المسار ده أصلًا
 * (`setOrderEntryMode` إجراء أدمن بنطاق)، والقيمة بتتقرا من السيرفر مش من الواجهة.
 */
function OrderEntryModeSelect({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.businesses.orderEntryMode.useQuery({ businessId });
  const set = trpc.businesses.setOrderEntryMode.useMutation({
    onSuccess: () => {
      utils.businesses.orderEntryMode.invalidate({ businessId });
      toast.success("تم تحديث قالب الإدخال");
    },
    onError: err => toast.error(err.message),
  });
  return (
    <Select
      value={data?.mode ?? ""}
      onValueChange={v => set.mutate({ businessId, mode: v as OrderEntryMode })}
      disabled={isLoading || set.isPending}
    >
      <SelectTrigger data-readonly-write className={`${TOUCH} w-full sm:w-56`} data-testid={`entry-mode-${businessId}`} aria-label="قالب إدخال الأوردر">
        <SelectValue placeholder="..." />
      </SelectTrigger>
      <SelectContent>
        {ORDER_ENTRY_MODES.map(m => (
          <SelectItem key={m} value={m}>{ORDER_ENTRY_MODE_LABEL[m]}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * إدارة الأنشطة — نفس الاستعلامات والـmutations (businesses.list/create/update + orderEntryMode/
 * setOrderEntryMode) ونفس اشتقاق الـslug. المرحلة 7H (عرض فقط): PageHeader + SetupJourney كما هي،
 * جدول Desktop/بطاقات Mobile عبر ResponsiveDataTable، شارات الحالة، أزرار 44px، حوارات بحقول معنونة
 * وحارس ضغط مكرر، وحالات Loading/Empty/Error/Offline. التاجر الجديد يرى فراغًا واضحًا مع خطوات الإعداد.
 */
export default function Businesses() {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingBusiness, setEditingBusiness] = useState<any>(null);
  const [formData, setFormData] = useState({ name: "", slug: "" });
  const online = useOnlineStatus();
  const guard = useRef(createInFlightGuard<string>()).current;

  const { data: businesses, isLoading, isError, error, refetch } = trpc.businesses.list.useQuery();
  const utils = trpc.useUtils();

  const createMutation = trpc.businesses.create.useMutation({
    onSuccess: () => {
      utils.businesses.list.invalidate();
      utils.businesses.activeList.invalidate();
      setIsAddOpen(false);
      setFormData({ name: "", slug: "" });
      toast.success("تم إنشاء النشاط بنجاح");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const updateMutation = trpc.businesses.update.useMutation({
    onSuccess: () => {
      utils.businesses.list.invalidate();
      utils.businesses.activeList.invalidate();
      setEditingBusiness(null);
      toast.success("تم تحديث النشاط بنجاح");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const toggleMutation = trpc.businesses.update.useMutation({
    onSuccess: () => {
      utils.businesses.list.invalidate();
      utils.businesses.activeList.invalidate();
      toast.success("تم تحديث الحالة");
    },
  });

  const handleCreate = () => {
    if (!formData.name.trim()) return;
    const slug = formData.slug.trim() || formData.name.toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]/g, "");
    guard.run("create", createMutation.isPending, done => createMutation.mutate({ name: formData.name.trim(), slug }, { onSettled: done }));
  };

  const handleUpdate = () => {
    if (!editingBusiness || !formData.name.trim()) return;
    guard.run("update", updateMutation.isPending, done => updateMutation.mutate({
      id: editingBusiness.id,
      name: formData.name.trim(),
      slug: formData.slug.trim() || undefined,
    }, { onSettled: done }));
  };

  const handleToggle = (business: any) => {
    guard.run(`toggle:${business.id}`, toggleMutation.isPending, done => toggleMutation.mutate({
      id: business.id,
      isActive: !business.isActive,
    }, { onSettled: done }));
  };

  const openEdit = (business: any) => {
    setEditingBusiness(business);
    setFormData({ name: business.name, slug: business.slug || "" });
  };

  const statusBadge = (b: any) => b.isActive
    ? <StatusBadge status="active" label="نشط" tone="success" size="sm" />
    : <StatusBadge status="disabled" label="معطل" tone="neutral" size="sm" icon={null} />;

  const actions = (b: any) => (
    <span className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
      <Button variant="ghost" size="sm" className={ICON_BTN} onClick={() => openEdit(b)} aria-label={`تعديل ${b.name}`} title="تعديل" data-testid={`biz-edit-${b.id}`}>
        <Edit className="h-4 w-4" aria-hidden="true" />
      </Button>
      <Button data-readonly-write variant="ghost" size="sm" className={ICON_BTN} onClick={() => handleToggle(b)} disabled={toggleMutation.isPending} aria-label={b.isActive ? `تعطيل ${b.name}` : `تفعيل ${b.name}`} aria-pressed={!!b.isActive} title={b.isActive ? "تعطيل" : "تفعيل"} data-testid={`biz-toggle-${b.id}`}>
        {b.isActive ? <ToggleRight className="h-4 w-4 text-[var(--success)]" aria-hidden="true" /> : <ToggleLeft className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
      </Button>
    </span>
  );

  const columns: Column<any>[] = [
    { id: "id", header: "#", cell: b => <span className="tabular-nums text-muted-foreground">{b.id}</span> },
    { id: "name", header: "اسم النشاط", alwaysVisible: true, cell: b => <span className="flex items-center gap-2 font-medium"><BusinessAvatar name={b.name} logoUrl={b.logoUrl ?? null} className="h-7 w-7" textClassName="text-xs" />{b.name}</span> },
    { id: "slug", header: "Slug", cell: b => <span className="font-mono text-sm text-muted-foreground" dir="ltr">{b.slug}</span> },
    { id: "status", header: "الحالة", alwaysVisible: true, cell: statusBadge },
    { id: "created", header: "تاريخ الإنشاء", cell: b => <span className="text-sm text-muted-foreground">{b.createdAt ? new Date(b.createdAt).toLocaleDateString(AR_LOCALE) : "-"}</span> },
    { id: "entryMode", header: "قالب إدخال الأوردر", alwaysVisible: true, cell: b => <span onClick={e => e.stopPropagation()}><OrderEntryModeSelect businessId={b.id} /></span> },
    { id: "actions", header: <span className="sr-only">إجراءات</span>, alwaysVisible: true, sticky: "end", cell: actions },
  ];

  const addDialog = (
    <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
      <DialogTrigger asChild>
        <Button className={TOUCH} data-testid="biz-add">
          <Plus className="h-4 w-4 ml-2" aria-hidden="true" />
          إضافة نشاط جديد
        </Button>
      </DialogTrigger>
      <DialogContent dir="rtl" data-testid="biz-add-dialog">
        <DialogHeader>
          <DialogTitle>إضافة نشاط جديد</DialogTitle>
          <DialogDescription>كل نشاط له أوردراته ومخزنه وموظفوه وحساباته بشكل منفصل.</DialogDescription>
        </DialogHeader>
        <div className="mt-2 space-y-4">
          <div>
            <Label htmlFor="biz-name">اسم النشاط</Label>
            <Input
              id="biz-name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="مثال: فرحات للنحاس"
              className={`mt-1 ${TOUCH}`}
              data-testid="biz-field-name"
            />
          </div>
          <div>
            <Label htmlFor="biz-slug">Slug (اختياري)</Label>
            <Input
              id="biz-slug"
              value={formData.slug}
              onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
              placeholder="farhat-brass"
              className={`mt-1 ${TOUCH}`}
              dir="ltr"
            />
            <p className="mt-1 text-xs text-muted-foreground">يُستخدم كمعرف فريد. يُنشأ تلقائياً إذا تُرك فارغاً.</p>
          </div>
          <Button onClick={handleCreate} disabled={createMutation.isPending} className={`w-full ${TOUCH}`} data-testid="biz-create">
            {createMutation.isPending ? "جاري الإنشاء..." : "إنشاء النشاط"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  return (
    <div className="space-y-6" dir="rtl" data-testid="businesses-page">
      <PageHeader
        title="إدارة الأنشطة"
        description="أنشئ وأدِر البراندات/الأنشطة التجارية. كل نشاط له أوردراته ومخزنه وموظفيه وحساباته بشكل منفصل. ابدأ بإنشاء نشاط، وبعدها اربط له قنوات البيع."
        icon={<Building2 className="h-5 w-5" aria-hidden="true" />}
        primaryAction={addDialog}
      />

      <SetupJourney current="business" />

      {!online && <OfflineState onRetry={() => refetch()} className="py-6" />}

      <SectionCard title={<span className="inline-flex items-center gap-2"><Building2 className="h-5 w-5" aria-hidden="true" /> الأنشطة التجارية <span className="text-sm font-normal text-muted-foreground tabular-nums">({(businesses?.length || 0).toLocaleString(AR_LOCALE)})</span></span>} flush testId="biz-list">
        {isLoading ? (
          <LoadingSkeleton variant="table" rows={3} className="p-4" />
        ) : isError ? (
          <div className="p-4 text-sm text-destructive" role="alert">{(error as any)?.message ?? "تعذّر تحميل الأنشطة"}</div>
        ) : (businesses?.length ?? 0) === 0 ? (
          <EmptyState
            title="لا توجد أنشطة بعد"
            description="ابدأ بإنشاء أول نشاط تجاري (براند/فرع) — بعدها تقدر تربطله قنوات بيع وتستقبل أوردرات."
            icon={<Building2 className="h-6 w-6" aria-hidden="true" />}
            action={<Button className={TOUCH} onClick={() => setIsAddOpen(true)} data-testid="biz-add-empty"><Plus className="h-4 w-4 ml-2" aria-hidden="true" /> إنشاء أول نشاط</Button>}
          />
        ) : (
          <ResponsiveDataTable<any>
            rows={businesses ?? []}
            columns={columns}
            rowKey={b => b.id}
            cardsBelow="md"
            mobileRow={b => (
              <article className="space-y-3 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`biz-card-${b.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2"><BusinessAvatar name={b.name} logoUrl={b.logoUrl ?? null} className="h-9 w-9" textClassName="text-sm" /><span className="min-w-0"><span className="block truncate font-semibold">{b.name}</span><span className="block font-mono text-xs text-muted-foreground" dir="ltr">{b.slug}</span></span></span>
                  {statusBadge(b)}
                </div>
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">قالب إدخال الأوردر</p>
                  <OrderEntryModeSelect businessId={b.id} />
                </div>
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>أُنشئ {b.createdAt ? new Date(b.createdAt).toLocaleDateString(AR_LOCALE) : "-"}</span>
                  {actions(b)}
                </div>
              </article>
            )}
          />
        )}
      </SectionCard>

      {/* Edit Dialog */}
      <Dialog open={!!editingBusiness} onOpenChange={(open) => !open && setEditingBusiness(null)}>
        <DialogContent dir="rtl" data-testid="biz-edit-dialog">
          <DialogHeader>
            <DialogTitle>تعديل النشاط</DialogTitle>
            <DialogDescription>الاسم والشعار والـslug — بلا تأثير على الأوردرات أو المخزون.</DialogDescription>
          </DialogHeader>
          <div className="mt-2 space-y-4">
            {editingBusiness && (
              <BusinessLogoField
                businessId={editingBusiness.id}
                name={formData.name || editingBusiness.name}
                logoUrl={businesses?.find((b: any) => b.id === editingBusiness.id)?.logoUrl ?? null}
              />
            )}
            <div>
              <Label htmlFor="biz-edit-name">اسم النشاط (البراند)</Label>
              <Input
                id="biz-edit-name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className={`mt-1 ${TOUCH}`}
                data-testid="biz-edit-name"
              />
            </div>
            <div>
              <Label htmlFor="biz-edit-slug">Slug</Label>
              <Input
                id="biz-edit-slug"
                value={formData.slug}
                onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                className={`mt-1 ${TOUCH}`}
                dir="ltr"
              />
            </div>
            <Button onClick={handleUpdate} disabled={updateMutation.isPending} className={`w-full ${TOUCH}`} data-testid="biz-save">
              {updateMutation.isPending ? "جاري التحديث..." : "حفظ التعديلات"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
