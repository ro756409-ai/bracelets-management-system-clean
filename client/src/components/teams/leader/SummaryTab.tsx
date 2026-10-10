import { trpc } from "@/lib/trpc";
import { LoadingSkeleton, SectionCard, StatCard } from "@/components/shared";
import { dayKey, fmtNum } from "../teamsUi";
import { QueryError, type LedTeam, type LeaderPerms } from "./common";

/**
 * ملخص الفريق — كل رقم من endpoint حقيقي ومقيّد بالصلاحية؛ قسم بلا صلاحيته يقول ذلك ولا يطلب شيئًا.
 * الحضور اليوم من team.attendance، والأوردرات من totals team.orders.list (limit 1)، والمهام من team.tasks.list،
 * والأداء من team.performance (آخر 7 أيام). لا حساب نسب جديدة في الواجهة.
 */
export function SummaryTab({ team, perms, leaderName }: { team: LedTeam; perms: LeaderPerms; leaderName?: string | null }) {
  const today = dayKey(0);
  const members = trpc.employeePortal.team.members.useQuery({ teamId: team.teamId }, { retry: false });
  const canAtt = perms.has("team_attendance.view");
  const canOrders = perms.has("team_orders.view");
  const canTasks = perms.has("team_tasks.manage");
  const canPerf = perms.has("team_performance.view");
  const att = trpc.employeePortal.team.attendance.useQuery({ teamId: team.teamId, dateFrom: today, dateTo: today }, { enabled: canAtt, retry: false });
  const ord = (extra: { status?: string; unassignedOnly?: boolean }) =>
    trpc.employeePortal.team.orders.list.useQuery({ teamId: team.teamId, ...extra, page: 1, limit: 1 }, { enabled: canOrders, retry: false });
  const unassigned = ord({ unassignedOnly: true });
  const fresh = ord({ status: "new" });
  const noAnswer = ord({ status: "no_answer" });
  const postponed = ord({ status: "postponed" });
  const tasks = trpc.employeePortal.team.tasks.list.useQuery({ teamId: team.teamId }, { enabled: canTasks, retry: false });
  const perf = trpc.employeePortal.team.performance.useQuery({ teamId: team.teamId, dateFrom: dayKey(6), dateTo: dayKey(0) }, { enabled: canPerf, retry: false });

  const days = att.data?.enabled ? att.data.days : [];
  const present = days.filter((d: any) => ["open", "on_break", "closed", "incomplete"].includes(d.status)).length;
  const late = days.filter((d: any) => Number(d.lateMinutes) > 0).length;
  const absent = days.filter((d: any) => d.status === "absent").length;
  const onBreak = days.filter((d: any) => d.status === "on_break").length;
  const total = (q: typeof unassigned) => (q.data?.enabled ? (q.data as any).total as number : null);
  const taskRows = tasks.data?.enabled ? tasks.data.rows : [];
  const perfRows: any[] = perf.data?.enabled ? (perf.data as any).rows : [];
  const sum = (k: string) => perfRows.reduce((a, r) => a + Number(r[k] ?? 0), 0);

  return (
    <div className="space-y-4" data-testid="leader-summary">
      <SectionCard title="الفريق">
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          <div><dt className="text-muted-foreground">الفريق</dt><dd className="font-semibold">{team.name}</dd></div>
          <div><dt className="text-muted-foreground">النشاط</dt><dd className="text-muted-foreground" data-testid="leader-business-gap">اسم النشاط غير متاح من الخادم</dd></div>
          <div><dt className="text-muted-foreground">القائد</dt><dd className="font-semibold">{leaderName ?? "—"}</dd></div>
        </dl>
      </SectionCard>

      <SectionCard title="الأعضاء الحاليون">
        {members.isLoading ? <LoadingSkeleton variant="cards" rows={1} /> : members.error ? <QueryError error={members.error} onRetry={() => members.refetch()} />
          : <StatCard label="عدد الأعضاء الآن (مع القائد)" value={<span className="tabular-nums">{fmtNum(members.data?.enabled ? members.data.members.length : 0)}</span>} />}
      </SectionCard>

      <SectionCard title="الحضور اليوم" description={<bdi className="tabular-nums" dir="ltr">{today}</bdi>}>
        {!canAtt ? <p className="text-sm text-muted-foreground">لا تملك صلاحية «عرض حضور الفريق».</p>
          : att.isLoading ? <LoadingSkeleton variant="cards" rows={1} />
          : att.error ? <QueryError error={att.error} onRetry={() => att.refetch()} />
          : !att.data?.enabled ? <p className="text-sm text-muted-foreground">نظام الحضور غير مفعّل.</p>
          : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="leader-summary-attendance">
              <StatCard label="حاضر" value={<span className="tabular-nums">{fmtNum(present)}</span>} tone="success" />
              <StatCard label="متأخر" value={<span className="tabular-nums">{fmtNum(late)}</span>} tone="warning" />
              <StatCard label="غائب" value={<span className="tabular-nums">{fmtNum(absent)}</span>} tone="danger" />
              <StatCard label="في استراحة" value={<span className="tabular-nums">{fmtNum(onBreak)}</span>} />
              <p className="col-span-full text-xs text-muted-foreground">طلبات تصحيح معلّقة: <span className="tabular-nums">{fmtNum(att.data.pending.length)}</span> — العضو الذي لا يوجد له يوم حضور اليوم لا يدخل في هذه الأرقام.</p>
            </div>
          )}
      </SectionCard>

      <SectionCard title="أوردرات تحتاج متابعة">
        {!canOrders ? <p className="text-sm text-muted-foreground">لا تملك صلاحية «عرض أوردرات الفريق».</p>
          : unassigned.error ? <QueryError error={unassigned.error} onRetry={() => unassigned.refetch()} />
          : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="leader-summary-orders">
              <StatCard label="غير مسندة" value={<span className="tabular-nums">{fmtNum(total(unassigned))}</span>} tone="warning" />
              <StatCard label="جديدة" value={<span className="tabular-nums">{fmtNum(total(fresh))}</span>} />
              <StatCard label="لم يرد" value={<span className="tabular-nums">{fmtNum(total(noAnswer))}</span>} />
              <StatCard label="مؤجلة" value={<span className="tabular-nums">{fmtNum(total(postponed))}</span>} />
            </div>
          )}
      </SectionCard>

      <SectionCard title="المهام المفتوحة">
        {!canTasks ? <p className="text-sm text-muted-foreground">لا تملك صلاحية «إدارة مهام الفريق».</p>
          : tasks.isLoading ? <LoadingSkeleton variant="cards" rows={1} />
          : tasks.error ? <QueryError error={tasks.error} onRetry={() => tasks.refetch()} />
          : (
            <div className="grid grid-cols-2 gap-3" data-testid="leader-summary-tasks">
              <StatCard label="جديدة" value={<span className="tabular-nums">{fmtNum(taskRows.filter(t => t.status === "new").length)}</span>} />
              <StatCard label="قيد التنفيذ" value={<span className="tabular-nums">{fmtNum(taskRows.filter(t => t.status === "in_progress").length)}</span>} />
              {taskRows.length >= 100 && <p className="col-span-full text-xs text-muted-foreground">يعرض الخادم آخر 100 مهمة فقط.</p>}
            </div>
          )}
      </SectionCard>

      <SectionCard title="الأداء — آخر 7 أيام">
        {!canPerf ? <p className="text-sm text-muted-foreground">لا تملك صلاحية «عرض أداء الفريق».</p>
          : perf.isLoading ? <LoadingSkeleton variant="cards" rows={1} />
          : perf.error ? <QueryError error={perf.error} onRetry={() => perf.refetch()} />
          : !perf.data?.enabled ? <p className="text-sm text-muted-foreground">غير متاح حاليًا — سجل الأحداث غير مفعّل.</p>
          : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3" data-testid="leader-summary-performance">
              <StatCard label="مجموع قرارات الأعضاء" value={<span className="tabular-nums">{fmtNum(sum("decisionEligibleOrders"))}</span>} />
              <StatCard label="مجموع المؤكد" value={<span className="tabular-nums">{fmtNum(sum("confirmedOrders"))}</span>} tone="success" />
              <StatCard label="أعضاء بعينة كافية للترتيب" value={<span className="tabular-nums">{fmtNum(perfRows.filter(r => r.rankable).length)}</span>} />
            </div>
          )}
      </SectionCard>
    </div>
  );
}
