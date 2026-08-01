import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { Employee, User } from "../../drizzle/schema";
import jwt from "jsonwebtoken";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { employees } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { COOKIE_NAME } from "@shared/const";
import { isAdminTierRole } from "../permissions";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("[FATAL] JWT_SECRET environment variable is required for authentication.");
}
const EMP_COOKIE = "employee_token";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  employee: Employee | null;
  employeeManager?: boolean; // flag to indicate this is a manager employee session (not the true owner login)
  realEmployeeId?: number; // the actual employee ID when a manager employee is acting
  // The tenant (merchant account) this session belongs to — every business-scoped query must be
  // clamped to this tenant's businesses, never trust a client-supplied businessId alone. `null`
  // only for a genuinely anonymous request (no session at all — protectedProcedure already
  // rejects those via `ctx.user`). There is NO fallback to tenant #1 or any other tenant: an
  // authenticated session whose employee record has no resolvable tenantId is rejected outright
  // in createContext() below, never silently treated as belonging to some default tenant.
  tenantId: number | null;
};

/** Thrown when an authenticated employee has no resolvable tenant membership yet (e.g. the
 *  employees.tenantId backfill migration hasn't run against this row). Never silently defaulted. */
function rejectUnresolvedTenant(): never {
  throw new TRPCError({
    code: "UNAUTHORIZED",
    message: "لا يوجد حساب تاجر مرتبط بهذا المستخدم — يرجى مراجعة الدعم الفني",
  });
}

/** A manager-role employee is treated as a full admin user throughout the app. */
function buildSyntheticAdminUser(emp: Employee): User {
  return {
    id: -emp.id, // negative ID to distinguish from real `users` rows
    openId: `employee-manager-${emp.id}`,
    name: emp.name,
    email: emp.email,
    loginMethod: "employee",
    role: "admin",
    createdAt: emp.createdAt,
    updatedAt: emp.updatedAt,
    lastSignedIn: new Date(),
  };
}

async function findActiveManagerById(employeeId: number): Promise<Employee | null> {
  const db = await getDb();
  if (!db) return null;
  const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
  if (emp && emp.isActive && isAdminTierRole(emp.role)) return emp;
  return null;
}

async function findActiveEmployeeById(employeeId: number): Promise<Employee | null> {
  const db = await getDb();
  if (!db) return null;
  const [emp] = await db.select().from(employees).where(eq(employees.id, employeeId)).limit(1);
  return emp?.isActive ? emp : null;
}

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  // 1. Local owner/admin session, issued by POST /api/auth/login (/login page).
  // This is the true owner login — no `employeeManager` flag, so owner-only
  // actions (e.g. deleting orders) remain available.
  try {
    const token = opts.req.cookies?.[COOKIE_NAME];
    if (token && JWT_SECRET) {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      if (payload?.employeeId) {
        const emp = await findActiveManagerById(payload.employeeId);
        if (emp) {
          if (emp.tenantId == null) rejectUnresolvedTenant();
          return {
            req: opts.req,
            res: opts.res,
            user: buildSyntheticAdminUser(emp),
            employee: emp,
            realEmployeeId: emp.id,
            tenantId: emp.tenantId,
          };
        }
      }
    }
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    // Invalid/expired session; fall through to the employee-token check.
  }

  // 2. Manager employee acting via the employee-portal token (logged in through
  // /employee-login rather than /login). Kept for backward compatibility and
  // because a manager may legitimately use either login page.
  try {
    const token = opts.req.cookies?.[EMP_COOKIE];
    if (token && JWT_SECRET) {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      if (payload?.employeeId) {
        const emp = await findActiveManagerById(payload.employeeId);
        if (emp) {
          if (emp.tenantId == null) rejectUnresolvedTenant();
          return {
            req: opts.req,
            res: opts.res,
            user: buildSyntheticAdminUser(emp),
            employee: emp,
            employeeManager: true,
            realEmployeeId: emp.id,
            tenantId: emp.tenantId,
          };
        }
      }
    }
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    // Employee token invalid, continue without user
  }


  // 3. Non-admin employee session. It has a tenant and a real employee identity, but no
  // synthetic admin user. Permission-aware procedures can authorize it explicitly.
  try {
    const token = opts.req.cookies?.[EMP_COOKIE];
    if (token && JWT_SECRET) {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      if (payload?.employeeId) {
        const emp = await findActiveEmployeeById(payload.employeeId);
        if (emp) {
          if (emp.tenantId == null) rejectUnresolvedTenant();
          return {
            req: opts.req,
            res: opts.res,
            user: null,
            employee: emp,
            tenantId: emp.tenantId,
          };
        }
      }
    }
  } catch (error) {
    if (error instanceof TRPCError) throw error;
  }

  return {
    req: opts.req,
    res: opts.res,
    tenantId: null,
    user: null,
    employee: null,
  };
}
