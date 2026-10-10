import { useEffect, useMemo, useState } from "react";
import { UsersRound } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { EmployeeShell } from "@/components/shell/EmployeeShell";
import { EmptyState, LoadingSkeleton, PermissionDeniedState, UnderlineTabs, type UnderlineTab } from "@/components/shared";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TeamsUnavailable } from "@/components/teams/TeamsStates";
import { useLeaderAccess } from "@/components/teams/useLeaderAccess";
import { QueryError, type LedTeam } from "@/components/teams/leader/common";
import { SummaryTab } from "@/components/teams/leader/SummaryTab";
import { MembersTab } from "@/components/teams/leader/MembersTab";
import { AttendanceTab } from "@/components/teams/leader/AttendanceTab";
import { PerformanceTab } from "@/components/teams/leader/PerformanceTab";

/**
 * «فريقي» — لوحة قائد الفريق داخل بوابة الموظف (هوية كوكي الموظف فقط).
 *  • الفريق يُختار من الفرق التي يقودها الموظف **الآن** (myTeams على السيرفر) — لا teamId من الرابط.
 *  • كل تبويب يظهر بصلاحيته، وكل endpoint يتحقق من الصلاحية + القيادة الفعّالة؛ رفضه يظهر كـPermissionDenied.
 *  • العلم معطل ⇒ «غير متاح» بلا أي استعلام آخر.
 */
type TabKey = "summary" | "members" | "attendance" | "performance";

export default function TeamLeaderDashboard() {
  const access = useLeaderAccess();
  const me = trpc.employeePortal.me.useQuery(undefined, { retry: false, staleTime: 5 * 60 * 1000 });
  return (
    <EmployeeShell title="فريقي" icon={UsersRound}>
      <div className="mx-auto max-w-5xl space-y-4" dir="rtl" data-testid="team-leader-dashboard">
        {access.permsLoading || (access.canViewOwn && access.myTeams.isLoading) ? <LoadingSkeleton variant="cards" rows={3} />
          : access.permsError ? <QueryError error={access.permsError} />
          : !access.canViewOwn ? <PermissionDeniedState message="«فريقي» يحتاج صلاحية «عرض فريقي»." />
          : access.myTeams.error ? <QueryError error={access.myTeams.error} onRetry={() => access.myTeams.refetch()} />
          : !access.enabled ? <TeamsUnavailable />
          : access.teams.length === 0 ? <EmptyState title="لست قائدًا لفريق حاليًا" description="تظهر هنا الفرق التي تقودها الآن فقط. إذا انتهت قيادتك فلن تظهر بيانات الفريق." />
          : <LeaderBoard teams={access.teams} has={access.has} leaderName={me.data?.name ?? null} />}
      </div>
    </EmployeeShell>
  );
}

function LeaderBoard({ teams, has, leaderName }: { teams: LedTeam[]; has: (p: string) => boolean; leaderName: string | null }) {
  const [teamId, setTeamId] = useState<number>(teams[0].teamId);
  // القيادة انتهت لفريق مختار (طلب لاحق لـmyTeams) ⇒ نعود لأول فريق ما زال يقوده
  useEffect(() => { if (!teams.some(t => t.teamId === teamId)) setTeamId(teams[0].teamId); }, [teams, teamId]);
  const team = teams.find(t => t.teamId === teamId) ?? teams[0];
  const tabs: UnderlineTab[] = useMemo(() => [
    { key: "summary", label: "الملخص" },
    { key: "members", label: "الأعضاء والورديات" },
    ...(has("team_attendance.view") ? [{ key: "attendance", label: "الحضور" }] : []),
    ...(has("team_performance.view") ? [{ key: "performance", label: "الأداء" }] : []),
  ], [has]);
  const [tab, setTab] = useState<TabKey>("summary");
  const perms = { has };
  return (
    <>
      {teams.length > 1 ? (
        <div className="space-y-1">
          <Label htmlFor="leader-team">الفريق</Label>
          <Select value={String(team.teamId)} onValueChange={v => setTeamId(Number(v))}>
            <SelectTrigger id="leader-team" className="min-h-11 w-full sm:w-72" data-testid="leader-team-select"><SelectValue /></SelectTrigger>
            <SelectContent>{teams.map(t => <SelectItem key={t.teamId} value={String(t.teamId)} className="min-h-11">{t.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      ) : <p className="text-sm text-muted-foreground">الفريق: <span className="font-semibold text-foreground" data-testid="leader-team-name">{team.name}</span></p>}
      <UnderlineTabs tabs={tabs} value={tab} onChange={k => setTab(k as TabKey)} ariaLabel="أقسام الفريق" />
      <div role="tabpanel" key={`${team.teamId}:${tab}`}>
        {tab === "summary" && <SummaryTab team={team} perms={perms} leaderName={leaderName} />}
        {tab === "members" && <MembersTab team={team} perms={perms} />}
        {tab === "attendance" && has("team_attendance.view") && <AttendanceTab team={team} perms={perms} />}
        {tab === "performance" && has("team_performance.view") && <PerformanceTab team={team} perms={perms} />}
      </div>
    </>
  );
}
