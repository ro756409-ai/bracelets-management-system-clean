import { useMemo, useState } from "react";
import { Edit2, Paperclip, Plus, Receipt, Tag, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DateRangePicker, { type DateRange } from "@/components/DateRangePicker";
import {
  PageHeader, StatCard, ResponsiveDataTable, type Column, Pagination,
  FilterBar, SearchInput, MobileOrderCard, ConfirmDialog, toast,
  buildFilterChips, countActiveFilters, type FilterDescriptor,
} from "@/components/shared";
import { formatMoney } from "@/lib/money";

const FILTER_DESCRIPTORS: FilterDescriptor<{ category: string; dateRange: DateRange }>[] = [
  { key: "category", label: "التصنيف" },
  {
    key: "dateRange", label: "التاريخ",
    format: (v: DateRange) => {
      const from = v.from ? v.from.toLocaleDateString("ar-EG") : "";
      const to = v.to ? v.to.toLocaleDateString("ar-EG") : "";
      return from && to ? `${from} – ${to}` : from || to;
    },
  },
];

/**
 * المصروفات — المرحلة الرابعة من وحدة الحسابات.
 *
 * كل إضافة/تعديل/حذف بينزل حركة على الخزنة تلقائيًا من طبقة الـdb، فمفيش طريقة يبقى فيها
 * مصروف مسجّل ورصيد الخزنة مش عارف عنه حاجة. التعديل والحذف بينزلوا حركة تسوية جديدة
 * مش بيمسحوا الحركة القديمة — الـledger مايتغيّرش بأثر رجعي.
 */
export default function Expenses() {
  const { currentBusinessIds } = useBusinessContext();
  const utils = trpc.useUtils();

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [expandedMobileId, setExpandedMobileId] = useState<number | null>(null);

  const [editing, setEditing] = useState<any | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<any | null>(null);

  const { data: categories } = trpc.accounting.expenseCategories.useQuery({ businessIds: currentBusinessIds });
  const categoryNameById = useMemo(() => {
    const map = new Map<number, string>();
    categories?.forEach((c: any) => map.set(c.id, c.name));
    return map;
  }, [categories]);

  const { data, isLoading } = trpc.accounting.expenseList.useQuery({
    search: search || undefined,
    categoryId: categoryFilter !== "all" ? Number(categoryFilter) : undefined,
    dateFrom: dateRange.from ?? undefined,
    dateTo: dateRange.to ?? undefined,
    page,
    limit: pageSize,
    businessIds: currentBusinessIds,
  });

  const invalidateAll = () => {
    utils.accounting.expenseList.invalidate();
    utils.accounting.treasuryList.invalidate();
    utils.accounting.treasuryBalance.invalidate();
    utils.accounting.dashboard.invalidate();
  };

  const deleteMutation = trpc.accounting.expenseDelete.useMutation({
    onSuccess: () => { toast.success("تم حذف المصروف وردّ قيمته للخزنة"); invalidateAll(); setPendingDelete(null); },
    onError: (e) => { toast.error(e.message); setPendingDelete(null); },
  });

  const filtersSnapshot = {
    category: categoryFilter === "all" ? "all" : (categoryNameById.get(Number(categoryFilter)) ?? `#${categoryFilter}`),
    dateRange,
  };
  const filterChips = buildFilterChips(filtersSnapshot, FILTER_DESCRIPTORS);
  const activeFilterCount = countActiveFilters(filtersSnapshot, FILTER_DESCRIPTORS);

  const rows = data?.expenses ?? [];

  const columns: Column<any>[] = [
    {
      id: "date", header: "التاريخ", alwaysVisible: true,
      cell: (e) => (
        <span className="whitespace-nowrap text-sm tabular-nums">
          {new Date(e.expenseDate).toLocaleDateString("ar-EG", { day: "numeric", month: "short", year: "numeric" })}
        </span>
      ),
    },
    {
      id: "category", header: "التصنيف", alwaysVisible: true,
      cell: (e) => e.categoryName
        ? <Badge variant="secondary" className="text-xs">{e.categoryName}</Badge>
        : <span className="type-caption">بدون تصنيف</span>,
    },
    {
      id: "description", header: "البيان", alwaysVisible: true,
      cell: (e) => (
        <p className="max-w-[320px] truncate text-sm font-medium" title={e.description}>{e.description}</p>
      ),
    },
    {
      id: "amount", header: "المبلغ", numeric: true, alwaysVisible: true,
      cell: (e) => <span className="text-sm font-bold tabular-nums">{formatMoney(e.amount)}</span>,
    },
    {
      id: "employee", header: "الموظف", alwaysVisible: true,
      cell: (e) => <span className="text-sm">{e.createdByName}</span>,
    },
    {
      id: "reference", header: "المرجع",
      cell: (e) => (
        <span className="flex items-center gap-1.5">
          {e.reference ? <span className="font-mono text-xs">{e.reference}</span> : <span className="type-caption">—</span>}
          {/* الرفع نفسه مش متطبّق في المرحلة دي — الأيقونة بتظهر لو الرابط اتحط،
              وبتفتحه في تاب جديد. */}
          {e.attachmentUrl && (
            <a
              href={e.attachmentUrl} target="_blank" rel="noopener noreferrer"
              className="text-[var(--info)] hover:opacity-80" title="عرض المرفق"
              onClick={(ev) => ev.stopPropagation()}
            >
              <Paperclip className="h-3.5 w-3.5" />
            </a>
          )}
        </span>
      ),
    },
    {
      id: "actions", header: "", alwaysVisible: true, sticky: true,
      cell: (e) => (
        <div className="flex items-center gap-0.5" onClick={(ev) => ev.stopPropagation()}>
          <Button
            size="icon" variant="ghost" className="h-8 w-8"
            title="تعديل" aria-label="تعديل المصروف"
            onClick={() => { setEditing(e); setShowForm(true); }}
          >
            <Edit2 className="h-4 w-4" />
          </Button>
          <Button
            size="icon" variant="ghost"
            className="h-8 w-8 text-destructive hover:bg-destructive/12 hover:text-destructive"
            title="حذف" aria-label="حذف المصروف"
            onClick={() => setPendingDelete(e)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="المصروفات"
        description="كل مصروف بينزل حركة على الخزنة تلقائيًا"
        primaryAction={
          <Button size="sm" className="h-9 gap-1.5" onClick={() => { setEditing(null); setShowForm(true); }}>
            <Plus className="h-4 w-4" /> إضافة مصروف
          </Button>
        }
        actions={
          <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => setShowCategories(true)}>
            <Tag className="h-4 w-4" /> التصنيفات
          </Button>
        }
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatCard
            label="إجمالي المصروفات" tone="warning" loading={isLoading}
            value={formatMoney(data?.totalAmount ?? 0)}
            hint="حسب الفلاتر الحالية"
            icon={<Receipt className="h-5 w-5" />}
          />
          <StatCard
            label="عدد المصروفات" loading={isLoading}
            value={(data?.total ?? 0).toLocaleString("ar-EG")}
            icon={<Receipt className="h-5 w-5" />}
          />
          <StatCard
            label="التصنيفات"
            value={(categories?.length ?? 0).toLocaleString("ar-EG")}
            icon={<Tag className="h-5 w-5" />}
          />
        </div>
      </PageHeader>

      <Card className="shadow-[var(--shadow-card)]">
        <CardContent className="p-3">
          <FilterBar
            search={
              <SearchInput
                value={search}
                onChange={(v) => { setSearch(v); setPage(1); }}
                placeholder="بحث بالبيان أو المرجع أو الموظف..."
              />
            }
            chips={filterChips}
            onClearChip={(key) => {
              setPage(1);
              if (key === "category") setCategoryFilter("all");
              else if (key === "dateRange") setDateRange({ from: null, to: null });
            }}
            onReset={() => { setPage(1); setSearch(""); setCategoryFilter("all"); setDateRange({ from: null, to: null }); }}
            activeCount={activeFilterCount}
          >
            <Select value={categoryFilter} onValueChange={v => { setCategoryFilter(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-44"><SelectValue placeholder="التصنيف" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل التصنيفات</SelectItem>
                {(categories ?? []).map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <DateRangePicker value={dateRange} onChange={(r) => { setDateRange(r); setPage(1); }} />
          </FilterBar>
        </CardContent>
      </Card>

      <ResponsiveDataTable
        rows={rows}
        columns={columns}
        rowKey={(e: any) => e.id}
        loading={isLoading}
        empty={{ title: "لا توجد مصروفات", description: "أضف أول مصروف من الزر أعلى الصفحة" }}
        mobileRow={(e: any) => (
          <MobileOrderCard
            orderNumber={e.reference || `#${e.id}`}
            customerName={e.description}
            customerPhone={e.createdByName}
            governorate={e.categoryName ?? "بدون تصنيف"}
            productSummary={new Date(e.expenseDate).toLocaleDateString("ar-EG", { day: "numeric", month: "long", year: "numeric" })}
            statusBadge={<Badge variant="outline" className="border-[var(--warning)]/40 text-[var(--warning)]">{formatMoney(e.amount)}</Badge>}
            total={formatMoney(e.amount)}
            dateLabel={new Date(e.expenseDate).toLocaleDateString("ar-EG", { day: "numeric", month: "short" })}
            expanded={expandedMobileId === e.id}
            onToggle={() => setExpandedMobileId(id => id === e.id ? null : e.id)}
            details={
              <div className="space-y-2">
                {e.attachmentUrl && (
                  <a
                    href={e.attachmentUrl} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-[var(--info)]"
                  >
                    <Paperclip className="h-3.5 w-3.5" /> عرض المرفق
                  </a>
                )}
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="flex-1 gap-1"
                    onClick={() => { setEditing(e); setShowForm(true); }}>
                    <Edit2 className="h-3.5 w-3.5" /> تعديل
                  </Button>
                  <Button size="sm" variant="outline"
                    className="flex-1 gap-1 border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={() => setPendingDelete(e)}>
                    <Trash2 className="h-3.5 w-3.5" /> حذف
                  </Button>
                </div>
              </div>
            }
          />
        )}
      />

      <Pagination
        page={data?.page ?? 1}
        total={data?.total ?? 0}
        pageSize={pageSize}
        pageSizeOptions={[25, 50, 100]}
        onPageChange={setPage}
        onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
      />

      <ExpenseFormDialog
        open={showForm}
        expense={editing}
        categories={categories ?? []}
        businessId={currentBusinessIds?.[0]}
        onClose={() => { setShowForm(false); setEditing(null); }}
        onDone={() => { invalidateAll(); setShowForm(false); setEditing(null); }}
      />

      <CategoriesDialog
        open={showCategories}
        onClose={() => setShowCategories(false)}
        categories={categories ?? []}
        businessId={currentBusinessIds?.[0]}
      />

      <ConfirmDialog
        open={pendingDelete != null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title="حذف المصروف؟"
        description={
          pendingDelete
            ? `سيتم حذف "${pendingDelete.description}" وردّ ${formatMoney(pendingDelete.amount)} للخزنة بحركة تسوية.`
            : ""
        }
        confirmLabel="حذف"
        tone="destructive"
        pending={deleteMutation.isPending}
        onConfirm={() => pendingDelete && deleteMutation.mutate({ id: pendingDelete.id })}
      />
    </div>
  );
}

function ExpenseFormDialog({
  open, expense, categories, businessId, onClose, onDone,
}: {
  open: boolean;
  expense: any | null;
  categories: any[];
  businessId?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = expense != null;
  // مفتاح إعادة التهيئة: الحوار بيفضل mounted، فالحقول لازم تتزامن مع الصف المختار.
  const [formKey, setFormKey] = useState("");
  const key = `${expense?.id ?? "new"}-${open}`;
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("none");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState("");

  if (key !== formKey) {
    setFormKey(key);
    setAmount(expense ? String(expense.amount) : "");
    setDescription(expense?.description ?? "");
    setCategoryId(expense?.categoryId ? String(expense.categoryId) : "none");
    setDate(expense
      ? new Date(expense.expenseDate).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10));
    setReference(expense?.reference ?? "");
    setAttachmentUrl(expense?.attachmentUrl ?? "");
  }

  const createMutation = trpc.accounting.expenseCreate.useMutation({
    onSuccess: () => { toast.success("تم إضافة المصروف"); onDone(); },
    onError: (e) => toast.error(e.message),
  });
  const updateMutation = trpc.accounting.expenseUpdate.useMutation({
    onSuccess: () => { toast.success("تم تعديل المصروف"); onDone(); },
    onError: (e) => toast.error(e.message),
  });
  const pending = createMutation.isPending || updateMutation.isPending;

  const submit = () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { toast.error("أدخل مبلغًا أكبر من صفر"); return; }
    if (!description.trim()) { toast.error("البيان مطلوب"); return; }
    const common = {
      amount: value,
      description: description.trim(),
      categoryId: categoryId !== "none" ? Number(categoryId) : undefined,
      expenseDate: new Date(date + "T12:00:00"),
      reference: reference.trim() || undefined,
      attachmentUrl: attachmentUrl.trim() || undefined,
    };
    if (isEdit) {
      updateMutation.mutate({ id: expense.id, ...common });
    } else {
      if (!businessId) { toast.error("اختر نشاطًا واحدًا من أعلى الصفحة أولاً"); return; }
      createMutation.mutate({ ...common, businessId });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "تعديل مصروف" : "إضافة مصروف"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>المبلغ <span className="text-destructive">*</span></Label>
            <Input
              type="number" inputMode="decimal" min="0" step="0.01" dir="ltr"
              value={amount} onChange={e => setAmount(e.target.value)}
              placeholder="0.00" className="mt-1"
            />
            {isEdit && (
              <p className="type-caption mt-1">
                تعديل المبلغ بينزل حركة تسوية بالفرق على الخزنة، مش بيعدّل الحركة الأصلية.
              </p>
            )}
          </div>
          <div>
            <Label>البيان <span className="text-destructive">*</span></Label>
            <Input
              value={description} onChange={e => setDescription(e.target.value)}
              placeholder="مثال: إيجار المخزن — يوليو" className="mt-1"
            />
          </div>
          <div>
            <Label>التصنيف</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="بدون تصنيف" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">بدون تصنيف</SelectItem>
                {categories.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>التاريخ <span className="text-destructive">*</span></Label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1" dir="ltr" />
          </div>
          <div>
            <Label>المرجع / رقم الفاتورة</Label>
            <Input value={reference} onChange={e => setReference(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>رابط المرفق</Label>
            <Textarea
              value={attachmentUrl} onChange={e => setAttachmentUrl(e.target.value)}
              rows={2} className="mt-1" dir="ltr"
              placeholder="https://..."
            />
            {/* الرفع من الجهاز محتاج خدمة تخزين مش موجودة في النظام حاليًا — الحقل
                بيقبل رابط لملف مرفوع بره لحد ما الخدمة تتضاف. */}
            <p className="type-caption mt-1">
              رفع الملفات من الجهاز غير متاح حاليًا — الصق رابط الفاتورة لو موجود.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "جاري الحفظ..." : isEdit ? "حفظ التعديل" : "إضافة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CategoriesDialog({
  open, onClose, categories, businessId,
}: {
  open: boolean;
  onClose: () => void;
  categories: any[];
  businessId?: number;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");

  const createMutation = trpc.accounting.expenseCategoryCreate.useMutation({
    onSuccess: () => { toast.success("تم إضافة التصنيف"); setName(""); utils.accounting.expenseCategories.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const archiveMutation = trpc.accounting.expenseCategoryArchive.useMutation({
    onSuccess: () => { toast.success("تم أرشفة التصنيف"); utils.accounting.expenseCategories.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader><DialogTitle>تصنيفات المصروفات</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={name} onChange={e => setName(e.target.value)}
              placeholder="اسم تصنيف جديد"
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() && businessId) {
                  createMutation.mutate({ name: name.trim(), businessId });
                }
              }}
            />
            <Button
              disabled={!name.trim() || !businessId || createMutation.isPending}
              onClick={() => businessId && createMutation.mutate({ name: name.trim(), businessId })}
            >
              إضافة
            </Button>
          </div>
          {!businessId && (
            <p className="type-caption">اختر نشاطًا واحدًا من أعلى الصفحة لإضافة تصنيف.</p>
          )}

          <div className="divide-y divide-border rounded-[var(--radius-brand-md)] border border-border">
            {categories.length === 0 ? (
              <p className="type-caption p-4 text-center">لا توجد تصنيفات بعد</p>
            ) : categories.map(c => (
              <div key={c.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="text-sm font-medium">{c.name}</span>
                {c.isSystem ? (
                  <Badge variant="secondary" className="text-[10px]">أساسي</Badge>
                ) : (
                  // أرشفة مش حذف: المصروفات القديمة بتشاور على التصنيف، والحذف كان
                  // هيخلي تقارير الشهور اللي فاتت تعرض تصنيف مفقود.
                  <Button
                    size="sm" variant="ghost"
                    className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10"
                    disabled={archiveMutation.isPending}
                    onClick={() => archiveMutation.mutate({ id: c.id })}
                  >
                    أرشفة
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إغلاق</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
