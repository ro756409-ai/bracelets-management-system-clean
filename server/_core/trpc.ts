import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { resolveTenantAccess, tenantAccessEnforcementEnabled, tenantAccessError } from "../tenantAccess";
import { trpcCallAllowed } from "@shared/tenantAccess";
import { hasTenantPermission, isFinancialPermission, isFrozenAccountingWrite, ACCOUNTING_FROZEN_MESSAGE, MANAGER_GRANT_ONLY_PERMISSIONS, type Permission } from "../permissions";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;

/**
 * إنفاذ حالة الشركة على **كل** إجراء tRPC (query/mutation) — الأساس لكل العائلات (public/protected/
 * authenticated/permission/admin)، فلا إجراء يفلت. خلف TENANT_ACCESS_ENFORCEMENT_ENABLED (معطل = لا شيء ولا
 * قراءة). tenant الجلسة من createContext؛ البوابة تُفحص مرة أخرى بهوية كوكي الموظف (employeePortalProcedure).
 */
const tenantAccessGuard = t.middleware(async ({ ctx, type, path, next }) => {
  if (!tenantAccessEnforcementEnabled() || ctx.tenantId == null) return next();
  await assertTrpcTenantAccess(ctx.tenantId, type, path);
  return next();
});

export async function assertTrpcTenantAccess(tenantId: number, type: "query" | "mutation" | "subscription", path: string): Promise<void> {
  if (!tenantAccessEnforcementEnabled()) return;
  const access = await resolveTenantAccess(tenantId);
  if (!trpcCallAllowed(access, type, path))
    throw new TRPCError({ code: "FORBIDDEN", message: tenantAccessError(access).message });
}

export const publicProcedure = t.procedure.use(tenantAccessGuard);

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  // ctx.user is only ever set once createContext() has already resolved a real tenant (or
  // rejected the request) — this should be unreachable, but never trust an implicit fallback.
  if (ctx.tenantId == null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
      tenantId: ctx.tenantId,
    },
  });
});

export const protectedProcedure = publicProcedure.use(requireUser);

const requireAuthenticatedIdentity = t.middleware(async ({ ctx, next }) => {
  if ((!ctx.user && !ctx.employee) || ctx.tenantId == null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({ ctx: { ...ctx, tenantId: ctx.tenantId } });
});

export const authenticatedProcedure = publicProcedure.use(requireAuthenticatedIdentity);

export function permissionProcedure(permission: Permission) {
  return authenticatedProcedure.use(async ({ ctx, next }) => {
    // تجميد النظام المحاسبي الحالي: أي عملية كتابة محاسبية متوقّفة لكل المستخدمين (بما فيهم
    // المالك) لحد ما يتبني النظام الجديد. قبل أي فحص صلاحية — عشان الرسالة تكون واضحة
    // وموحّدة. القراءات والمخزون والشحن التشغيلي والأوردرات مش متأثرة (مش في المجموعة).
    if (isFrozenAccountingWrite(permission)) {
      throw new TRPCError({ code: "FORBIDDEN", message: ACCOUNTING_FROZEN_MESSAGE });
    }
    // المدير تشغيلي بحت: بياخد جلسة admin صناعية عشان تشغيله يفضل شغّال، لكن **ممنوع**
    // من أي بوابة مالية صراحةً هنا — بغضّ النظر عن خريطة الصلاحيات أو الـsynthetic-admin.
    // المالك الحقيقي (super_admin/admin) والمحاسب بس بيعدّوا على المالي.
    if (ctx.employee?.role === "manager" && isFinancialPermission(permission)) {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    // صلاحيات «بالمنح فقط» للمدير (قرار المالك: مقارنة/تصدير الأداء): جلسة الـadmin الصناعية لا تكفي —
    // لازم منح صريح للدور manager في هذه الشركة (tenant_role_permissions). لا تأثير على أي صلاحية أخرى.
    if (ctx.employee?.role === "manager" && MANAGER_GRANT_ONLY_PERMISSIONS.includes(permission)) {
      if (!(await hasTenantPermission(ctx.tenantId, "manager", permission)))
        throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
      return next({ ctx });
    }
    const ownerOrAdmin = ctx.user?.role === "admin";
    if (!ownerOrAdmin && !await hasTenantPermission(ctx.tenantId, ctx.employee?.role, permission)) {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }
    return next({ ctx });
  });
}

// Built on protectedProcedure (not a fresh t.procedure) so it inherits the same tenantId
// narrowing requireUser already does — one place asserts "authenticated ⇒ real tenant",
// instead of duplicating that check in every procedure family separately.
export const adminProcedure = protectedProcedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({ ctx });
  }),
);
