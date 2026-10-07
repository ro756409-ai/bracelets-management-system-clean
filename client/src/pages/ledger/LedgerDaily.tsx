import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Wallet, Landmark, Smartphone, CreditCard, Truck, ArrowDownCircle, ArrowUpCircle, ArrowLeftRight, RefreshCw, BookOpen } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { usePermissions } from "@/hooks/usePermission";
import { useLedgerBusinesses } from "./useLedgerBusinesses";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, StatCard } from "@/components/shared";
import { toast } from "sonner";
import {
  BALANCE_CARD_CODES, OPERATION_META, composeDailyPost, cairoToday, expenseAccounts, money, moneyAccounts, newOperationId, revenueAccounts,
  type DailyOperation, type UiAccount,
} from "./ledgerUi";

/**
 * «الحسابات اليومية» — Mobile-first: بطاقات أرصدة، ثلاثة أزرار كبيرة، ونموذج واحد بسيط.
 * لا مدين/دائن للمستخدم؛ القيد يُكوَّن من نوع العملية (ledgerUi.composeDailyPost). الأنواع المتاحة
 * من هنا: إيراد/مصروف/تحويل فقط. كل فتح للنموذج يحمل operationId ثابتًا فإعادة الضغط لا تكرر.
 */
const CARD_ICONS: Record<string, typeof Wallet> = { OFFICE_CASH: Wallet, BANK_MAIN: Landmark, VF_CASH: Smartphone, INSTAPAY: CreditCard, COD_BOSTA: Truck };

export default function LedgerDaily() {
  const { has, isLoading: permsLoading } = usePermissions();
  const utils = trpc.useUtils();
  const status = trpc.ledger.status.useQuery(undefined, { retry: false });
  const accounts = trpc.ledger.accounts.list.useQuery(undefined, { enabled: status.data?.enabled === true, retry: false });
  const [op, setOp] = useState<DailyOperation | null>(null);

  const list = (accounts.data ?? []) as unknown as UiAccount[];
  const cards = BALANCE_CARD_CODES.map(code => list.find(a => a.code === code)).filter((a): a is UiAccount => Boolean(a));
  const canPost = has("ledger.post");

  const refresh = async () => { await Promise.all([utils.ledger.accounts.list.invalidate(), utils.ledger.transactions.list.invalidate(), utils.ledger.reconciliation.invalidate()]); };

  if (permsLoading || status.isLoading) return <div className="p-4 text-sm text-muted-foreground">جارٍ التحميل…</div>;
  if (status.error) return <StateCard title="تعذر الوصول إلى دفتر الحسابات" text={status.error.message} />;
  if (!status.data?.tablesPresent) return <StateCard title="دفتر الحسابات غير مهيأ بعد" text="جداول الدفتر لم تُنشأ على هذه البيئة (الترحيلة 0040). يُنفّذها المسؤول التقني بعد الموافقة." />;
  if (!status.data.enabled) return <StateCard title="دفتر الحسابات غير مفعّل لهذه الشركة" text="التفعيل يتم من المالك بعد اعتماد تقرير المطابقة وإدخال الأرصدة الافتتاحية. لا تُسجَّل أي حركات قبل ذلك." />;

  return (
    <div className="space-y-5 pb-24 sm:pb-6" dir="rtl" data-testid="ledger-daily">
      <PageHeader
        title="الحسابات اليومية"
        description={`دفتر الحسابات · بداية العمل ${status.data.goLiveDate ?? ""}`}
        icon={<BookOpen className="h-5 w-5" />}
        actions={<Button variant="outline" size="sm" onClick={refresh} className="min-h-11"><RefreshCw className="h-4 w-4 ml-1" /> تحديث</Button>}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="ledger-balance-cards">
        {cards.map(a => {
          const Icon = CARD_ICONS[a.code] ?? Wallet;
          return <StatCard key={a.code} label={a.name} value={`${money(a.currentBalance)} ج.م`} icon={<Icon className="h-5 w-5" />} tone={Number(a.currentBalance) < 0 ? "danger" : "primary"} />;
        })}
      </div>

      {canPost ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="ledger-actions">
          <Button className="min-h-12 text-base" onClick={() => setOp("revenue")} data-testid="ledger-action-revenue"><ArrowDownCircle className="h-5 w-5 ml-2" /> تسجيل إيراد</Button>
          <Button className="min-h-12 text-base" variant="secondary" onClick={() => setOp("expense")} data-testid="ledger-action-expense"><ArrowUpCircle className="h-5 w-5 ml-2" /> تسجيل مصروف</Button>
          <Button className="min-h-12 text-base" variant="outline" onClick={() => setOp("transfer")} data-testid="ledger-action-transfer"><ArrowLeftRight className="h-5 w-5 ml-2" /> تحويل بين الخزن</Button>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground" data-testid="ledger-no-post">لديك صلاحية العرض فقط — التسجيل يحتاج صلاحية «تسجيل إيراد/مصروف/تحويل» من المالك.</p>
      )}

      <div className="text-sm">
        <Link href="/ledger/transactions" className="text-primary underline underline-offset-4">سجل الحركات ←</Link>
      </div>

      {op && <DailyOperationDialog op={op} accounts={list} onClose={() => setOp(null)} onDone={refresh} />}
    </div>
  );
}

function StateCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="m-4 rounded-xl border bg-card p-5 text-center" dir="rtl" data-testid="ledger-state">
      <h2 className="text-base font-bold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

/** النموذج البسيط: النشاط، التاريخ، الحساب/التصنيف، المبلغ، البيان — بزر حفظ ثابت أسفل النافذة. */
export function DailyOperationDialog({ op, accounts, onClose, onDone, initial }: {
  op: DailyOperation; accounts: UiAccount[]; onClose: () => void; onDone: () => Promise<void> | void;
  /** قيم ابتدائية (للاختبارات/إعادة الفتح) — الاختيار يبقى بيد المستخدم. */
  initial?: { businessId?: number; moneyId?: number; counterId?: number };
}) {
  const meta = OPERATION_META[op];
  // أنشطة الجلسة من الدفتر نفسه (نطاق السيرفر) — لا BusinessContext الذي يشترط جلسة مالك (المحاسب موظف)
  const { brands, selected: businessId, setSelected: setBusinessId, isEmpty: noBusinesses } = useLedgerBusinesses(initial?.businessId);
  const [date, setDate] = useState(cairoToday());
  const [moneyId, setMoneyId] = useState<string>(initial?.moneyId != null ? String(initial.moneyId) : "");
  const [counterId, setCounterId] = useState<string>(initial?.counterId != null ? String(initial.counterId) : "");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  // معرّف العملية ثابت طوال عمر النموذج المفتوح — إعادة الضغط/إعادة الإرسال = نفس المفتاح = لا تكرار
  const [operationId] = useState(newOperationId);
  const [submitting, setSubmitting] = useState(false);
  const utils = trpc.useUtils();
  const post = trpc.ledger.post.useMutation();

  const moneyList = useMemo(() => moneyAccounts(accounts), [accounts]);
  const counterList = useMemo(() => op === "revenue" ? revenueAccounts(accounts) : op === "expense" ? expenseAccounts(accounts) : moneyAccounts(accounts), [accounts, op]);
  const moneyAccount = moneyList.find(a => String(a.id) === moneyId);
  const counterAccount = counterList.find(a => String(a.id) === counterId);

  const submit = async () => {
    if (submitting || post.isPending) return; // double-click: لا طلب ثانٍ أصلًا؛ ولو وصل فالمفتاح نفسه
    if (!moneyAccount || !counterAccount) return toast.error("اختر الحساب والتصنيف");
    if (!description.trim()) return toast.error("اكتب البيان");
    let composed;
    try { composed = composeDailyPost(op, { businessId: businessId ? Number(businessId) : null, moneyAccount, counterAccount, amount: amount.trim() }); }
    catch (e) { return toast.error((e as Error).message); }
    setSubmitting(true);
    try {
      const r = await post.mutateAsync({ ...composed, idempotencyKey: operationId, effectiveDate: date, currency: "EGP", description: description.trim(), sourceType: "daily_ui" });
      toast.success(r.replay ? "هذه العملية مسجّلة بالفعل — لم تتكرر" : "تم تسجيل الحركة");
      await utils.ledger.accounts.list.invalidate();
      await onDone();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally { setSubmitting(false); }
  };

  const field = "min-h-11";
  return (
    <Dialog open onOpenChange={o => { if (!o && !submitting) onClose(); }}>
      <DialogContent className="flex max-h-[92dvh] w-[calc(100vw-1.5rem)] max-w-md flex-col gap-0 overflow-hidden p-0 sm:w-full" dir="rtl" data-testid={`ledger-form-${op}`}>
        <DialogHeader className="border-b px-4 py-3 text-right">
          <DialogTitle>{meta.label}</DialogTitle>
          <DialogDescription>بتاريخ القاهرة · بالجنيه المصري</DialogDescription>
        </DialogHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {op !== "transfer" && (
            <div>
              <Label>النشاط</Label>
              <Select value={businessId} onValueChange={setBusinessId}>
                <SelectTrigger className={`mt-1 ${field}`} data-testid="ledger-field-business"><SelectValue placeholder="اختر النشاط" /></SelectTrigger>
                <SelectContent>{brands.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
              {noBusinesses && <p className="mt-1 text-xs text-destructive" data-testid="ledger-no-businesses">لا توجد أنشطة ضمن نطاقك — لا يمكن تسجيل إيراد/مصروف بلا نشاط.</p>}
            </div>
          )}
          <div>
            <Label>التاريخ</Label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} className={`mt-1 ${field}`} dir="ltr" data-testid="ledger-field-date" />
          </div>
          <div>
            <Label>{meta.money}</Label>
            <Select value={moneyId} onValueChange={setMoneyId}>
              <SelectTrigger className={`mt-1 ${field}`} data-testid="ledger-field-money"><SelectValue placeholder="اختر الخزنة / الحساب" /></SelectTrigger>
              <SelectContent>{moneyList.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name} — {money(a.currentBalance)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>{meta.counter}</Label>
            <Select value={counterId} onValueChange={setCounterId}>
              <SelectTrigger className={`mt-1 ${field}`} data-testid="ledger-field-counter"><SelectValue placeholder={op === "transfer" ? "اختر الخزنة المستلمة" : "اختر"} /></SelectTrigger>
              <SelectContent>{counterList.filter(a => String(a.id) !== moneyId).map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>المبلغ (ج.م)</Label>
            <Input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" className={`mt-1 ${field} text-lg`} dir="ltr" data-testid="ledger-field-amount" />
          </div>
          <div>
            <Label>البيان</Label>
            <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="وصف قصير للعملية" rows={2} className="mt-1 min-h-11" data-testid="ledger-field-description" />
          </div>
        </div>
        <div className="sticky bottom-0 flex items-center gap-2 border-t bg-card px-4 py-3">
          <Button className="min-h-12 flex-1 text-base" onClick={submit} disabled={submitting || post.isPending} data-testid="ledger-save">
            {submitting || post.isPending ? "جارٍ الحفظ…" : "حفظ"}
          </Button>
          <Button variant="outline" className="min-h-12" onClick={onClose} disabled={submitting}>إلغاء</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
