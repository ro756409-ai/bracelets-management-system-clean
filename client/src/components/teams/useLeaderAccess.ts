import { trpc } from "@/lib/trpc";

/**
 * وصول القائد في البوابة — هوية كوكي الموظف فقط (employeePortal.myPermissions + team.myTeams).
 * «قائد» = صف قيادة فعّال الآن على السيرفر (myTeams)، لا من الواجهة ولا من الرابط. myTeams لا يُطلب أصلًا
 * بلا teams.view_own؛ والعلم معطل ⇒ enabled:false بلا أي استعلام آخر. السحب/انتهاء القيادة يظهر في الطلب التالي.
 */
export function useLeaderAccess() {
  const perms = trpc.employeePortal.myPermissions.useQuery(undefined, { retry: false, staleTime: 60 * 1000 });
  const list: string[] = (perms.data as string[] | undefined) ?? [];
  const canViewOwn = list.includes("teams.view_own");
  const my = trpc.employeePortal.team.myTeams.useQuery(undefined, { enabled: canViewOwn, retry: false, staleTime: 60 * 1000 });
  const enabled = my.data?.enabled === true;
  const teams = enabled ? my.data!.teams : [];
  return {
    permsLoading: perms.isLoading,
    permsError: perms.error,
    has: (p: string) => list.includes(p),
    canViewOwn,
    myTeams: my,
    enabled,
    teams,
    /** يظهر رابط «فريقي»: الميزة مفعّلة + teams.view_own + قيادة فعّالة الآن. */
    showEntry: canViewOwn && enabled && teams.length > 0,
  };
}
