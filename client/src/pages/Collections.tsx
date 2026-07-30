import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Banknote, Clock, History, TriangleAlert, Truck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DateRangePicker, { type DateRange } from "@/components/DateRangePicker";
import {
  SectionHeader, StatCard, ResponsiveDataTable, type Column, Pagination,
  FilterBar, SearchInput, MobileOrderCard, StatusBadge, toast,
} from "@/components/shared";
import { formatMoney } from "@/lib/money";

const COLLECTION_STATUS: Record<string, { label: string; className: string }> = {
  pending:   { label: "معلّق",       className: "border-[var(--warning)]/40 text-[var(--warning)]" },
  collected: { label: "محصّل",       className: "border-[var(--success)]/40 text-[var(--success)]" },
  partial:   { label: "محصّل جزئيًا", className: "border-[var(--info)]/40 text-[var(--info)]" },
  failed:    { label: "فاشل",        className: "border-destructive/40 text-destructive" },
};

/**
 * التحصيلات — متابعة الفرق بين المبلغ المتوقع من العميل واللي رجع فعلاً من شركة الشحن.
 *
 * النطاق: الأوردرات اللي خرجت للشحن بس. أوردر لسه "جديد" أو "ملغي" مالوش مبلغ متوقع،
 * ووجوده هنا كان هيخلي رقم "المعلّق" بلا معنى.
 *
 * "شركة الشحن" عمود مشتق: النظام مربوط ببوسطة بس، فالأوردر اللي معاه رقم شحنة بوسطة
 * بيتعرض كـ"بوسطة" والباقي "غير محدد". لو اتضافت شركة تانية بعدين لازم يبقى عمود
 * حقيقي على الأوردر — مرصود كنقص.
 */
export function CollectionsSection() {
  const { currentBusinessIds } = useBusinessContext();
  const utils = trpc.useUtils();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [expandedMobileId, setExpandedMobileId] = useState<number | null>(null);
  const [recording, setRecording] = useState<any | null>(null);
  const [historyOrder, setHistoryOrder] = useState<any | null>(null);

  const { data, isLoading } = trpc.accounting.collectionList.useQuery({
    search: search || undefined,
    collectionStatus: statusFilter !== "all" ? (statusFilter as any) : undefined,
    dateFrom: dateRange.from ?? undefined,
    dateTo: dateRange.to ?? undefined,
    page,
    limit: pageSize,
    businessIds: currentBusinessIds,
  });

  const rows = data?.orders ?? [];
  const difference = (data?.collectedTotal ?? 0) - (data?.expectedTotal ?? 0);

  const columns: Column<any>[] = [
    {
      id: "order", header: "الطلب", alwaysVisible: true,
      cell: (o) => (
        <div className="leading-tight">
          <p className="font-mono text-sm font-bold">#{o.orderNumber}</p>
          <StatusBadge status={o.status} kind="order" size="sm" />
        </div>
      ),
    },
    {
      id: "customer", header: "العميل", alwaysVisible: true,
      cell: (o) => (
        <div className="min-w-0 max-w-[190px] leading-tight">
          <p className="truncate text-sm font-semibold" title={o.customerName}>{o.customerName}</p>
          <p className="type-caption">{o.governorate}</p>
        </div>
      ),
    },
    {
      id: "carrier", header: "شركة الشحن", alwaysVisible: true,
      cell: (o) => o.bostaShipmentId || o.bostaTrackingNumber ? (
        <div className="leading-tight">
          <span className="flex items-center gap-1 text-sm font-medium text-[var(--info)]">
            <Truck className="h-3.5 w-3.5" /> بوسطة
          </span>
          {o.bostaTrackingNumber && (
            <p className="font-mono type-caption">{o.bostaTrackingNumber}</p>
          )}
        </div>
      ) : <span className="type-caption">غير محدد</span>,
    },
    {
      id: "expected", header: "المتوقع", numeric: true, alwaysVisible: true,
      cell: (o) => <span className="text-sm tabular-nums">{formatMoney(o.totalAmount)}</span>,
    },
    {
      id: "collected", header: "المحصّل", numeric: true, alwaysVisible: true,
      cell: (o) => o.collectedAmount != null
        ? <span className="text-sm font-semibold tabular-nums">{formatMoney(o.collectedAmount)}</span>
        : <span className="type-caption">—</span>,
    },
    {
      id: "difference", header: "الفرق", numeric: true, alwaysVisible: true,
      cell: (o) => {
        if (o.collectedAmount == null) return <span className="type-caption">—</span>;
        const diff = Number(o.collectedAmount) - Number(o.totalAmount);
        if (diff === 0) return <span className="text-sm tabular-nums text-[var(--success)]">٠</span>;
        return (
          <span className={`text-sm font-semibold tabular-nums ${diff < 0 ? "text-destructive" : "text-[var(--success)]"}`}>
            {diff > 0 ? "+" : "−"}{formatMoney(Math.abs(diff))}
          </span>
        );
      },
    },
    {
      id: "status", header: "الحالة", alwaysVisible: true,
      cell: (o) => {
        const conf = COLLECTION_STATUS[o.collectionStatus] ?? COLLECTION_STATUS.pending;
        return <Badge variant="outline" className={`text-xs ${conf.className}`}>{conf.label}</Badge>;
      },
    },
    {
      // "الموظف الذي قام بالتحصيل" — مشتق على السيرفر من آخر حركة خزنة للأوردر
      id: "collectedBy", header: "حصّله", alwaysVisible: true,
      cell: (o) => o.collectedByName
        ? <span className="text-sm">{o.collectedByName}</span>
        : <span className="type-caption">—</span>,
    },
    {
      id: "collectedAt", header: "تاريخ التحصيل", alwaysVisible: true,
      cell: (o) => o.collectedAt ? (
        <span className="whitespace-nowrap text-sm tabular-nums">
          {new Date(o.collectedAt).toLocaleDateString("ar-EG", { day: "numeric", month: "short" })}
        </span>
      ) : <span className="type-caption">—</span>,
    },
    {
      id: "actions", header: "", alwaysVisible: true, sticky: true,
      cell: (o) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={() => setRecording(o)}>
            <Banknote className="h-3.5 w-3.5" />
            {o.collectedAmount != null ? "تعديل" : "تسجيل"}
          </Button>
          {/* السجل بيظهر بس لما يكون فيه حركة فعلاً — زرار بيفتح شاشة فاضية أسوأ من
              زرار مش موجود. */}
          {o.collectedAmount != null && (
            <Button
              size="icon" variant="ghost" className="h-8 w-8"
              title="سجل التحصيل" aria-label="سجل التحصيل"
              onClick={() => setHistoryOrder(o)}
            >
              <History className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader description="متابعة المبالغ المتوقعة مقابل اللي رجع فعلاً من شركة الشحن">
        <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 lg:grid lg:grid-cols-3 lg:overflow-visible [&>*]:min-w-[196px] [&>*]:snap-start lg:[&>*]:min-w-0">
          <StatCard
            label="المتوقع" tone="primary" loading={isLoading}
            value={formatMoney(data?.expectedTotal ?? 0)}
            hint="حسب الفلاتر الحالية"
            icon={<Clock className="h-5 w-5" />}
          />
          <StatCard
            label="المحصّل" tone="success" loading={isLoading}
            value={formatMoney(data?.collectedTotal ?? 0)}
            icon={<Banknote className="h-5 w-5" />}
          />
          <StatCard
            label="الفرق"
            tone={difference < 0 ? "danger" : "success"}
            loading={isLoading}
            value={formatMoney(difference)}
            hint={difference < 0 ? "أقل من المتوقع" : "مطابق أو أعلى"}
            icon={<TriangleAlert className="h-5 w-5" />}
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
                placeholder="بحث بالعميل أو رقم الأوردر أو الهاتف..."
              />
            }
            chips={[]}
            onReset={() => { setPage(1); setSearch(""); setStatusFilter("all"); setDateRange({ from: null, to: null }); }}
            activeCount={(statusFilter !== "all" ? 1 : 0) + (dateRange.from || dateRange.to ? 1 : 0)}
          >
            <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(1); }}>
              <SelectTrigger className="h-9 w-40"><SelectValue placeholder="حالة التحصيل" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل الحالات</SelectItem>
                {Object.entries(COLLECTION_STATUS).map(([v, c]) => (
                  <SelectItem key={v} value={v}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DateRangePicker value={dateRange} onChange={(r) => { setDateRange(r); setPage(1); }} />
          </FilterBar>
        </CardContent>
      </Card>

      <ResponsiveDataTable
        rows={rows}
        columns={columns}
        rowKey={(o: any) => o.id}
        loading={isLoading}
        empty={{ title: "لا توجد أوردرات للتحصيل", description: "الأوردرات بتظهر هنا بعد ما تخرج للشحن" }}
        mobileRow={(o: any) => {
          const conf = COLLECTION_STATUS[o.collectionStatus] ?? COLLECTION_STATUS.pending;
          return (
            <MobileOrderCard
              orderNumber={o.orderNumber}
              customerName={o.customerName}
              customerPhone={o.customerPhone}
              governorate={o.governorate}
              productSummary={`متوقع ${formatMoney(o.totalAmount)}${o.collectedAmount != null ? ` · محصّل ${formatMoney(o.collectedAmount)}` : ""}`}
              statusBadge={<Badge variant="outline" className={`text-xs ${conf.className}`}>{conf.label}</Badge>}
              total={formatMoney(o.collectedAmount ?? o.totalAmount)}
              dateLabel={o.shippedAt
                ? new Date(o.shippedAt).toLocaleDateString("ar-EG", { day: "numeric", month: "short" })
                : "—"}
              expanded={expandedMobileId === o.id}
              onToggle={() => setExpandedMobileId(id => id === o.id ? null : o.id)}
              details={
                <div className="space-y-2">
                  {o.bostaTrackingNumber && (
                    <p className="type-caption">تتبع بوسطة: <span className="font-mono">{o.bostaTrackingNumber}</span></p>
                  )}
                  <Button size="sm" variant="outline" className="w-full gap-1" onClick={() => setRecording(o)}>
                    <Banknote className="h-3.5 w-3.5" />
                    {o.collectedAmount != null ? "تعديل التحصيل" : "تسجيل التحصيل"}
                  </Button>
                </div>
              }
            />
          );
        }}
      />

      <Pagination
        page={data?.page ?? 1}
        total={data?.total ?? 0}
        pageSize={pageSize}
        pageSizeOptions={[25, 50, 100]}
        onPageChange={setPage}
        onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
      />

      <CollectionHistoryDialog order={historyOrder} onClose={() => setHistoryOrder(null)} />

      <RecordCollectionDialog
        order={recording}
        onClose={() => setRecording(null)}
        onDone={() => {
          utils.accounting.collectionList.invalidate();
          utils.accounting.treasuryList.invalidate();
          utils.accounting.treasuryBalance.invalidate();
          utils.accounting.dashboard.invalidate();
          setRecording(null);
        }}
      />
    </div>
  );
}

/**
 * تسجيل تحصيل.
 *
 * الحالة (محصّل / جزئي / فاشل) مابتتسألش من المستخدم — السيرفر بيستنتجها من المقارنة
 * بين المحصّل والمتوقع. سؤال المستخدم عنها كان بيسمح بأوردر محصّل بالكامل وحالته "معلّق".
 */
function RecordCollectionDialog({
  order, onClose, onDone,
}: {
  order: any | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [formKey, setFormKey] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));

  const key = String(order?.id ?? "");
  if (key !== formKey) {
    setFormKey(key);
    // الافتراضي هو المبلغ المتوقع كامل: ده الحالة الأغلب، فالمستخدم بيأكد بدل ما يكتب.
    setAmount(order ? String(order.collectedAmount ?? order.totalAmount) : "");
    setDate(order?.collectedAt
      ? new Date(order.collectedAt).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10));
  }

  const mutation = trpc.accounting.collectionRecord.useMutation({
    onSuccess: (res: any) => {
      const label = COLLECTION_STATUS[res?.status]?.label ?? "";
      toast.success(`تم تسجيل التحصيل${label ? ` — ${label}` : ""}`);
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });

  if (!order) return null;

  const value = Number(amount);
  const expected = Number(order.totalAmount);
  const diff = Number.isFinite(value) ? value - expected : 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-w-md">
        <DialogHeader>
          <DialogTitle>تسجيل تحصيل — {order.orderNumber}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-[var(--radius-brand-md)] border border-border bg-muted/40 p-3 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">العميل</span><span className="font-semibold">{order.customerName}</span></div>
            <div className="mt-1 flex justify-between"><span className="text-muted-foreground">المبلغ المتوقع</span><span className="font-semibold tabular-nums">{formatMoney(expected)}</span></div>
          </div>
          <div>
            <Label>المبلغ المحصّل <span className="text-destructive">*</span></Label>
            <Input
              type="number" inputMode="decimal" min="0" step="0.01" dir="ltr"
              value={amount} onChange={e => setAmount(e.target.value)}
              className="mt-1"
            />
            {/* معاينة الحالة قبل الحفظ: المستخدم يشوف نتيجة الرقم اللي كتبه فورًا
                بدل ما يكتشفها بعد الحفظ. */}
            {Number.isFinite(value) && amount !== "" && (
              <p className="type-caption mt-1">
                {value <= 0
                  ? "سيُسجَّل كـ«فاشل» — لم يُحصَّل أي مبلغ"
                  : diff < 0
                    ? `سيُسجَّل كـ«محصّل جزئيًا» — ناقص ${formatMoney(Math.abs(diff))}`
                    : "سيُسجَّل كـ«محصّل» بالكامل"}
              </p>
            )}
          </div>
          <div>
            <Label>تاريخ التحصيل</Label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1" dir="ltr" />
          </div>
          {order.collectedAmount != null && (
            <p className="type-caption rounded-[var(--radius-brand-sm)] bg-[var(--info)]/10 p-2">
              التعديل بينزل حركة تسوية بالفرق على الخزنة، مش بيعدّل حركة التحصيل الأصلية.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button
            disabled={mutation.isPending || !Number.isFinite(value) || amount === ""}
            onClick={() => mutation.mutate({
              orderId: order.id,
              collectedAmount: value,
              collectedAt: new Date(date + "T12:00:00"),
            })}
          >
            {mutation.isPending ? "جاري الحفظ..." : "حفظ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * سجل تحصيل أوردر واحد.
 *
 * بيقرا حركات الخزنة المرتبطة بالأوردر بالترتيب الزمني: التحصيل الأول، وأي تصحيح بعده،
 * ومين عمل كل خطوة. الأوردر نفسه بيحمل آخر قيمة بس — السجل ده هو اللي بيمسك المسار.
 */
function CollectionHistoryDialog({
  order, onClose,
}: {
  order: any | null;
  onClose: () => void;
}) {
  const { data, isLoading } = trpc.accounting.collectionHistory.useQuery(
    { orderId: order?.id as number },
    { enabled: order?.id != null }
  );

  if (!order) return null;
  const rows = data ?? [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>سجل التحصيل — {order.orderNumber}</DialogTitle>
        </DialogHeader>

        <div className="rounded-[var(--radius-brand-md)] border border-border bg-muted/40 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">العميل</span>
            <span className="font-semibold">{order.customerName}</span>
          </div>
          <div className="mt-1 flex justify-between">
            <span className="text-muted-foreground">المتوقع</span>
            <span className="font-semibold tabular-nums">{formatMoney(order.totalAmount)}</span>
          </div>
          <div className="mt-1 flex justify-between">
            <span className="text-muted-foreground">المحصّل حاليًا</span>
            <span className="font-semibold tabular-nums">{formatMoney(order.collectedAmount)}</span>
          </div>
        </div>

        {isLoading ? (
          <p className="type-caption py-6 text-center">جاري التحميل...</p>
        ) : rows.length === 0 ? (
          <p className="type-caption py-6 text-center">لا توجد حركات مسجّلة لهذا الأوردر</p>
        ) : (
          <ol className="space-y-0">
            {rows.map((t: any, i: number) => {
              const isIn = t.direction === "in";
              return (
                <li key={t.id} className="flex gap-3">
                  {/* نفس نمط الخط الزمني في drawer الأوردرات: نقطة لكل خطوة، وخط واصل
                      ما عدا الأخيرة. */}
                  <div className="flex flex-col items-center">
                    <span
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: isIn ? "var(--success)" : "var(--destructive)" }}
                    />
                    {i < rows.length - 1 && <span className="w-px flex-1 bg-border" />}
                  </div>
                  <div className={`flex min-w-0 flex-1 items-start justify-between gap-3 ${i < rows.length - 1 ? "pb-3" : ""}`}>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1 text-sm font-semibold"
                        style={{ color: isIn ? "var(--success)" : "var(--destructive)" }}>
                        {isIn ? <ArrowDownLeft className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
                        {isIn ? "+" : "−"}{formatMoney(t.amount)}
                      </p>
                      <p className="type-caption">{t.performedByName}</p>
                      {t.notes && <p className="type-caption truncate" title={t.notes}>{t.notes}</p>}
                    </div>
                    <p className="type-caption shrink-0 tabular-nums">
                      {new Date(t.transactionDate).toLocaleDateString("ar-EG", { day: "numeric", month: "short" })}
                      {" · "}
                      {new Date(t.transactionDate).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إغلاق</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
