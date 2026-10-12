import { useMemo, useState } from "react";
import { Link } from "wouter";
import { BookOpen, Undo2, Link2, Lock, LockOpen, CalendarRange, Eye } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { usePermissions } from "@/hooks/usePermission";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, SectionCard, StatusBadge, ResponsiveDataTable, Pagination, EmptyState, LoadingSkeleton, OfflineState, type Column } from "@/components/shared";
import { toast } from "sonner";
import { cairoToday, kindLabel, money, newOperationId, transactionAmount, transactionFlow } from "./ledgerUi";

/**
 * «سجل الحركات» — بطاقات على الموبايل وجدول على الشاشات الواسعة (نسخة واحدة في DOM عبر ResponsiveDataTable).
 * لا تعديل ولا حذف؛ العكس فقط لمن لديه ledger.reverse، بتأكيد وسبب إلزامي، والأصل والعكس مرتبطان بوضوح.
 *
 * المرحلة 7E (عرض فقط): تفاصيل الحركة في حوار قراءة من بيانات الصف نفسه (لا استعلام إضافي)، قسم «الفترات
 * المحاسبية» من periods.list مع قفل (ledger.period.lock) وإعادة فتح (ledger.period.reopen — للمالك فقط على
 * السيرفر) بتأكيد وسبب وحارس ضغط مكرر. نفس transactions.list/reverse بنفس الـpayload.
 */
type Row = {
  id: number; effectiveDate: string; kind: string; description: string; sourceBusinessId: number | null;
  actorType: string; actorName: string | null; reversalOfTransactionId: number | null; reversedByTransactionId: number | null;
  entries: { accountId: number; side: "debit" | "credit"; amount: string; code: string; name: string }[];
  sourceType?: string | null; sourceReference?: string | null; postingPeriod?: string | null; createdAt?: string | Date | null;
};
type PeriodRow = { id: number; period: string; status: "open" | "locked"; events: { id: number; action: "lock" | "reopen"; reason: string; createdAt: string | Date }[] };

const actorLabel = (r: Row) => r.actorName ?? (r.actorType === "webhook" ? "بوسطة/تكامل" : "النظام");
const bizLabel = (r: Row, bizName: Map<number, string>) => r.sourceBusinessId != null ? bizName.get(r.sourceBusinessId) ?? `#${r.sourceBusinessId}` : "الشركة";

export default function LedgerTransactions() {
  const { has } = usePermissions();
  const online = useOnlineStatus();
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const limit = 25;
  const status = trpc.ledger.status.useQuery(undefined, { retry: false });
  const enabled = status.data?.enabled === true;
  const list = trpc.ledger.transactions.list.useQuery({ page, limit, from: from || undefined, to: to || undefined }, { enabled, retry: false, placeholderData: prev => prev });
  const [reverseTarget, setReverseTarget] = useState<Row | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<Row | null>(null);
  // أسماء الأنشطة من الدفتر نفسه (نطاق السيرفر) — لا BusinessContext الذي يشترط جلسة مالك (المحاسب موظف)
  const businessesQuery = trpc.ledger.businesses.list.useQuery(undefined, { enabled, retry: false, staleTime: 60_000 });
  const bizName = useMemo(() => new Map((businessesQuery.data ?? []).map(b => [b.id, b.name])), [businessesQuery.data]);
  const rows = (list.data?.rows ?? []) as unknown as Row[];
  const total = list.data?.total ?? 0;
  const canReverse = has("ledger.reverse");

  if (status.data && !status.data.tablesPresent) return <EmptyState title="دفتر الحسابات غير مهيأ بعد" description="جداول الدفتر لم تُنشأ على هذه البيئة (الترحيلة 0040). يُنفّذها المسؤول التقني بعد الموافقة." className="m-4" />;
  if (status.data && !status.data.enabled) return <EmptyState title="دفتر الحسابات غير مفعّل لهذه الشركة" description="لا حركات تُعرض أو تُسجَّل قبل التفعيل من المالك." className="m-4" />;

  const columns: Column<Row>[] = [
    { id: "date", header: "التاريخ", alwaysVisible: true, cell: r => <span className="whitespace-nowrap tabular-nums" dir="ltr">{r.effectiveDate}</span> },
    { id: "business", header: "النشاط", cell: r => bizLabel(r, bizName) },
    { id: "kind", header: "النوع", alwaysVisible: true, cell: r => <KindBadge row={r} /> },
    { id: "description", header: "البيان", alwaysVisible: true, cell: r => <span className="block max-w-[260px] truncate" title={r.description}>{r.description}</span> },
    { id: "amount", header: "المبلغ", numeric: true, alwaysVisible: true, cell: r => <span className="whitespace-nowrap font-semibold tabular-nums">{money(transactionAmount(r.entries))} ج.م</span> },
    { id: "flow", header: "من ← إلى", cell: r => { const f = transactionFlow(r.entries); return <span className="text-xs text-muted-foreground">{f.from.join("، ")} ← {f.to.join("، ")}</span>; } },
    { id: "actor", header: "المنفّذ", cell: r => actorLabel(r) },
    { id: "actions", header: <span className="sr-only">إجراءات</span>, alwaysVisible: true, sticky: "end", cell: r => (
      <span className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
        <Button variant="ghost" size="sm" className="min-h-11 md:min-h-9" onClick={() => setDetailsTarget(r)} aria-label={`تفاصيل الحركة #${r.id}`} data-testid={`ledger-details-${r.id}`}><Eye className="h-4 w-4" aria-hidden="true" /></Button>
        <ReverseButton row={r} canReverse={canReverse} onReverse={() => setReverseTarget(r)} />
      </span>
    ) },
  ];

  return (
    <div className="space-y-4" dir="rtl" data-testid="ledger-transactions">
      <PageHeader title="سجل الحركات" description="كل حركة مسجّلة كما هي — التصحيح بعكس الحركة فقط" icon={<BookOpen className="h-5 w-5" aria-hidden="true" />}
        actions={<Link href="/ledger" className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4 md:min-h-0">الحسابات اليومية</Link>} />

      {!online && <OfflineState onRetry={() => list.refetch()} className="py-6" />}

      <div className="flex flex-wrap items-end gap-2" data-testid="ledger-filters">
        <div className="min-w-0 flex-1 sm:flex-none"><Label htmlFor="ledger-filter-from" className="text-xs">من</Label><Input id="ledger-filter-from" type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} className="min-h-11 md:min-h-9" dir="ltr" data-testid="ledger-filter-from" /></div>
        <div className="min-w-0 flex-1 sm:flex-none"><Label htmlFor="ledger-filter-to" className="text-xs">إلى</Label><Input id="ledger-filter-to" type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); }} className="min-h-11 md:min-h-9" dir="ltr" data-testid="ledger-filter-to" /></div>
      </div>

      <ResponsiveDataTable<Row>
        rows={rows}
        columns={columns}
        rowKey={r => r.id}
        loading={list.isLoading}
        error={list.error ? list.error.message : null}
        onRetry={() => list.refetch()}
        onRowClick={r => setDetailsTarget(r)}
        empty={{ title: "لا توجد حركات في هذه الفترة.", description: from || to ? "عدّل نطاق التاريخ." : "الحركات المسجّلة ستظهر هنا." }}
        cardsBelow="md"
        mobileRow={r => <TransactionCard row={r} bizName={bizName} canReverse={canReverse} onReverse={() => setReverseTarget(r)} onDetails={() => setDetailsTarget(r)} />}
      />
      {!list.isLoading && rows.length === 0 && <span className="sr-only" data-testid="ledger-empty">لا توجد حركات في هذه الفترة.</span>}

      {total > limit && <Pagination page={page} pageSize={limit} total={total} onPageChange={setPage} />}

      <PeriodsSection enabled={enabled} canLock={has("ledger.period.lock")} canReopen={has("ledger.period.reopen")} />

      {detailsTarget && <TransactionDetailsDialog row={detailsTarget} bizName={bizName} canReverse={canReverse} onClose={() => setDetailsTarget(null)} onReverse={() => { setReverseTarget(detailsTarget); setDetailsTarget(null); }} />}
      {reverseTarget && <ReverseDialog row={reverseTarget} onClose={() => setReverseTarget(null)} onDone={async () => { await list.refetch(); }} />}
    </div>
  );
}

function KindBadge({ row }: { row: Row }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusBadge status={row.kind} label={kindLabel(row.kind)} tone={row.kind === "reversal" ? "warning" : row.kind.startsWith("revenue") ? "success" : row.kind === "expense" ? "neutral" : "info"} size="sm" icon={null} />
      {row.reversalOfTransactionId != null && <span className="inline-flex items-center gap-1 rounded-[var(--radius-brand-pill)] bg-[var(--warning)]/10 px-2 py-0.5 text-xs text-[var(--warning)]" data-testid={`ledger-reverses-${row.id}`}><Link2 className="h-3 w-3" aria-hidden="true" /> يعكس #{row.reversalOfTransactionId}</span>}
      {row.reversedByTransactionId != null && <span className="inline-flex items-center gap-1 rounded-[var(--radius-brand-pill)] bg-destructive/10 px-2 py-0.5 text-xs text-destructive" data-testid={`ledger-reversed-${row.id}`}><Undo2 className="h-3 w-3" aria-hidden="true" /> معكوسة بـ #{row.reversedByTransactionId}</span>}
    </span>
  );
}

function ReverseButton({ row, canReverse, onReverse }: { row: Row; canReverse: boolean; onReverse: () => void }) {
  if (!canReverse || row.reversedByTransactionId != null || row.kind === "reversal") return null;
  return <Button variant="ghost" size="sm" className="min-h-11 text-destructive md:min-h-9" onClick={onReverse} data-testid={`ledger-reverse-${row.id}`}><Undo2 className="h-4 w-4 ml-1" aria-hidden="true" /> عكس الحركة</Button>;
}

function TransactionCard({ row, bizName, canReverse, onReverse, onDetails }: { row: Row; bizName: Map<number, string>; canReverse: boolean; onReverse: () => void; onDetails: () => void }) {
  const flow = transactionFlow(row.entries);
  return (
    <article className="rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`ledger-card-${row.id}`}>
      <button type="button" className="block w-full text-start" onClick={onDetails} aria-label={`تفاصيل الحركة #${row.id}`} data-testid={`ledger-details-${row.id}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs tabular-nums text-muted-foreground" dir="ltr">{row.effectiveDate}</div>
            <div className="mt-1 truncate font-medium">{row.description}</div>
          </div>
          <div className="shrink-0 text-base font-bold tabular-nums">{money(transactionAmount(row.entries))} ج.م</div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <KindBadge row={row} />
          <span>{bizLabel(row, bizName)}</span>
        </div>
        <div className="mt-2 text-xs text-muted-foreground">من: {flow.from.join("، ")} ← إلى: {flow.to.join("، ")}</div>
      </button>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>المنفّذ: {actorLabel(row)}</span>
        <ReverseButton row={row} canReverse={canReverse} onReverse={onReverse} />
      </div>
    </article>
  );
}

/** تفاصيل الحركة — قراءة فقط من بيانات الصف (القيود بالاسم من/إلى، الروابط، المنفّذ). لا تعديل ولا حذف. */
export function TransactionDetailsDialog({ row, bizName, canReverse, onClose, onReverse }: { row: Row; bizName: Map<number, string>; canReverse: boolean; onClose: () => void; onReverse: () => void }) {
  const flow = transactionFlow(row.entries);
  const canReverseThis = canReverse && row.reversedByTransactionId == null && row.kind !== "reversal";
  const Item = ({ label, value, testId }: { label: string; value: React.ReactNode; testId?: string }) => (
    <div className="flex items-start justify-between gap-3 py-2 text-sm"><dt className="shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 text-end font-medium" data-testid={testId}>{value}</dd></div>
  );
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[92dvh] w-[calc(100vw-1.5rem)] max-w-md flex-col gap-0 overflow-hidden p-0 sm:w-full" dir="rtl" data-testid="ledger-details-dialog">
        <DialogHeader className="border-b py-3 pl-4 pr-16 text-start md:pr-14">
          <DialogTitle>الحركة #{row.id}</DialogTitle>
          <DialogDescription>{kindLabel(row.kind)} · <span dir="ltr">{row.effectiveDate}</span></DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <dl className="divide-y divide-border">
            <Item label="المبلغ" value={<span className="tabular-nums">{money(transactionAmount(row.entries))} ج.م</span>} testId="ledger-details-amount" />
            <Item label="البيان" value={row.description} />
            <Item label="النشاط" value={bizLabel(row, bizName)} />
            <Item label="من" value={flow.from.join("، ") || "غير متاح"} />
            <Item label="إلى" value={flow.to.join("، ") || "غير متاح"} />
            <Item label="المنفّذ" value={actorLabel(row)} />
            {row.sourceReference && <Item label="المرجع" value={<span dir="ltr">{row.sourceReference}</span>} />}
            {row.postingPeriod && <Item label="فترة الترحيل" value={<span dir="ltr">{row.postingPeriod}</span>} />}
            {row.reversalOfTransactionId != null && <Item label="تعكس الحركة" value={`#${row.reversalOfTransactionId}`} />}
            {row.reversedByTransactionId != null && <Item label="معكوسة بالحركة" value={`#${row.reversedByTransactionId}`} />}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">الحركات لا تُعدَّل ولا تُحذف — التصحيح بحركة عكسية مرتبطة فقط.</p>
        </div>
        <div className="flex gap-2 border-t px-4 py-3">
          {canReverseThis && <Button variant="outline" className="min-h-12 flex-1 text-destructive" onClick={onReverse} data-testid="ledger-details-reverse"><Undo2 className="h-4 w-4 ml-1" aria-hidden="true" /> عكس الحركة</Button>}
          <Button variant={canReverseThis ? "ghost" : "outline"} className="min-h-12 flex-1" onClick={onClose}>إغلاق</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** الفترات المحاسبية — قراءة من periods.list؛ القفل لمن لديه ledger.period.lock، وإعادة الفتح للمالك فقط (السيرفر يرفض غيره). */
function PeriodsSection({ enabled, canLock, canReopen }: { enabled: boolean; canLock: boolean; canReopen: boolean }) {
  const periods = trpc.ledger.periods.list.useQuery(undefined, { enabled, retry: false });
  const [target, setTarget] = useState<{ period: string; action: "lock" | "reopen" } | null>(null);
  const rows = (periods.data ?? []) as unknown as PeriodRow[];
  return (
    <SectionCard title={<span className="inline-flex items-center gap-2"><CalendarRange className="h-4 w-4" aria-hidden="true" /> الفترات المحاسبية</span>} testId="ledger-periods">
      {periods.isLoading ? <LoadingSkeleton variant="table" rows={3} /> : periods.error ? (
        <p className="text-sm text-destructive" role="alert">{periods.error.message}</p>
      ) : rows.length === 0 ? (
        <EmptyState title="لا توجد فترات مقفلة بعد" description={canLock ? "اقفل فترة لمنع تسجيل حركات بتاريخ داخلها." : "الفترات تُقفل بصلاحية «قفل الفترة»."} />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map(p => {
            const last = p.events[p.events.length - 1];
            return (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm" data-testid={`ledger-period-${p.period}`}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="font-mono font-semibold" dir="ltr">{p.period}</span>
                  <StatusBadge status={p.status} label={p.status === "locked" ? "مقفلة" : "مفتوحة"} tone={p.status === "locked" ? "warning" : "success"} size="sm" icon={p.status === "locked" ? <Lock className="h-3 w-3" aria-hidden="true" /> : <LockOpen className="h-3 w-3" aria-hidden="true" />} />
                  {last && <span className="truncate text-xs text-muted-foreground">{last.action === "lock" ? "أُقفلت" : "أُعيد فتحها"}: {last.reason}</span>}
                </span>
                {p.status === "open" && canLock && <Button variant="outline" size="sm" className="min-h-11 md:min-h-9" onClick={() => setTarget({ period: p.period, action: "lock" })} data-testid={`ledger-period-lock-${p.period}`}><Lock className="h-4 w-4 ml-1" aria-hidden="true" /> قفل</Button>}
                {p.status === "locked" && canReopen && <Button variant="outline" size="sm" className="min-h-11 md:min-h-9" onClick={() => setTarget({ period: p.period, action: "reopen" })} data-testid={`ledger-period-reopen-${p.period}`}><LockOpen className="h-4 w-4 ml-1" aria-hidden="true" /> إعادة فتح</Button>}
              </li>
            );
          })}
        </ul>
      )}
      {canLock && !periods.isLoading && !periods.error && (
        <div className="mt-3 border-t border-border pt-3">
          <Button variant="outline" className="min-h-11 md:min-h-9" onClick={() => setTarget({ period: cairoToday().slice(0, 7), action: "lock" })} data-testid="ledger-period-lock-new"><Lock className="h-4 w-4 ml-1" aria-hidden="true" /> قفل فترة…</Button>
        </div>
      )}
      {target && <PeriodDialog period={target.period} action={target.action} onClose={() => setTarget(null)} onDone={async () => { await periods.refetch(); }} />}
    </SectionCard>
  );
}

/** تأكيد قفل/إعادة فتح الفترة — سبب إلزامي لإعادة الفتح، وحارس ضغط مكرر (طلب واحد). */
export function PeriodDialog({ period: initialPeriod, action, onClose, onDone }: { period: string; action: "lock" | "reopen"; onClose: () => void; onDone: () => Promise<void> | void }) {
  const [period, setPeriod] = useState(initialPeriod);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const lock = trpc.ledger.period.lock.useMutation();
  const reopen = trpc.ledger.period.reopen.useMutation();
  const pending = submitting || lock.isPending || reopen.isPending;
  const submit = async () => {
    if (pending) return; // double-click: طلب واحد
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return toast.error("الفترة بصيغة YYYY-MM");
    if (reason.trim().length < 3) return toast.error(action === "lock" ? "اكتب ملاحظة المراجعة قبل الإقفال (3 أحرف على الأقل)" : "اكتب سبب إعادة الفتح (3 أحرف على الأقل)");
    setSubmitting(true);
    try {
      const r = action === "lock"
        ? await lock.mutateAsync({ period, reason: reason.trim() })
        : await reopen.mutateAsync({ period, reason: reason.trim() });
      toast.success(r.replay ? (action === "lock" ? "الفترة مقفلة بالفعل" : "الفترة مفتوحة بالفعل") : (action === "lock" ? `أُقفلت الفترة ${period}` : `أُعيد فتح الفترة ${period}`));
      await onDone();
      onClose();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSubmitting(false); }
  };
  return (
    <Dialog open onOpenChange={o => { if (!o && !submitting) onClose(); }}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md p-0" dir="rtl" data-testid={`ledger-period-dialog-${action}`}>
        <DialogHeader className="border-b py-3 pl-4 pr-16 text-start md:pr-14">
          <DialogTitle>{action === "lock" ? "قفل فترة محاسبية" : "إعادة فتح فترة محاسبية"}</DialogTitle>
          <DialogDescription>{action === "lock" ? "الحركات تُرحّل فورًا عند إدخالها؛ الاعتماد هو مراجعة الشهر ثم إقفاله بملاحظة تُسجَّل باسمك. بعد القفل لا تُسجَّل حركات بتاريخ داخل الفترة، وإعادة الفتح للمالك فقط." : "إعادة الفتح تُسجَّل باسمك وسببك في سجل الفترة."}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-4 py-4">
          <div><Label htmlFor="ledger-period-input">الفترة (YYYY-MM)</Label><Input id="ledger-period-input" type="month" value={period} onChange={e => setPeriod(e.target.value)} className="mt-1 min-h-11" dir="ltr" disabled={action === "reopen"} data-testid="ledger-period-input" /></div>
          <div><Label htmlFor="ledger-period-reason">{action === "lock" ? "ملاحظة المراجعة (إلزامية)" : "السبب (إلزامي)"}</Label><Textarea id="ledger-period-reason" value={reason} onChange={e => setReason(e.target.value)} rows={2} className="mt-1 min-h-11" placeholder={action === "lock" ? "مثال: راجعت حركة الشهر والأرصدة وطابقت الخزنة" : "مثال: تصحيح حركة مسجّلة بتاريخ خاطئ"} data-testid="ledger-period-reason" /></div>
        </div>
        <div className="flex gap-2 border-t px-4 py-3">
          <Button variant={action === "lock" ? "default" : "destructive"} className="min-h-12 flex-1" onClick={submit} disabled={pending} data-testid="ledger-period-confirm">{pending ? "جارٍ التنفيذ…" : action === "lock" ? "تأكيد القفل" : "تأكيد إعادة الفتح"}</Button>
          <Button variant="outline" className="min-h-12" onClick={onClose} disabled={submitting}>إلغاء</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** تأكيد العكس بسبب إلزامي — نفس operationId طوال فتح النافذة. */
export function ReverseDialog({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => Promise<void> | void }) {
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(cairoToday());
  const [operationId] = useState(newOperationId);
  const [submitting, setSubmitting] = useState(false);
  const reverse = trpc.ledger.reverse.useMutation();
  const utils = trpc.useUtils();
  const submit = async () => {
    if (submitting || reverse.isPending) return; // double-click: طلب واحد (ولو وصل ثانٍ فنفس المفتاح = replay)
    if (reason.trim().length < 3) return toast.error("اكتب سبب العكس (3 أحرف على الأقل)");
    setSubmitting(true);
    try {
      const r = await reverse.mutateAsync({ transactionId: row.id, idempotencyKey: operationId, effectiveDate: date, reason: reason.trim() });
      toast.success(r.replay ? "العكس مسجّل بالفعل" : `تم عكس الحركة #${row.id} بالحركة #${r.transactionId}`);
      await utils.ledger.accounts.list.invalidate();
      await onDone();
      onClose();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSubmitting(false); }
  };
  return (
    <Dialog open onOpenChange={o => { if (!o && !submitting) onClose(); }}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md p-0" dir="rtl" data-testid="ledger-reverse-dialog">
        <DialogHeader className="border-b py-3 pl-4 pr-16 text-start md:pr-14">
          <DialogTitle>عكس الحركة #{row.id}</DialogTitle>
          <DialogDescription>{row.description} — {money(transactionAmount(row.entries))} ج.م. الحركة الأصلية تبقى كما هي وتُسجَّل حركة عكسية مرتبطة بها.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-4 py-4">
          <div><Label htmlFor="ledger-reverse-date">تاريخ العكس</Label><Input id="ledger-reverse-date" type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1 min-h-11" dir="ltr" /></div>
          <div><Label htmlFor="ledger-reverse-reason">السبب (إلزامي)</Label><Textarea id="ledger-reverse-reason" value={reason} onChange={e => setReason(e.target.value)} rows={2} className="mt-1 min-h-11" placeholder="مثال: خطأ في المبلغ" data-testid="ledger-reverse-reason" /></div>
        </div>
        <div className="flex gap-2 border-t px-4 py-3">
          <Button variant="destructive" className="min-h-12 flex-1" onClick={submit} disabled={submitting || reverse.isPending} data-testid="ledger-reverse-confirm">{submitting || reverse.isPending ? "جارٍ العكس…" : "تأكيد العكس"}</Button>
          <Button variant="outline" className="min-h-12" onClick={onClose} disabled={submitting}>إلغاء</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
