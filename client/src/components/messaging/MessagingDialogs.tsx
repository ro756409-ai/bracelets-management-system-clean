import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import { MESSAGING_LIMITS } from "@shared/messagingSpec";
import { roleLabel } from "@shared/permissionLabels";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingSkeleton } from "@/components/shared";
import { MessagingError } from "./MessagingStates";
import { completeOperation, operationIdFor } from "@/lib/operationId";
import { cn } from "@/lib/utils";
import { messagingErrorText, useMessagingApi, type DirectoryRow, type MessagingVia } from "./messagingApi";
import { formatFullTime } from "./format";

const inputCls = "min-h-11 w-full rounded-[var(--radius-brand-md)] border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** دليل موظفي **نفس الشركة** (من السيرفر) مع بحث — اختيار واحد أو متعدد. */
function DirectoryPicker({ rows, selected, onToggle, multi }: { rows: DirectoryRow[]; selected: number[]; onToggle: (id: number) => void; multi: boolean }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim();
    return s ? rows.filter(r => r.name.includes(s) || roleLabel(r.role).includes(s)) : rows;
  }, [rows, q]);
  return (
    <div className="space-y-2">
      <label className="relative block" role="search">
        <span className="sr-only">ابحث عن موظف</span>
        <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="ابحث بالاسم أو الدور" className={cn(inputCls, "ps-9")} data-testid="directory-search" />
      </label>
      <ul className="max-h-72 overflow-y-auto rounded-[var(--radius-brand-md)] border border-border" role={multi ? "group" : "listbox"} aria-label="موظفو الشركة">
        {list.length === 0 && <li className="p-3 text-center text-sm text-muted-foreground">لا نتائج</li>}
        {list.map(r => {
          const on = selected.includes(r.id);
          return (
            <li key={r.id}>
              <button
                type="button"
                role={multi ? "checkbox" : "option"}
                aria-checked={multi ? on : undefined}
                aria-selected={multi ? undefined : on}
                onClick={() => onToggle(r.id)}
                className={cn("flex min-h-12 w-full items-center gap-3 px-3 py-2 text-start hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", on && "bg-accent")}
                data-testid={`directory-${r.id}`}
              >
                <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded border", on ? "border-primary bg-primary text-primary-foreground" : "border-input")} aria-hidden="true">{on && <Check className="h-3.5 w-3.5" />}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{roleLabel(r.role)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function NewDirectDialog({ via, open, onOpenChange, onCreated }: { via: MessagingVia; open: boolean; onOpenChange: (o: boolean) => void; onCreated: (conversationId: number) => void }) {
  const api = useMessagingApi(via);
  const dir = api.directory.useQuery(undefined, { enabled: open, retry: false, staleTime: 60_000 });
  const start = api.startDirect.useMutation();
  const [picked, setPicked] = useState<number | null>(null);
  const submit = () => {
    if (picked == null || start.isPending) return;
    start.mutate({ employeeId: picked }, { onSuccess: r => { onOpenChange(false); setPicked(null); onCreated(r.conversationId); } });
  };
  return (
    <Dialog open={open} onOpenChange={o => { if (!start.isPending) onOpenChange(o); }}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle>محادثة خاصة جديدة</DialogTitle>
          <DialogDescription>اختر زميلًا من موظفي شركتك. المحادثات الخاصة يمكن للمالك الاطلاع عليها، وكل اطلاع مسجَّل.</DialogDescription>
        </DialogHeader>
        {dir.isLoading ? <LoadingSkeleton variant="cards" rows={4} /> : dir.error ? <MessagingError compact message={messagingErrorText(dir.error)} onRetry={() => dir.refetch()} /> : (
          <DirectoryPicker rows={dir.data ?? []} selected={picked == null ? [] : [picked]} onToggle={id => setPicked(id)} multi={false} />
        )}
        {start.error && <p className="text-sm text-destructive" role="alert">{messagingErrorText(start.error)}</p>}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onOpenChange(false)} disabled={start.isPending} data-readonly-safe>إلغاء</Button>
          <Button type="button" className="min-h-11" onClick={submit} disabled={picked == null || start.isPending} data-testid="start-direct">{start.isPending ? "جارٍ الفتح…" : "بدء المحادثة"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** مجموعة جديدة — operationId ثابت لنفس الجلسة المفتوحة من النافذة (الضغط المزدوج = Replay على السيرفر). */
export function NewGroupDialog({ via, open, onOpenChange, onCreated }: { via: MessagingVia; open: boolean; onOpenChange: (o: boolean) => void; onCreated: (conversationId: number) => void }) {
  const api = useMessagingApi(via);
  const dir = api.directory.useQuery(undefined, { enabled: open, retry: false, staleTime: 60_000 });
  const create = api.createGroup.useMutation();
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<number[]>([]);
  const [session, setSession] = useState(0);
  const scope = `msg-group:${session}`;
  const close = (o: boolean) => {
    if (create.isPending) return;
    onOpenChange(o);
    if (!o) { setTitle(""); setMembers([]); completeOperation(operationIdFor(scope)); setSession(s => s + 1); create.reset(); }
  };
  const valid = title.trim().length > 0 && members.length > 0 && members.length < MESSAGING_LIMITS.groupMaxMembers;
  const submit = () => {
    if (!valid || create.isPending) return;
    create.mutate(
      { title: title.trim(), memberIds: members, operationId: operationIdFor(scope) },
      { onSuccess: r => { onCreated(r.conversationId); close(false); } },
    );
  };
  // تغيير الاسم/الأعضاء بعد محاولة فاشلة = عملية جديدة
  const edit = (fn: () => void) => { if (create.isError) { completeOperation(operationIdFor(scope)); setSession(s => s + 1); create.reset(); } fn(); };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle>مجموعة جديدة</DialogTitle>
          <DialogDescription>من موظفي شركتك فقط. ستكون مشرف المجموعة.</DialogDescription>
        </DialogHeader>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">اسم المجموعة</span>
          <input value={title} onChange={e => edit(() => setTitle(e.target.value))} maxLength={MESSAGING_LIMITS.groupTitleMaxChars} className={inputCls} data-testid="group-title" />
        </label>
        {dir.isLoading ? <LoadingSkeleton variant="cards" rows={4} /> : dir.error ? <MessagingError compact message={messagingErrorText(dir.error)} onRetry={() => dir.refetch()} /> : (
          <DirectoryPicker rows={dir.data ?? []} selected={members} multi onToggle={id => edit(() => setMembers(m => (m.includes(id) ? m.filter(x => x !== id) : [...m, id])))} />
        )}
        <p className="text-xs text-muted-foreground">المختارون: {members.length}</p>
        {create.error && <p className="text-sm text-destructive" role="alert">{messagingErrorText(create.error)}</p>}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="min-h-11" onClick={() => close(false)} disabled={create.isPending} data-readonly-safe>إلغاء</Button>
          <Button type="button" className="min-h-11" onClick={submit} disabled={!valid || create.isPending} data-testid="create-group">{create.isPending ? "جارٍ الإنشاء…" : "إنشاء المجموعة"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** سجل نسخ الرسالة — من المسار المصرّح (messages.history) فقط. */
export function HistoryDialog({ via, messageId, onOpenChange }: { via: MessagingVia; messageId: number | null; onOpenChange: (o: boolean) => void }) {
  const api = useMessagingApi(via);
  const hist = api.history.useQuery({ messageId: messageId ?? 0 }, { enabled: messageId != null, retry: false, staleTime: 0 });
  return (
    <Dialog open={messageId != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle>سجل التعديلات</DialogTitle>
          <DialogDescription>النسخ السابقة للرسالة بترتيبها.</DialogDescription>
        </DialogHeader>
        {hist.isLoading ? <LoadingSkeleton variant="cards" rows={3} /> : hist.error ? <MessagingError compact message={messagingErrorText(hist.error)} onRetry={() => hist.refetch()} /> : (
          <ol className="max-h-80 space-y-2 overflow-y-auto" data-testid="history-list">
            {(hist.data ?? []).length === 0 && <li className="text-sm text-muted-foreground">لا نسخ سابقة.</li>}
            {(hist.data ?? []).map((h, i) => (
              <li key={i} className="rounded-[var(--radius-brand-md)] border border-border p-2 text-sm">
                <p className="mb-1 text-xs text-muted-foreground">{h.action === "delete" ? "قبل الحذف" : "قبل التعديل"} · {h.editorName ?? ""} · {formatFullTime(h.at)}</p>
                {h.previousTitle && <p className="font-semibold" dir="auto">{h.previousTitle}</p>}
                <p className="whitespace-pre-wrap break-words" dir="auto">{h.previousBody ?? "—"}</p>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** من اطّلع على إعلان ومن لم يطّلع — لأصحاب messages.announce فقط (الزر لا يظهر لغيرهم والسيرفر يرفض). */
export function ReadsDialog({ via, messageId, onOpenChange }: { via: MessagingVia; messageId: number | null; onOpenChange: (o: boolean) => void }) {
  const api = useMessagingApi(via);
  const reads = api.announcementReads.useQuery({ messageId: messageId ?? 0 }, { enabled: messageId != null, retry: false, staleTime: 0 });
  return (
    <Dialog open={messageId != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle>الاطلاع على الإعلان</DialogTitle>
          <DialogDescription>من ضغط «اطّلعت» ومن لم يطّلع بعد.</DialogDescription>
        </DialogHeader>
        {reads.isLoading ? <LoadingSkeleton variant="cards" rows={3} /> : reads.error ? <MessagingError compact message={messagingErrorText(reads.error)} onRetry={() => reads.refetch()} /> : reads.data && (
          <div className="grid max-h-80 gap-3 overflow-y-auto sm:grid-cols-2" data-testid="reads-list">
            <section>
              <h4 className="mb-1 text-sm font-semibold">اطّلع ({reads.data.acked.length})</h4>
              <ul className="space-y-1 text-sm">{reads.data.acked.map(p => <li key={p.employeeId} className="flex justify-between gap-2"><span className="truncate">{p.name}</span><span className="shrink-0 text-xs text-muted-foreground">{formatFullTime(p.ackedAt)}</span></li>)}</ul>
            </section>
            <section>
              <h4 className="mb-1 text-sm font-semibold">لم يطّلع ({reads.data.pending.length})</h4>
              <ul className="space-y-1 text-sm">{reads.data.pending.map(p => <li key={p.employeeId} className="truncate">{p.name}</li>)}</ul>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
