import { Crown } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { LoadingSkeleton, SectionCard, StatusBadge } from "@/components/shared";
import { fmtNum, formatMs } from "../teamsUi";
import { QueryError, ServerGap, type LedTeam } from "./common";

/** الأعضاء الحاليون (employeePortal.team.members). الورديات وسجل العضويات للقائد غير متاحة من الخادم بعد. */
export function MembersTab({ team }: { team: LedTeam }) {
  const q = trpc.employeePortal.team.members.useQuery({ teamId: team.teamId }, { retry: false });
  if (q.isLoading) return <LoadingSkeleton variant="cards" rows={3} />;
  if (q.error) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  const members = q.data?.enabled ? q.data.members : [];
  return (
    <div className="space-y-4" data-testid="leader-members">
      <SectionCard title={`الأعضاء الحاليون (${fmtNum(members.length)})`}>
        {members.length === 0 ? <p className="text-sm text-muted-foreground">لا أعضاء حاليًا.</p> : (
          <ul className="grid gap-2 md:grid-cols-2">
            {members.map((m: any) => (
              <li key={m.id} className="flex min-h-14 items-center gap-3 rounded-[var(--radius-brand-md)] border border-border bg-card p-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{m.employeeName}</span>
                  <span className="block text-xs text-muted-foreground">عضو منذ {formatMs(m.fromMs)}</span>
                  <span className="block text-xs text-muted-foreground">الوردية: غير متاحة من الخادم</span>
                </span>
                <StatusBadge status={m.membershipRole} label={m.membershipRole === "leader" ? "قائد" : "عضو"} tone={m.membershipRole === "leader" ? "primary" : "neutral"} icon={m.membershipRole === "leader" ? <Crown className="h-3 w-3" aria-hidden="true" /> : undefined} size="sm" />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title="الورديات والتعارضات">
        <ServerGap testId="leader-shifts-gap">لا يوجد مسار يعرض للقائد وردية كل عضو (البداية/النهاية/الليلية) أو تحذير «بلا وردية/تعارض».</ServerGap>
      </SectionCard>
      <SectionCard title="سجل العضويات">
        <ServerGap testId="leader-history-gap">سجل العضويات متاح للإدارة فقط من صفحة «الفرق»؛ لا مسار للقائد.</ServerGap>
      </SectionCard>
    </div>
  );
}
