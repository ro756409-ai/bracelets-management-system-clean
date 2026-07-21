/**
 * Express middleware to protect import/export routes.
 * Only allows admin (OAuth owner) or manager (employee with role=manager).
 */
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { getDb } from "./db";
import { employees } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { sdk } from "./_core/sdk";

const JWT_SECRET = process.env.JWT_SECRET;
const EMP_COOKIE = "employee_token";

export async function requireAdminOrManager(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // 1. Try OAuth (admin/owner)
  try {
    const user = await sdk.authenticateRequest(req);
    if (user && user.role === "admin") {
      return next();
    }
  } catch {
    // Not OAuth authenticated, continue to check employee token
  }

  // 2. Try employee manager token
  try {
    if (!JWT_SECRET) {
      return res.status(500).json({ error: "Server misconfigured: JWT_SECRET missing" });
    }
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

    if (emp.role !== "manager") {
      return res.status(403).json({ error: "هذا الإجراء متاح للمديرين فقط" });
    }

    return next();
  } catch {
    return res.status(401).json({ error: "غير مصرح — يرجى تسجيل الدخول" });
  }
}
