/**
 * Local owner/admin authentication (replaces Manus OAuth for the admin dashboard).
 * Reuses the existing `employees` table: an active employee with role='manager'
 * logging in here is treated as the platform owner/admin — same mechanism the
 * app already used for "manager employee acting as admin", just as the primary
 * login path instead of a fallback.
 */
import { Router, type Express } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getEmployeeByUsernameOrEmail, updateEmployee } from "./db";
import { COOKIE_NAME } from "../shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { isAdminTierRole } from "./permissions";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("[FATAL] JWT_SECRET environment variable is required. Server cannot start without it.");
}

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type OwnerLoginResult =
  | {
      status: 200;
      body: {
        success: true;
        user: { id: number; name: string; username: string | null; email: string | null; role: string };
      };
      token: string;
    }
  | { status: 400 | 401 | 403 | 500; body: { success: false; error: string } };

/** Pure credential-verification logic, kept separate from Express so it's directly unit-testable. */
export async function verifyOwnerLogin(identifier: string, password: string): Promise<OwnerLoginResult> {
  if (!identifier || !password) {
    return { status: 400, body: { success: false, error: "يرجى إدخال اسم المستخدم أو البريد وكلمة المرور" } };
  }

  const employee = await getEmployeeByUsernameOrEmail(identifier.trim());
  if (!employee) {
    return { status: 401, body: { success: false, error: "بيانات الدخول غير صحيحة" } };
  }
  if (!employee.isActive) {
    return { status: 403, body: { success: false, error: "هذا الحساب موقوف، تواصل مع الإدارة" } };
  }
  if (!isAdminTierRole(employee.role)) {
    return { status: 403, body: { success: false, error: "هذا الحساب لا يملك صلاحية الدخول للوحة الإدارة" } };
  }
  if (!employee.passwordHash) {
    return { status: 401, body: { success: false, error: "لم يتم تعيين كلمة مرور لهذا الحساب بعد" } };
  }

  const isValid = await bcrypt.compare(password, employee.passwordHash);
  if (!isValid) {
    return { status: 401, body: { success: false, error: "بيانات الدخول غير صحيحة" } };
  }

  if (!JWT_SECRET) {
    return { status: 500, body: { success: false, error: "خطأ في إعدادات الخادم" } };
  }

  const token = jwt.sign({ employeeId: employee.id, role: employee.role }, JWT_SECRET, { expiresIn: "7d" });
  updateEmployee(employee.id, { lastLoginAt: new Date() }).catch(() => {
    // Non-fatal: login already succeeded, don't block it on a stats-only write.
  });

  return {
    status: 200,
    body: {
      success: true,
      user: {
        id: employee.id,
        name: employee.name,
        username: employee.username,
        email: employee.email,
        role: employee.role,
      },
    },
    token,
  };
}

export function registerLocalAuthRoutes(app: Express) {
  const router = Router();

  // POST /api/auth/login — owner/admin login for the main platform (/login page)
  router.post("/login", async (req, res) => {
    try {
      const { username, password } = req.body ?? {};
      const result = await verifyOwnerLogin(String(username ?? ""), String(password ?? ""));

      if (result.status === 200) {
        const cookieOptions = getSessionCookieOptions(req);
        res.cookie(COOKIE_NAME, result.token, { ...cookieOptions, maxAge: SESSION_MAX_AGE_MS });
      }

      return res.status(result.status).json(result.body);
    } catch (err) {
      console.error("[auth/login]", err);
      return res.status(500).json({ success: false, error: "خطأ في الخادم" });
    }
  });

  app.use("/api/auth", router);
}
