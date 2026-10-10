import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { operationIdFor } from "@/lib/operationId";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LoadingSkeleton, SectionCard, StatusBadge, UnderlineTabs, toast } from "@/components/shared";
import { TOUCH, formatMs, serverErrorText, useWritesBlocked } from "../teamsUi";
import { QueryError, type LedTeam } from "./common";

/**
 * مهام الفريق (team.tasks.*): لعضو فعّال أو عامة لنشاط الفريق. الإنشاء بمعرّف عملية ثابت لنفس المحتوى (Replay على
 * السيرفر — بلا أي dedup زمني)، وتحديث الحالة كما يسمح السيرفر (new/in_progress/done)، ولا حذف.
 * المنشئ يظهر باسمه من السيرفر (creator) — لا يُعرض createdBy الخام أبدًا.
 */
const STATUS = { new: { label: "جديدة", tone: "info" as const }, in_progress: { label: "قيد التنفيذ", tone: "warning" as const }, done: { label: "منتهية", tone: "success" as const } };
type TaskStatus = keyof typeof STATUS;
const GENERAL = "__general";

export function TasksTab({ team }: { team: LedTeam }) {
  const [filter, setFilter] = useState<"all" | TaskStatus>("all");
  const q = trpc.employeePortal.team.tasks.list.useQuery({ teamId: team.teamId }, { retry: false });
  const members = trpc.employeePortal.team.members.useQuery({ teamId: team.teamId }, { retry: false });
  const memberList: { employeeId: number; employeeName: string }[] = members.data?.enabled ? (members.data.members as any[]) : [];
  const rows = q.data?.enabled ? q.data.rows : [];
  const shown = filter === "all" ? rows : rows.filter(t => t.status === filter);
  return (
    <div className="space-y-4" data-testid="leader-tasks">
      <CreateTask team={team} members={memberList} />
      <SectionCard title="مهام الفريق">
        <UnderlineTabs
          value={filter}
          onChange={k => setFilter(k as typeof filter)}
          ariaLabel="حالة المهام"
          tabs={[
            { key: "all", label: "الكل", count: q.data?.enabled ? rows.length : null },
            ...(Object.keys(STATUS) as TaskStatus[]).map(k => ({ key: k, label: STATUS[k].label, count: q.data?.enabled ? rows.filter(t => t.status === k).length : null })),
          ]}
        />
        <div className="mt-3">
          {q.isLoading ? <LoadingSkeleton variant="cards" rows={3} />
            : q.error ? <QueryError error={q.error} onRetry={() => q.refetch()} />
            : !q.data?.enabled ? <p className="text-sm text-muted-foreground">غير متاح حاليًا.</p>
            : shown.length === 0 ? <p className="text-sm text-muted-foreground">لا مهام.</p>
            : (
              <ul className="space-y-2">
                {shown.map(t => <TaskItem key={t.id} team={team} task={t} />)}
                {rows.length >= 100 && <li className="text-xs text-muted-foreground">يعرض الخادم آخر 100 مهمة فقط.</li>}
              </ul>
            )}
        </div>
      </SectionCard>
    </div>
  );
}

function TaskItem({ team, task }: { team: LedTeam; task: { id: number; title: string; description: string | null; assignedToName: string | null; assignedTo: number | null; status: string; createdAtMs: number; creator: { kind: "employee" | "legacy"; name: string } } }) {
  const utils = trpc.useUtils();
  const update = trpc.employeePortal.team.tasks.updateStatus.useMutation();
  const writes = useWritesBlocked();
  const lock = useRef(false);
  const s = STATUS[task.status as TaskStatus];
  const change = (status: TaskStatus) => {
    if (lock.current || update.isPending || status === task.status) return;
    lock.current = true;
    update.mutate({ teamId: team.teamId, taskId: task.id, status }, {
      onSuccess: () => { toast.success("تم تحديث الحالة"); utils.employeePortal.team.tasks.list.invalidate(); },
      onError: e => { toast.error(serverErrorText(e)); utils.employeePortal.team.tasks.list.invalidate(); },
      onSettled: () => { lock.current = false; },
    });
  };
  return (
    <li className="space-y-2 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`task-${task.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 font-medium">{task.title}</span>
        <StatusBadge status={task.status} label={s?.label ?? task.status} tone={s?.tone ?? "neutral"} size="sm" />
      </div>
      {task.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{task.description}</p>}
      <p className="text-xs text-muted-foreground">
        {task.assignedTo == null ? "مهمة عامة للنشاط" : `لـ ${task.assignedToName ?? "عضو"}`} · أنشأها {task.creator.name || "—"} · {formatMs(task.createdAtMs)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`task-status-${task.id}`} className="text-xs text-muted-foreground">الحالة</Label>
        <Select value={task.status} onValueChange={v => change(v as TaskStatus)} disabled={writes.blocked || update.isPending}>
          <SelectTrigger id={`task-status-${task.id}`} className="min-h-11 w-40 md:min-h-9" data-testid={`task-status-${task.id}`}><SelectValue /></SelectTrigger>
          <SelectContent>{(Object.keys(STATUS) as TaskStatus[]).map(k => <SelectItem key={k} value={k} className="min-h-11">{STATUS[k].label}</SelectItem>)}</SelectContent>
        </Select>
        {update.isPending && <span className="text-xs text-muted-foreground" role="status">جارٍ الحفظ…</span>}
      </div>
    </li>
  );
}

function CreateTask({ team, members }: { team: LedTeam; members: { employeeId: number; employeeName: string }[] }) {
  const utils = trpc.useUtils();
  const create = trpc.employeePortal.team.tasks.create.useMutation();
  const writes = useWritesBlocked();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [to, setTo] = useState(GENERAL);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const valid = title.trim().length >= 2;
  const submit = () => {
    if (lock.current || create.isPending || !valid) return;
    lock.current = true; setError(null);
    const assignedTo = to === GENERAL ? null : Number(to);
    const payload = { teamId: team.teamId, title: title.trim(), description: description.trim() || null, assignedTo };
    // نفس المحتوى ⇒ نفس المعرّف حتى النجاح (إعادة المحاولة بعد انقطاع = Replay لا مهمة مكرّرة)؛ تغيير المحتوى ⇒ عملية جديدة
    create.mutate({ ...payload, operationId: operationIdFor(`team-task:${team.teamId}:${payload.title}:${payload.description ?? ""}:${assignedTo ?? "general"}`) }, {
      onSuccess: r => { toast.success(r.replay ? "المهمة موجودة بالفعل" : "أُنشئت المهمة"); setTitle(""); setDescription(""); setTo(GENERAL); utils.employeePortal.team.tasks.list.invalidate(); },
      onError: e => setError(serverErrorText(e)),
      onSettled: () => { lock.current = false; },
    });
  };
  return (
    <SectionCard title="مهمة جديدة" description={`لعضو حالي أو عامة لنشاط الفريق «${team.name}».`}>
      <form className="grid gap-3 md:grid-cols-2" onSubmit={e => { e.preventDefault(); submit(); }} data-testid="task-create">
        <div className="space-y-1 md:col-span-2"><Label htmlFor="task-title">العنوان</Label><Input id="task-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} className="min-h-11" /></div>
        <div className="space-y-1 md:col-span-2"><Label htmlFor="task-desc">التفاصيل (اختياري)</Label><Textarea id="task-desc" value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} rows={2} /></div>
        <div className="space-y-1">
          <Label htmlFor="task-to">المستلم</Label>
          <Select value={to} onValueChange={setTo}>
            <SelectTrigger id="task-to" className="min-h-11"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={GENERAL} className="min-h-11">مهمة عامة للنشاط</SelectItem>
              {members.map(m => <SelectItem key={m.employeeId} value={String(m.employeeId)} className="min-h-11">{m.employeeName}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end">
          <Button type="submit" className={`${TOUCH} w-full md:w-auto`} disabled={writes.blocked || !valid || create.isPending} data-testid="task-create-submit"><Plus className="h-4 w-4" aria-hidden="true" /> {create.isPending ? "جارٍ الإنشاء…" : "إنشاء المهمة"}</Button>
        </div>
        {writes.blocked && <p className="text-sm text-muted-foreground md:col-span-2" role="status">{writes.reason}</p>}
        {error && <p className="text-sm text-destructive md:col-span-2" role="alert" data-testid="task-create-error">{error}</p>}
      </form>
      <p className="mt-2 text-xs text-muted-foreground">لا حذف للمهام — غيّر الحالة إلى «منتهية» عند الإنجاز.</p>
    </SectionCard>
  );
}
