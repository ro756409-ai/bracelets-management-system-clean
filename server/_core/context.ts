import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import jwt from "jsonwebtoken";
import { getDb } from "../db";
import { employees } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

const EMP_JWT_SECRET = process.env.JWT_SECRET;
if (!EMP_JWT_SECRET) {
  console.error("[FATAL] JWT_SECRET environment variable is required for employee auth.");
}
const EMP_COOKIE = "employee_token";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  employeeManager?: boolean; // flag to indicate this is a manager employee session
  realEmployeeId?: number; // the actual employee ID when a manager employee is acting
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  // 1. Try normal OAuth authentication first
  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
  }

  // 2. If no OAuth user, check for employee manager token
  if (!user) {
    try {
      const token = opts.req.cookies?.[EMP_COOKIE];
      if (token && EMP_JWT_SECRET) {
        const payload = jwt.verify(token, EMP_JWT_SECRET) as any;
        if (payload?.employeeId) {
          const db = await getDb();
          if (db) {
            const [emp] = await db.select().from(employees).where(eq(employees.id, payload.employeeId)).limit(1);
            if (emp && emp.isActive && emp.role === 'manager') {
              // Create a synthetic admin user from the manager employee
              user = {
                id: -emp.id, // negative ID to distinguish from real users
                openId: `employee-manager-${emp.id}`,
                name: emp.name,
                email: emp.email,
                loginMethod: 'employee',
                role: 'admin',
                createdAt: emp.createdAt,
                updatedAt: emp.updatedAt,
                lastSignedIn: new Date(),
              };
              return {
                req: opts.req,
                res: opts.res,
                user,
                employeeManager: true,
                realEmployeeId: emp.id, // preserve real employee ID for audit trails
              };
            }
          }
        }
      }
    } catch (error) {
      // Employee token invalid, continue without user
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
