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

/**
 * هوية الجلسة المُتحقّقة، بتتعلّق على `req` عشان مسارات الاستيراد/التصدير تعرف الـtenant
 * من نفس مصدر الحقيقة اللي `createContext` بيستخدمه — من غير ما تثق في أي قيمة من العميل.
 * `tenantId` ممكن يكون null للمالك على مستوى المنصة (بيشوف كل الأنشطة)، زي طبقة العزل.
 */
export type RequestAuthInfo = {
  employeeId: number;
  tenantId: number | null;
  role: string;
};

/** بترجّع صف الموظف المدير النشط من كوكي معيّن، أو null. */
async function resolveActiveManager(req: Request, cookieName: string) {
  if (!JWT_SECRET) return null;
  const token = req.cookies?.[cookieName];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    if (!payload?.employeeId) return null;
    const db = await getDb();
    if (!db) return null;
    const [emp] = await db.select().from(employees).where(eq(employees.id, payload.employeeId)).limit(1);
    return emp && emp.isActive && isAdminTierRole(emp.role) ? emp : null;
  } catch {
    return null;
  }
}

/** بتعلّق الهوية على `req` عشان المسار يستخدم الـtenant من غير ما يعيد التحقّق. */
function attachAuth(req: Request, emp: { id: number; tenantId: number | null; role: string }) {
  (req as RequestWithAuth).authInfo = {
    employeeId: emp.id,
    tenantId: emp.tenantId,
    role: emp.role,
  };
}

export interface RequestWithAuth extends Request {
  authInfo?: RequestAuthInfo;
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
  const owner = await resolveActiveManager(req, COOKIE_NAME);
  if (owner) {
    attachAuth(req, owner);
    return next();
  }

  // 2. Employee manager token (from /api/employee/login)
  const emp = await resolveActiveManager(req, EMP_COOKIE);
  if (!emp) {
    // نفرّق بين "مفيش جلسة" و"جلسة موظف مش مدير" عشان الرسالة تبقى مفيدة.
    if (!req.cookies?.[EMP_COOKIE] && !req.cookies?.[COOKIE_NAME]) {
      return res.status(401).json({ error: "غير مصرح — يرجى تسجيل الدخول" });
    }
    return res.status(403).json({ error: "هذا الإجراء متاح للمديرين فقط" });
  }
  attachAuth(req, emp);
  return next();
}
