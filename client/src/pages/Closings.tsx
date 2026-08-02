import { useEffect, useState } from "react";
import {
  Download,
  FileText,
  LockKeyhole,
  RefreshCw,
  Send,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EvidenceUpload } from "@/components/EvidenceUpload";
import {
  EmptyState,
  LoadingSkeleton,
  SectionHeader,
} from "@/components/shared";
import {
  exportClosingWorkbook,
  printClosingReport,
} from "@/lib/closingExports";

const STATUS_LABELS: Record<string, string> = {
  draft: "مسودة",
  pending_approval: "بانتظار الاعتماد",
  approved: "معتمدة",
  locked: "مقفولة نهائيًا",
};

export function ClosingsSection() {
  const { businesses } = useBusinessContext();
  const [businessId, setBusinessId] = useState<number>();
  const [selectedId, setSelectedId] = useState<number>();
  const [periodType, setPeriodType] = useState<
    "daily" | "weekly" | "monthly" | "custom"
  >("daily");
  const [periodTo, setPeriodTo] = useState("");
  useEffect(() => {
    if (!businessId && businesses[0]) setBusinessId(businesses[0].id);
  }, [businessId, businesses]);

  const utils = trpc.useUtils();
  const list = trpc.accountingV2.closingList.useQuery(
    { businessId: businessId! },
    { enabled: Boolean(businessId) }
  );
  const detail = trpc.accountingV2.closingDetail.useQuery(
    { businessId: businessId!, closingId: selectedId! },
    { enabled: Boolean(businessId && selectedId) }
  );
  const refresh = async () => {
    await utils.accountingV2.closingList.invalidate();
    await utils.accountingV2.closingDetail.invalidate();
  };
  const mutationOptions = {
    onSuccess: refresh,
    onError: (error: { message: string }) => toast.error(error.message),
  };
  const create = trpc.accountingV2.closingCreate.useMutation({
    ...mutationOptions,
    onSuccess: async result => {
      setSelectedId(result.closingId);
      toast.success("تم إنشاء مسودة التقفيلة");
      await refresh();
    },
  });
  const submit = trpc.accountingV2.closingSubmit.useMutation({
    ...mutationOptions,
    onSuccess: async () => {
      toast.success("تم إنشاء الـ Snapshot وإرساله للاعتماد");
      await refresh();
    },
  });
  const approve = trpc.accountingV2.closingApprove.useMutation({
    ...mutationOptions,
    onSuccess: async result => {
      if (!result.approved)
        toast.error(`تعذر الاعتماد: ${result.blockers.join(", ")}`);
      else toast.success("تم اعتماد التقفيلة");
      await refresh();
    },
  });
  const lock = trpc.accountingV2.closingLock.useMutation({
    ...mutationOptions,
    onSuccess: async () => {
      toast.success("تم القفل النهائي");
      await refresh();
    },
  });
  const busy =
    create.isPending || submit.isPending || approve.isPending || lock.isPending;

  const createDraft = () => {
    if (!businessId || !periodTo)
      return toast.error("اختار النشاط ونهاية الفترة");
    create.mutate({
      businessId,
      periodType,
      periodTo: new Date(`${periodTo}T00:00:00`),
    });
  };

  return (
    <div className="space-y-4">
      <SectionHeader description="سلسلة رسمية واحدة لكل Business، من غير تداخل أو فجوات" />
      <Card className="overflow-hidden border-emerald-900/10 bg-gradient-to-l from-emerald-950 to-slate-900 text-white">
        <CardContent className="grid gap-3 p-5 md:grid-cols-[1fr_160px_180px_auto] md:items-end">
          <label className="space-y-1 text-sm">
            <span className="text-emerald-100">النشاط</span>
            <select
              className="h-10 w-full rounded-md border border-white/15 bg-white/10 px-3"
              value={businessId ?? ""}
              onChange={e => {
                setBusinessId(Number(e.target.value));
                setSelectedId(undefined);
              }}
            >
              {businesses.map(business => (
                <option
                  className="text-slate-900"
                  key={business.id}
                  value={business.id}
                >
                  {business.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-emerald-100">نوع الفترة</span>
            <select
              className="h-10 w-full rounded-md border border-white/15 bg-white/10 px-3"
              value={periodType}
              onChange={e => setPeriodType(e.target.value as typeof periodType)}
            >
              <option className="text-slate-900" value="daily">
                يومية
              </option>
              <option className="text-slate-900" value="weekly">
                أسبوعية
              </option>
              <option className="text-slate-900" value="monthly">
                شهرية
              </option>
              <option className="text-slate-900" value="custom">
                مخصصة
              </option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-emerald-100">بداية الفترة التالية</span>
            <input
              className="h-10 w-full rounded-md border border-white/15 bg-white/10 px-3"
              type="date"
              value={periodTo}
              onChange={e => setPeriodTo(e.target.value)}
            />
          </label>
          <Button
            disabled={busy}
            onClick={createDraft}
            className="bg-amber-400 text-slate-950 hover:bg-amber-300"
          >
            إنشاء تقفيلة
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">سجل التقفيلات</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {list.isLoading ? (
              <LoadingSkeleton />
            ) : !list.data?.length ? (
              <EmptyState
                title="لا توجد تقفيلات"
                description="ابدأ بأول فترة من تاريخ الـ Go-Live."
              />
            ) : (
              list.data.map(row => (
                <button
                  key={row.id}
                  onClick={() => setSelectedId(row.id)}
                  className={`w-full rounded-xl border p-3 text-right transition ${selectedId === row.id ? "border-emerald-600 bg-emerald-50" : "hover:bg-muted/60"}`}
                >
                  <div className="flex items-center justify-between">
                    <strong>تقفيلة #{row.sequenceNumber}</strong>
                    <span className="text-xs text-muted-foreground">
                      {STATUS_LABELS[row.status]}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {new Date(row.periodFrom).toLocaleDateString("ar-EG")} -{" "}
                    {new Date(row.periodTo).toLocaleDateString("ar-EG")}
                  </div>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        {!selectedId ? (
          <Card>
            <CardContent className="p-10">
              <EmptyState
                title="اختار تقفيلة"
                description="التفاصيل والأرقام والـ Audit Trail هيظهروا هنا."
              />
            </CardContent>
          </Card>
        ) : detail.isLoading ? (
          <LoadingSkeleton />
        ) : detail.data ? (
          <ClosingDetail
            detail={detail.data}
            busy={busy}
            onSubmit={() =>
              submit.mutate({ businessId: businessId!, closingId: selectedId })
            }
            onApprove={() =>
              approve.mutate({ businessId: businessId!, closingId: selectedId })
            }
            onLock={() =>
              lock.mutate({ businessId: businessId!, closingId: selectedId })
            }
          />
        ) : null}
      </div>
    </div>
  );
}

function ClosingDetail({
  detail,
  busy,
  onSubmit,
  onApprove,
  onLock,
}: {
  detail: any;
  busy: boolean;
  onSubmit: () => void;
  onApprove: () => void;
  onLock: () => void;
}) {
  const totals = detail.totals ?? {};
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle>تقفيلة #{detail.sequenceNumber}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {STATUS_LABELS[detail.status]}{" "}
              {detail.isStale ? "- Snapshot قديم" : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(detail.status === "draft" ||
              detail.status === "pending_approval") && (
              <Button disabled={busy} onClick={onSubmit}>
                <Send className="ml-2 h-4 w-4" />
                {detail.status === "draft"
                  ? "إرسال للاعتماد"
                  : "تحديث الـ Snapshot"}
              </Button>
            )}
            {detail.status === "pending_approval" && (
              <Button disabled={busy} variant="outline" onClick={onApprove}>
                <ShieldCheck className="ml-2 h-4 w-4" />
                اعتماد
              </Button>
            )}
            {detail.status === "approved" && (
              <Button disabled={busy} variant="destructive" onClick={onLock}>
                <LockKeyhole className="ml-2 h-4 w-4" />
                Lock نهائي
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => printClosingReport(detail)}
            >
              <FileText className="ml-2 h-4 w-4" />
              PDF
            </Button>
            <Button
              variant="outline"
              onClick={() => exportClosingWorkbook(detail)}
            >
              <Download className="ml-2 h-4 w-4" />
              Excel
            </Button>
          </div>
        </CardHeader>
      </Card>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          ["صافي المبيعات", totals.netSales],
          ["COGS", totals.cogs],
          ["مجمل الربح", totals.grossProfit],
          ["صافي الربح", totals.netProfit],
          ["الشحن", totals.shippingExpense],
          ["المصروفات", totals.operatingExpense],
          ["التدفق النقدي", totals.cashFlow],
          ["مستحق لدى الشحن", totals.carrierReceivable],
        ].map(([label, value]) => (
          <Card key={label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-2 text-xl font-black" dir="ltr">
                {value ?? "0.0000"}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
      {detail.status === "approved" && <AdjustmentForm detail={detail} />}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Audit Trail</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {!detail.actions?.length ? (
            <p className="text-sm text-muted-foreground">لا توجد إجراءات.</p>
          ) : (
            detail.actions.map((row: any) => (
              <div
                key={row.id}
                className="flex items-center justify-between rounded-lg border p-3 text-sm"
              >
                <span>
                  {row.action} - {row.performedByName}
                </span>
                <time className="text-xs text-muted-foreground">
                  {new Date(row.createdAt).toLocaleString("ar-EG")}
                </time>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AdjustmentForm({ detail }: { detail: any }) {
  const utils = trpc.useUtils();
  const { data: adjustmentTypes = [] } =
    trpc.accountingV2.configurationList.useQuery({
      businessId: detail.businessId,
      namespace: "closing_adjustment_type",
      activeOnly: true,
    });
  const [adjustmentType, setAdjustmentType] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const mutation = trpc.accountingV2.closingAdjust.useMutation({
    onSuccess: async () => {
      toast.success("تمت إضافة التسوية والتقفيلة محتاجة Re-Approval");
      setAdjustmentType("");
      setAmount("");
      setReason("");
      setEvidenceUrl("");
      await utils.accountingV2.closingDetail.invalidate();
      await utils.accountingV2.closingList.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          إضافة Adjustment قبل الـ Lock
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <select
          className="h-10 rounded-md border bg-background px-3 text-sm"
          value={adjustmentType}
          onChange={e => setAdjustmentType(e.target.value)}
        >
          <option value="">نوع التسوية من الإعدادات</option>
          {adjustmentTypes.map(row => (
            <option key={row.id} value={row.configKey}>
              {row.displayName}
            </option>
          ))}
        </select>
        <Input
          placeholder="القيمة"
          inputMode="decimal"
          dir="ltr"
          value={amount}
          onChange={e => setAmount(e.target.value)}
        />
        <Textarea
          className="md:col-span-2"
          placeholder="سبب التسوية"
          value={reason}
          onChange={e => setReason(e.target.value)}
        />
        <EvidenceUpload value={evidenceUrl} onChange={setEvidenceUrl} />
        <Button
          disabled={mutation.isPending}
          onClick={() => {
            if (
              !adjustmentType.trim() ||
              !amount.trim() ||
              reason.trim().length < 5 ||
              !evidenceUrl.trim()
            )
              return toast.error("كل بيانات التسوية والدليل مطلوبة");
            mutation.mutate({
              businessId: detail.businessId,
              closingId: detail.id,
              adjustmentType: adjustmentType.trim(),
              amount,
              reason: reason.trim(),
              evidenceUrl: evidenceUrl.trim(),
            });
          }}
        >
          إضافة وإعادة الإرسال للاعتماد
        </Button>
      </CardContent>
    </Card>
  );
}
