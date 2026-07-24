import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { Employee, User } from "../../drizzle/schema";
import jwt from "jsonwebtoken";
import { getDb } from "../db";
import { employees } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { COOKIE_NAME } from "@shared/const";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("[FATAL] JWT_SECRET environment variable is required for authentication.");
}
const EMP_COOKIE = "employee_token";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  employeeManager?: boolean; // flag to indicate this is a manager employee session (not the true owner login)
  realEmployeeId?: number; // the actual employee ID when a manager employee is acting
};

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
  if (emp && emp.isActive && emp.role === "manager") return emp;
  return null;
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
          return {
            req: opts.req,
            res: opts.res,
            user: buildSyntheticAdminUser(emp),
            realEmployeeId: emp.id,
          };
        }
      }
    }
  } catch (error) {
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
          return {
            req: opts.req,
            res: opts.res,
            user: buildSyntheticAdminUser(emp),
            employeeManager: true,
            realEmployeeId: emp.id,
          };
        }
      }
    }
  } catch (error) {
    // Employee token invalid, continue without user
  }

  return {
    req: opts.req,
    res: opts.res,
    user: null,
  };
}
