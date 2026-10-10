import { useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingSkeleton, ResponsiveDataTable, SectionCard, StatusBadge, toast, type Column } from "@/components/shared";
import { DAY_STATUS_LABELS, REQUEST_TYPE_LABELS, formatClock, formatMinutes } from "@shared/attendanceLabels";
import { TEAMS_TZ, TOUCH, fmtNum, formatMs, serverErrorText, useWritesBlocked } from "../teamsUi";
import { PeriodPicker, usePeriod, type Preset } from "./PeriodPicker";
import { QueryError, type LedTeam, type LeaderPerms } from "./common";

/**
 * حضور الفريق (team.attendance): أيام كل عضو لحظة يومه فقط، وطلبات التصحيح المعلّقة للأعضاء الحاليين **مهما كان
 * النطاق** — تغيير الفترة لا يخفيها (والبيانات السابقة تبقى أثناء التحميل). طلب القائد نفسه (isMine) يظهر بلا أزرار.
 * الاعتماد/الرفض فقط مع attendance.approve_corrections، والإجازة/المأمورية تضيف manage_leaves؛ السيرفر يتحقق بنفسه.
 */
const PRESETS: Preset[] = [{ key: "today", label: "اليوم", daysBack: 0 }, { key: "week", label: "آخر 7 أيام", daysBack: 6 }];
const LEAVE_TYPES = new Set(["absence_to_leave", "absence_to_mission"]);
type Day = { id: number; employeeName: string; workDate: string; status: string; workedMinutes: number; lateMinutes: number; firstInMs: number | null; lastOutMs: number | null; timezone?: string | null };

export function AttendanceTab({ team, perms }: { team: LedTeam; perms: LeaderPerms }) {
  const period = usePeriod(PRESETS, "today");
  const q = trpc.employeePortal.team.attendance.useQuery({ teamId: team.teamId, ...period.period }, { retry: false, placeholderData: keepPreviousData });
  if (q.isLoading) return <LoadingSkeleton variant="table" rows={4} />;
  if (q.error && !q.data) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.enabled) return <p className="rounded-[var(--radius-brand-md)] border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground" data-testid="leader-attendance-off">غير متاح حاليًا — نظام الحضور غير مفعّل.</p>;
  const { days, pending } = q.data as unknown as { days: Day[]; pending: any[] };
  const columns: Column<Day>[] = [
    { id: "name", header: "العضو", cell: r => <span className="font-medium">{r.employeeName}</span> },
    { id: "date", header: "اليوم", cell: r => <span className="tabular-nums" dir="ltr">{r.workDate}</span> },
    { id: "status", header: "الحالة", cell: r => { const s = DAY_STATUS_LABELS[r.status as keyof typeof DAY_STATUS_LABELS]; return <StatusBadge status={r.status} label={s?.label ?? r.status} tone={s?.tone} size="sm" />; } },
    { id: "in", header: "حضور", numeric: true, cell: r => formatClock(r.firstInMs, r.timezone || TEAMS_TZ) },
    { id: "out", header: "انصراف", numeric: true, cell: r => formatClock(r.lastOutMs, r.timezone || TEAMS_TZ) },
    { id: "late", header: "تأخير", numeric: true, cell: r => (Number(r.lateMinutes) > 0 ? formatMinutes(r.lateMinutes) : "—") },
    { id: "worked", header: "مدة العمل", numeric: true, cell: r => formatMinutes(r.workedMinutes) },
  ];
  return (
    <div className="space-y-4" data-testid="leader-attendance">
      <PendingCorrections team={team} perms={perms} pending={pending} />
      <SectionCard title="أيام الحضور">
        <PeriodPicker presets={PRESETS} state={period} testId="leader-attendance-period" />
        {q.error && <p className="mt-2 text-sm text-destructive" role="alert">{serverErrorText(q.error)}</p>}
        <div className="mt-3" aria-busy={q.isFetching}>
          <ResponsiveDataTable
            rows={days}
            columns={columns}
            rowKey={r => r.id}
            empty={{ title: "لا أيام حضور في الفترة", description: "تظهر أيام الأعضاء خلال فترات عضويتهم فقط." }}
            mobileRow={r => {
              const s = DAY_STATUS_LABELS[r.status as keyof typeof DAY_STATUS_LABELS];
              return (
                <div className="space-y-1 rounded-[var(--radius-brand-md)] border border-border bg-card p-3">
                  <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{r.employeeName}</span><StatusBadge status={r.status} label={s?.label ?? r.status} tone={s?.tone} size="sm" /></div>
                  <p className="text-xs text-muted-foreground"><span className="tabular-nums" dir="ltr">{r.workDate}</span> · حضور <span className="tabular-nums">{formatClock(r.firstInMs, r.timezone || TEAMS_TZ)}</span> · انصراف <span className="tabular-nums">{formatClock(r.lastOutMs, r.timezone || TEAMS_TZ)}</span>{Number(r.lateMinutes) > 0 ? <> · تأخير {formatMinutes(r.lateMinutes)}</> : null}</p>
                </div>
              );
            }}
          />
        </div>
      </SectionCard>
    </div>
  );
}

function PendingCorrections({ team, perms, pending }: { team: LedTeam; perms: LeaderPerms; pending: any[] }) {
  const utils = trpc.useUtils();
  const review = trpc.employeePortal.team.reviewCorrection.useMutation();
  const writes = useWritesBlocked();
  const canApprove = perms.has("attendance.approve_corrections");
  const canLeaves = perms.has("attendance.manage_leaves");
  const busy = useRef(new Set<number>());
  const [rejecting, setRejecting] = useState<{ id: number; reason: string } | null>(null);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const submit = (requestId: number, decision: "approve" | "reject", reviewReason?: string) => {
    if (busy.current.has(requestId)) return;
    busy.current.add(requestId);
    setErrors(e => ({ ...e, [requestId]: "" }));
    review.mutate({ teamId: team.teamId, requestId, decision, reviewReason: reviewReason ?? null }, {
      onSuccess: () => { toast.success(decision === "approve" ? "اعتُمد الطلب" : "رُفض الطلب"); setRejecting(null); utils.employeePortal.team.attendance.invalidate(); },
      onError: e => { const m = serverErrorText(e); setErrors(x => ({ ...x, [requestId]: m })); toast.error(m); utils.employeePortal.team.attendance.invalidate(); },
      onSettled: () => { busy.current.delete(requestId); },
    });
  };
  return (
    <SectionCard title={`طلبات تصحيح معلّقة (${fmtNum(pending.length)})`} description="كل الطلبات المعلّقة لأعضاء الفريق الحاليين — لا تتأثر بالفترة المختارة.">
      {writes.blocked && <p className="mb-2 text-sm text-muted-foreground" role="status">{writes.reason}</p>}
      {pending.length === 0 ? <p className="text-sm text-muted-foreground">لا طلبات معلّقة.</p> : (
        <ul className="space-y-2" data-testid="leader-pending">
          {pending.map(p => {
            const needsLeaves = LEAVE_TYPES.has(p.requestType);
            const allowed = canApprove && (!needsLeaves || canLeaves);
            const pendingThis = review.isPending && review.variables?.requestId === p.id;
            return (
              <li key={p.id} className="space-y-2 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`pending-${p.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{p.employeeName}</span>
                  <StatusBadge status="pending" label={REQUEST_TYPE_LABELS[p.requestType as keyof typeof REQUEST_TYPE_LABELS] ?? "طلب تصحيح"} tone="warning" size="sm" />
                </div>
                <p className="text-xs text-muted-foreground">يوم <span className="tabular-nums" dir="ltr">{p.workDate}</span> · قُدّم {formatMs(Number(p.createdMs))}</p>
                {p.reason && <p className="text-sm">{p.reason}</p>}
                {p.isMine ? (
                  <p className="text-xs text-muted-foreground" data-testid={`pending-mine-${p.id}`}>طلبك أنت — يراجعه مسؤول آخر، ولا يمكنك اعتماده.</p>
                ) : !canApprove ? (
                  <p className="text-xs text-muted-foreground">للعرض فقط — الاعتماد يحتاج صلاحية «اعتماد طلبات التصحيح».</p>
                ) : !allowed ? (
                  <p className="text-xs text-muted-foreground">تحويل الغياب لإجازة/مأمورية يحتاج أيضًا صلاحية «إدارة الإجازات».</p>
                ) : rejecting?.id === p.id ? (
                  <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); if ((rejecting?.reason ?? "").trim().length >= 3) submit(p.id, "reject", (rejecting?.reason ?? "").trim()); }}>
                    <Input value={(rejecting?.reason ?? "")} onChange={e => setRejecting({ id: p.id, reason: e.target.value })} maxLength={500} placeholder="سبب الرفض (3 أحرف على الأقل)" aria-label="سبب الرفض" className="min-h-11 min-w-0 flex-1" />
                    <Button type="submit" variant="destructive" className={TOUCH} disabled={writes.blocked || pendingThis || (rejecting?.reason ?? "").trim().length < 3} data-testid={`pending-reject-confirm-${p.id}`}>{pendingThis ? "جارٍ…" : "تأكيد الرفض"}</Button>
                    <Button type="button" variant="ghost" className={TOUCH} onClick={() => setRejecting(null)} data-readonly-safe>إلغاء</Button>
                  </form>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button className={TOUCH} onClick={() => submit(p.id, "approve")} disabled={writes.blocked || review.isPending} data-testid={`pending-approve-${p.id}`}><Check className="h-4 w-4" aria-hidden="true" /> {pendingThis ? "جارٍ…" : "اعتماد"}</Button>
                    <Button variant="outline" className={TOUCH} onClick={() => setRejecting({ id: p.id, reason: "" })} disabled={writes.blocked || review.isPending} data-testid={`pending-reject-${p.id}`}><X className="h-4 w-4" aria-hidden="true" /> رفض</Button>
                  </div>
                )}
                {errors[p.id] && <p className="text-sm text-destructive" role="alert">{errors[p.id]}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
