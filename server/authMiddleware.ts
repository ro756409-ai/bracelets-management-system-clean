/**
 * Express middleware to protect import/export routes.
 * Only allows the owner/admin (local /login session) or a manager employee
 * (employee_token session with role=manager).
 */
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getDb } from "./db";
import { employees } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { COOKIE_NAME } from "@shared/const";
import { isAdminTierRole } from "./permissions";

const JWT_SECRET = process.env.JWT_SECRET;
const EMP_COOKIE = "employee_token";

async function isActiveManagerSession(req: Request, cookieName: string): Promise<boolean> {
  if (!JWT_SECRET) return false;
  const token = req.cookies?.[cookieName];
  if (!token) return false;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    if (!payload?.employeeId) return false;
    const db = await getDb();
    if (!db) return false;
    const [emp] = await db.select().from(employees).where(eq(employees.id, payload.employeeId)).limit(1);
    return Boolean(emp && emp.isActive && isAdminTierRole(emp.role));
  } catch {
    return false;
  }
}

export async function requireAdminOrManager(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: "Server misconfigured: JWT_SECRET missing" });
  }

  // 1. Local owner/admin session (from /api/auth/login)
  if (await isActiveManagerSession(req, COOKIE_NAME)) {
    return next();
  }

  // 2. Employee manager token (from /api/employee/login)
  try {
    const token = req.cookies?.[EMP_COOKIE];
    if (!token) {
      return res.status(401).json({ error: "غير مصرح — يرجى تسجيل الدخول" });
    }

    const payload = jwt.verify(token, JWT_SECRET) as any;
    if (!payload?.employeeId) {
      return res.status(401).json({ error: "جلسة غير صالحة" });
    }

    const db = await getDb();
    if (!db) {
      return res.status(500).json({ error: "خطأ في قاعدة البيانات" });
    }

    const [emp] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, payload.employeeId))
      .limit(1);

    if (!emp || !emp.isActive) {
      return res.status(401).json({ error: "الحساب غير نشط أو غير موجود" });
    }

    if (!isAdminTierRole(emp.role)) {
      return res.status(403).json({ error: "هذا الإجراء متاح للمديرين فقط" });
    }

    return next();
  } catch {
    return res.status(401).json({ error: "غير مصرح — يرجى تسجيل الدخول" });
  }
}
