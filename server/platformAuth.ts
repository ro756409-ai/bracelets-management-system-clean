/**
 * Platform Admin authentication (Phase 3.2, hardened) — منفصل تمامًا عن مصادقة العملاء.
 *
 * عزل كامل:
 *   • كوكي مستقلة `platform_admin_session` بمسار `/api/platform` — المتصفّح **مايبعتهاش** لأي
 *     مسار عميل، والعكس: مسارات العميل بتقرا كوكيزها الخاصة بس (مش دي).
 *   • توقيع الجلسة بسر مستقل `PLATFORM_SESSION_SECRET` + HS256 + issuer/audience/sessionType
 *     مثبّتين ومُتحقَّق منهم — توكن الموظف/المالك مستحيل يتحقّق هنا، وبالعكس.
 *   • لا يعتمد على tenantId/businessId؛ isActive بيتفحص كل request.
 *   • fail-closed: سر ناقص/ضعيف → المسارات 503 والحارس يرفض الكل.
 *
 * أمان: مفيش secret افتراضي؛ مفيش password/token/cookie في اللوجز/الـaudit؛ الـMFA مُجهَّز
 * (mfaSecret nullable، مايتخزنش plaintext) بس **مش منفّذ** هنا. القرار الأمني بيعتمد **فقط**
 * على تحقّق الجلسة/الأدمن — فشل الـaudit مايعتبرش auth ناجح ولا يمنعه.
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
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 ساعات
const SESSION_EXPIRES_IN = "8h";
const JWT_ALG = "HS256" as const;
export const PLATFORM_ISSUER = "matjarak-platform";
export const PLATFORM_AUDIENCE = "matjarak-platform-admin";
export const PLATFORM_SESSION_TYPE = "platform_admin";

// حدود الإدخال
const USERNAME_MIN = 3;
const USERNAME_MAX = 50;
const PASSWORD_MIN_BYTES = 12;
const PASSWORD_MAX_BYTES = 72; // bcrypt بيقصّ بعد 72 بايت

// ── تحقّق السر مرة واحدة: مستقل، موجود، ≥32، ومختلف عن JWT_SECRET ──
const PLATFORM_SESSION_SECRET = process.env.PLATFORM_SESSION_SECRET;
export function platformAuthConfigError(): string | null {
  if (!PLATFORM_SESSION_SECRET) return "missing";
  if (PLATFORM_SESSION_SECRET.length < 32) return "weak";
  if (PLATFORM_SESSION_SECRET === process.env.JWT_SECRET) return "not_independent";
  return null;
}
const ENABLED = platformAuthConfigError() === null;
if (!ENABLED) {
  // رسالة عامة فقط — بلا سبب أو قيمة. يعطّل platform auth فقط (tenant system مايتأثرش).
  console.error("[platform-auth] disabled: session secret is not configured correctly");
}

/**
 * IP المصدر لمفتاح rate-limit والتدقيق. **ملاحظة**: خلف بروكسي Coolify ده غالبًا IP البروكسي
 * مش العميل الحقيقي — مانثقش في X-Forwarded-For (قابل للتزوير) ومابنغيّرش trust proxy العام
 * دلوقتي. (دين لاحق: إعداد trusted proxy/CIDR خاص بـCoolify لاستخراج client IP بأمان.)
 */
export function clientIp(req: Request): string {
  return req.socket?.remoteAddress ?? "unknown";
}

// ── Rate limiting in-memory (نسخة واحدة فقط؛ per-process، يتصفّر مع restart) ──
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_ENTRIES = 10_000;
const attempts = new Map<string, { count: number; resetAt: number }>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;
function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, rec] of attempts) if (now > rec.resetAt) attempts.delete(k);
  }, WINDOW_MS);
  // ماtمنعش Node من الإغلاق.
  sweepTimer.unref?.();
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
  if (rec && now <= rec.resetAt) {
    rec.count += 1;
    return;
  }
  // إدخال جديد — طبّق السقف والإخلاء لو محتاج (المفتاح مش موجود حاليًا).
  if (!attempts.has(key) && attempts.size >= MAX_ENTRIES) {
    let evicted = false;
    for (const [k, r] of attempts) {
      if (now > r.resetAt) { attempts.delete(k); evicted = true; break; }
    }
    if (!evicted) {
      const oldest = attempts.keys().next().value; // Map بيحافظ على ترتيب الإدخال
      if (oldest !== undefined) attempts.delete(oldest);
    }
  }
  attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  ensureSweep();
}
export function clearFailures(key: string): void {
  attempts.delete(key);
}
export function rateLimitSize(): number {
  return attempts.size;
}
export const RATE_LIMIT_MAX_FAILURES = MAX_FAILURES;
export const RATE_LIMIT_MAX_ENTRIES = MAX_ENTRIES;

/** تحقّق شكل بيانات الدخول: نوع نصّي فقط + الحدود. مايحوّلش object/array/number بـString(). */
export function parseCredentials(body: any):
  | { ok: true; username: string; password: string }
  | { ok: false } {
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
    return { ok: false };
  }
  const username = body.username.trim().toLowerCase();
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) return { ok: false };
  const bytes = Buffer.byteLength(body.password, "utf8");
  if (bytes < PASSWORD_MIN_BYTES || bytes > PASSWORD_MAX_BYTES) return { ok: false };
  return { ok: true, username, password: body.password };
}

// ── حماية Origin للطلبات الحسّاسة (login/logout) ──
function allowedOrigins(): Set<string> {
  return new Set(
    (process.env.PLATFORM_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map(o => o.trim())
      .filter(Boolean)
  );
}
/** مقارنة exact origin بعد parsing آمن. لا Host وحده، لا startsWith/includes. */
export function isOriginAllowed(req: Request): boolean {
  const isProd = process.env.NODE_ENV === "production";
  const allow = allowedOrigins();
  // في dev/test: لو مفيش قائمة مضبوطة نسمح؛ لو مضبوطة نفرضها.
  if (!isProd && allow.size === 0) return true;
  const origin = req.headers.origin;
  if (!origin || typeof origin !== "string") return false; // production: Origin مفقود = رفض
  let parsed: string;
  try {
    parsed = new URL(origin).origin;
  } catch {
    return false;
  }
  return allow.has(parsed);
}

function platformCookieOptions(req: Request) {
  return {
    httpOnly: true as const,
    // production: Secure إجباري بلا اعتماد على X-Forwarded-Proto؛ dev: حسب الطلب.
    secure: process.env.NODE_ENV === "production" ? true : isSecureRequest(req),
    sameSite: "strict" as const,
    path: COOKIE_PATH,
  };
}

export interface PlatformRequest extends Request {
  platformAdmin?: { id: number; username: string };
}

function signSession(adminId: number): string {
  return jwt.sign(
    { platformAdminId: adminId, sessionType: PLATFORM_SESSION_TYPE },
    PLATFORM_SESSION_SECRET as string,
    { algorithm: JWT_ALG, issuer: PLATFORM_ISSUER, audience: PLATFORM_AUDIENCE, expiresIn: SESSION_EXPIRES_IN }
  );
}

function verifySession(token: string): { platformAdminId: number } | null {
  try {
    const payload: any = jwt.verify(token, PLATFORM_SESSION_SECRET as string, {
      algorithms: [JWT_ALG],
      issuer: PLATFORM_ISSUER,
      audience: PLATFORM_AUDIENCE,
    });
    if (payload?.sessionType !== PLATFORM_SESSION_TYPE) return null;
    const id = Number(payload?.platformAdminId);
    if (!id) return null;
    return { platformAdminId: id };
  } catch {
    return null;
  }
}

/**
 * حارس مسارات المنصة — بيتحقّق كل request: توكن الكوكي المستقلة → verify (alg+iss+aud+type)
 * → جلب الأدمن → isActive. أي فشل = رفض موحّد 401. لا يعتمد على tenantId/businessId، ولا
 * يقبل Authorization header (كوكي فقط).
 */
export async function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  if (!ENABLED) return res.status(503).json({ error: "مصادقة المنصة غير مفعّلة" });
  const token = req.cookies?.[PLATFORM_COOKIE];
  if (!token) return res.status(401).json({ error: "غير مصرح" });
  const session = verifySession(token);
  if (!session) return res.status(401).json({ error: "غير مصرح" });
  const admin = await getPlatformAdminById(session.platformAdminId);
  if (!admin || !admin.isActive) return res.status(401).json({ error: "غير مصرح" });
  (req as PlatformRequest).platformAdmin = { id: admin.id, username: admin.username };
  return next();
}

export function registerPlatformAuthRoutes(app: Express) {
  const router = Router();

  if (!ENABLED) {
    router.all("/auth/*", (_req, res) => res.status(503).json({ error: "مصادقة المنصة غير مفعّلة" }));
    app.use("/api/platform", router);
    return;
  }

  // POST /api/platform/auth/login
  router.post("/auth/login", async (req, res) => {
    // Content-Type: application/json فقط.
    if (!req.is("application/json")) {
      return res.status(415).json({ success: false, error: "نوع المحتوى غير مدعوم" });
    }
    // Origin (production أو لو مضبوط في dev).
    if (!isOriginAllowed(req)) {
      return res.status(403).json({ success: false, error: "مصدر غير مسموح" });
    }
    // شكل الإدخال (نوع نصّي + حدود) — رسالة عامة، ماتكشفش وجود المستخدم.
    const parsed = parseCredentials(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ success: false, error: "بيانات غير صالحة" });
    }
    const { username, password } = parsed;
    const ip = clientIp(req);
    const key = `${ip}::${username}`;
    const genericFail = () => res.status(401).json({ success: false, error: "بيانات الدخول غير صحيحة" });

    if (isRateLimited(key)) {
      await addPlatformAuditLog({ action: "login_rate_limited", details: JSON.stringify({ username }), ipAddress: ip });
      return res.status(429).json({ success: false, error: "محاولات كثيرة، حاول لاحقًا" });
    }

    const admin = await getPlatformAdminByUsername(username);
    const ok = admin && admin.isActive && admin.passwordHash
      ? await bcrypt.compare(password, admin.passwordHash)
      : false;
    // compare وهمي لو الأدمن مش موجود — تقليل timing oracle.
    if (!admin) await bcrypt.compare(password, "$2a$12$0000000000000000000000000000000000000000000000000000a");

    if (!ok || !admin) {
      recordFailure(key);
      await addPlatformAuditLog({
        platformAdminId: admin?.id ?? null,
        action: "login_failed",
        details: JSON.stringify({ username }), // بنية محددة، بلا password/token
        ipAddress: ip,
      });
      return genericFail();
    }

    clearFailures(key);
    const token = signSession(admin.id);
    res.cookie(PLATFORM_COOKIE, token, { ...platformCookieOptions(req), maxAge: SESSION_MAX_AGE_MS });
    touchPlatformAdminLogin(admin.id).catch(() => {});
    await addPlatformAuditLog({ platformAdminId: admin.id, action: "login", ipAddress: ip });
    return res.json({ success: true, admin: { id: admin.id, username: admin.username } });
  });

  // POST /api/platform/auth/logout
  router.post("/auth/logout", async (req, res) => {
    if (!isOriginAllowed(req)) {
      return res.status(403).json({ success: false, error: "مصدر غير مسموح" });
    }
    const token = req.cookies?.[PLATFORM_COOKIE];
    if (token) {
      const session = verifySession(token);
      if (session) {
        await addPlatformAuditLog({ platformAdminId: session.platformAdminId, action: "logout", ipAddress: clientIp(req) });
      }
    }
    res.clearCookie(PLATFORM_COOKIE, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production" ? true : isSecureRequest(req),
      sameSite: "strict",
      path: COOKIE_PATH,
    });
    return res.json({ success: true });
  });

  // GET /api/platform/auth/me — محمي بالجلسة (+ SameSite)؛ مايحتاجش Origin/Content-Type.
  router.get("/auth/me", requirePlatformAdmin, (req, res) => {
    const admin = (req as PlatformRequest).platformAdmin!;
    return res.json({ admin: { id: admin.id, username: admin.username } });
  });

  app.use("/api/platform", router);
}
