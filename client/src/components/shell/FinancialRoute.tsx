import type { ReactNode } from "react";
import { Redirect } from "wouter";
import type { LucideIcon } from "lucide-react";
import Home from "@/pages/Home";
import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePermissions } from "@/hooks/usePermission";
import { EmployeeShell } from "./EmployeeShell";

/** أنسب صفحة هبوط لجلسة حسب صلاحياتها — بيتستخدم لما نطرد حد من صفحة مالوش حق فيها. */
export function homeForPermissions(perms: string[], hasUser = false): string {
  // جلسة إدارية (user موجود) → لوحة التحكم. غير ذلك (المحاسب: موظف غير إداري، لوحة التحكم تطلب
  // جلسة مالك فتعرض له «سجّل الدخول»): دفتر V3 لو ممنوح `ledger.view`، وإلا — النظام المحاسبي
  // القديم مجمّد — صفحة «قيد التطوير» الآمنة. المالك admin بيعدّي الحُرّاس فمابيوصلش هنا.
  if (hasUser && perms.includes("dashboard.view")) return "/dashboard";
  if (perms.includes("ledger.view")) return "/ledger";
  if (perms.includes("accounting.view")) return "/accounting-disabled";
  return "/employee-dashboard";
}

/**
 * صفحة مالية/تشغيلية مقيّدة بصلاحية: بتفتح للمالك، أو لأي موظف **عنده الصلاحية دي فعليًا**.
 *
 * مش زي `ProtectedLayout` اللي بيشترط جلسة مالك — عشان الموظف غير الإداري (`auth.me` بيرجّعله null)
 * يقدر يفتح الصفحة. القايمة بتتقري من `usePermissions` (نفس مصدر السيرفر)، والبيانات نفسها جاية
 * من `permissionProcedure`/`authenticatedProcedure` اللي بيصرّح له. ده توجيه واجهة فوق الحارس
 * الحقيقي على الـendpoints — مش بديل عنه.
 *
 * المرحلة 7C (تشخيص /goods-receipt و/stocktake): قبل كده الصفحة غير الـ`bare` كانت تتغلّف دائمًا
 * بـ`DashboardLayout`، وهو بيرسم «يرجى تسجيل الدخول» لأي جلسة `user` = null — فموظف المخزن الممنوح
 * `inventory_costing.view` كان يعدّي الحارس ثم يقف عند شاشة الدخول. الآن: جلسة مالك → DashboardLayout
 * كما هي؛ جلسة موظف مصرَّح له → `EmployeeShell` خفيفة. لا صلاحية جديدة ولا تغيير backend.
 */
export function FinancialRoute({
  permission,
  children,
  bare = false,
  employeeTitle = "متجرك",
  employeeIcon,
}: {
  permission: string;
  children: ReactNode;
  /** `bare`: الصفحة بترندر layout بتاعها بنفسها (مساحة المحاسب) — من غير DashboardLayout. */
  bare?: boolean;
  /** عنوان قشرة الموظف (لما تكون الجلسة موظفًا غير إداري مصرَّحًا له). */
  employeeTitle?: string;
  employeeIcon?: LucideIcon;
}) {
  const { user, loading } = useAuth();
  const { permissions, isLoading } = usePermissions();
  if (loading || isLoading) return null;
  const authed = Boolean(user) || permissions.length > 0;
  if (!authed) return <Home />;
  const allowed = user?.role === "admin" || permissions.includes(permission);
  if (!allowed) return <Redirect to={homeForPermissions(permissions, Boolean(user))} />;
  if (bare) return <>{children}</>;
  if (user) return <DashboardLayout>{children}</DashboardLayout>;
  return <EmployeeShell title={employeeTitle} icon={employeeIcon}>{children}</EmployeeShell>;
}
