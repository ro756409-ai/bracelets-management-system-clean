import { useMemo, useState } from "react";
import { Link } from "wouter";
import { BookOpen, Undo2, Link2, ArrowLeft, ArrowRight } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { usePermissions } from "@/hooks/usePermission";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/shared";
import { toast } from "sonner";
import { cairoToday, kindLabel, money, newOperationId, transactionAmount, transactionFlow } from "./ledgerUi";

/**
 * «سجل الحركات» — بطاقات على الموبايل وجدول على الشاشات الواسعة. لا تعديل ولا حذف؛ العكس فقط
 * لمن لديه ledger.reverse، بتأكيد وسبب إلزامي، والأصل والعكس مرتبطان بوضوح في الاتجاهين.
 */
type Row = {
  id: number; effectiveDate: string; kind: string; description: string; sourceBusinessId: number | null;
  actorType: string; actorName: string | null; reversalOfTransactionId: number | null; reversedByTransactionId: number | null;
  entries: { accountId: number; side: "debit" | "credit"; amount: string; code: string; name: string }[];
};

export default function LedgerTransactions() {
  const { has } = usePermissions();
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const limit = 25;
  const status = trpc.ledger.status.useQuery(undefined, { retry: false });
  const enabled = status.data?.enabled === true;
  const list = trpc.ledger.transactions.list.useQuery({ page, limit, from: from || undefined, to: to || undefined }, { enabled, retry: false, placeholderData: prev => prev });
  const [reverseTarget, setReverseTarget] = useState<Row | null>(null);
  // أسماء الأنشطة من الدفتر نفسه (نطاق السيرفر) — لا BusinessContext الذي يشترط جلسة مالك (المحاسب موظف)
  const businessesQuery = trpc.ledger.businesses.list.useQuery(undefined, { enabled, retry: false, staleTime: 60_000 });
  const bizName = useMemo(() => new Map((businessesQuery.data ?? []).map(b => [b.id, b.name])), [businessesQuery.data]);
  const rows = (list.data?.rows ?? []) as unknown as Row[];
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const canReverse = has("ledger.reverse");

  if (status.data && !status.data.enabled) return <p className="m-4 rounded-xl border p-4 text-center text-sm text-muted-foreground" dir="rtl">دفتر الحسابات غير مفعّل لهذه الشركة.</p>;

  return (
    <div className="space-y-4 pb-24 sm:pb-6" dir="rtl" data-testid="ledger-transactions">
      <PageHeader title="سجل الحركات" description="كل حركة مسجّلة كما هي — التصحيح بعكس الحركة فقط" icon={<BookOpen className="h-5 w-5" />}
        actions={<Link href="/ledger" className="text-sm text-primary underline underline-offset-4">الحسابات اليومية</Link>} />

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 sm:flex-none"><Label className="text-xs">من</Label><Input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }} className="min-h-11" dir="ltr" data-testid="ledger-filter-from" /></div>
        <div className="min-w-0 flex-1 sm:flex-none"><Label className="text-xs">إلى</Label><Input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); }} className="min-h-11" dir="ltr" data-testid="ledger-filter-to" /></div>
      </div>

      {list.isLoading && <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>}
      {list.error && <p className="text-sm text-destructive">{list.error.message}</p>}
      {!list.isLoading && rows.length === 0 && <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground" data-testid="ledger-empty">لا توجد حركات في هذه الفترة.</p>}

      {/* الموبايل: بطاقات */}
      <ul className="space-y-3 md:hidden" data-testid="ledger-cards">
        {rows.map(r => <TransactionCard key={r.id} row={r} bizName={bizName} canReverse={canReverse} onReverse={() => setReverseTarget(r)} />)}
      </ul>

      {/* الشاشات الواسعة: جدول */}
      <div className="hidden overflow-x-auto rounded-xl border md:block">
        <table className="w-full text-sm" data-testid="ledger-table">
          <thead className="bg-muted/50 text-right text-xs text-muted-foreground">
            <tr><th className="p-3">التاريخ</th><th className="p-3">النشاط</th><th className="p-3">النوع</th><th className="p-3">البيان</th><th className="p-3">المبلغ</th><th className="p-3">من ← إلى</th><th className="p-3">المنفّذ</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const flow = transactionFlow(r.entries);
              return (
                <tr key={r.id} className="border-t align-top" data-testid={`ledger-row-${r.id}`}>
                  <td className="p-3 whitespace-nowrap" dir="ltr">{r.effectiveDate}</td>
                  <td className="p-3">{r.sourceBusinessId != null ? bizName.get(r.sourceBusinessId) ?? `#${r.sourceBusinessId}` : "الشركة"}</td>
                  <td className="p-3"><KindBadge row={r} /></td>
                  <td className="p-3">{r.description}</td>
                  <td className="p-3 whitespace-nowrap font-semibold">{money(transactionAmount(r.entries))} ج.م</td>
                  <td className="p-3 text-xs text-muted-foreground">{flow.from.join("، ")} ← {flow.to.join("، ")}</td>
                  <td className="p-3">{r.actorName ?? (r.actorType === "webhook" ? "بوسطة/تكامل" : "النظام")}</td>
                  <td className="p-3"><ReverseButton row={r} canReverse={canReverse} onReverse={() => setReverseTarget(r)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-2 text-sm">
        <Button variant="outline" className="min-h-11" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><ArrowRight className="h-4 w-4 ml-1" /> السابق</Button>
        <span className="text-muted-foreground">صفحة {page} من {pages} · {total} حركة</span>
        <Button variant="outline" className="min-h-11" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>التالي <ArrowLeft className="h-4 w-4 mr-1" /></Button>
      </div>

      {reverseTarget && <ReverseDialog row={reverseTarget} onClose={() => setReverseTarget(null)} onDone={async () => { await list.refetch(); }} />}
    </div>
  );
}

function KindBadge({ row }: { row: Row }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{kindLabel(row.kind)}</span>
      {row.reversalOfTransactionId != null && <span className="inline-flex items-center gap-1 rounded-full bg-[var(--warning)]/10 px-2 py-0.5 text-xs text-[var(--warning)]" data-testid={`ledger-reverses-${row.id}`}><Link2 className="h-3 w-3" /> يعكس #{row.reversalOfTransactionId}</span>}
      {row.reversedByTransactionId != null && <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive" data-testid={`ledger-reversed-${row.id}`}><Undo2 className="h-3 w-3" /> معكوسة بـ #{row.reversedByTransactionId}</span>}
    </span>
  );
}

function ReverseButton({ row, canReverse, onReverse }: { row: Row; canReverse: boolean; onReverse: () => void }) {
  if (!canReverse || row.reversedByTransactionId != null || row.kind === "reversal") return null;
  return <Button variant="ghost" size="sm" className="min-h-11 text-destructive" onClick={onReverse} data-testid={`ledger-reverse-${row.id}`}><Undo2 className="h-4 w-4 ml-1" /> عكس الحركة</Button>;
}

function TransactionCard({ row, bizName, canReverse, onReverse }: { row: Row; bizName: Map<number, string>; canReverse: boolean; onReverse: () => void }) {
  const flow = transactionFlow(row.entries);
  return (
    <li className="rounded-xl border bg-card p-3" data-testid={`ledger-card-${row.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground" dir="ltr">{row.effectiveDate}</div>
          <div className="mt-1 truncate font-medium">{row.description}</div>
        </div>
        <div className="shrink-0 text-base font-bold">{money(transactionAmount(row.entries))} ج.م</div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <KindBadge row={row} />
        <span>{row.sourceBusinessId != null ? bizName.get(row.sourceBusinessId) ?? `#${row.sourceBusinessId}` : "الشركة"}</span>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">من: {flow.from.join("، ")} ← إلى: {flow.to.join("، ")}</div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>المنفّذ: {row.actorName ?? (row.actorType === "webhook" ? "بوسطة/تكامل" : "النظام")}</span>
        <ReverseButton row={row} canReverse={canReverse} onReverse={onReverse} />
      </div>
    </li>
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
        <DialogHeader className="border-b px-4 py-3 text-right">
          <DialogTitle>عكس الحركة #{row.id}</DialogTitle>
          <DialogDescription>{row.description} — {money(transactionAmount(row.entries))} ج.م. الحركة الأصلية تبقى كما هي وتُسجَّل حركة عكسية مرتبطة بها.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-4 py-4">
          <div><Label>تاريخ العكس</Label><Input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1 min-h-11" dir="ltr" /></div>
          <div><Label>السبب (إلزامي)</Label><Textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} className="mt-1 min-h-11" placeholder="مثال: خطأ في المبلغ" data-testid="ledger-reverse-reason" /></div>
        </div>
        <div className="flex gap-2 border-t px-4 py-3">
          <Button variant="destructive" className="min-h-12 flex-1" onClick={submit} disabled={submitting || reverse.isPending} data-testid="ledger-reverse-confirm">{submitting || reverse.isPending ? "جارٍ العكس…" : "تأكيد العكس"}</Button>
          <Button variant="outline" className="min-h-12" onClick={onClose} disabled={submitting}>إلغاء</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
