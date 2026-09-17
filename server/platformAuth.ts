/**
 * Platform Admin authentication (Phase 3.2) — منفصل تمامًا عن مصادقة العملاء.
 *
 * عزل كامل:
 *   • كوكي مستقلة `platform_admin_session` بمسار `/api/platform` — المتصفّح **مايبعتهاش** لأي
 *     tenant API إطلاقًا، والعكس: مسارات التينانت بتقرا كوكيز العميل الخاصة بيها بس (مش دي).
 *   • توقيع الجلسة بـ`PLATFORM_SESSION_SECRET` (سر مستقل) — توكن الموظف/المالك (JWT_SECRET)
 *     مستحيل يتحقّق هنا، وبالعكس.
 *   • لا يعتمد على tenantId/businessId؛ isActive بيتفحص كل request.
 *   • fail-closed: أي سر ناقص/ضعيف → المسارات ترجع 503 والحارس يرفض الكل.
 *
 * ملاحظات أمان: مفيش secret افتراضي في الكود؛ مفيش password/token/cookie في اللوجز؛
 * الـMFA مُجهَّز (mfaSecret nullable، مايتخزنش plaintext) بس **مش منفّذ** في المرحلة دي.
 */
import { Router, type Express, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  getPlatformAdminByUsername,
  getPlatformAdminById,
  touchPlatformAdminLogin,
  addPlatformAuditLog,
} from "./db";
import { isSecureRequest } from "./_core/cookies";

export const PLATFORM_COOKIE = "platform_admin_session";
const COOKIE_PATH = "/api/platform";
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 ساعات — جلسة محدودة
const SESSION_EXPIRES_IN = "8h";

// ── تحقّق السر مرة واحدة عند التحميل: مستقل، موجود، وقوي (≥ 32 حرف)، ومختلف عن JWT_SECRET ──
const PLATFORM_SESSION_SECRET = process.env.PLATFORM_SESSION_SECRET;
export function platformAuthConfigError(): string | null {
  if (!PLATFORM_SESSION_SECRET) return "PLATFORM_SESSION_SECRET غير مضبوط";
  if (PLATFORM_SESSION_SECRET.length < 32) return "PLATFORM_SESSION_SECRET أقصر من 32 حرفًا (ضعيف)";
  if (PLATFORM_SESSION_SECRET === process.env.JWT_SECRET)
    return "PLATFORM_SESSION_SECRET لازم يكون مختلفًا عن JWT_SECRET";
  return null;
}
const CONFIG_ERROR = platformAuthConfigError();
const ENABLED = CONFIG_ERROR === null;
if (!ENABLED) {
  // مايكسرش تطبيق العميل — بس بيعطّل platform auth ويوضّح السبب (fail-closed).
  console.error(`[platform-auth] معطّل: ${CONFIG_ERROR}. مسارات /api/platform هترجع 503.`);
}

/** IP آمن: افتراضيًا عنوان السوكت المباشر (مانثقش في X-Forwarded-For إلا لو مفعّل صراحةً). */
export function clientIp(req: Request): string {
  if (process.env.PLATFORM_TRUST_PROXY === "true") {
    const xff = req.headers["x-forwarded-for"];
    const first = Array.isArray(xff) ? xff[0] : (xff ?? "").split(",")[0];
    if (first && first.trim()) return first.trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

// ── Rate limiting بسيط in-memory (بلا dependency جديدة؛ per-process — يتصفّر مع restart) ──
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const attempts = new Map<string, { count: number; resetAt: number }>();
function rateKey(req: Request, username: string): string {
  return `${clientIp(req)}::${username}`;
}
export function isRateLimited(key: string, now = Date.now()): boolean {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (now > rec.resetAt) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= MAX_FAILURES;
}
export function recordFailure(key: string, now = Date.now()): void {
  const rec = attempts.get(key);
  if (!rec || now > rec.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  rec.count += 1;
}
export function clearFailures(key: string): void {
  attempts.delete(key);
}
export const RATE_LIMIT_MAX_FAILURES = MAX_FAILURES;

function normalizeUsername(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

function platformCookieOptions(req: Request) {
  return {
    httpOnly: true as const,
    secure: isSecureRequest(req),
    sameSite: "strict" as const,
    path: COOKIE_PATH,
  };
}

export interface PlatformRequest extends Request {
  platformAdmin?: { id: number; username: string };
}

/**
 * حارس مسارات المنصة — بيتحقّق من الجلسة المستقلة كل request:
 *   توكن platform_admin_session → تحقّق بـPLATFORM_SESSION_SECRET → جلب الأدمن → isActive.
 * أي فشل = رفض موحّد 401. لا يعتمد على tenantId/businessId.
 */
export async function requirePlatformAdmin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!ENABLED) return res.status(503).json({ error: "مصادقة المنصة غير مفعّلة" });
  const token = req.cookies?.[PLATFORM_COOKIE];
  if (!token) return res.status(401).json({ error: "غير مصرح" });
  let payload: any;
  try {
    payload = jwt.verify(token, PLATFORM_SESSION_SECRET as string);
  } catch {
    return res.status(401).json({ error: "غير مصرح" });
  }
  const adminId = Number(payload?.platformAdminId);
  if (!adminId) return res.status(401).json({ error: "غير مصرح" });
  const admin = await getPlatformAdminById(adminId);
  if (!admin || !admin.isActive) return res.status(401).json({ error: "غير مصرح" });
  (req as PlatformRequest).platformAdmin = { id: admin.id, username: admin.username };
  return next();
}

export function registerPlatformAuthRoutes(app: Express) {
  const router = Router();

  // لو السر ناقص/ضعيف: كل المسارات fail-closed بـ503 (مفيش تسريب سبب للعميل).
  if (!ENABLED) {
    router.all("/auth/*", (_req, res) => res.status(503).json({ error: "مصادقة المنصة غير مفعّلة" }));
    app.use("/api/platform", router);
    return;
  }

  // POST /api/platform/auth/login
  router.post("/auth/login", async (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password ?? "");
    const key = rateKey(req, username);
    const ip = clientIp(req);

    // رسالة عامة موحّدة لكل فشل — ماتكشفش هل username موجود.
    const genericFail = () => res.status(401).json({ success: false, error: "بيانات الدخول غير صحيحة" });

    if (isRateLimited(key)) {
      await addPlatformAuditLog({ action: "login_rate_limited", details: `user=${username}`, ipAddress: ip });
      return res.status(429).json({ success: false, error: "محاولات كثيرة، حاول لاحقًا" });
    }
    if (!username || !password) {
      recordFailure(key);
      return genericFail();
    }

    const admin = await getPlatformAdminByUsername(username);
    const ok = admin && admin.isActive && admin.passwordHash
      ? await bcrypt.compare(password, admin.passwordHash)
      : false;
    // نعمل bcrypt.compare وهمي لو الأدمن مش موجود عشان نقلّل timing oracle.
    if (!admin) await bcrypt.compare(password, "$2a$12$0000000000000000000000000000000000000000000000000000a");

    if (!ok || !admin) {
      recordFailure(key);
      await addPlatformAuditLog({
        platformAdminId: admin?.id ?? null,
        action: "login_failed",
        details: `user=${username}`, // بلا password/token
        ipAddress: ip,
      });
      return genericFail();
    }

    clearFailures(key);
    const token = jwt.sign({ platformAdminId: admin.id }, PLATFORM_SESSION_SECRET as string, {
      expiresIn: SESSION_EXPIRES_IN,
    });
    res.cookie(PLATFORM_COOKIE, token, { ...platformCookieOptions(req), maxAge: SESSION_MAX_AGE_MS });
    touchPlatformAdminLogin(admin.id).catch(() => {});
    await addPlatformAuditLog({ platformAdminId: admin.id, action: "login", ipAddress: ip });
    // نرجّع الحقول العامة فقط (id + username) — لا أي أسرار.
    return res.json({ success: true, admin: { id: admin.id, username: admin.username } });
  });

  // POST /api/platform/auth/logout
  router.post("/auth/logout", async (req, res) => {
    const token = req.cookies?.[PLATFORM_COOKIE];
    if (token) {
      try {
        const payload: any = jwt.verify(token, PLATFORM_SESSION_SECRET as string);
        await addPlatformAuditLog({ platformAdminId: Number(payload?.platformAdminId) || null, action: "logout", ipAddress: clientIp(req) });
      } catch {
        // توكن تالف — نمسح الكوكي بس.
      }
    }
    res.clearCookie(PLATFORM_COOKIE, { path: COOKIE_PATH });
    return res.json({ success: true });
  });

  // GET /api/platform/auth/me
  router.get("/auth/me", requirePlatformAdmin, (req, res) => {
    const admin = (req as PlatformRequest).platformAdmin!;
    return res.json({ admin: { id: admin.id, username: admin.username } });
  });

  app.use("/api/platform", router);
}
