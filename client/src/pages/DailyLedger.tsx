import { useMemo, useState } from "react";
import {
  Wallet, Receipt, ArrowDownCircle, ArrowUpCircle, HandCoins, CalendarDays,
  Plus, RefreshCw, Save, XCircle, AlertCircle, TrendingUp, Package, Clock,
  PackagePlus, Truck,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PageHeader, SectionCard } from "@/components/shared";
import { toast } from "sonner";

/**
 * مركز التسجيل اليومي.
 *
 * الشاشة اللي المحاسب بيقضي يومه فيها. قبلها كان لازم يلف على أربع صفحات عشان يسجّل
 * حركات يوم واحد — الخزنة للإيداع والسحب، المصروفات للمصروف، التحصيلات للتحصيل — ومفيش
 * مكان واحد بيقوله «اليوم ده اكتمل ولا لسه».
 *
 * كل إجراء بيفتح نموذج جوّه الصفحة، وبيرجّع الأرقام لوحدها بعد الحفظ. «حفظ وإضافة تاني»
 * بيسيب النموذج مفتوح بمبلغ فاضي، لأن اللي بيسجّل مصروف نادرًا بيسجّل واحد بس.
 */

type ActionKind = "expense" | "deposit" | "withdrawal" | "collection";

const ACTION_META: Record<ActionKind, { label: string; icon: typeof Receipt; tone: string }> = {
  expense: { label: "إضافة مصروف", icon: Receipt, tone: "var(--destructive)" },
  deposit: { label: "إيداع في الخزنة", icon: ArrowDownCircle, tone: "var(--success)" },
  withdrawal: { label: "سحب من الخزنة", icon: ArrowUpCircle, tone: "var(--warning)" },
  // Not a free-text movement like the other three: the money belongs to an order, so the
  // form picks the order and the amount defaults to what is still owed on it.
  collection: { label: "تسجيل تحصيل", icon: HandCoins, tone: "var(--success)" },
};

/** Cairo-local YYYY-MM-DD — the day the accountant means, not the browser's UTC day. */
function cairoToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

const money = (n: number) =>
  Number(n || 0).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MOVEMENT_LABELS: Record<string, string> = {
  collection: "تحصيل", refund: "مرتجع", expense: "مصروف",
  deposit: "إيداع", withdrawal: "سحب", adjustment: "تسوية",
};

export default function DailyLedger() {
  const { currentBusinessIds, currentGroup } = useBusinessContext();
  const utils = trpc.useUtils();

  const [dateKey, setDateKey] = useState(cairoToday);
  const [action, setAction] = useState<ActionKind | null>(null);

  // Form state, shared by the three actions — they differ in which fields show, not in shape.
  // The brand is a field of the movement, so it belongs in the form. It used to be read
  // from the page header, which selects a GROUP — and a group holds several brands, so the
  // form asked the user to "pick one brand above" when there was no such control above.
  const [businessId, setBusinessId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  /** Collection only: which order is being collected. */
  const [orderId, setOrderId] = useState<string>("");
  const [orderSearch, setOrderSearch] = useState("");

  const scope = currentBusinessIds?.length ? { businessIds: currentBusinessIds } : undefined;

  const summary = trpc.accounting.dailySummary.useQuery(
    { ...(scope ?? {}), dateKey },
    { retry: false }
  );
  const categories = trpc.accounting.expenseCategories.useQuery(scope, { retry: false });

  // Orders the courier still owes money on. Loaded only while the collection form is open,
  // and re-queried as the accountant types — they are looking for one order among hundreds.
  const pendingOrders = trpc.accounting.collectionList.useQuery(
    { ...(scope ?? {}), collectionStatus: "pending", search: orderSearch || undefined, limit: 25 },
    { enabled: action === "collection", retry: false }
  );

  /** Brands in the selected group — what the form offers. */
  const brands = currentGroup?.businesses ?? [];
  /** Chosen brand, or the only one when the group holds a single brand. */
  const chosenBusinessId =
    businessId ? Number(businessId) : brands.length === 1 ? brands[0].id : undefined;

  /** `keepBrand` on the "save and add another" path — the next movement is usually the
   *  same brand, and re-picking it every time is the kind of friction that stops a screen
   *  being used. */
  function resetForm(keepBrand = false) {
    if (!keepBrand) setBusinessId("");
    setAmount("");
    setDescription("");
    setNotes("");
    setCategoryId("");
    setOrderId("");
    setOrderSearch("");
    setTouched({});
  }

  function closeForm() {
    setAction(null);
    setSubmitAttempted(false);
    resetForm();
  }

  async function refresh() {
    await Promise.all([
      utils.accounting.dailySummary.invalidate(),
      utils.accounting.treasuryBalance.invalidate(),
    ]);
  }

  const expenseMutation = trpc.accounting.expenseCreate.useMutation({
    onError: e => toast.error(e.message),
  });
  const treasuryMutation = trpc.accounting.treasuryCreate.useMutation({
    onError: e => toast.error(e.message),
  });
  const collectionMutation = trpc.accounting.collectionRecord.useMutation({
    onError: e => toast.error(e.message),
  });

  const saving =
    expenseMutation.isPending || treasuryMutation.isPending || collectionMutation.isPending;

  /**
   * A rule set per action, not one shared set.
   *
   * The three used to share a single validator, which is only correct while the three
   * happen to require the same fields — the moment one gains a field the shared version is
   * wrong for the other two, silently. Each action now states its own requirements against
   * its own backend contract, and the errors are keyed by field so they can be shown next
   * to the input that is actually wrong.
   */
  type FieldErrors = Partial<Record<"businessId" | "amount" | "description" | "categoryId" | "orderId", string>>;

  function validateCommon(): FieldErrors {
    const errors: FieldErrors = {};
    const value = Number(amount);
    if (!amount.trim()) errors.amount = "المبلغ مطلوب";
    else if (!Number.isFinite(value)) errors.amount = "المبلغ لازم يكون رقم";
    else if (value <= 0) errors.amount = "المبلغ لازم يكون أكبر من صفر";
    if (!description.trim()) errors.description = "البيان مطلوب";
    // Required by every one of the three backends, and now answerable inside the form.
    if (chosenBusinessId == null) errors.businessId = "اختر البراند";
    return errors;
  }

  /** accounting.expenseCreate: amount · description · expenseDate · businessId. */
  const validateExpense = validateCommon;
  /** accounting.treasuryCreate (deposit): type · amount · description · businessId. */
  const validateDeposit = validateCommon;
  /** accounting.treasuryCreate (withdrawal): identical contract to deposit. */
  const validateWithdrawal = validateCommon;

  /**
   * accounting.collectionRecord: orderId · collectedAmount.
   *
   * Deliberately not validateCommon. There is no description — the order is the
   * description — and no brand, because the order already belongs to one. Reusing the
   * shared rules here would demand two fields this form does not and should not have.
   */
  function validateCollection(): FieldErrors {
    const errors: FieldErrors = {};
    if (!orderId) errors.orderId = "اختر الأوردر";
    const value = Number(amount);
    if (!amount.trim()) errors.amount = "المبلغ مطلوب";
    else if (!Number.isFinite(value)) errors.amount = "المبلغ لازم يكون رقم";
    else if (value <= 0) errors.amount = "المبلغ لازم يكون أكبر من صفر";
    return errors;
  }

  const errors: FieldErrors = useMemo(() => {
    if (!action) return {};
    if (action === "expense") return validateExpense();
    if (action === "collection") return validateCollection();
    if (action === "deposit") return validateDeposit();
    return validateWithdrawal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, amount, description, chosenBusinessId, orderId]);

  const hasErrors = Object.keys(errors).length > 0;

  /** Which fields the user has left, so a pristine form is not red before it is filled. */
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const showError = (field: keyof FieldErrors) =>
    (touched[field] || submitAttempted) ? errors[field] : undefined;
  const [submitAttempted, setSubmitAttempted] = useState(false);

  /** `keepOpen` is the "save and add another" path — the form stays up, the amount clears. */
  async function save(keepOpen: boolean) {
    if (!action || saving) return;
    setSubmitAttempted(true);
    if (hasErrors) return;
    // Collection carries its brand through the order; the other three need one chosen.
    if (action !== "collection" && chosenBusinessId == null) return;
    const value = Number(amount);
    // The date carries the accountant's chosen day at midday Cairo, so the row lands inside
    // that day's window no matter which hour they are actually typing.
    const when = new Date(`${dateKey}T12:00:00+02:00`);
    try {
      if (action === "collection") {
        await collectionMutation.mutateAsync({
          orderId: Number(orderId),
          collectedAmount: value,
          collectedAt: when,
        });
      } else if (chosenBusinessId == null) {
        return; // unreachable: guarded above, but keeps the type honest
      } else if (action === "expense") {
        await expenseMutation.mutateAsync({
          businessId: chosenBusinessId,
          amount: value,
          description: description.trim(),
          expenseDate: when,
          categoryId: categoryId ? Number(categoryId) : undefined,
        });
      } else {
        await treasuryMutation.mutateAsync({
          businessId: chosenBusinessId,
          type: action,
          amount: value,
          description: description.trim(),
          notes: notes.trim() || undefined,
          transactionDate: when,
        });
      }
      toast.success(`✅ ${ACTION_META[action].label} — اتسجّل`);
      await refresh();
      setSubmitAttempted(false);
      if (keepOpen) resetForm(true);
      else closeForm();
    } catch {
      // The mutation's onError showed the message; the form stays open with the values.
    }
  }

  const s = summary.data;
  const isToday = dateKey === cairoToday();

  const cards = [
    { label: "رصيد الخزنة", value: s?.balance, icon: Wallet, tone: "var(--info)", always: true },
    { label: "تحصيلات اليوم", value: s?.collections, icon: HandCoins, tone: "var(--success)" },
    // Two separate figures on purpose. A draft expense has not moved any money, so folding
    // it into one "expenses" number would overstate what left the business today — and
    // leaving it out entirely was what made the screen disagree with what was just entered.
    { label: "مصروفات مدفوعة", value: s?.expensesPaid, icon: Receipt, tone: "var(--destructive)" },
    { label: "مصروفات مستحقة", value: s?.expensesDue, icon: Clock, tone: "var(--warning)", due: true },
    { label: "صافي اليوم", value: s?.net, icon: TrendingUp, tone: "var(--purple)", signed: true },
    { label: "إيداعات", value: s?.deposits, icon: ArrowDownCircle, tone: "var(--success)" },
    { label: "سحوبات", value: s?.withdrawals, icon: ArrowUpCircle, tone: "var(--warning)" },
    { label: "فلوس عند الشحن", value: s?.pendingCollection, icon: Clock, tone: "var(--warning)" },
    // المشتريات كتلات حقايق منفصلة: البضاعة اللي دخلت، الفلوس اللي اتدفعت للمورد،
    // واللي عليك ليه. دمجهم في رقم واحد هو اللي بيخلّي فاتورة مش مدفوعة تبان كمصروف مدفوع.
    { label: "بضاعة مستلمة", value: s?.goodsReceivedValue, icon: PackagePlus, tone: "var(--info)" },
    { label: "مدفوعات موردين", value: s?.supplierPaid, icon: Truck, tone: "var(--success)" },
    { label: "مستحق للموردين", value: s?.supplierDue, icon: Clock, tone: "var(--warning)", due: true },
  ];

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="مركز التسجيل اليومي"
        description="كل حركات اليوم من مكان واحد — من غير ما تلف على الصفحات."
      />

      {/* شريط اليوم */}
      <SectionCard>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[10rem]">
            <Label className="text-xs">اليوم</Label>
            <div className="mt-1 flex items-center gap-2">
              <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input
                type="date"
                value={dateKey}
                max={cairoToday()}
                onChange={e => setDateKey(e.target.value || cairoToday())}
                className="h-10"
              />
            </div>
          </div>
          {!isToday && (
            <Button variant="outline" className="h-10" onClick={() => setDateKey(cairoToday())}>
              ارجع للنهاردة
            </Button>
          )}
          <Button
            variant="outline"
            className="h-10 gap-1.5 ms-auto"
            onClick={refresh}
            disabled={summary.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${summary.isFetching ? "animate-spin" : ""}`} />
            تحديث
          </Button>
        </div>

        {brands.length > 1 && (
          <p className="mt-3 flex items-start gap-1.5 rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              الأرقام دي مجمّعة لـ<strong className="text-foreground">{brands.length} براندات</strong>.
              كل حركة بتتسجّل على براند بتختاره جوّه النموذج.
            </span>
          </p>
        )}
      </SectionCard>

      {/* ملخص اليوم */}
      {summary.isError ? (
        <SectionCard>
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            تعذّر تحميل ملخص اليوم — {summary.error.message}
          </p>
        </SectionCard>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {cards.map(c => {
            const Icon = c.icon;
            const v = c.value;
            return (
              <div key={c.label} className="rounded-lg border bg-card p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: c.tone }} />
                  <span className="truncate">{c.label}</span>
                </div>
                <p className="mt-1.5 text-lg font-black tabular-nums">
                  {summary.isLoading ? (
                    <span className="inline-block h-5 w-20 animate-pulse rounded bg-muted" />
                  ) : v === null ? (
                    // فرق مقصود بين «صفر» و«مش موجود». مفيش مسار تسجيل مدفوعات موردين في
                    // النظام لسه، فصفر هنا كان هيتقري «مادفعناش النهاردة» بدل «مابنسجّلش».
                    <span className="text-sm font-normal text-muted-foreground">
                      — لسه مفيش مسار دفع موردين
                    </span>
                  ) : (
                    <>
                      {c.signed && Number(v ?? 0) > 0 ? "+" : ""}
                      {money(Number(v ?? 0))}
                      <span className="ms-1 text-xs font-normal text-muted-foreground">ج.م</span>
                    </>
                  )}
                </p>
              </div>
            );
          })}
          <div className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Package className="h-3.5 w-3.5 shrink-0 text-[var(--info)]" />
              <span className="truncate">أوردرات اليوم</span>
            </div>
            <p className="mt-1.5 text-lg font-black tabular-nums">
              {summary.isLoading ? "—" : s?.ordersToday ?? 0}
              <span className="ms-1 text-xs font-normal text-muted-foreground">
                منهم {s?.confirmedToday ?? 0} مؤكد
              </span>
            </p>
          </div>
        </div>
      )}

      {/* الإجراءات السريعة */}
      <SectionCard title="إجراءات سريعة">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {(Object.keys(ACTION_META) as ActionKind[]).map(kind => {
            const meta = ACTION_META[kind];
            const Icon = meta.icon;
            return (
              <Button
                key={kind}
                variant="outline"
                className="h-14 justify-start gap-2 text-sm"
                onClick={() => { resetForm(); setAction(kind); }}
              >
                <Icon className="h-5 w-5 shrink-0" style={{ color: meta.tone }} />
                {meta.label}
                <Plus className="ms-auto h-4 w-4 opacity-40" />
              </Button>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          التحصيل وشراء البضاعة ودفع المورد والمرتبات والتحويل بين الحسابات وتسوية الشحن —
          جايين في الخطوة الجاية من نفس الشاشة.
        </p>
      </SectionCard>

      {/* حركات اليوم */}
      <SectionCard
        title="حركات الخزنة اليوم"
        description={
          s ? `${s.movementCount} حركة نقدية — المصروفات المستحقة مش هنا لأنها لسه ماخرجتش` : undefined
        }
      >
        {summary.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map(i => <div key={i} className="h-12 animate-pulse rounded bg-muted" />)}
          </div>
        ) : !s?.movements.length ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <Receipt className="mx-auto mb-2 h-7 w-7 text-muted-foreground" />
            <p className="text-sm font-semibold">مفيش حركات مسجّلة في اليوم ده</p>
            <p className="mt-1 text-xs text-muted-foreground">
              ابدأ بإضافة مصروف أو إيداع من الإجراءات فوق.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="p-2 text-start font-semibold">الوقت</th>
                  <th className="p-2 text-start font-semibold">النوع</th>
                  <th className="p-2 text-start font-semibold">البيان</th>
                  <th className="p-2 text-end font-semibold">المبلغ</th>
                </tr>
              </thead>
              <tbody>
                {s.movements.map(m => (
                  <tr key={m.id} className="border-b last:border-0">
                    <td className="p-2 text-xs tabular-nums text-muted-foreground">
                      {new Date(m.transactionDate as any).toLocaleTimeString("ar-EG", {
                        hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo",
                      })}
                    </td>
                    <td className="p-2">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold">
                        {MOVEMENT_LABELS[m.type as string] ?? m.type}
                      </span>
                    </td>
                    <td className="p-2">
                      <span className="line-clamp-1">{m.description}</span>
                    </td>
                    <td
                      className="p-2 text-end font-bold tabular-nums"
                      style={{ color: m.direction === "in" ? "var(--success)" : "var(--destructive)" }}
                    >
                      {m.direction === "in" ? "+" : "−"}{money(Number(m.amount))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* نموذج الإجراء */}
      <Dialog open={action != null} onOpenChange={open => { if (!open) closeForm(); }}>
        <DialogContent
          className="grid max-h-[92dvh] w-[calc(100%-1rem)] max-w-md grid-rows-[auto_1fr_auto] gap-0 overflow-hidden p-0 sm:w-full"
          dir="rtl"
        >
          <DialogHeader className="border-b px-4 py-3 text-start sm:px-6">
            <DialogTitle className="flex items-center gap-2 text-base">
              {action && (() => {
                const Icon = ACTION_META[action].icon;
                return <Icon className="h-5 w-5 shrink-0" style={{ color: ACTION_META[action].tone }} />;
              })()}
              {action ? ACTION_META[action].label : ""}
              <span className="ms-auto text-xs font-normal text-muted-foreground">{dateKey}</span>
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-6">
            {/* البراند حقل في النموذج، مش في ترويسة الصفحة. الترويسة بتختار مجموعة،
                والمجموعة فيها كذا براند — فطلب «اختر براند من فوق» كان بيشاور على حاجة
                مش موجودة. بيتخفي لما المجموعة فيها براند واحد لأنه بيتحدد لوحده. */}
            {action !== "collection" && brands.length > 1 && (
              <div>
                <Label>البراند <span className="text-destructive">*</span></Label>
                <Select
                  value={businessId || undefined}
                  onValueChange={v => { setBusinessId(v); setTouched(t => ({ ...t, businessId: true })); }}
                >
                  <SelectTrigger
                    className={`mt-1 !h-11 w-full ${showError("businessId") ? "border-destructive bg-destructive/10" : ""}`}
                  >
                    <SelectValue placeholder="اختر البراند..." />
                  </SelectTrigger>
                  <SelectContent className="max-h-[45vh]">
                    {brands.map(b => (
                      <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {showError("businessId") && (
                  <p className="mt-1 text-xs text-destructive">{showError("businessId")}</p>
                )}
              </div>
            )}
            {action !== "collection" && brands.length === 1 && (
              <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                البراند: <strong className="text-foreground">{brands[0].name}</strong>
              </p>
            )}

            {action === "collection" && (
              <div>
                <Label>الأوردر <span className="text-destructive">*</span></Label>
                <Input
                  value={orderSearch}
                  onChange={e => setOrderSearch(e.target.value)}
                  placeholder="ابحث برقم الأوردر أو اسم العميل..."
                  className="mt-1 h-10"
                />
                <div
                  className={`mt-2 max-h-52 overflow-y-auto rounded-md border ${showError("orderId") ? "border-destructive" : ""}`}
                >
                  {pendingOrders.isLoading ? (
                    <div className="space-y-1 p-2">
                      {[0, 1].map(i => <div key={i} className="h-10 animate-pulse rounded bg-muted" />)}
                    </div>
                  ) : (pendingOrders.data?.orders ?? []).length === 0 ? (
                    <p className="p-4 text-center text-xs text-muted-foreground">
                      مفيش أوردرات مستنية تحصيل
                      {orderSearch ? " بالبحث ده" : ""}.
                    </p>
                  ) : (
                    (pendingOrders.data?.orders ?? []).map((o: any) => {
                      const outstanding =
                        Number(o.totalAmount ?? 0) - Number(o.collectedAmount ?? 0);
                      return (
                        <button
                          key={o.id}
                          type="button"
                          onClick={() => {
                            setOrderId(String(o.id));
                            // Default to what is still owed — the common case is collecting
                            // the whole remainder, and retyping it invites a typo.
                            setAmount(String(outstanding));
                            setTouched(t => ({ ...t, orderId: true }));
                          }}
                          className={`flex w-full items-center justify-between gap-2 border-b p-2.5 text-start last:border-0 transition ${
                            String(o.id) === orderId ? "bg-[var(--success)]/10" : "hover:bg-muted/60"
                          }`}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">
                              {o.orderNumber}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {o.customerName}
                            </span>
                          </span>
                          <span className="shrink-0 text-sm font-bold tabular-nums">
                            {money(outstanding)}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
                {showError("orderId") && (
                  <p className="mt-1 text-xs text-destructive">{showError("orderId")}</p>
                )}
              </div>
            )}

            {/* المبلغ بعد البراند — هو اللي المحاسب بيبدأ بيه فعليًا لما البراند واحد */}
            <div>
              <Label>المبلغ <span className="text-destructive">*</span></Label>
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                autoFocus={brands.length <= 1}
                value={amount}
                onChange={e => setAmount(e.target.value)}
                onBlur={() => setTouched(t => ({ ...t, amount: true }))}
                placeholder="0.00"
                className={`mt-1 h-12 text-lg font-bold ${showError("amount") ? "border-destructive bg-destructive/10" : ""}`}
              />
              {showError("amount") && (
                <p className="mt-1 text-xs text-destructive">{showError("amount")}</p>
              )}
            </div>

            {action !== "collection" && (
            <div>
              <Label>البيان <span className="text-destructive">*</span></Label>
              <Input
                value={description}
                onChange={e => setDescription(e.target.value)}
                onBlur={() => setTouched(t => ({ ...t, description: true }))}
                placeholder={action === "expense" ? "مثال: إعلانات فيسبوك" : "مثال: إيداع من العميل"}
                className={`mt-1 h-10 ${showError("description") ? "border-destructive bg-destructive/10" : ""}`}
              />
              {showError("description") && (
                <p className="mt-1 text-xs text-destructive">{showError("description")}</p>
              )}
            </div>
            )}

            {action === "expense" && (
              <p className="rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-2 text-xs text-[var(--warning)]">
                المصروف بيتسجّل <strong>مستحق وغير مدفوع</strong> — مفيش فلوس بتنزل من
                الخزنة دلوقتي. بيظهر في «مصروفات مستحقة»، وبيتحوّل لمدفوع لما يتعتمد
                ويتدفع من شاشة المصروفات.
              </p>
            )}

            {action === "expense" && (
              <div>
                <Label>التصنيف</Label>
                <Select value={categoryId || undefined} onValueChange={setCategoryId}>
                  <SelectTrigger className="mt-1 !h-11 w-full">
                    <SelectValue placeholder="بدون تصنيف" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[45vh]">
                    {(categories.data ?? []).map((c: any) => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {categories.data?.length === 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    مفيش تصنيفات متضبطة — الحركة هتتسجّل من غير تصنيف.
                  </p>
                )}
              </div>
            )}

            {/* الملاحظات للإيداع والسحب بس — `collectionRecord` مابيقبلش ملاحظات، وعرض
                خانة الكلام اللي هيتكتب فيها هيتضيع أسوأ من إنها مش موجودة. */}
            {(action === "deposit" || action === "withdrawal") && (
              <div>
                <Label>ملاحظات</Label>
                <Textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  rows={2}
                  className="mt-1"
                  placeholder="اختياري"
                />
              </div>
            )}


          </div>

          <DialogFooter className="flex-col gap-2 border-t bg-background px-4 py-3 sm:flex-row sm:px-6">
            <Button
              variant="outline"
              className="h-11 gap-1.5 sm:me-auto"
              onClick={closeForm}
              disabled={saving}
            >
              <XCircle className="h-4 w-4" />
              إلغاء
            </Button>
            <Button
              variant="outline"
              className="h-11 gap-1.5"
              onClick={() => save(true)}
              disabled={saving}
            >
              <Plus className="h-4 w-4" />
              حفظ وإضافة تاني
            </Button>
            <Button
              className="h-11 gap-1.5"
              onClick={() => save(false)}
              disabled={saving}
            >
              {saving
                ? <><RefreshCw className="h-4 w-4 animate-spin" />جاري الحفظ...</>
                : <><Save className="h-4 w-4" />حفظ وإغلاق</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
