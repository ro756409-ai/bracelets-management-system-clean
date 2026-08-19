import { useMemo, useState } from "react";
import {
  Banknote,
  CheckCircle2,
  Edit2,
  Megaphone,
  Paperclip,
  Plus,
  Printer,
  Receipt,
  Send,
  Tag,
  Trash2,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  PaymentSource,
  paymentSourceId,
  paymentSourceMissing,
} from "@/components/accounting/PaymentSource";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import DateRangePicker, { type DateRange } from "@/components/DateRangePicker";
import {
  SectionHeader,
  StatCard,
  ResponsiveDataTable,
  type Column,
  Pagination,
  FilterBar,
  SearchInput,
  MobileOrderCard,
  ConfirmDialog,
  toast,
  buildFilterChips,
  countActiveFilters,
  type FilterDescriptor,
} from "@/components/shared";
import { NewExpenseButton } from "@/components/accounting/ExpenseDrawer";
import { formatMoney } from "@/lib/money";
import { printExpenses } from "@/lib/printExpenses";

const FILTER_DESCRIPTORS: FilterDescriptor<{
  category: string;
  dateRange: DateRange;
}>[] = [
  { key: "category", label: "التصنيف" },
  {
    key: "dateRange",
    label: "التاريخ",
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
 * الاستحقاق منفصل بالكامل عن الدفع: الاعتماد ينشئ Daily Accrual، والدفع فقط هو اللي
 * يحرك الحساب المالي المختار. المصروف المعتمد لا يُحذف أو يتعدل بأثر رجعي.
 */
export function ExpensesSection() {
  const { currentBusinessIds } = useBusinessContext();
  const utils = trpc.useUtils();

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [dateRange, setDateRange] = useState<DateRange>({
    from: null,
    to: null,
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [expandedMobileId, setExpandedMobileId] = useState<number | null>(null);

  const [editing, setEditing] = useState<any | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<any | null>(null);
  const [paymentExpense, setPaymentExpense] = useState<any | null>(null);

  const { data: categories } = trpc.accounting.expenseCategories.useQuery({
    businessIds: currentBusinessIds,
  });
  const businessId =
    currentBusinessIds?.length === 1 ? currentBusinessIds[0] : undefined;
  const { data: accounts = [] } = trpc.accountingV2.financialAccounts.useQuery(
    { businessId: businessId! },
    { enabled: Boolean(businessId) }
  );
  const { data: costCenters = [] } = trpc.accountingV2.costCenters.useQuery(
    { businessId: businessId! },
    { enabled: Boolean(businessId) }
  );
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
    onSuccess: () => {
      toast.success("تم حذف مسودة المصروف");
      invalidateAll();
      setPendingDelete(null);
    },
    onError: e => {
      toast.error(e.message);
      setPendingDelete(null);
    },
  });
  const submitMutation = trpc.accountingV2.expenseSubmit.useMutation({
    onSuccess: () => {
      toast.success("تم إرسال المصروف للاعتماد");
      invalidateAll();
    },
    onError: error => toast.error(error.message),
  });
  const approveMutation = trpc.accountingV2.expenseApprove.useMutation({
    onSuccess: () => {
      toast.success("تم الاعتماد وإنشاء جدول الاستحقاق اليومي");
      invalidateAll();
    },
    onError: error => toast.error(error.message),
  });

  const filtersSnapshot = {
    category:
      categoryFilter === "all"
        ? "all"
        : (categoryNameById.get(Number(categoryFilter)) ??
          `#${categoryFilter}`),
    dateRange,
  };
  const filterChips = buildFilterChips(filtersSnapshot, FILTER_DESCRIPTORS);
  const activeFilterCount = countActiveFilters(
    filtersSnapshot,
    FILTER_DESCRIPTORS
  );

  const rows = data?.expenses ?? [];

  const columns: Column<any>[] = [
    {
      id: "status",
      header: "الحالة",
      alwaysVisible: true,
      cell: e => (
        <Badge variant="outline">
          {{
            draft: "مسودة",
            pending_approval: "بانتظار الاعتماد",
            accrued: "مستحق",
            partially_paid: "مدفوع جزئيًا",
            paid: "مدفوع",
            voided: "ملغي",
          }[e.status as string] ?? e.status}
        </Badge>
      ),
    },
    {
      id: "date",
      header: "التاريخ",
      alwaysVisible: true,
      cell: e => (
        <span className="whitespace-nowrap text-sm tabular-nums">
          {new Date(e.expenseDate).toLocaleDateString("ar-EG", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </span>
      ),
    },
    {
      id: "category",
      header: "التصنيف",
      alwaysVisible: true,
      cell: e =>
        e.categoryName ? (
          <Badge variant="secondary" className="text-xs">
            {e.categoryName}
          </Badge>
        ) : (
          <span className="type-caption">بدون تصنيف</span>
        ),
    },
    {
      id: "description",
      header: "البيان",
      alwaysVisible: true,
      cell: e => (
        <p
          className="max-w-[320px] truncate text-sm font-medium"
          title={e.description}
        >
          {e.description}
        </p>
      ),
    },
    {
      id: "amount",
      header: "المبلغ",
      numeric: true,
      alwaysVisible: true,
      cell: e => (
        <span className="text-sm font-bold tabular-nums">
          {formatMoney(e.amount)}
        </span>
      ),
    },
    {
      id: "employee",
      header: "الموظف",
      alwaysVisible: true,
      cell: e => <span className="text-sm">{e.createdByName}</span>,
    },
    {
      id: "reference",
      header: "المرجع",
      cell: e => (
        <span className="flex items-center gap-1.5">
          {e.reference ? (
            <span className="font-mono text-xs">{e.reference}</span>
          ) : (
            <span className="type-caption">—</span>
          )}
          {/* الرفع نفسه مش متطبّق في المرحلة دي — الأيقونة بتظهر لو الرابط اتحط،
              وبتفتحه في تاب جديد. */}
          {e.attachmentUrl && (
            <a
              href={e.attachmentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--info)] hover:opacity-80"
              title="عرض المرفق"
              onClick={ev => ev.stopPropagation()}
            >
              <Paperclip className="h-3.5 w-3.5" />
            </a>
          )}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      alwaysVisible: true,
      sticky: true,
      cell: e => (
        <div
          className="flex items-center gap-0.5"
          onClick={ev => ev.stopPropagation()}
        >
          {e.status === "draft" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              title="تعديل"
              aria-label="تعديل المصروف"
              onClick={() => {
                setEditing(e);
                setShowForm(true);
              }}
            >
              <Edit2 className="h-4 w-4" />
            </Button>
          )}
          {e.status === "draft" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              title="إرسال للاعتماد"
              onClick={() =>
                businessId &&
                submitMutation.mutate({ businessId, expenseId: e.id })
              }
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
          {e.status === "pending_approval" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-emerald-700"
              title="اعتماد"
              onClick={() =>
                businessId &&
                approveMutation.mutate({ businessId, expenseId: e.id })
              }
            >
              <CheckCircle2 className="h-4 w-4" />
            </Button>
          )}
          {(e.status === "accrued" || e.status === "partially_paid") && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-sky-700"
              title="تسجيل دفعة"
              onClick={() => setPaymentExpense(e)}
            >
              <Banknote className="h-4 w-4" />
            </Button>
          )}
          {e.status === "draft" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-destructive hover:bg-destructive/12 hover:text-destructive"
              title="حذف"
              aria-label="حذف المصروف"
              onClick={() => setPendingDelete(e)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/*
        الوصف كان بيقول «الاستحقاق حسب Service Period والدفع منفصل على الحساب المالي»
        — دي جملة لمحاسب. الصفحة دي تقرير: كام صرفت، كام مدفوع، وكام لسه عليك.
      */}
      <SectionHeader
        description="كام صرفت، كام مدفوع، وكام لسه عليك"
        actions={
          <>
            {businessId != null && (
              <NewExpenseButton businessId={businessId} onSaved={invalidateAll} />
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => {
                if (!printExpenses(rows, data?.totalAmount ?? 0)) {
                  toast.error(
                    "المتصفح منع نافذة الطباعة — اسمح بالنوافذ المنبثقة لهذا الموقع"
                  );
                }
              }}
            >
              <Printer className="h-4 w-4" /> طباعة
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => setShowCategories(true)}
            >
              <Tag className="h-4 w-4" /> التصنيفات
            </Button>
            <Button
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => {
                setEditing(null);
                setShowForm(true);
              }}
            >
              <Plus className="h-4 w-4" /> إضافة مصروف
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatCard
            label="إجمالي المصروفات"
            tone="warning"
            loading={isLoading}
            value={formatMoney(data?.totalAmount ?? 0)}
            hint="حسب الفلاتر الحالية"
            icon={<Receipt className="h-5 w-5" />}
          />
          <StatCard
            label="عدد المصروفات"
            loading={isLoading}
            value={(data?.total ?? 0).toLocaleString("ar-EG")}
            icon={<Receipt className="h-5 w-5" />}
          />
          <StatCard
            label="التصنيفات"
            value={(categories?.length ?? 0).toLocaleString("ar-EG")}
            icon={<Tag className="h-5 w-5" />}
          />
        </div>
      </SectionHeader>

      <Card className="shadow-[var(--shadow-card)]">
        <CardContent className="p-3">
          <FilterBar
            search={
              <SearchInput
                value={search}
                onChange={v => {
                  setSearch(v);
                  setPage(1);
                }}
                placeholder="بحث بالبيان أو المرجع أو الموظف..."
              />
            }
            chips={filterChips}
            onClearChip={key => {
              setPage(1);
              if (key === "category") setCategoryFilter("all");
              else if (key === "dateRange")
                setDateRange({ from: null, to: null });
            }}
            onReset={() => {
              setPage(1);
              setSearch("");
              setCategoryFilter("all");
              setDateRange({ from: null, to: null });
            }}
            activeCount={activeFilterCount}
          >
            <Select
              value={categoryFilter}
              onValueChange={v => {
                setCategoryFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="h-9 w-44">
                <SelectValue placeholder="التصنيف" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل التصنيفات</SelectItem>
                {(categories ?? []).map((c: any) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DateRangePicker
              value={dateRange}
              onChange={r => {
                setDateRange(r);
                setPage(1);
              }}
            />
          </FilterBar>
        </CardContent>
      </Card>

      <ResponsiveDataTable
        rows={rows}
        columns={columns}
        rowKey={(e: any) => e.id}
        loading={isLoading}
        empty={{
          title: "لا توجد مصروفات",
          description: "أضف أول مصروف من الزر أعلى الصفحة",
        }}
        mobileRow={(e: any) => (
          <MobileOrderCard
            orderNumber={e.reference || `#${e.id}`}
            customerName={e.description}
            customerPhone={e.createdByName}
            governorate={e.categoryName ?? "بدون تصنيف"}
            productSummary={new Date(e.expenseDate).toLocaleDateString(
              "ar-EG",
              { day: "numeric", month: "long", year: "numeric" }
            )}
            statusBadge={
              <Badge
                variant="outline"
                className="border-[var(--warning)]/40 text-[var(--warning)]"
              >
                {formatMoney(e.amount)}
              </Badge>
            }
            total={formatMoney(e.amount)}
            dateLabel={new Date(e.expenseDate).toLocaleDateString("ar-EG", {
              day: "numeric",
              month: "short",
            })}
            expanded={expandedMobileId === e.id}
            onToggle={() =>
              setExpandedMobileId(id => (id === e.id ? null : e.id))
            }
            details={
              <div className="space-y-2">
                {e.attachmentUrl && (
                  <a
                    href={e.attachmentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-[var(--info)]"
                  >
                    <Paperclip className="h-3.5 w-3.5" /> عرض المرفق
                  </a>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 gap-1"
                    onClick={() => {
                      setEditing(e);
                      setShowForm(true);
                    }}
                  >
                    <Edit2 className="h-3.5 w-3.5" /> تعديل
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 gap-1 border-destructive/40 text-destructive hover:bg-destructive/10"
                    onClick={() => setPendingDelete(e)}
                  >
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
        onPageSizeChange={n => {
          setPageSize(n);
          setPage(1);
        }}
      />

      {businessId && (
        <AdSpendCard
          businessId={businessId}
          categories={categories ?? []}
          costCenters={costCenters}
        />
      )}

      <ExpenseFormDialog
        open={showForm}
        expense={editing}
        categories={categories ?? []}
        costCenters={costCenters}
        businessId={businessId}
        onClose={() => {
          setShowForm(false);
          setEditing(null);
        }}
        onDone={() => {
          invalidateAll();
          setShowForm(false);
          setEditing(null);
        }}
      />

      <CategoriesDialog
        open={showCategories}
        onClose={() => setShowCategories(false)}
        categories={categories ?? []}
        businessId={currentBusinessIds?.[0]}
      />

      <ConfirmDialog
        open={pendingDelete != null}
        onOpenChange={o => !o && setPendingDelete(null)}
        title="حذف المصروف؟"
        description={
          pendingDelete
            ? `سيتم حذف مسودة "${pendingDelete.description}" فقط. المصروفات المعتمدة لا تُحذف.`
            : ""
        }
        confirmLabel="حذف"
        tone="destructive"
        pending={deleteMutation.isPending}
        onConfirm={() =>
          pendingDelete && deleteMutation.mutate({ id: pendingDelete.id })
        }
      />
      <ExpensePaymentDialog
        open={paymentExpense != null}
        expense={paymentExpense}
        businessId={businessId}
        accounts={accounts}
        onClose={() => setPaymentExpense(null)}
        onDone={() => {
          setPaymentExpense(null);
          invalidateAll();
        }}
      />
    </div>
  );
}

function ExpenseFormDialog({
  open,
  expense,
  categories,
  costCenters,
  businessId,
  onClose,
  onDone,
}: {
  open: boolean;
  expense: any | null;
  categories: any[];
  costCenters: any[];
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
  const [serviceFrom, setServiceFrom] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [serviceTo, setServiceTo] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [costCenterId, setCostCenterId] = useState("none");
  const [taxCode, setTaxCode] = useState("");
  const [taxAmount, setTaxAmount] = useState("0");
  const [reference, setReference] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState("");

  if (key !== formKey) {
    setFormKey(key);
    setAmount(expense ? String(expense.amount) : "");
    setDescription(expense?.description ?? "");
    setCategoryId(expense?.categoryId ? String(expense.categoryId) : "none");
    setDate(
      expense
        ? new Date(expense.expenseDate).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10)
    );
    setServiceFrom(
      expense?.serviceFrom
        ? new Date(expense.serviceFrom).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10)
    );
    setServiceTo(
      expense?.serviceTo
        ? new Date(expense.serviceTo).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10)
    );
    setCostCenterId(
      expense?.costCenterId ? String(expense.costCenterId) : "none"
    );
    setTaxCode(expense?.taxCode ?? "");
    setTaxAmount(String(expense?.taxAmount ?? "0"));
    setReference(expense?.reference ?? "");
    setAttachmentUrl(expense?.attachmentUrl ?? "");
  }

  const createMutation = trpc.accounting.expenseCreate.useMutation({
    onSuccess: () => {
      toast.success("تم إضافة المصروف");
      onDone();
    },
    onError: e => toast.error(e.message),
  });
  const updateMutation = trpc.accounting.expenseUpdate.useMutation({
    onSuccess: () => {
      toast.success("تم تعديل المصروف");
      onDone();
    },
    onError: e => toast.error(e.message),
  });
  const pending = createMutation.isPending || updateMutation.isPending;

  const submit = () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("أدخل مبلغًا أكبر من صفر");
      return;
    }
    if (!description.trim()) {
      toast.error("البيان مطلوب");
      return;
    }
    // الدليل بقى اختياري تمامًا — التاجر بيسجّل المصروف مباشرة.
    const evidenceUrl = attachmentUrl.trim();
    const common = {
      amount: value,
      description: description.trim(),
      categoryId: categoryId !== "none" ? Number(categoryId) : undefined,
      costCenterId: costCenterId !== "none" ? Number(costCenterId) : undefined,
      expenseDate: new Date(date + "T12:00:00"),
      serviceFrom,
      serviceTo,
      taxCode: taxCode || undefined,
      taxAmount: Number(taxAmount) || 0,
      reference: reference.trim() || undefined,
      attachmentUrl: evidenceUrl || undefined,
    };
    if (isEdit) {
      const {
        costCenterId: _costCenterId,
        serviceFrom: _serviceFrom,
        serviceTo: _serviceTo,
        taxCode: _taxCode,
        taxAmount: _taxAmount,
        ...legacyCommon
      } = common;
      updateMutation.mutate({ id: expense.id, ...legacyCommon });
    } else {
      if (!businessId) {
        toast.error("اختر نشاطًا واحدًا من أعلى الصفحة أولاً");
        return;
      }
      createMutation.mutate({
        ...common,
        attachmentUrl: evidenceUrl,
        businessId,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent
        dir="rtl"
        className="max-h-[90vh] max-w-md overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? "تعديل مصروف" : "إضافة مصروف"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>
              المبلغ <span className="text-destructive">*</span>
            </Label>
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              dir="ltr"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              className="mt-1"
            />
            {isEdit && (
              <p className="type-caption mt-1">
                التعديل متاح للمسودة فقط؛ بعد الاعتماد يتم التصحيح بـ Adjustment
                موثق.
              </p>
            )}
          </div>
          <div>
            <Label>
              البيان <span className="text-destructive">*</span>
            </Label>
            <Input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="مثال: إيجار المخزن — يوليو"
              className="mt-1"
            />
          </div>
          <div>
            <Label>التصنيف</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="بدون تصنيف" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">بدون تصنيف</SelectItem>
                {categories.map(c => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>
              التاريخ <span className="text-destructive">*</span>
            </Label>
            <Input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="mt-1"
              dir="ltr"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Service From *</Label>
              <Input
                type="date"
                value={serviceFrom}
                onChange={e => setServiceFrom(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Service To *</Label>
              <Input
                type="date"
                value={serviceTo}
                onChange={e => setServiceTo(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <Label>مركز التكلفة</Label>
            <Select value={costCenterId} onValueChange={setCostCenterId}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">بدون مركز تكلفة</SelectItem>
                {costCenters
                  .filter(center => center.isActive)
                  .map(center => (
                    <SelectItem key={center.id} value={String(center.id)}>
                      {center.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Tax Code</Label>
              <Input
                className="mt-1"
                dir="ltr"
                value={taxCode}
                onChange={e => setTaxCode(e.target.value)}
              />
            </div>
            <div>
              <Label>Tax Amount</Label>
              <Input
                className="mt-1"
                dir="ltr"
                inputMode="decimal"
                value={taxAmount}
                onChange={e => setTaxAmount(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>المرجع / رقم الفاتورة (اختياري)</Label>
            <Input
              value={reference}
              onChange={e => setReference(e.target.value)}
              className="mt-1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "جاري الحفظ..." : isEdit ? "حفظ التعديل" : "إضافة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExpensePaymentDialog({
  open,
  expense,
  businessId,
  accounts,
  onClose,
  onDone,
}: {
  open: boolean;
  expense: any | null;
  businessId?: number;
  accounts: any[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [paidAt, setPaidAt] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const mutation = trpc.accountingV2.expensePay.useMutation({
    onSuccess: () => {
      toast.success("تم تسجيل دفعة المصروف على الحساب المالي");
      onDone();
    },
    onError: error => toast.error(error.message),
  });
  const remaining = expense
    ? Number(expense.amount) - Number(expense.paidAmount ?? 0)
    : 0;
  return (
    <Dialog open={open} onOpenChange={value => !value && onClose()}>
      <DialogContent dir="rtl">
        <DialogHeader>
          <DialogTitle>دفع مصروف</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            المتبقي: {formatMoney(remaining)}
          </p>
          <PaymentSource
            accounts={accounts}
            value={accountId}
            onChange={setAccountId}
          />
          <div>
            <Label>المبلغ *</Label>
            <Input
              className="mt-1"
              dir="ltr"
              inputMode="decimal"
              value={amount}
              onChange={event => setAmount(event.target.value)}
            />
          </div>
          <div>
            <Label>تاريخ الدفع *</Label>
            <Input
              className="mt-1"
              type="date"
              value={paidAt}
              onChange={event => setPaidAt(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            disabled={mutation.isPending}
            onClick={() => {
              if (!businessId || !expense || !amount)
                return toast.error("كل بيانات الدفع مطلوبة");
              if (paymentSourceMissing(accounts, accountId))
                return toast.error("اختار الخزنة اللي هتخرج منها الفلوس");
              mutation.mutate({
                businessId,
                expenseId: expense.id,
                sourceAccountId: paymentSourceId(accounts, accountId),
                amount,
                paidAt: new Date(`${paidAt}T12:00:00`),
              });
            }}
          >
            تسجيل الدفع
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdSpendCard({
  businessId,
  categories,
  costCenters,
}: {
  businessId: number;
  categories: any[];
  costCenters: any[];
}) {
  const utils = trpc.useUtils();
  const platforms = trpc.accountingV2.configurationList.useQuery({
    businessId,
    namespace: "ad_platform",
    activeOnly: true,
  });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    platformId: "",
    accountId: "",
    accountName: "",
    campaignId: "",
    campaignName: "",
    adSetId: "",
    adId: "",
    categoryId: "",
    costCenterId: "",
    amount: "",
    description: "",
    serviceFrom: new Date().toISOString().slice(0, 10),
    serviceTo: new Date().toISOString().slice(0, 10),
    reference: "",
    evidenceUrl: "",
    overrideReason: "",
    notes: "",
  });
  const [metricRows, setMetricRows] = useState([{ key: "", value: "" }]);
  const mutation = trpc.accountingV2.adSpendCreate.useMutation({
    onSuccess: async () => {
      toast.success("تم إنشاء Ad Spend كمصروف Draft مرتبط بـ Business Event");
      setOpen(false);
      await utils.accounting.expenseList.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 font-bold">
              <Megaphone className="h-5 w-5 text-rose-600" />
              Ad Spend & Attribution
            </h3>
            <p className="text-sm text-muted-foreground">
              IDs ثابتة مع Snapshots للأسماء وManual Metrics للـ Hybrid
              Attribution.
            </p>
          </div>
          <Button variant="outline" onClick={() => setOpen(true)}>
            إضافة Ad Spend
          </Button>
        </div>
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          dir="rtl"
          className="max-h-[90vh] max-w-2xl overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>إضافة Ad Spend</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label>المنصة *</Label>
              <Select
                value={form.platformId}
                onValueChange={platformId => setForm({ ...form, platformId })}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="من الإعدادات" />
                </SelectTrigger>
                <SelectContent>
                  {platforms.data?.map(row => (
                    <SelectItem key={row.id} value={row.configKey}>
                      {row.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>المبلغ *</Label>
              <Input
                className="mt-1"
                dir="ltr"
                value={form.amount}
                onChange={e => setForm({ ...form, amount: e.target.value })}
              />
            </div>
            <div>
              <Label>Account ID *</Label>
              <Input
                className="mt-1"
                dir="ltr"
                value={form.accountId}
                onChange={e => setForm({ ...form, accountId: e.target.value })}
              />
            </div>
            <div>
              <Label>Account Name Snapshot *</Label>
              <Input
                className="mt-1"
                value={form.accountName}
                onChange={e =>
                  setForm({ ...form, accountName: e.target.value })
                }
              />
            </div>
            <div>
              <Label>Campaign ID *</Label>
              <Input
                className="mt-1"
                dir="ltr"
                value={form.campaignId}
                onChange={e => setForm({ ...form, campaignId: e.target.value })}
              />
            </div>
            <div>
              <Label>Campaign Name Snapshot *</Label>
              <Input
                className="mt-1"
                value={form.campaignName}
                onChange={e =>
                  setForm({ ...form, campaignName: e.target.value })
                }
              />
            </div>
            <div>
              <Label>Ad Set ID</Label>
              <Input
                className="mt-1"
                dir="ltr"
                value={form.adSetId}
                onChange={e => setForm({ ...form, adSetId: e.target.value })}
              />
            </div>
            <div>
              <Label>Ad ID</Label>
              <Input
                className="mt-1"
                dir="ltr"
                value={form.adId}
                onChange={e => setForm({ ...form, adId: e.target.value })}
              />
            </div>
            <div>
              <Label>التصنيف</Label>
              <Select
                value={form.categoryId || "none"}
                onValueChange={value =>
                  setForm({
                    ...form,
                    categoryId: value === "none" ? "" : value,
                  })
                }
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">بدون</SelectItem>
                  {categories.map(row => (
                    <SelectItem key={row.id} value={String(row.id)}>
                      {row.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>مركز التكلفة</Label>
              <Select
                value={form.costCenterId || "none"}
                onValueChange={value =>
                  setForm({
                    ...form,
                    costCenterId: value === "none" ? "" : value,
                  })
                }
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">بدون</SelectItem>
                  {costCenters
                    .filter(row => row.isActive)
                    .map(row => (
                      <SelectItem key={row.id} value={String(row.id)}>
                        {row.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Service From *</Label>
              <Input
                className="mt-1"
                type="date"
                value={form.serviceFrom}
                onChange={e =>
                  setForm({ ...form, serviceFrom: e.target.value })
                }
              />
            </div>
            <div>
              <Label>Service To *</Label>
              <Input
                className="mt-1"
                type="date"
                value={form.serviceTo}
                onChange={e => setForm({ ...form, serviceTo: e.target.value })}
              />
            </div>
            <div className="md:col-span-2">
              <Label>البيان *</Label>
              <Input
                className="mt-1"
                value={form.description}
                onChange={e =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </div>
            <div>
              <Label>المرجع</Label>
              <Input
                className="mt-1"
                value={form.reference}
                onChange={e => setForm({ ...form, reference: e.target.value })}
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>المؤشرات اليدوية</Label>
              {metricRows.map((metric, index) => (
                <div
                  key={index}
                  className="grid grid-cols-[1fr_1fr_auto] gap-2"
                >
                  <Input
                    dir="ltr"
                    placeholder="Metric key"
                    value={metric.key}
                    onChange={e =>
                      setMetricRows(rows =>
                        rows.map((row, i) =>
                          i === index ? { ...row, key: e.target.value } : row
                        )
                      )
                    }
                  />
                  <Input
                    dir="ltr"
                    inputMode="decimal"
                    placeholder="Value"
                    value={metric.value}
                    onChange={e =>
                      setMetricRows(rows =>
                        rows.map((row, i) =>
                          i === index ? { ...row, value: e.target.value } : row
                        )
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={metricRows.length === 1}
                    onClick={() =>
                      setMetricRows(rows => rows.filter((_, i) => i !== index))
                    }
                  >
                    حذف
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setMetricRows(rows => [...rows, { key: "", value: "" }])
                }
              >
                إضافة مؤشر
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              إلغاء
            </Button>
            <Button
              disabled={mutation.isPending}
              onClick={() => {
                try {
                  const manualMetrics = Object.fromEntries(
                    metricRows
                      .filter(row => row.key.trim())
                      .map(row => [row.key.trim(), Number(row.value)])
                  );
                  if (
                    Object.values(manualMetrics).some(
                      value => !Number.isFinite(value)
                    )
                  )
                    throw new Error("Invalid metric");
                  const platform = platforms.data?.find(
                    row => row.configKey === form.platformId
                  );
                  if (
                    !platform ||
                    !form.amount ||
                    !form.accountId ||
                    !form.accountName ||
                    !form.campaignId ||
                    !form.campaignName ||
                    !form.description
                  )
                    return toast.error("كل البيانات الأساسية مطلوبة");
                  mutation.mutate({
                    businessId,
                    categoryId: form.categoryId
                      ? Number(form.categoryId)
                      : undefined,
                    costCenterId: form.costCenterId
                      ? Number(form.costCenterId)
                      : undefined,
                    amount: form.amount,
                    description: form.description,
                    serviceFrom: form.serviceFrom,
                    serviceTo: form.serviceTo,
                    reference: form.reference || undefined,
                    evidenceUrl: form.evidenceUrl,
                    platformId: form.platformId,
                    platformName: platform.displayName,
                    accountId: form.accountId,
                    accountName: form.accountName,
                    campaignId: form.campaignId,
                    campaignName: form.campaignName,
                    adSetId: form.adSetId || undefined,
                    adId: form.adId || undefined,
                    manualMetrics,
                  });
                } catch {
                  toast.error("قيم المؤشرات اليدوية لازم تكون أرقام صحيحة");
                }
              }}
            >
              إنشاء Draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function CategoriesDialog({
  open,
  onClose,
  categories,
  businessId,
}: {
  open: boolean;
  onClose: () => void;
  categories: any[];
  businessId?: number;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");

  const createMutation = trpc.accounting.expenseCategoryCreate.useMutation({
    onSuccess: () => {
      toast.success("تم إضافة التصنيف");
      setName("");
      utils.accounting.expenseCategories.invalidate();
    },
    onError: e => toast.error(e.message),
  });
  const archiveMutation = trpc.accounting.expenseCategoryArchive.useMutation({
    onSuccess: () => {
      toast.success("تم أرشفة التصنيف");
      utils.accounting.expenseCategories.invalidate();
    },
    onError: e => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent
        dir="rtl"
        className="max-h-[90vh] max-w-md overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>تصنيفات المصروفات</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="اسم تصنيف جديد"
              onKeyDown={e => {
                if (e.key === "Enter" && name.trim() && businessId) {
                  createMutation.mutate({ name: name.trim(), businessId });
                }
              }}
            />
            <Button
              disabled={!name.trim() || !businessId || createMutation.isPending}
              onClick={() =>
                businessId &&
                createMutation.mutate({ name: name.trim(), businessId })
              }
            >
              إضافة
            </Button>
          </div>
          {!businessId && (
            <p className="type-caption">
              اختر نشاطًا واحدًا من أعلى الصفحة لإضافة تصنيف.
            </p>
          )}

          <div className="divide-y divide-border rounded-[var(--radius-brand-md)] border border-border">
            {categories.length === 0 ? (
              <p className="type-caption p-4 text-center">
                لا توجد تصنيفات بعد
              </p>
            ) : (
              categories.map(c => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                >
                  <span className="text-sm font-medium">{c.name}</span>
                  {c.isSystem ? (
                    <Badge variant="secondary" className="text-[10px]">
                      أساسي
                    </Badge>
                  ) : (
                    // أرشفة مش حذف: المصروفات القديمة بتشاور على التصنيف، والحذف كان
                    // هيخلي تقارير الشهور اللي فاتت تعرض تصنيف مفقود.
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10"
                      disabled={archiveMutation.isPending}
                      onClick={() => archiveMutation.mutate({ id: c.id })}
                    >
                      أرشفة
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إغلاق
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
