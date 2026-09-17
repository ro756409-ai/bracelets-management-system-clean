import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import bcrypt from "bcryptjs";
import {
  clientIp,
  isRateLimited,
  recordFailure,
  clearFailures,
  RATE_LIMIT_MAX_FAILURES,
  PLATFORM_COOKIE,
} from "./platformAuth";
import {
  createPlatformAdmin,
  getPlatformAdminByUsername,
  getPlatformAdminById,
  countPlatformAdmins,
  touchPlatformAdminLogin,
  addPlatformAuditLog,
  getDb,
} from "./db";
import { platformAdmins, platformAuditLogs } from "../drizzle/schema";
import { eq } from "drizzle-orm";

/**
 * Phase 3.2 — Platform Admin auth. عزل كامل عن مصادقة العملاء + fail-closed.
 * القسم الأول سلوكي/حراس نصّية؛ الأخير سلوكي فعلي على TEST_DATABASE_URL (matjarak_test).
 */

const src = fs.readFileSync("server/platformAuth.ts", "utf-8");
const ctx = fs.readFileSync("server/_core/context.ts", "utf-8");
const authMw = fs.readFileSync("server/authMiddleware.ts", "utf-8");
const bootstrap = fs.readFileSync("scripts/bootstrap-platform-admin.ts", "utf-8");
const indexTs = fs.readFileSync("server/_core/index.ts", "utf-8");

describe("🔑 عزل: كوكي/سر/مسار منفصل تمامًا عن العملاء", () => {
  it("🔑 كوكي مستقلة باسم platform_admin_session + path /api/platform", () => {
    expect(PLATFORM_COOKIE).toBe("platform_admin_session");
    expect(src).toContain('const COOKIE_PATH = "/api/platform"');
  });
  it("🔑 كوكي HttpOnly + SameSite=Strict + Secure حسب الطلب", () => {
    expect(src).toContain("httpOnly: true");
    expect(src).toContain('sameSite: "strict"');
    expect(src).toContain("secure: isSecureRequest(req)");
  });
  it("🔑 سر مستقل PLATFORM_SESSION_SECRET، ومختلف عن JWT_SECRET، وطوله ≥32", () => {
    expect(src).toContain("process.env.PLATFORM_SESSION_SECRET");
    expect(src).toContain("PLATFORM_SESSION_SECRET.length < 32");
    expect(src).toContain("PLATFORM_SESSION_SECRET === process.env.JWT_SECRET");
    // مفيش secret افتراضي في الكود.
    expect(src).not.toMatch(/PLATFORM_SESSION_SECRET\s*[|?]{2}\s*["'`]/);
  });
  it("🔑 platform auth مايقراش كوكيز العملاء، والعكس", () => {
    // platformAuth ما بيلمسش كوكي/توكن العميل.
    expect(src).not.toContain("app_session_id");
    expect(src).not.toContain("employee_token");
    expect(src).not.toContain("COOKIE_NAME");
    // context/authMiddleware بتوع العملاء ما بيلمسوش كوكي المنصة.
    expect(ctx).not.toContain("platform_admin_session");
    expect(authMw).not.toContain("platform_admin_session");
  });
});

describe("🔑 حارس المنصة fail-closed", () => {
  it("🔑 requirePlatformAdmin بيتحقق من isActive كل request + يتحقق بالسر المستقل", () => {
    const fn = src.slice(src.indexOf("export async function requirePlatformAdmin"), src.indexOf("export function registerPlatformAuthRoutes"));
    expect(fn).toContain("jwt.verify(token, PLATFORM_SESSION_SECRET");
    expect(fn).toContain("getPlatformAdminById(adminId)");
    expect(fn).toContain("!admin.isActive");
    expect(fn).toContain("status(401)");
    expect(fn).toContain("if (!ENABLED)"); // معطّل لو السر ناقص/ضعيف
  });
  it("🔑 السر الناقص/الضعيف → المسارات 503 (مش تسريب)", () => {
    expect(src).toContain('res.status(503)');
    expect(src).toContain("if (!ENABLED)");
  });
});

describe("🔑 login آمن", () => {
  const fn = src.slice(src.indexOf('router.post("/auth/login"'), src.indexOf('router.post("/auth/logout"'));
  it("🔑 username مطبّع trim+lowercase", () => {
    expect(src).toContain("String(raw ?? \"\").trim().toLowerCase()");
    expect(fn).toContain("normalizeUsername(req.body?.username)");
  });
  it("🔑 bcrypt.compare + رسالة خطأ عامة موحّدة", () => {
    expect(fn).toContain("bcrypt.compare(password");
    expect(fn).toContain('"بيانات الدخول غير صحيحة"');
    expect(fn).toContain("genericFail");
  });
  it("🔑 rate limit + تحديث lastLoginAt + تدقيق بلا password/token", () => {
    expect(fn).toContain("isRateLimited(key)");
    expect(fn).toContain("touchPlatformAdminLogin(admin.id)");
    expect(fn).toContain('action: "login"');
    expect(fn).toContain('action: "login_failed"');
    // مفيش تسجيل للـpassword أو الـtoken في التدقيق.
    expect(fn).not.toMatch(/details:\s*`?[^`\n]*password/i);
    expect(fn).not.toMatch(/details:\s*`?[^`\n]*token/i);
  });
  it("🔑 الرد يحتوي الحقول العامة فقط (id+username)، ومفيش mfaSecret", () => {
    expect(fn).toContain("admin: { id: admin.id, username: admin.username }");
    expect(fn).not.toContain("mfaSecret");
    // passwordHash بتظهر فقط في سياق bcrypt.compare (قراءة للمقارنة)، مش في أي res.json.
    const jsonLines = fn.split("\n").filter(l => l.includes("res.json"));
    expect(jsonLines.some(l => l.includes("passwordHash"))).toBe(false);
  });
  it("🔑 logout بيمسح الكوكي بنفس الـpath؛ me محمي بالحارس", () => {
    expect(src).toContain("res.clearCookie(PLATFORM_COOKIE, { path: COOKIE_PATH })");
    expect(src).toContain('router.get("/auth/me", requirePlatformAdmin');
  });
});

describe("🔑 IP: ما يوثقش X-Forwarded-For افتراضيًا", () => {
  it("🔑 افتراضيًا عنوان السوكت؛ XFF فقط لو PLATFORM_TRUST_PROXY=true", () => {
    const req: any = { headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "10.0.0.9" } };
    const saved = process.env.PLATFORM_TRUST_PROXY;
    delete process.env.PLATFORM_TRUST_PROXY;
    expect(clientIp(req)).toBe("10.0.0.9"); // XFF مُتجاهَل
    process.env.PLATFORM_TRUST_PROXY = "true";
    expect(clientIp(req)).toBe("1.2.3.4"); // XFF مُحترَم صراحةً
    if (saved === undefined) delete process.env.PLATFORM_TRUST_PROXY;
    else process.env.PLATFORM_TRUST_PROXY = saved;
  });
});

describe("🔑 rate limiter", () => {
  const key = "test-key::user";
  beforeEach(() => clearFailures(key));
  it("🔑 مش محدود قبل الحد، محدود بعد MAX_FAILURES", () => {
    expect(isRateLimited(key)).toBe(false);
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES; i++) recordFailure(key);
    expect(isRateLimited(key)).toBe(true);
    clearFailures(key);
    expect(isRateLimited(key)).toBe(false);
  });
  it("🔑 النافذة بتنتهي (reset بعد الوقت)", () => {
    const past = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES; i++) recordFailure(key, past);
    expect(isRateLimited(key, past + 1000)).toBe(true);
    expect(isRateLimited(key)).toBe(false); // دلوقتي = بعد النافذة
  });
});

describe("🔑 bootstrap: أول أدمن فقط، بلا طباعة سر", () => {
  it("🔑 يرفض أدمن ثانٍ + env-based + bcrypt + مايطبعش password/hash", () => {
    expect(bootstrap).toContain("countPlatformAdmins()");
    expect(bootstrap).toContain("رفض إنشاء أدمن ثانٍ");
    expect(bootstrap).toContain("process.env.PLATFORM_ADMIN_USERNAME");
    expect(bootstrap).toContain("process.env.PLATFORM_ADMIN_PASSWORD");
    expect(bootstrap).toContain("bcrypt.hash(password, 12)");
    // مايطبعش الباسورد ولا الـhash.
    expect(bootstrap).not.toMatch(/console\.log[^\n]*passwordHash/);
    expect(bootstrap).not.toMatch(/console\.log[^\n]*password\b/);
  });
});

describe("🔑 مُسجّل في index", () => {
  it("🔑 registerPlatformAuthRoutes متسجّل", () => {
    expect(indexTs).toContain("registerPlatformAuthRoutes(app)");
  });
});

// ── سلوكي فعلي على DB (matjarak_test) ──
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("🔑 platform admin — DB فعلي", () => {
  let createdId = 0;
  const uname = `pa-test-${Date.now()}`;

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    if (createdId) {
      await db.delete(platformAuditLogs).where(eq(platformAuditLogs.platformAdminId, createdId));
      await db.delete(platformAdmins).where(eq(platformAdmins.id, createdId));
    }
  });

  it("🔑 إنشاء أدمن + جلب بالـusername + bcrypt round-trip", async () => {
    const hash = await bcrypt.hash("correct-horse-battery", 12);
    createdId = await createPlatformAdmin({ username: uname, email: "pa@test.local", passwordHash: hash });
    expect(createdId).toBeGreaterThan(0);
    const fetched = await getPlatformAdminByUsername(uname);
    expect(fetched?.id).toBe(createdId);
    expect(await bcrypt.compare("correct-horse-battery", fetched!.passwordHash)).toBe(true);
    expect(await bcrypt.compare("wrong-password", fetched!.passwordHash)).toBe(false);
  });

  it("🔑 countPlatformAdmins > 0 (bootstrap هيرفض التكرار)", async () => {
    expect(await countPlatformAdmins()).toBeGreaterThan(0);
  });

  it("🔑 touchPlatformAdminLogin بيحدّث lastLoginAt", async () => {
    await touchPlatformAdminLogin(createdId);
    const a = await getPlatformAdminById(createdId);
    expect(a?.lastLoginAt).toBeTruthy();
  });

  it("🔑 addPlatformAuditLog بيكتب بلا بيانات حساسة", async () => {
    await addPlatformAuditLog({ platformAdminId: createdId, action: "login", ipAddress: "10.0.0.1" });
    const db = await getDb();
    const rows = await db!.select().from(platformAuditLogs).where(eq(platformAuditLogs.platformAdminId, createdId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => !/password|token/i.test(r.details ?? ""))).toBe(true);
  });
});
