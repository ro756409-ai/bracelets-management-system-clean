import { Crown, History } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { LoadingSkeleton, SectionCard, StatusBadge } from "@/components/shared";
import { MemberShiftsList, type MemberShift } from "../MemberShifts";
import { fmtNum, formatMs } from "../teamsUi";
import { QueryError, type LedTeam, type LeaderPerms } from "./common";

/**
 * الأعضاء والورديات: الأعضاء الحاليون (team.members)، وورديات اليوم كما يطبّقها الحضور (team.memberShifts،
 * team_attendance.view)، وسجل العضويات بأسماء فقط (team.history). الحضور معطل ⇒ الورديات «غير متاح حاليًا» وحدها.
 */
export function MembersTab({ team, perms }: { team: LedTeam; perms: LeaderPerms }) {
  const q = trpc.employeePortal.team.members.useQuery({ teamId: team.teamId }, { retry: false });
  const canShifts = perms.has("team_attendance.view");
  const shifts = trpc.employeePortal.team.memberShifts.useQuery({ teamId: team.teamId }, { enabled: canShifts, retry: false });
  const history = trpc.employeePortal.team.history.useQuery({ teamId: team.teamId }, { retry: false });
  const members = q.data?.enabled ? q.data.members : [];
  return (
    <div className="space-y-4" data-testid="leader-members">
      <SectionCard title={`الأعضاء الحاليون (${fmtNum(members.length)})`}>
        {q.isLoading ? <LoadingSkeleton variant="cards" rows={2} /> : q.error ? <QueryError error={q.error} onRetry={() => q.refetch()} />
          : members.length === 0 ? <p className="text-sm text-muted-foreground">لا أعضاء حاليًا.</p> : (
          <ul className="grid gap-2 md:grid-cols-2">
            {members.map((m: any) => (
              <li key={m.id} className="flex min-h-14 items-center gap-3 rounded-[var(--radius-brand-md)] border border-border bg-card p-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{m.employeeName}</span>
                  <span className="block text-xs text-muted-foreground">منذ {formatMs(m.fromMs)}</span>
                </span>
                <StatusBadge status={m.membershipRole} label={m.membershipRole === "leader" ? "قائد" : "عضو"} tone={m.membershipRole === "leader" ? "primary" : "neutral"} icon={m.membershipRole === "leader" ? <Crown className="h-3 w-3" aria-hidden="true" /> : undefined} size="sm" />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="الورديات والتحذيرات">
        {!canShifts ? <p className="text-sm text-muted-foreground">لا تملك صلاحية «عرض حضور الفريق» — الورديات غير معروضة.</p>
          : shifts.isLoading ? <LoadingSkeleton variant="cards" rows={2} />
          : shifts.error ? <QueryError error={shifts.error} onRetry={() => shifts.refetch()} />
          : !shifts.data?.enabled ? <p className="text-sm text-muted-foreground" data-testid="leader-shifts-off">غير متاح حاليًا — نظام الحضور غير مفعّل.</p>
          : <MemberShiftsList workDate={shifts.data.workDate} timeZone={shifts.data.timeZone} members={shifts.data.members as MemberShift[]} />}
      </SectionCard>

      <SectionCard title="سجل العضويات والقيادة">
        {history.isLoading ? <LoadingSkeleton variant="table" rows={3} />
          : history.error ? <QueryError error={history.error} onRetry={() => history.refetch()} />
          : !history.data?.enabled ? <p className="text-sm text-muted-foreground">غير متاح حاليًا.</p>
          : history.data.history.length === 0 ? <p className="text-sm text-muted-foreground">لا سجل بعد.</p> : (
            <ul className="space-y-2" data-testid="leader-history">
              {history.data.history.map((h: any, i: number) => (
                <li key={i} className="rounded-[var(--radius-brand-md)] border border-border p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <span className="font-medium">{h.memberName}</span>
                    <StatusBadge status={h.membershipRole} label={h.membershipRole === "leader" ? "قائد" : "عضو"} tone={h.membershipRole === "leader" ? "primary" : "neutral"} size="sm" />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    من {formatMs(h.fromMs)} ({h.addedByName}) · {h.toMs ? `حتى ${formatMs(h.toMs)}${h.endedByName ? ` (${h.endedByName})` : ""}` : "مستمرة"}
                  </p>
                </li>
              ))}
            </ul>
          )}
      </SectionCard>
    </div>
  );
}
