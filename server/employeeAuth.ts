import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getDb } from "./db";
import { employees } from "../drizzle/schema";
import { eq } from "drizzle-orm";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("[FATAL] JWT_SECRET environment variable is required. Server cannot start without it.");
}
const COOKIE_NAME = "employee_token";

// POST /api/employee/login
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "يرجى إدخال اسم المستخدم وكلمة المرور" });
    }

    const db = await getDb();
    if (!db) return res.status(500).json({ error: "خطأ في الاتصال بقاعدة البيانات" });

    const [employee] = await db
      .select()
      .from(employees)
      .where(eq(employees.username, username.trim()))
      .limit(1);

    if (!employee) {
      return res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
    }

    if (!employee.isActive) {
      return res.status(403).json({ error: "هذا الحساب موقوف، تواصل مع المدير" });
    }

    if (!employee.passwordHash) {
      return res.status(401).json({ error: "لم يتم تعيين كلمة مرور لهذا الحساب بعد" });
    }

    const isValid = await bcrypt.compare(password, employee.passwordHash);
    if (!isValid) {
      return res.status(401).json({ error: "اسم المستخدم أو كلمة المرور غير صحيحة" });
    }

    // Create JWT token
    const token = jwt.sign(
      {
        employeeId: employee.id,
        name: employee.name,
        role: employee.role,
        username: employee.username,
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Set cookie
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return res.json({
      success: true,
      employee: {
        id: employee.id,
        name: employee.name,
        role: employee.role,
        username: employee.username,
      },
    });
  } catch (err) {
    console.error("[employee/login]", err);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// POST /api/employee/logout
router.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  return res.json({ success: true });
});

// GET /api/employee/me
router.get("/me", async (req, res) => {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: "غير مسجل الدخول" });

    const payload = jwt.verify(token, JWT_SECRET) as any;

    const db = await getDb();
    if (!db) return res.status(500).json({ error: "خطأ في قاعدة البيانات" });

    const [employee] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, payload.employeeId))
      .limit(1);

    if (!employee || !employee.isActive) {
      res.clearCookie(COOKIE_NAME);
      return res.status(401).json({ error: "الجلسة منتهية" });
    }

    return res.json({
      id: employee.id,
      name: employee.name,
      role: employee.role,
      username: employee.username,
    });
  } catch {
    res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ error: "الجلسة منتهية" });
  }
});

export default router;
