import { describe, it, expect } from "vitest";
import fs from "node:fs";

/**
 * مدخل «فريقي» في رأس البوابة: يظهر فقط مع teams.view_own + العلم مفعّل + قيادة فعّالة (myTeams)، ولا يُطلب myTeams
 * بلا الصلاحية، وهو **غير مثبّت** فيبقى في «المزيد» على الهاتف (الرأس صف واحد)؛ ورابط «الفرق» للمالك خلف flag.
 */
const dash = fs.readFileSync("client/src/pages/EmployeeDashboard.tsx", "utf-8");
const nav = fs.readFileSync("client/src/config/navigation.ts", "utf-8");
const app = fs.readFileSync("client/src/App.tsx", "utf-8");

const layout = fs.readFileSync("client/src/components/DashboardLayout.tsx", "utf-8");

describe("🔗 «فريقي» و«الفرق» — المداخل", () => {
  it("الويب: myTeams لجلسة موظف فقط + العلم + teams.view_own، و«فريقي» بـflag teamLeader", () => {
    expect(layout).toContain('const isEmployeeSession = (user as { loginMethod?: string | null } | null)?.loginMethod === "employee";');
    expect(layout).toContain('const canAskLeadership = Boolean(teamsStatus.data?.enabled) && isEmployeeSession && permissions.includes("teams.view_own");');
    expect(layout).toContain("trpc.employeePortal.team.myTeams.useQuery(undefined, { enabled: canAskLeadership,");
  });
  it("الشرط الثلاثي: الصلاحية + العلم + قيادة فعّالة، وبلا الصلاحية لا طلب", () => {
    expect(dash).toContain('const canViewOwnTeam = (portalPermissions ?? []).includes("teams.view_own");');
    expect(dash).toContain("trpc.employeePortal.team.myTeams.useQuery(undefined, { enabled: canViewOwnTeam,");
    expect(dash).toContain("const canOpenMyTeam = canViewOwnTeam && myTeams?.enabled === true && myTeams.teams.length > 0;");
  });
  it("الفعل غير مثبّت (يذهب إلى «المزيد» على الهاتف) ويفتح لوحة القائد بلا teamId في الرابط", () => {
    const line = dash.split("\n").find(l => l.includes('key: "team", label: "فريقي"'))!;
    expect(line).toContain("canOpenMyTeam ?");
    expect(line).not.toContain("pinned");
    expect(line).toContain('setLocation("/team-leader-dashboard")');
    expect(app).toContain('<Route path={"/team-leader-dashboard"} component={TeamLeaderDashboard} />');
  });
  it("زر التحديث يعيد قراءة القيادة أيضًا (السحب يظهر فورًا)", () => {
    expect(dash).toContain("utils.employeePortal.team.myTeams.invalidate();");
  });
  it("رابط «الفرق» للمالك: teams.view_all + flag teams", () => {
    expect(nav).toContain('{ label: "الفرق", path: "/teams", icon: UsersRound, permission: "teams.view_all", flag: "teams" }');
  });
});
