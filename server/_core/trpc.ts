import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { hasTenantPermission, isFinancialPermission, type Permission } from "../permissions";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

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

export const protectedProcedure = t.procedure.use(requireUser);

const requireAuthenticatedIdentity = t.middleware(async ({ ctx, next }) => {
  if ((!ctx.user && !ctx.employee) || ctx.tenantId == null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }
  return next({ ctx: { ...ctx, tenantId: ctx.tenantId } });
});

export const authenticatedProcedure = t.procedure.use(requireAuthenticatedIdentity);

export function permissionProcedure(permission: Permission) {
  return authenticatedProcedure.use(async ({ ctx, next }) => {
    // المدير تشغيلي بحت: بياخد جلسة admin صناعية عشان تشغيله يفضل شغّال، لكن **ممنوع**
    // من أي بوابة مالية صراحةً هنا — بغضّ النظر عن خريطة الصلاحيات أو الـsynthetic-admin.
    // المالك الحقيقي (super_admin/admin) والمحاسب بس بيعدّوا على المالي.
    if (ctx.employee?.role === "manager" && isFinancialPermission(permission)) {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
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
