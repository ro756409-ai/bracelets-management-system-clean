import { PartnerLogo, type PartnerId } from "@/components/brand/PartnerLogo";
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Wallet, Landmark, Smartphone, CreditCard, Truck, ArrowDownCircle, ArrowUpCircle, ArrowLeftRight, RefreshCw, BookOpen, History, Lock } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { usePermissions } from "@/hooks/usePermission";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useLedgerBusinesses } from "./useLedgerBusinesses";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, StatCard, SectionCard, StatusBadge, EmptyState, ErrorState, LoadingSkeleton, OfflineState } from "@/components/shared";
import { toast } from "sonner";
import {
  BALANCE_CARD_CODES, OPERATION_META, composeDailyPost, cairoToday, expenseAccounts, money, moneyAccounts, newOperationId, revenueAccounts, isActiveAccount, MONEY_KINDS, CASH_KINDS, CARRIER_RECEIVABLE_KINDS, availableCash, balanceText,
  type DailyOperation, type UiAccount,
} from "./ledgerUi";

/**
 * «الحسابات اليومية» — Mobile-first: بطاقات أرصدة، ثلاثة أزرار كبيرة، ونموذج واحد بسيط.
 * لا مدين/دائن للمستخدم؛ القيد يُكوَّن من نوع العملية (ledgerUi.composeDailyPost). الأنواع المتاحة
 * من هنا: إيراد/مصروف/تحويل فقط. كل فتح للنموذج يحمل operationId ثابتًا فإعادة الضغط لا تكرر.
 *
 * المرحلة 7E (عرض فقط): حالات Loading/Error/Offline/غير مهيأ/غير مفعّل المشتركة، قائمة «الحسابات والخزن»
 * للقراءة من نفس accounts.list (لا تعديل رصيد ولا إنشاء حساب من هنا)، وحوار العملية بمساحة زر الإغلاق.
 * نفس الاستعلامات (ledger.status / accounts.list / post) ونفس الـpayload.
 */
const CARD_ICONS: Record<string, typeof Wallet> = { OFFICE_CASH: Wallet, BANK_MAIN: Landmark, VF_CASH: Smartphone, INSTAPAY: CreditCard, COD_BOSTA: Truck };
// شعارات رسمية محلية للحسابات المرتبطة بجهة (المرحلة 6) — زخرفية، الاسم مكتوب على البطاقة؛ فقط على حسابها الصحيح
const CARD_LOGOS: Record<string, PartnerId> = { VF_CASH: "vodafone_cash", INSTAPAY: "instapay", COD_BOSTA: "bosta" };

const KIND_GROUPS: { key: string; label: string; match: (a: UiAccount) => boolean }[] = [
  // النقدية المتاحة فقط؛ COD بوسطة ذمة على شركة الشحن في مجموعة مستقلة (ليست نقدية)
  { key: "money", label: "النقدية والخزن", match: a => CASH_KINDS.has(a.kind) },
  { key: "carrier", label: "ذمم على شركات الشحن (ليست نقدية متاحة)", match: a => CARRIER_RECEIVABLE_KINDS.has(a.kind) },
  { key: "revenue", label: "الإيرادات", match: a => a.kind === "revenue" },
  { key: "expense", label: "المصروفات", match: a => a.kind === "expense" },
  { key: "other", label: "حسابات أخرى", match: a => !MONEY_KINDS.has(a.kind) && a.kind !== "revenue" && a.kind !== "expense" },
];

export default function LedgerDaily() {
  const { has, isLoading: permsLoading } = usePermissions();
  const online = useOnlineStatus();
  const utils = trpc.useUtils();
  const status = trpc.ledger.status.useQuery(undefined, { retry: false });
  const accounts = trpc.ledger.accounts.list.useQuery(undefined, { enabled: status.data?.enabled === true, retry: false });
  const [op, setOp] = useState<DailyOperation | null>(null);

  const list = (accounts.data ?? []) as unknown as UiAccount[];
  const cards = BALANCE_CARD_CODES.map(code => list.find(a => a.code === code)).filter((a): a is UiAccount => Boolean(a));
  const cashCards = cards.filter(a => CASH_KINDS.has(a.kind));
  const receivableCards = cards.filter(a => CARRIER_RECEIVABLE_KINDS.has(a.kind));
  const canPost = has("ledger.post");

  const refresh = async () => { await Promise.all([utils.ledger.accounts.list.invalidate(), utils.ledger.transactions.list.invalidate(), utils.ledger.reconciliation.invalidate()]); };

  if (permsLoading || status.isLoading) return <LoadingSkeleton variant="cards" rows={5} className="p-4" />;
  if (status.error) return <StateCard title="تعذر الوصول إلى دفتر الحسابات" text={status.error.message} onRetry={() => status.refetch()} />;
  if (!status.data?.tablesPresent) return <StateCard title="دفتر الحسابات غير مهيأ بعد" text="جداول الدفتر لم تُنشأ على هذه البيئة (الترحيلة 0040). يُنفّذها المسؤول التقني بعد الموافقة." />;
  if (!status.data.enabled) return <StateCard title="دفتر الحسابات غير مفعّل لهذه الشركة" text="التفعيل يتم من المالك بعد اعتماد تقرير المطابقة وإدخال الأرصدة الافتتاحية. لا تُسجَّل أي حركات قبل ذلك." />;

  return (
    <div className="space-y-5" dir="rtl" data-testid="ledger-daily">
      <PageHeader
        title="الحسابات اليومية"
        description={`دفتر الحسابات · بداية العمل ${status.data.goLiveDate ?? "غير متاح"}`}
        icon={<BookOpen className="h-5 w-5" aria-hidden="true" />}
        actions={<Button data-readonly-safe variant="outline" size="sm" onClick={refresh} className="min-h-11 md:min-h-9"><RefreshCw className="h-4 w-4 ml-1" aria-hidden="true" /> تحديث</Button>}
      />

      {!online && <OfflineState onRetry={refresh} className="py-6" />}

      <section aria-label="أرصدة الخزن والحسابات" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="ledger-balance-cards">
        {accounts.isLoading && cards.length === 0 && <LoadingSkeleton variant="cards" rows={5} className="col-span-full" />}
        {accounts.error && <ErrorState message={accounts.error.message} onRetry={() => accounts.refetch()} className="col-span-full" />}
        {cashCards.length > 0 && (
          <StatCard
            key="available-cash"
            label="النقدية المتاحة"
            value={balanceText(availableCash(list))}
            hint={availableCash(list) == null ? "خزن مشتركة مع أنشطة أخرى — الإجمالي للمالك ومدير الحسابات" : "الخزنة + البنك + المحافظ — بدون مستحقات شركات الشحن"}
            icon={<Wallet className="h-5 w-5" aria-hidden="true" />}
            tone={Number(availableCash(list)) < 0 ? "danger" : "success"}
          />
        )}
        {cashCards.map(a => {
          const Icon = CARD_ICONS[a.code] ?? Wallet;
          const logo = CARD_LOGOS[a.code];
          return (
            <StatCard
              key={a.code}
              label={a.name}
              value={balanceText(a.currentBalance)}
              hint={a.currentBalance == null ? "حساب مشترك — الرصيد للمالك ومدير الحسابات" : "الرصيد الحالي من الدفتر"}
              icon={logo ? <PartnerLogo partner={logo} size="sm" decorative /> : <Icon className="h-5 w-5" aria-hidden="true" />}
              tone={Number(a.currentBalance) < 0 ? "danger" : "primary"}
            />
          );
        })}
      </section>

      {receivableCards.length > 0 && (
        <section aria-label="مستحقات على شركات الشحن" className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="ledger-carrier-receivables">
          {receivableCards.map(a => {
            const logo = CARD_LOGOS[a.code];
            return (
              <StatCard
                key={a.code}
                label={`ذمة على شركة الشحن — ${a.name}`}
                value={balanceText(a.currentBalance)}
                hint="مستحق تحصيله من شركة الشحن عند التسوية — ليس نقدية متاحة"
                icon={logo ? <PartnerLogo partner={logo} size="sm" decorative /> : <Truck className="h-5 w-5" aria-hidden="true" />}
                tone={Number(a.currentBalance) < 0 ? "danger" : "default"}
              />
            );
          })}
        </section>
      )}

      {canPost ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="ledger-actions">
          <Button className="min-h-12 text-base" onClick={() => setOp("revenue")} data-testid="ledger-action-revenue"><ArrowDownCircle className="h-5 w-5 ml-2" aria-hidden="true" /> تسجيل إيراد</Button>
          <Button className="min-h-12 text-base" variant="secondary" onClick={() => setOp("expense")} data-testid="ledger-action-expense"><ArrowUpCircle className="h-5 w-5 ml-2" aria-hidden="true" /> تسجيل مصروف</Button>
          <Button className="min-h-12 text-base" variant="outline" onClick={() => setOp("transfer")} data-testid="ledger-action-transfer"><ArrowLeftRight className="h-5 w-5 ml-2" aria-hidden="true" /> تحويل بين الخزن</Button>
        </div>
      ) : (
        <p className="flex items-start gap-2 rounded-[var(--radius-brand-md)] border border-dashed border-border bg-card p-3 text-sm text-muted-foreground" data-testid="ledger-no-post">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          لديك صلاحية العرض فقط — التسجيل يحتاج صلاحية «تسجيل إيراد/مصروف/تحويل» من المالك.
        </p>
      )}

      <div className="text-sm">
        <Link href="/ledger/transactions" className="inline-flex min-h-11 items-center gap-1.5 text-primary underline underline-offset-4 md:min-h-0"><History className="h-4 w-4" aria-hidden="true" /> سجل الحركات</Link>
      </div>

      {/* الحسابات والخزن — قراءة فقط من نفس accounts.list: الرصيد لا يُعدَّل من هنا، والحسابات تُدار بصلاحية ledger.manage_accounts (بلا واجهة في هذه المرحلة) */}
      <AccountsSection accounts={list} loading={accounts.isLoading} />

      {op && <DailyOperationDialog op={op} accounts={list} onClose={() => setOp(null)} onDone={refresh} />}
    </div>
  );
}

function AccountsSection({ accounts, loading }: { accounts: UiAccount[]; loading: boolean }) {
  const groups = useMemo(() => KIND_GROUPS.map(g => ({ ...g, rows: accounts.filter(g.match) })).filter(g => g.rows.length > 0), [accounts]);
  return (
    <SectionCard title={<span>الحسابات والخزن <span className="text-xs font-normal text-muted-foreground">(قراءة فقط — الأرصدة تتغير بالحركات لا بالتعديل)</span></span>} testId="ledger-accounts">
      {loading && accounts.length === 0 ? <LoadingSkeleton variant="table" rows={4} /> : groups.length === 0 ? (
        <EmptyState title="لا توجد حسابات بعد" description="تُنشأ حسابات النظام عند تفعيل الدفتر." />
      ) : (
        <div className="space-y-4">
          {groups.map(g => (
            <div key={g.key} data-testid={`ledger-accounts-${g.key}`}>
              <h3 className="mb-2 text-xs font-semibold text-muted-foreground">{g.label}</h3>
              <ul className="divide-y divide-border rounded-[var(--radius-brand-md)] border border-border">
                {g.rows.map(a => {
                  const logo = CARD_LOGOS[a.code];
                  const active = isActiveAccount(a);
                  return (
                    <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm" data-testid={`ledger-account-${a.code}`}>
                      <span className="flex min-w-0 items-center gap-2">
                        {logo && <PartnerLogo partner={logo} size="sm" decorative />}
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{a.name}</span>
                          <span className="block font-mono text-[11px] text-muted-foreground" dir="ltr">{a.code}</span>
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {!active && <StatusBadge status="inactive" label="موقوف" tone="neutral" size="sm" icon={null} />}
                        <span className={`tabular-nums font-semibold ${Number(a.currentBalance) < 0 ? "text-destructive" : ""}`}>{balanceText(a.currentBalance)}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function StateCard({ title, text, onRetry }: { title: string; text: string; onRetry?: () => void }) {
  return (
    <div className="m-4 rounded-[var(--radius-brand-md)] border border-border bg-card p-5 text-center shadow-[var(--shadow-card)]" dir="rtl" data-testid="ledger-state" role={onRetry ? "alert" : undefined}>
      <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden="true"><Lock className="h-6 w-6" /></span>
      <h2 className="text-base font-bold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{text}</p>
      {onRetry && <Button data-readonly-safe variant="outline" className="mt-4 min-h-11 md:min-h-9" onClick={onRetry}><RefreshCw className="h-4 w-4 ml-1" aria-hidden="true" /> إعادة المحاولة</Button>}
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
        {/* مساحة زر الإغلاق 44px محفوظة من DialogHeader (pr) — لا px-4 يلغيها */}
        <DialogHeader className="border-b py-3 pl-4 pr-16 text-start md:pr-14">
          <DialogTitle>{meta.label}</DialogTitle>
          <DialogDescription>بتاريخ القاهرة · بالجنيه المصري</DialogDescription>
        </DialogHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {op !== "transfer" && (
            <div>
              <Label htmlFor="ledger-field-business">النشاط</Label>
              <Select value={businessId} onValueChange={setBusinessId}>
                <SelectTrigger id="ledger-field-business" className={`mt-1 ${field}`} data-testid="ledger-field-business"><SelectValue placeholder="اختر النشاط" /></SelectTrigger>
                <SelectContent>{brands.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}</SelectContent>
              </Select>
              {noBusinesses && <p className="mt-1 text-xs text-destructive" role="alert" data-testid="ledger-no-businesses">لا توجد أنشطة ضمن نطاقك — لا يمكن تسجيل إيراد/مصروف بلا نشاط.</p>}
            </div>
          )}
          <div>
            <Label htmlFor="ledger-field-date">التاريخ</Label>
            <Input id="ledger-field-date" type="date" value={date} onChange={e => setDate(e.target.value)} className={`mt-1 ${field}`} dir="ltr" data-testid="ledger-field-date" />
          </div>
          <div>
            <Label htmlFor="ledger-field-money">{meta.money}</Label>
            <Select value={moneyId} onValueChange={setMoneyId}>
              <SelectTrigger id="ledger-field-money" className={`mt-1 ${field}`} data-testid="ledger-field-money"><SelectValue placeholder="اختر الخزنة / الحساب" /></SelectTrigger>
              <SelectContent>{moneyList.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}{a.currentBalance != null ? ` — ${money(a.currentBalance)}` : ""}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="ledger-field-counter">{meta.counter}</Label>
            <Select value={counterId} onValueChange={setCounterId}>
              <SelectTrigger id="ledger-field-counter" className={`mt-1 ${field}`} data-testid="ledger-field-counter"><SelectValue placeholder={op === "transfer" ? "اختر الخزنة المستلمة" : "اختر"} /></SelectTrigger>
              <SelectContent>{counterList.filter(a => String(a.id) !== moneyId).map(a => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="ledger-field-amount">المبلغ (ج.م)</Label>
            <Input id="ledger-field-amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" className={`mt-1 ${field} text-lg`} dir="ltr" data-testid="ledger-field-amount" />
          </div>
          <div>
            <Label htmlFor="ledger-field-description">البيان</Label>
            <Textarea id="ledger-field-description" value={description} onChange={e => setDescription(e.target.value)} placeholder="وصف قصير للعملية" rows={2} className="mt-1 min-h-11" data-testid="ledger-field-description" />
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
