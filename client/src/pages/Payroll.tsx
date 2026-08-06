import { useMemo, useState } from "react";
import {
  BadgeCheck,
  Banknote,
  CalendarPlus,
  FileText,
  HandCoins,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  Users,
  Wallet,
  XCircle,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { EvidenceUpload } from "@/components/EvidenceUpload";
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
import {
  SectionHeader,
  StatCard,
  ResponsiveDataTable,
  type Column,
  Pagination,
  ConfirmDialog,
  Drawer,
  LoadingSkeleton,
  EmptyState,
  toast,
} from "@/components/shared";
import { formatAmount, formatMoney } from "@/lib/money";
import { printPayslip } from "@/lib/printPayslip";

const MONTHS = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

const PERIOD_STATUS: Record<string, { label: string; className: string }> = {
  draft: { label: "مسودة", className: "border-border text-muted-foreground" },
  approved: {
    label: "معتمد",
    className: "border-[var(--info)]/40 text-[var(--info)]",
  },
  paid: {
    label: "مدفوع",
    className: "border-[var(--success)]/40 text-[var(--success)]",
  },
  cancelled: {
    label: "ملغي",
    className: "border-destructive/40 text-destructive",
  },
};

const ADVANCE_STATUS: Record<string, { label: string; className: string }> = {
  pending: {
    label: "معلّقة",
    className: "border-[var(--warning)]/40 text-[var(--warning)]",
  },
  settled: {
    label: "مُسوّاة",
    className: "border-[var(--success)]/40 text-[var(--success)]",
  },
  cancelled: {
    label: "ملغاة",
    className: "border-destructive/40 text-destructive",
  },
};

const SALARY_TYPES: Record<string, string> = {
  monthly: "شهري",
  daily: "يومي",
  commission: "عمولة",
  mixed: "مختلط",
};

const COMMISSION_BASIS: Record<string, string> = {
  confirmed: "عند التأكيد",
  prepared: "عند التجهيز",
  shipped: "عند الشحن",
  delivered: "عند التوصيل",
};

/** الرقم كبير والعملة صغيرة وراه — نفس نمط بطاقات الخزنة. */
function Money({ value }: { value: unknown }) {
  return (
    <span className="whitespace-nowrap">
      {formatAmount(value)}
      <span className="ms-1 text-sm font-normal text-muted-foreground">
        ج.م
      </span>
    </span>
  );
}

/**
 * المرتبات — التاب الخامس في الحسابات.
 *
 * الرواتب فلوس، فمكانها مع الحسابات مش تحت الموظفين: نفس المنطق اللي خلّى الخزنة
 * والمصروفات والتحصيلات تاباتٍ في مكان واحد.
 */
export function PayrollSection() {
  const { currentBusinessIds } = useBusinessContext();
  const utils = trpc.useUtils();
  const businessId = currentBusinessIds?.[0];

  const [view, setView] = useState<"periods" | "advances" | "profiles">(
    "periods"
  );
  const [openPeriodId, setOpenPeriodId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAdvance, setShowAdvance] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    kind: "approve" | "pay" | "delete";
    id: number;
    label: string;
  } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<any | null>(null);
  const [page, setPage] = useState(1);
  const [actionEvidence, setActionEvidence] = useState("");
  const [payAccountId, setPayAccountId] = useState("");

  const { data: summary, isLoading: summaryLoading } =
    trpc.payroll.summary.useQuery({
      businessIds: currentBusinessIds,
    });
  const { data: periodsData, isLoading: periodsLoading } =
    trpc.payroll.periodList.useQuery({
      page,
      limit: 25,
      businessIds: currentBusinessIds,
    });
  const { data: advancesData, isLoading: advancesLoading } =
    trpc.payroll.advanceList.useQuery({
      page: 1,
      limit: 50,
      businessIds: currentBusinessIds,
    });
  const { data: financialAccounts = [] } =
    trpc.accountingV2.financialAccounts.useQuery(
      { businessId: businessId! },
      { enabled: Boolean(businessId) }
    );

  const invalidateAll = () => {
    utils.payroll.invalidate();
    // الدفع بينشئ مصروفًا وحركة خزنة، فأرقام الحسابات لازم تتحدّث معاه
    utils.accounting.invalidate();
  };

  const approveMutation = trpc.payroll.periodApprove.useMutation({
    onSuccess: () => {
      toast.success("تم اعتماد الدورة وخصم السُلف المعلّقة");
      invalidateAll();
      setPendingAction(null);
    },
    onError: e => {
      toast.error(e.message);
      setPendingAction(null);
    },
  });
  const payMutation = trpc.payroll.periodPay.useMutation({
    // القراءة من الاستجابة بحارس: رسالة نجاح مالهاش لازمة تقع وتطلع للمستخدم
    // "Cannot read properties of null" بدل التأكيد.
    onSuccess: (r: any) => {
      toast.success(
        r?.transactionId
          ? `تم الدفع — حركة مالية #${r.transactionId}`
          : "تم الدفع"
      );
      invalidateAll();
      setPendingAction(null);
    },
    onError: e => {
      toast.error(e.message);
      setPendingAction(null);
    },
  });
  const deleteMutation = trpc.payroll.periodDelete.useMutation({
    onSuccess: () => {
      toast.success("تم حذف الدورة");
      invalidateAll();
      setPendingAction(null);
    },
    onError: e => {
      toast.error(e.message);
      setPendingAction(null);
    },
  });
  const cancelMutation = trpc.payroll.periodCancel.useMutation({
    onSuccess: () => {
      toast.success("تم إلغاء الدورة وإرجاع السُلف");
      invalidateAll();
      setCancelTarget(null);
    },
    onError: e => toast.error(e.message),
  });

  const periodColumns: Column<any>[] = [
    {
      id: "period",
      header: "الشهر",
      alwaysVisible: true,
      cell: p => (
        <div className="leading-tight">
          <p className="text-sm font-bold">
            {MONTHS[p.month - 1]} {p.year}
          </p>
          <p className="type-caption">{p.employeeCount} موظف</p>
        </div>
      ),
    },
    {
      id: "status",
      header: "الحالة",
      alwaysVisible: true,
      cell: p => {
        const c = PERIOD_STATUS[p.status] ?? PERIOD_STATUS.draft;
        return (
          <Badge variant="outline" className={`text-xs ${c.className}`}>
            {c.label}
          </Badge>
        );
      },
    },
    {
      id: "gross",
      header: "الإجمالي",
      numeric: true,
      alwaysVisible: true,
      cell: p => (
        <span className="text-sm tabular-nums">
          {formatMoney(p.totalGross)}
        </span>
      ),
    },
    {
      id: "net",
      header: "الصافي",
      numeric: true,
      alwaysVisible: true,
      cell: p => (
        <span className="text-sm font-bold tabular-nums">
          {formatMoney(p.totalNet)}
        </span>
      ),
    },
    {
      id: "trail",
      header: "سجل الإجراءات",
      alwaysVisible: true,
      cell: p => (
        <div className="leading-tight type-caption">
          {p.approvedByName && <p>اعتمد: {p.approvedByName}</p>}
          {p.paidByName && <p>دفع: {p.paidByName}</p>}
          {p.cancelledByName && (
            <p className="text-destructive">ألغى: {p.cancelledByName}</p>
          )}
          {!p.approvedByName && !p.paidByName && !p.cancelledByName && (
            <p>أنشأ: {p.createdByName}</p>
          )}
        </div>
      ),
    },
    {
      id: "actions",
      header: "",
      alwaysVisible: true,
      sticky: true,
      cell: p => (
        <div
          className="flex items-center gap-1"
          onClick={e => e.stopPropagation()}
        >
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1 text-xs"
            onClick={() => setOpenPeriodId(p.id)}
          >
            <FileText className="h-3.5 w-3.5" /> التفاصيل
          </Button>
          {p.status === "draft" && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 border-[var(--info)]/40 text-xs text-[var(--info)]"
                onClick={() =>
                  setPendingAction({
                    kind: "approve",
                    id: p.id,
                    label: `${MONTHS[p.month - 1]} ${p.year}`,
                  })
                }
              >
                <BadgeCheck className="h-3.5 w-3.5" /> اعتماد
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-destructive hover:bg-destructive/12 hover:text-destructive"
                title="حذف المسودة"
                aria-label="حذف المسودة"
                onClick={() =>
                  setPendingAction({
                    kind: "delete",
                    id: p.id,
                    label: `${MONTHS[p.month - 1]} ${p.year}`,
                  })
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
          {p.status === "approved" && (
            <Button
              size="sm"
              className="h-8 gap-1 bg-[var(--success)] text-xs text-[var(--success-foreground)] hover:opacity-90"
              onClick={() =>
                setPendingAction({
                  kind: "pay",
                  id: p.id,
                  label: `${MONTHS[p.month - 1]} ${p.year}`,
                })
              }
            >
              <Banknote className="h-3.5 w-3.5" /> دفع
            </Button>
          )}
          {p.status !== "cancelled" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground"
              title="إلغاء الدورة"
              aria-label="إلغاء الدورة"
              onClick={() => setCancelTarget(p)}
            >
              <XCircle className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  const advanceColumns: Column<any>[] = [
    {
      id: "employee",
      header: "الموظف",
      alwaysVisible: true,
      cell: a => (
        <span className="text-sm font-semibold">{a.employeeName}</span>
      ),
    },
    {
      id: "amount",
      header: "المبلغ",
      numeric: true,
      alwaysVisible: true,
      cell: a => (
        <span className="text-sm font-bold tabular-nums">
          {formatMoney(a.amount)}
        </span>
      ),
    },
    {
      id: "date",
      header: "التاريخ",
      alwaysVisible: true,
      cell: a => (
        <span className="whitespace-nowrap text-sm tabular-nums">
          {new Date(a.advanceDate).toLocaleDateString("ar-EG", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </span>
      ),
    },
    {
      id: "reason",
      header: "السبب",
      alwaysVisible: true,
      cell: a => (
        <p className="max-w-[260px] truncate text-sm" title={a.reason ?? ""}>
          {a.reason || "—"}
        </p>
      ),
    },
    {
      id: "status",
      header: "الحالة",
      alwaysVisible: true,
      cell: a => {
        const c = ADVANCE_STATUS[a.status] ?? ADVANCE_STATUS.pending;
        return (
          <Badge variant="outline" className={`text-xs ${c.className}`}>
            {c.label}
          </Badge>
        );
      },
    },
    {
      id: "createdBy",
      header: "صرفها",
      alwaysVisible: true,
      cell: a => <span className="type-caption">{a.createdByName}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <SectionHeader
        description="ملفات الرواتب ودورات الصرف والسُلف — كل دفعة بتنزل قيد مصروف واحد على الحسابات"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => setShowSettings(true)}
            >
              <Settings2 className="h-4 w-4" /> الإعدادات
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => setShowAdvance(true)}
            >
              <HandCoins className="h-4 w-4" /> صرف سُلفة
            </Button>
            <Button
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => setShowCreate(true)}
            >
              <CalendarPlus className="h-4 w-4" /> دورة جديدة
            </Button>
          </>
        }
      >
        <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 lg:grid lg:grid-cols-4 lg:overflow-visible [&>*]:min-w-[196px] [&>*]:snap-start lg:[&>*]:min-w-0">
          <StatCard
            label="مصروف رواتب السنة"
            tone="primary"
            loading={summaryLoading}
            value={<Money value={summary?.paidThisYear ?? 0} />}
            hint={String(new Date().getFullYear())}
            icon={<Wallet className="h-5 w-5" />}
          />
          <StatCard
            label="سُلف معلّقة"
            tone="warning"
            loading={summaryLoading}
            value={<Money value={summary?.pendingAdvances ?? 0} />}
            hint="هتُخصم في الدورة الجاية"
            icon={<HandCoins className="h-5 w-5" />}
          />
          <StatCard
            label="دورات بانتظار إجراء"
            tone="info"
            loading={summaryLoading}
            value={(
              (summary?.draftPeriods ?? 0) + (summary?.approvedPeriods ?? 0)
            ).toLocaleString("ar-EG")}
            hint={`${summary?.draftPeriods ?? 0} مسودة · ${summary?.approvedPeriods ?? 0} معتمدة`}
            icon={<FileText className="h-5 w-5" />}
          />
          <StatCard
            label="موظفون بملف راتب"
            loading={summaryLoading}
            value={(summary?.employeesWithProfile ?? 0).toLocaleString("ar-EG")}
            icon={<Users className="h-5 w-5" />}
          />
        </div>
      </SectionHeader>

      {/* تبديل بين الدورات والسُلف — شرائح مش تابات تانية جوه تاب */}
      <div className="flex items-center gap-1.5">
        {(
          [
            { key: "periods", label: "دورات الرواتب" },
            { key: "advances", label: "السُلف" },
          ] as const
        ).map(v => (
          <Button
            key={v.key}
            variant={view === v.key ? "default" : "outline"}
            size="sm"
            className="h-9"
            aria-pressed={view === v.key}
            onClick={() => setView(v.key)}
          >
            {v.label}
          </Button>
        ))}
      </div>

      {view === "periods" ? (
        <>
          <ResponsiveDataTable
            rows={periodsData?.periods ?? []}
            columns={periodColumns}
            rowKey={(p: any) => p.id}
            loading={periodsLoading}
            onRowClick={(p: any) => setOpenPeriodId(p.id)}
            empty={{
              title: "لا توجد دورات رواتب",
              description:
                "أنشئ دورة لشهر لتوليد سطر راتب لكل موظف له ملف راتب ساري",
            }}
          />
          <Pagination
            page={periodsData?.page ?? 1}
            total={periodsData?.total ?? 0}
            pageSize={25}
            onPageChange={setPage}
          />
        </>
      ) : (
        <ResponsiveDataTable
          rows={advancesData?.advances ?? []}
          columns={advanceColumns}
          rowKey={(a: any) => a.id}
          loading={advancesLoading}
          empty={{
            title: "لا توجد سُلف",
            description: "السُلفة بتتسجّل كمصروف فور صرفها",
          }}
        />
      )}

      <PeriodDrawer
        periodId={openPeriodId}
        onClose={() => setOpenPeriodId(null)}
      />

      <CreatePeriodDialog
        open={showCreate}
        businessId={businessId}
        onClose={() => setShowCreate(false)}
        onDone={id => {
          invalidateAll();
          setShowCreate(false);
          setOpenPeriodId(id);
        }}
      />
      <AdvanceDialog
        open={showAdvance}
        businessId={businessId}
        onClose={() => setShowAdvance(false)}
        onDone={() => {
          invalidateAll();
          setShowAdvance(false);
        }}
      />
      <SettingsDialog
        open={showSettings}
        businessId={businessId}
        onClose={() => setShowSettings(false)}
      />

      <ConfirmDialog
        open={pendingAction != null}
        onOpenChange={o => {
          if (!o) {
            setPendingAction(null);
            setActionEvidence("");
            setPayAccountId("");
          }
        }}
        title={
          pendingAction?.kind === "approve"
            ? "اعتماد الدورة؟"
            : pendingAction?.kind === "pay"
              ? "دفع الدورة؟"
              : "حذف المسودة؟"
        }
        description={
          <div className="space-y-3">
            <p>
              {pendingAction?.kind === "approve"
                ? `سيتم تثبيت أرقام ${pendingAction.label} وإنشاء الاستحقاق اليومي للرواتب.`
                : pendingAction?.kind === "pay"
                  ? `سيتم دفع صافي ${pendingAction.label} من الحساب المالي المختار، بدون تسجيل مصروف مكرر.`
                  : `سيتم حذف مسودة ${pendingAction?.label ?? ""} وكل سطورها نهائيًا.`}
            </p>
            {(pendingAction?.kind === "approve" ||
              pendingAction?.kind === "pay") && (
              <EvidenceUpload
                label="كشف الرواتب / مستند الاعتماد"
                value={actionEvidence}
                onChange={setActionEvidence}
              />
            )}
            {pendingAction?.kind === "pay" && (
              <PaymentSource
                accounts={financialAccounts}
                value={payAccountId}
                onChange={setPayAccountId}
              />
            )}
          </div>
        }
        confirmLabel={
          pendingAction?.kind === "approve"
            ? "اعتماد"
            : pendingAction?.kind === "pay"
              ? "تأكيد الدفع"
              : "حذف"
        }
        tone={pendingAction?.kind === "delete" ? "destructive" : "default"}
        pending={
          approveMutation.isPending ||
          payMutation.isPending ||
          deleteMutation.isPending
        }
        onConfirm={() => {
          if (!pendingAction) return;
          if (
            (pendingAction.kind === "approve" ||
              pendingAction.kind === "pay") &&
            !actionEvidence.trim()
          ) {
            toast.error("رابط الدليل مطلوب");
            return;
          }
          if (pendingAction.kind === "approve")
            approveMutation.mutate({
              id: pendingAction.id,
              evidenceUrl: actionEvidence.trim(),
            });
          else if (pendingAction.kind === "pay") {
            if (paymentSourceMissing(financialAccounts, payAccountId)) {
              toast.error("اختار الخزنة اللي هتخرج منها الفلوس");
              return;
            }
            payMutation.mutate({
              id: pendingAction.id,
              sourceAccountId: paymentSourceId(financialAccounts, payAccountId),
              evidenceUrl: actionEvidence.trim(),
            });
          } else deleteMutation.mutate({ id: pendingAction.id });
        }}
      />

      <CancelPeriodDialog
        period={cancelTarget}
        onClose={() => setCancelTarget(null)}
        onConfirm={reason =>
          cancelTarget && cancelMutation.mutate({ id: cancelTarget.id, reason })
        }
        pending={cancelMutation.isPending}
      />
    </div>
  );
}

/**
 * تفاصيل الدورة — سطر لكل موظف مع الصيغة كاملة.
 *
 * السطور قابلة للتعديل في المسودة بس. بعد الاعتماد بتتعرض للقراءة: المدير وافق على
 * أرقام بعينها، وتعديلها بعد الاعتماد معناه إن الاعتماد نفسه بلا قيمة.
 */
function PeriodDrawer({
  periodId,
  onClose,
}: {
  periodId: number | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const { data: period, isLoading } = trpc.payroll.periodGet.useQuery(
    { id: periodId as number },
    { enabled: periodId != null }
  );
  const [editing, setEditing] = useState<any | null>(null);

  const recalcMutation = trpc.payroll.periodRecalculate.useMutation({
    onSuccess: (r: any) => {
      toast.success(
        r?.employeeCount != null
          ? `تمت إعادة الحساب — ${r.employeeCount} موظف`
          : "تمت إعادة الحساب"
      );
      utils.payroll.invalidate();
    },
    onError: e => toast.error(e.message),
  });

  const isDraft = period?.status === "draft";
  const statusConf = period
    ? (PERIOD_STATUS[period.status] ?? PERIOD_STATUS.draft)
    : null;

  return (
    <Drawer
      open={periodId != null}
      onOpenChange={o => !o && onClose()}
      width="xl"
      title={
        period
          ? `رواتب ${MONTHS[period.month - 1]} ${period.year}`
          : "دورة رواتب"
      }
      headerExtra={
        statusConf ? (
          <Badge
            variant="outline"
            className={`text-xs ${statusConf.className}`}
          >
            {statusConf.label}
          </Badge>
        ) : undefined
      }
      subHeader={
        isDraft ? (
          <Button
            size="sm"
            variant="outline"
            className="h-9 gap-1.5"
            disabled={recalcMutation.isPending}
            onClick={() => periodId && recalcMutation.mutate({ id: periodId })}
          >
            <RefreshCw className="h-4 w-4" /> إعادة حساب
          </Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <LoadingSkeleton variant="table" rows={5} />
      ) : !period ? (
        <EmptyState title="الدورة غير موجودة" />
      ) : period.items.length === 0 ? (
        <EmptyState
          icon={<Users className="h-6 w-6" />}
          title="لا توجد سطور"
          description="لا يوجد موظف نشط له ملف راتب ساري في هذا الشهر"
        />
      ) : (
        <div className="space-y-3">
          {isDraft && (
            <p className="type-caption rounded-[var(--radius-brand-sm)] bg-[var(--info)]/10 p-2">
              التعديل اليدوي على أي حقل محسوب بيقفله — إعادة الحساب بعدها
              مابتكتبش فوقه.
            </p>
          )}
          {period.items.map((item: any) => (
            <PayrollItemCard
              key={item.id}
              item={item}
              period={period}
              editable={isDraft}
              onEdit={() => setEditing(item)}
            />
          ))}
        </div>
      )}

      <EditItemDialog
        item={editing}
        onClose={() => setEditing(null)}
        onDone={() => {
          utils.payroll.invalidate();
          setEditing(null);
        }}
      />
    </Drawer>
  );
}

function PayrollItemCard({
  item,
  period,
  editable,
  onEdit,
}: {
  item: any;
  period: any;
  editable: boolean;
  onEdit: () => void;
}) {
  const manual = useMemo<string[]>(() => {
    try {
      return JSON.parse(item.manualFields ?? "[]");
    } catch {
      return [];
    }
  }, [item.manualFields]);

  const line = (
    label: string,
    value: unknown,
    kind: "add" | "sub" | "plain" = "plain",
    field?: string
  ) => (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {label}
        {field && manual.includes(field) && (
          <Badge
            variant="outline"
            className="border-[var(--warning)]/40 px-1 py-0 text-[10px] text-[var(--warning)]"
          >
            يدوي
          </Badge>
        )}
      </span>
      <span
        className={`tabular-nums ${
          kind === "add"
            ? "text-[var(--success)]"
            : kind === "sub"
              ? "text-destructive"
              : "font-medium"
        }`}
      >
        {kind === "sub" ? "−" : kind === "add" ? "+" : ""}
        {formatMoney(value)}
      </span>
    </div>
  );

  return (
    <Card className="shadow-[var(--shadow-card)]">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="type-subheading">{item.employeeName}</CardTitle>
        <p className="type-caption">
          {SALARY_TYPES[item.salaryType] ?? item.salaryType}
          {" · "}حضور {item.attendanceDays} · غياب {item.absenceDays}
        </p>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {line("الراتب الأساسي", item.baseSalary, "plain", "baseSalary")}
        {line("أوفرتايم", item.overtimeAmount, "add", "overtimeAmount")}
        {line("حوافز", item.bonuses, "add")}
        {line(
          `عمولة${item.commissionOrders > 0 ? ` (${item.commissionOrders} أوردر)` : ""}`,
          item.commissions,
          "add",
          "commissions"
        )}
        {line("خصم غياب", item.absenceDeduction, "sub", "absenceDeduction")}
        {line("خصومات", item.deductions, "sub")}
        {line("سُلف", item.advances, "sub")}

        <div className="flex items-baseline justify-between gap-2 border-t border-border pt-2">
          <span className="type-subheading">الصافي</span>
          <span
            className={`text-lg font-bold tabular-nums ${
              Number(item.netSalary) < 0 ? "text-destructive" : "text-primary"
            }`}
          >
            {formatMoney(item.netSalary)}
          </span>
        </div>

        <div className="flex gap-2 pt-1">
          {editable && (
            <Button
              size="sm"
              variant="outline"
              className="flex-1 h-8 text-xs"
              onClick={onEdit}
            >
              تعديل
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="flex-1 h-8 gap-1 text-xs"
            onClick={() => {
              const ok = printPayslip({
                employeeName: item.employeeName,
                employeeId: item.employeeId,
                month: period.month,
                year: period.year,
                salaryType: item.salaryType,
                baseSalary: item.baseSalary,
                attendanceDays: item.attendanceDays,
                absenceDays: item.absenceDays,
                overtimeAmount: item.overtimeAmount,
                bonuses: item.bonuses,
                commissions: item.commissions,
                commissionOrders: item.commissionOrders,
                absenceDeduction: item.absenceDeduction,
                deductions: item.deductions,
                advances: item.advances,
                netSalary: item.netSalary,
                notes: item.notes,
                periodStatus: period.status,
                paidAt: period.paidAt,
                approvedByName: period.approvedByName,
                paidByName: period.paidByName,
              });
              if (!ok)
                toast.error(
                  "المتصفح منع نافذة الطباعة — اسمح بالنوافذ المنبثقة"
                );
            }}
          >
            <FileText className="h-3.5 w-3.5" /> كشف راتب
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EditItemDialog({
  item,
  onClose,
  onDone,
}: {
  item: any | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [formKey, setFormKey] = useState("");
  const [form, setForm] = useState<Record<string, string>>({});

  const key = String(item?.id ?? "");
  if (key !== formKey) {
    setFormKey(key);
    setForm(
      item
        ? {
            attendanceDays: String(item.attendanceDays ?? 0),
            absenceDays: String(item.absenceDays ?? 0),
            overtimeAmount: String(item.overtimeAmount ?? 0),
            bonuses: String(item.bonuses ?? 0),
            deductions: String(item.deductions ?? 0),
            commissions: String(item.commissions ?? 0),
            notes: item.notes ?? "",
          }
        : {}
    );
  }

  const mutation = trpc.payroll.itemUpdate.useMutation({
    onSuccess: () => {
      toast.success("تم حفظ السطر");
      onDone();
    },
    onError: e => toast.error(e.message),
  });

  if (!item) return null;
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  const num = (k: string) => {
    const n = Number(form[k]);
    return Number.isFinite(n) ? n : 0;
  };

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent
        dir="rtl"
        className="max-h-[90vh] max-w-md overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>تعديل سطر — {item.employeeName}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              ["attendanceDays", "أيام الحضور"],
              ["absenceDays", "أيام الغياب"],
              ["overtimeAmount", "أوفرتايم"],
              ["bonuses", "حوافز"],
              ["deductions", "خصومات"],
              ["commissions", "عمولة"],
            ] as const
          ).map(([k, label]) => (
            <div key={k}>
              <Label>{label}</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                dir="ltr"
                className="mt-1"
                value={form[k] ?? ""}
                onChange={e => set(k, e.target.value)}
              />
            </div>
          ))}
          <div className="col-span-2">
            <Label>ملاحظات</Label>
            <Textarea
              rows={2}
              className="mt-1"
              value={form.notes ?? ""}
              onChange={e => set("notes", e.target.value)}
            />
          </div>
        </div>
        <p className="type-caption">
          تعديل «أوفرتايم» أو «عمولة» بيقفلهم — إعادة الحساب بعدها مش هتكتب
          فوقهم.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({
                id: item.id,
                attendanceDays: num("attendanceDays"),
                absenceDays: num("absenceDays"),
                overtimeAmount: num("overtimeAmount"),
                bonuses: num("bonuses"),
                deductions: num("deductions"),
                commissions: num("commissions"),
                notes: form.notes || undefined,
              })
            }
          >
            {mutation.isPending ? "جاري الحفظ..." : "حفظ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreatePeriodDialog({
  open,
  businessId,
  onClose,
  onDone,
}: {
  open: boolean;
  businessId?: number;
  onClose: () => void;
  onDone: (id: number) => void;
}) {
  const now = new Date();
  const [year, setYear] = useState(String(now.getFullYear()));
  const [month, setMonth] = useState(String(now.getMonth() + 1));
  const [notes, setNotes] = useState("");

  const mutation = trpc.payroll.periodCreate.useMutation({
    onSuccess: (r: any) => {
      toast.success("تم إنشاء الدورة وتوليد السطور");
      onDone(r.id);
    },
    onError: e => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent dir="rtl" className="max-w-md">
        <DialogHeader>
          <DialogTitle>دورة رواتب جديدة</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>الشهر</Label>
              <Select value={month} onValueChange={setMonth}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTHS.map((m, i) => (
                    <SelectItem key={m} value={String(i + 1)}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>السنة</Label>
              <Input
                type="number"
                dir="ltr"
                className="mt-1"
                value={year}
                onChange={e => setYear(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>ملاحظات</Label>
            <Textarea
              rows={2}
              className="mt-1"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>
          <p className="type-caption">
            هيتولّد سطر لكل موظف نشط له ملف راتب ساري في الشهر ده. الموظف بلا
            ملف راتب مش هيظهر — عشان يبان إنه إعداد ناقص مش صفر مقصود.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            disabled={mutation.isPending || !businessId}
            onClick={() => {
              if (!businessId) {
                toast.error("اختر نشاطًا واحدًا من أعلى الصفحة");
                return;
              }
              mutation.mutate({
                businessId,
                year: Number(year),
                month: Number(month),
                notes: notes.trim() || undefined,
              });
            }}
          >
            {mutation.isPending ? "جاري الإنشاء..." : "إنشاء"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdvanceDialog({
  open,
  businessId,
  onClose,
  onDone,
}: {
  open: boolean;
  businessId?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { currentBusinessIds } = useBusinessContext();
  const { data: employees } = trpc.employees.activeList.useQuery(
    businessId ? { businessId } : undefined
  );
  const [employeeId, setEmployeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [receivableAccountId, setReceivableAccountId] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const { data: accounts = [] } = trpc.accountingV2.financialAccounts.useQuery(
    { businessId: businessId! },
    { enabled: Boolean(businessId && open) }
  );

  const mutation = trpc.payroll.advanceCreate.useMutation({
    onSuccess: () => {
      toast.success("تم صرف السُلفة وتسجيلها كرصيد مستحق على الموظف");
      setAmount("");
      setReason("");
      setEmployeeId("");
      setSourceAccountId("");
      setReceivableAccountId("");
      setEvidenceUrl("");
      onDone();
    },
    onError: e => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent dir="rtl" className="max-w-md">
        <DialogHeader>
          <DialogTitle>صرف سُلفة</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>
              الموظف <span className="text-destructive">*</span>
            </Label>
            <Select value={employeeId} onValueChange={setEmployeeId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="اختر الموظف" />
              </SelectTrigger>
              <SelectContent>
                {(employees ?? []).map((e: any) => (
                  <SelectItem key={e.id} value={String(e.id)}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
              className="mt-1"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>
          <div>
            <Label>التاريخ</Label>
            <Input
              type="date"
              dir="ltr"
              className="mt-1"
              value={date}
              onChange={e => setDate(e.target.value)}
            />
          </div>
          <div>
            <Label>السبب</Label>
            <Textarea
              rows={2}
              className="mt-1"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </div>
          <div>
            <Label>الحساب المصدر *</Label>
            <Select value={sourceAccountId} onValueChange={setSourceAccountId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="اختار الحساب النقدي" />
              </SelectTrigger>
              <SelectContent>
                {accounts
                  .filter(
                    (account: any) =>
                      account.isActive && account.isCashEquivalent
                  )
                  .map((account: any) => (
                    <SelectItem key={account.id} value={String(account.id)}>
                      {account.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>حساب سلف الموظفين *</Label>
            <Select
              value={receivableAccountId}
              onValueChange={setReceivableAccountId}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="اختار حساب Receivable" />
              </SelectTrigger>
              <SelectContent>
                {accounts
                  .filter(
                    (account: any) =>
                      account.isActive && !account.isCashEquivalent
                  )
                  .map((account: any) => (
                    <SelectItem key={account.id} value={String(account.id)}>
                      {account.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <EvidenceUpload
            label="إيصال التحويل / مستند الصرف"
            value={evidenceUrl}
            onChange={setEvidenceUrl}
          />
          <p className="type-caption rounded-[var(--radius-brand-sm)] bg-[var(--info)]/10 p-2">
            السُلفة تدفق نقدي خارج ورصيد مستحق على الموظف، وليست مصروفًا على
            أرباح الفترة.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            disabled={mutation.isPending}
            onClick={() => {
              const value = Number(amount);
              if (!employeeId) {
                toast.error("اختر الموظف");
                return;
              }
              if (!Number.isFinite(value) || value <= 0) {
                toast.error("أدخل مبلغًا أكبر من صفر");
                return;
              }
              if (!businessId) {
                toast.error("اختر نشاطًا واحدًا من أعلى الصفحة");
                return;
              }
              if (!sourceAccountId || !receivableAccountId) {
                toast.error("اختار الحساب المصدر وحساب السلف");
                return;
              }
              if (!evidenceUrl.trim()) {
                toast.error("رابط الدليل مطلوب");
                return;
              }
              mutation.mutate({
                businessId,
                employeeId: Number(employeeId),
                amount: value,
                advanceDate: new Date(date + "T12:00:00"),
                reason: reason.trim() || undefined,
                sourceAccountId: Number(sourceAccountId),
                receivableAccountId: Number(receivableAccountId),
                evidenceUrl: evidenceUrl.trim(),
              });
            }}
          >
            {mutation.isPending ? "جاري الصرف..." : "صرف"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettingsDialog({
  open,
  businessId,
  onClose,
}: {
  open: boolean;
  businessId?: number;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const { data: settings } = trpc.payroll.settingsGet.useQuery(
    { businessId: businessId as number },
    { enabled: open && businessId != null }
  );
  const [formKey, setFormKey] = useState("");
  const [form, setForm] = useState<Record<string, string>>({});

  const key = `${businessId}-${open}-${settings?.id ?? ""}`;
  if (key !== formKey && settings) {
    setFormKey(key);
    setForm({
      workingDaysPerMonth: String(settings.workingDaysPerMonth),
      absenceDeductionBasis: settings.absenceDeductionBasis,
      overtimeMode: settings.overtimeMode,
      overtimeMultiplier: String(settings.overtimeMultiplier),
      workHoursPerDay: String(settings.workHoursPerDay),
      currency: settings.currency,
      roundingMode: settings.roundingMode,
      defaultCommissionBasis: settings.defaultCommissionBasis,
    });
  }

  const mutation = trpc.payroll.settingsSave.useMutation({
    onSuccess: () => {
      toast.success("تم حفظ الإعدادات");
      utils.payroll.invalidate();
      onClose();
    },
    onError: e => toast.error(e.message),
  });

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent
        dir="rtl"
        className="max-h-[90vh] max-w-md overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>إعدادات محرّك الرواتب</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>أيام العمل في الشهر</Label>
              <Input
                type="number"
                min="1"
                max="31"
                dir="ltr"
                className="mt-1"
                value={form.workingDaysPerMonth ?? ""}
                onChange={e => set("workingDaysPerMonth", e.target.value)}
              />
            </div>
            <div>
              <Label>العملة</Label>
              <Input
                className="mt-1"
                value={form.currency ?? ""}
                onChange={e => set("currency", e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>أساس خصم الغياب</Label>
            <Select
              value={form.absenceDeductionBasis ?? "working_days"}
              onValueChange={v => set("absenceDeductionBasis", v)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="working_days">أيام العمل</SelectItem>
                <SelectItem value="calendar_days">أيام التقويم (٣٠)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>طريقة الأوفرتايم</Label>
            <Select
              value={form.overtimeMode ?? "manual"}
              onValueChange={v => set("overtimeMode", v)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">إدخال يدوي للمبلغ</SelectItem>
                <SelectItem value="hourly_multiplier">
                  محسوب من أجر الساعة
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.overtimeMode === "hourly_multiplier" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>مضاعف الساعة</Label>
                <Input
                  type="number"
                  step="0.25"
                  min="1"
                  max="5"
                  dir="ltr"
                  className="mt-1"
                  value={form.overtimeMultiplier ?? ""}
                  onChange={e => set("overtimeMultiplier", e.target.value)}
                />
              </div>
              <div>
                <Label>ساعات اليوم</Label>
                <Input
                  type="number"
                  step="0.5"
                  min="1"
                  max="24"
                  dir="ltr"
                  className="mt-1"
                  value={form.workHoursPerDay ?? ""}
                  onChange={e => set("workHoursPerDay", e.target.value)}
                />
              </div>
            </div>
          )}
          <div>
            <Label>تقريب الصافي</Label>
            <Select
              value={form.roundingMode ?? "none"}
              onValueChange={v => set("roundingMode", v)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">بدون تقريب</SelectItem>
                <SelectItem value="nearest_1">أقرب جنيه</SelectItem>
                <SelectItem value="nearest_5">أقرب ٥</SelectItem>
                <SelectItem value="nearest_10">أقرب ١٠</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>أساس العمولة الافتراضي</Label>
            <Select
              value={form.defaultCommissionBasis ?? "delivered"}
              onValueChange={v => set("defaultCommissionBasis", v)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(COMMISSION_BASIS).map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            disabled={mutation.isPending || !businessId}
            onClick={() => {
              if (!businessId) return;
              mutation.mutate({
                businessId,
                workingDaysPerMonth: Number(form.workingDaysPerMonth) || 26,
                absenceDeductionBasis: form.absenceDeductionBasis as any,
                overtimeMode: form.overtimeMode as any,
                overtimeMultiplier: Number(form.overtimeMultiplier) || 1.5,
                workHoursPerDay: Number(form.workHoursPerDay) || 8,
                currency: form.currency || "EGP",
                roundingMode: form.roundingMode as any,
                defaultCommissionBasis: form.defaultCommissionBasis as any,
              });
            }}
          >
            {mutation.isPending ? "جاري الحفظ..." : "حفظ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelPeriodDialog({
  period,
  onClose,
  onConfirm,
  pending,
}: {
  period: any | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  pending: boolean;
}) {
  const [reason, setReason] = useState("");
  if (!period) return null;
  const wasPaid = period.status === "paid";

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent dir="rtl" className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            إلغاء دورة {MONTHS[period.month - 1]} {period.year}؟
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {wasPaid && (
            <p className="rounded-[var(--radius-brand-sm)] border border-destructive/30 bg-destructive/10 p-2.5 text-sm">
              الدورة دي <strong>مدفوعة</strong>. الإلغاء هينزّل قيد تسوية عكسي
              يرد المبلغ للخزنة — القيد الأصلي مش هيتمسح لأن السجل المالي
              مابيتعدّلش بأثر رجعي.
            </p>
          )}
          <p className="type-caption">
            السُلف المخصومة في الدورة هترجع «معلّقة» لتُخصم في الدورة الجاية.
          </p>
          <div>
            <Label>
              سبب الإلغاء <span className="text-destructive">*</span>
            </Label>
            <Textarea
              rows={2}
              className="mt-1"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            تراجع
          </Button>
          <Button
            variant="destructive"
            disabled={pending || !reason.trim()}
            onClick={() => onConfirm(reason.trim())}
          >
            {pending ? "جاري الإلغاء..." : "تأكيد الإلغاء"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
