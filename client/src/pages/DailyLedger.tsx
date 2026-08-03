import { useMemo, useState } from "react";
import {
  Wallet, Receipt, ArrowDownCircle, ArrowUpCircle, HandCoins, CalendarDays,
  Plus, RefreshCw, Save, XCircle, AlertCircle, TrendingUp, Package, Clock,
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

type ActionKind = "expense" | "deposit" | "withdrawal";

const ACTION_META: Record<ActionKind, { label: string; icon: typeof Receipt; tone: string }> = {
  expense: { label: "إضافة مصروف", icon: Receipt, tone: "var(--destructive)" },
  deposit: { label: "إيداع في الخزنة", icon: ArrowDownCircle, tone: "var(--success)" },
  withdrawal: { label: "سحب من الخزنة", icon: ArrowUpCircle, tone: "var(--warning)" },
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
  const { currentBusinessIds } = useBusinessContext();
  const utils = trpc.useUtils();

  const [dateKey, setDateKey] = useState(cairoToday);
  const [action, setAction] = useState<ActionKind | null>(null);

  // Form state, shared by the three actions — they differ in which fields show, not in shape.
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");

  const scope = currentBusinessIds?.length ? { businessIds: currentBusinessIds } : undefined;

  const summary = trpc.accounting.dailySummary.useQuery(
    { ...(scope ?? {}), dateKey },
    { retry: false }
  );
  const categories = trpc.accounting.expenseCategories.useQuery(scope, { retry: false });

  /** The single brand a movement is recorded against. */
  const businessId = currentBusinessIds?.length === 1 ? currentBusinessIds[0] : undefined;

  function resetForm() {
    setAmount("");
    setDescription("");
    setNotes("");
    setCategoryId("");
  }

  function closeForm() {
    setAction(null);
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

  const saving = expenseMutation.isPending || treasuryMutation.isPending;

  const issues = useMemo(() => {
    const out: string[] = [];
    const value = Number(amount);
    if (!amount.trim() || !Number.isFinite(value) || value <= 0)
      out.push("المبلغ لازم يكون رقم أكبر من صفر");
    if (!description.trim()) out.push("البيان مطلوب");
    if (businessId == null) out.push("اختر براند واحد من فوق قبل التسجيل");
    return out;
  }, [amount, description, businessId]);

  /** `keepOpen` is the "save and add another" path — the form stays up, the amount clears. */
  async function save(keepOpen: boolean) {
    if (!action || saving || issues.length > 0 || businessId == null) return;
    const value = Number(amount);
    // The date carries the accountant's chosen day at midday Cairo, so the row lands inside
    // that day's window no matter which hour they are actually typing.
    const when = new Date(`${dateKey}T12:00:00+02:00`);
    try {
      if (action === "expense") {
        await expenseMutation.mutateAsync({
          businessId,
          amount: value,
          description: description.trim(),
          expenseDate: when,
          categoryId: categoryId ? Number(categoryId) : undefined,
        });
      } else {
        await treasuryMutation.mutateAsync({
          businessId,
          type: action,
          amount: value,
          description: description.trim(),
          notes: notes.trim() || undefined,
          transactionDate: when,
        });
      }
      toast.success(`✅ ${ACTION_META[action].label} — اتسجّل`);
      await refresh();
      if (keepOpen) resetForm();
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
    { label: "مصروفات اليوم", value: s?.expenses, icon: Receipt, tone: "var(--destructive)" },
    { label: "صافي اليوم", value: s?.net, icon: TrendingUp, tone: "var(--purple)", signed: true },
    { label: "إيداعات", value: s?.deposits, icon: ArrowDownCircle, tone: "var(--success)" },
    { label: "سحوبات", value: s?.withdrawals, icon: ArrowUpCircle, tone: "var(--warning)" },
    { label: "فلوس عند الشحن", value: s?.pendingCollection, icon: Clock, tone: "var(--warning)" },
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

        {currentBusinessIds && currentBusinessIds.length !== 1 && (
          <p className="mt-3 flex items-start gap-1.5 rounded-md bg-[var(--warning)]/10 p-2 text-xs text-[var(--warning)]">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              الأرقام دي مجمّعة لكل البراندات. عشان تسجّل حركة، اختر <strong>براند واحد</strong> من
              أعلى الصفحة — كل حركة لازم تبقى على براند معروف.
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
        title="حركات اليوم"
        description={s ? `${s.movementCount} حركة` : undefined}
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
            {/* المبلغ أول حقل عن قصد — هو اللي المحاسب بيبدأ بيه */}
            <div>
              <Label>المبلغ <span className="text-destructive">*</span></Label>
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                autoFocus
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0.00"
                className="mt-1 h-12 text-lg font-bold"
              />
            </div>

            <div>
              <Label>البيان <span className="text-destructive">*</span></Label>
              <Input
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder={action === "expense" ? "مثال: إعلانات فيسبوك" : "مثال: إيداع من العميل"}
                className="mt-1 h-10"
              />
            </div>

            {action === "expense" && (
              <div>
                <Label>التصنيف</Label>
                <Select value={categoryId || undefined} onValueChange={setCategoryId}>
                  <SelectTrigger className="mt-1 h-10 w-full">
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

            {action !== "expense" && (
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

            {issues.length > 0 && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-2">
                <ul className="list-inside list-disc text-xs text-destructive">
                  {issues.map(i => <li key={i}>{i}</li>)}
                </ul>
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
              disabled={saving || issues.length > 0}
            >
              <Plus className="h-4 w-4" />
              حفظ وإضافة تاني
            </Button>
            <Button
              className="h-11 gap-1.5"
              onClick={() => save(false)}
              disabled={saving || issues.length > 0}
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
