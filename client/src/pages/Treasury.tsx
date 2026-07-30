import { useMemo, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Plus, ShoppingCart, Wallet } from "lucide-react";
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
  SectionHeader, StatCard, ResponsiveDataTable, type Column, Pagination,
  FilterBar, SearchInput, MobileOrderCard, toast,
  buildFilterChips, countActiveFilters, type FilterDescriptor,
} from "@/components/shared";
import { formatMoney } from "@/lib/money";

/** نفس ترتيب الـenum على السيرفر، مع تسمياتها العربية. */
const TX_TYPES: Record<string, string> = {
  collection: "تحصيل",
  order_new: "أوردر جديد",
  refund: "مرتجع",
  expense: "مصروف",
  deposit: "إيداع",
  withdrawal: "سحب",
  adjustment: "تسوية",
};

const FILTER_DESCRIPTORS: FilterDescriptor<{
  type: string; direction: string; employee: string; dateRange: DateRange;
}>[] = [
  { key: "type", label: "نوع الحركة", format: (v) => TX_TYPES[v] ?? v },
  { key: "direction", label: "الاتجاه", format: (v) => (v === "in" ? "داخل" : "خارج") },
  { key: "employee", label: "الموظف" },
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
 * الخزنة — المرحلة الثالثة من وحدة الحسابات.
 *
 * الصفحة قراءة للـledger + إدخال يدوي للإيداع والسحب بس. التحصيل والمصروف والمرتجع
 * بينزلوا الخزنة تلقائيًا من مصادرهم (`recordOrderCollection`, `createExpense`)، فلو
 * الصفحة دي سمحت بإدخالهم يدوي كان ممكن نفس المبلغ يتحسب مرتين.
 */
export function TreasurySection() {
  const { currentBusinessIds } = useBusinessContext();
  const utils = trpc.useUtils();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [directionFilter, setDirectionFilter] = useState("all");
  const [employeeFilter, setEmployeeFilter] = useState("all");
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [expandedMobileId, setExpandedMobileId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [includeOrderEvents, setIncludeOrderEvents] = useState(false);

  const { data: employees } = trpc.employees.activeList.useQuery(
    currentBusinessIds && currentBusinessIds.length === 1 ? { businessId: currentBusinessIds[0] } : undefined
  );
  const employeeNameById = useMemo(() => {
    const map = new Map<number, string>();
    employees?.forEach((e: any) => map.set(e.id, e.name));
    return map;
  }, [employees]);

  const { data, isLoading } = trpc.accounting.treasuryList.useQuery({
    search: search || undefined,
    type: typeFilter !== "all" ? (typeFilter as any) : undefined,
    direction: directionFilter !== "all" ? (directionFilter as any) : undefined,
    performedBy: employeeFilter !== "all" ? Number(employeeFilter) : undefined,
    dateFrom: dateRange.from ?? undefined,
    dateTo: dateRange.to ?? undefined,
    page,
    limit: pageSize,
    businessIds: currentBusinessIds,
    includeOrderEvents,
  });
  const { data: balanceData } = trpc.accounting.treasuryBalance.useQuery({ businessIds: currentBusinessIds });

  const rows = data?.transactions ?? [];

  // إجماليات الصفحة المعروضة — مش إجمالي كل الحركات. الفرق مهم فالكارت بيقوله صراحة.
  const pageTotals = useMemo(() => {
    let inflow = 0, outflow = 0;
    for (const t of rows) {
      // الالتزامات مش فلوس، فمابتدخلش في مجموع الداخل/الخارج
      if (t.kind === "commitment") continue;
      const amount = Number(t.amount);
      if (t.direction === "in") inflow += amount; else outflow += amount;
    }
    return { inflow, outflow };
  }, [rows]);

  const filtersSnapshot = {
    type: typeFilter,
    direction: directionFilter,
    employee: employeeFilter === "all" ? "all" : (employeeNameById.get(Number(employeeFilter)) ?? `#${employeeFilter}`),
    dateRange,
  };
  const filterChips = buildFilterChips(filtersSnapshot, FILTER_DESCRIPTORS);
  const activeFilterCount = countActiveFilters(filtersSnapshot, FILTER_DESCRIPTORS);
  const clearOneFilter = (key: string) => {
    setPage(1);
    if (key === "type") setTypeFilter("all");
    else if (key === "direction") setDirectionFilter("all");
    else if (key === "employee") setEmployeeFilter("all");
    else if (key === "dateRange") setDateRange({ from: null, to: null });
  };
  const resetAllFilters = () => {
    setPage(1); setSearch(""); setTypeFilter("all"); setDirectionFilter("all");
    setEmployeeFilter("all"); setDateRange({ from: null, to: null });
  };

  const columns: Column<any>[] = [
    {
      id: "date", header: "التاريخ", alwaysVisible: true,
      cell: (t) => (
        <div className="whitespace-nowrap leading-tight">
          <p className="text-sm tabular-nums">
            {new Date(t.transactionDate).toLocaleDateString("ar-EG", { day: "numeric", month: "short" })}
          </p>
          <p className="type-caption tabular-nums">
            {new Date(t.transactionDate).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
      ),
    },
    {
      id: "type", header: "نوع الحركة", alwaysVisible: true,
      cell: (t) => (
        <Badge
          variant="outline"
          className={t.kind === "commitment"
            ? "border-dashed border-border text-xs text-muted-foreground"
            : "border-transparent bg-secondary text-xs text-secondary-foreground"}
        >
          {TX_TYPES[t.type] ?? t.type}
        </Badge>
      ),
    },
    {
      id: "description", header: "الوصف", alwaysVisible: true,
      cell: (t) => (
        <div className="max-w-[280px] leading-tight">
          <p className="truncate text-sm font-medium" title={t.description}>{t.description}</p>
          {t.notes && <p className="truncate type-caption" title={t.notes}>{t.notes}</p>}
        </div>
      ),
    },
    {
      id: "direction", header: "الاتجاه", alwaysVisible: true,
      // الالتزام (أوردر جديد) مالوش اتجاه: الفلوس لسه مادخلتش ولا خرجت
      cell: (t) => t.kind === "commitment" ? (
        <span className="type-caption">التزام</span>
      ) : t.direction === "in" ? (
        <span className="flex items-center gap-1 text-sm font-medium text-[var(--success)]">
          <ArrowDownLeft className="h-3.5 w-3.5" /> داخل
        </span>
      ) : (
        <span className="flex items-center gap-1 text-sm font-medium text-destructive">
          <ArrowUpRight className="h-3.5 w-3.5" /> خارج
        </span>
      ),
    },
    {
      id: "amount", header: "المبلغ", numeric: true, alwaysVisible: true,
      cell: (t) => t.kind === "commitment" ? (
        <span className="text-sm tabular-nums text-muted-foreground">{formatMoney(t.amount)}</span>
      ) : (
        <span className={`text-sm font-bold tabular-nums ${t.direction === "in" ? "text-[var(--success)]" : "text-destructive"}`}>
          {t.direction === "in" ? "+" : "−"}{formatMoney(t.amount)}
        </span>
      ),
    },
    {
      id: "employee", header: "الموظف", alwaysVisible: true,
      cell: (t) => <span className="text-sm">{t.performedByName}</span>,
    },
    {
      id: "reference", header: "المرجع",
      cell: (t) => t.referenceId ? (
        <span className="font-mono type-caption">
          {t.referenceType === "order" ? "أوردر" : t.referenceType === "expense" ? "مصروف" : t.referenceType === "return" ? "مرتجع" : "يدوي"}
          {" #"}{t.referenceId}
        </span>
      ) : <span className="type-caption">—</span>,
    },
    {
      id: "balanceAfter", header: "الرصيد بعد الحركة", numeric: true, alwaysVisible: true,
      // الالتزام مابيغيّرش الرصيد، فالخانة بتقول كده صراحة بدل ما تعرض رقم مضلّل
      cell: (t) => t.balanceAfter == null
        ? <span className="type-caption" title="الأوردر التزام — الرصيد بيتغيّر عند التحصيل">لا يؤثر</span>
        : <span className="text-sm font-semibold tabular-nums">{formatMoney(t.balanceAfter)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        description="كل حركة مالية في النظام — تحصيل، مصروف، مرتجع، إيداع، سحب"
        actions={
          <>
            {/* التبديل ده عرض بحت: بيضيف الأوردرات الجديدة للتايم‌لاين كالتزامات
                (بدون أثر على الرصيد) عشان التاجر يشوف الصورة كاملة في مكان واحد. */}
            <Button
              variant={includeOrderEvents ? "default" : "outline"}
              size="sm" className="h-9 gap-1.5"
              aria-pressed={includeOrderEvents}
              onClick={() => setIncludeOrderEvents(v => !v)}
            >
              <ShoppingCart className="h-4 w-4" /> إظهار الأوردرات الجديدة
            </Button>
            <Button size="sm" className="h-9 gap-1.5" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" /> حركة يدوية
            </Button>
          </>
        }
      >
        <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 lg:grid lg:grid-cols-3 lg:overflow-visible [&>*]:min-w-[196px] [&>*]:snap-start lg:[&>*]:min-w-0">
          <StatCard
            label="رصيد الخزنة"
            tone={(balanceData?.balance ?? 0) < 0 ? "danger" : "primary"}
            value={formatMoney(balanceData?.balance ?? 0)}
            icon={<Wallet className="h-5 w-5" />}
          />
          <StatCard
            label="داخل (هذه الصفحة)" tone="success"
            value={formatMoney(pageTotals.inflow)}
            hint={`${rows.length} حركة معروضة`}
            icon={<ArrowDownLeft className="h-5 w-5" />}
          />
          <StatCard
            label="خارج (هذه الصفحة)" tone="danger"
            value={formatMoney(pageTotals.outflow)}
            hint={`إجمالي الحركات: ${(data?.total ?? 0).toLocaleString("ar-EG")}`}
            icon={<ArrowUpRight className="h-5 w-5" />}
          />
        </div>
      </SectionHeader>

      <Card className="shadow-[var(--shadow-card)]">
        <CardContent className="p-3">
          <FilterBar
            search={
              <SearchInput
                value={search}
                onChange={(v) => { setSearch(v); setPage(1); }}
                placeholder="بحث بالوصف أو الملاحظات أو الموظف..."
              />
            }
            chips={filterChips}
            onClearChip={clearOneFilter}
            onReset={resetAllFilters}
            activeCount={activeFilterCount}
          >
            <Select value={typeFilter} onValueChange={v => { setTypeFilter(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-40"><SelectValue placeholder="نوع الحركة" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل الأنواع</SelectItem>
                {Object.entries(TX_TYPES).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
              </SelectContent>
            </Select>

            <Select value={directionFilter} onValueChange={v => { setDirectionFilter(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-32"><SelectValue placeholder="الاتجاه" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                <SelectItem value="in">داخل</SelectItem>
                <SelectItem value="out">خارج</SelectItem>
              </SelectContent>
            </Select>

            <Select value={employeeFilter} onValueChange={v => { setEmployeeFilter(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-40"><SelectValue placeholder="الموظف" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل الموظفين</SelectItem>
                {(employees ?? []).map((e: any) => <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>)}
              </SelectContent>
            </Select>

            <DateRangePicker value={dateRange} onChange={(r) => { setDateRange(r); setPage(1); }} />
          </FilterBar>
        </CardContent>
      </Card>

      <ResponsiveDataTable
        rows={rows}
        columns={columns}
        rowKey={(t: any) => String(t.id)}
        loading={isLoading}
        empty={{ title: "لا توجد حركات", description: "أول تحصيل أو مصروف هيظهر هنا تلقائيًا" }}
        mobileRow={(t: any) => (
          <MobileOrderCard
            orderNumber={TX_TYPES[t.type] ?? t.type}
            customerName={t.description}
            customerPhone={t.performedByName}
            governorate={t.direction === "in" ? "داخل" : "خارج"}
            productSummary={
              t.referenceId
                ? `${t.referenceType === "order" ? "أوردر" : t.referenceType === "expense" ? "مصروف" : t.referenceType === "return" ? "مرتجع" : "يدوي"} #${t.referenceId}`
                : "حركة يدوية"
            }
            statusBadge={
              <Badge
                variant="outline"
                className={t.direction === "in"
                  ? "border-[var(--success)]/40 text-[var(--success)]"
                  : "border-destructive/40 text-destructive"}
              >
                {t.direction === "in" ? "+" : "−"}{formatMoney(t.amount)}
              </Badge>
            }
            total={formatMoney(t.balanceAfter)}
            dateLabel={new Date(t.transactionDate).toLocaleDateString("ar-EG", { day: "numeric", month: "short" })}
            expanded={expandedMobileId === t.id}
            onToggle={() => setExpandedMobileId(id => id === t.id ? null : t.id)}
            details={
              <div className="space-y-1.5 text-sm">
                {t.notes && <p className="text-muted-foreground">{t.notes}</p>}
                <p className="type-caption">
                  المرجع:{" "}
                  {t.referenceId
                    ? `${t.referenceType === "order" ? "أوردر" : t.referenceType === "expense" ? "مصروف" : t.referenceType === "return" ? "مرتجع" : "يدوي"} #${t.referenceId}`
                    : "يدوي"}
                </p>
                <p className="type-caption">الرصيد بعد الحركة: {formatMoney(t.balanceAfter)}</p>
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

      <ManualTransactionDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        businessId={currentBusinessIds?.[0]}
        onDone={() => {
          utils.accounting.treasuryList.invalidate();
          utils.accounting.treasuryBalance.invalidate();
          utils.accounting.dashboard.invalidate();
          setShowCreate(false);
        }}
      />
    </div>
  );
}

/**
 * إيداع/سحب يدوي.
 *
 * النوعين دول بس عن قصد — باقي الأنواع بتنزل تلقائيًا من مصادرها، والسماح بإدخالها هنا
 * كان معناه إن نفس المبلغ ينفع يتحسب مرتين.
 */
function ManualTransactionDialog({
  open, onClose, businessId, onDone,
}: {
  open: boolean;
  onClose: () => void;
  businessId?: number;
  onDone: () => void;
}) {
  const [type, setType] = useState<"deposit" | "withdrawal">("deposit");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));

  const mutation = trpc.accounting.treasuryCreate.useMutation({
    onSuccess: () => {
      toast.success(type === "deposit" ? "تم تسجيل الإيداع" : "تم تسجيل السحب");
      setAmount(""); setDescription(""); setNotes("");
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });

  const submit = () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { toast.error("أدخل مبلغًا أكبر من صفر"); return; }
    if (!description.trim()) { toast.error("الوصف مطلوب"); return; }
    if (!businessId) { toast.error("اختر نشاطًا واحدًا من أعلى الصفحة أولاً"); return; }
    mutation.mutate({
      type,
      amount: value,
      description: description.trim(),
      notes: notes.trim() || undefined,
      transactionDate: new Date(date + "T12:00:00"),
      businessId,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-w-md">
        <DialogHeader><DialogTitle>حركة يدوية على الخزنة</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>نوع الحركة</Label>
            <Select value={type} onValueChange={(v) => setType(v as any)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="deposit">إيداع (داخل)</SelectItem>
                <SelectItem value="withdrawal">سحب (خارج)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>المبلغ <span className="text-destructive">*</span></Label>
            <Input
              type="number" inputMode="decimal" min="0" step="0.01" dir="ltr"
              value={amount} onChange={e => setAmount(e.target.value)}
              placeholder="0.00" className="mt-1"
            />
          </div>
          <div>
            <Label>الوصف <span className="text-destructive">*</span></Label>
            <Input
              value={description} onChange={e => setDescription(e.target.value)}
              placeholder="مثال: إيداع من حساب البنك" className="mt-1"
            />
          </div>
          <div>
            <Label>التاريخ</Label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1" dir="ltr" />
          </div>
          <div>
            <Label>ملاحظات</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="mt-1" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? "جاري الحفظ..." : "حفظ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
