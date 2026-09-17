import { describe, it, expect, afterAll, beforeEach } from "vitest";
import fs from "fs";
import bcrypt from "bcryptjs";
import {
  clientIp,
  isRateLimited,
  recordFailure,
  clearFailures,
  rateLimitSize,
  parseCredentials,
  isOriginAllowed,
  RATE_LIMIT_MAX_FAILURES,
  RATE_LIMIT_MAX_ENTRIES,
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
 * Phase 3.2 — Platform Admin auth (وحدة/سلوكي). التدفّق الكامل عبر HTTP في
 * platformAuth.http.test.ts (supertest). حراس المصدر هنا للنقاط الثابتة فقط، **مش** بديل للسلوك.
 */

const bootstrap = fs.readFileSync("scripts/bootstrap-platform-admin.ts", "utf-8");
const indexTs = fs.readFileSync("server/_core/index.ts", "utf-8");
const ctx = fs.readFileSync("server/_core/context.ts", "utf-8");
const authMw = fs.readFileSync("server/authMiddleware.ts", "utf-8");

describe("🔑 عزل (حراس مصدر): مصادقة العميل ما تلمسش كوكي المنصة", () => {
  it("🔑 context/authMiddleware مايقروش platform_admin_session", () => {
    expect(ctx).not.toContain("platform_admin_session");
    expect(authMw).not.toContain("platform_admin_session");
  });
  it("🔑 registerPlatformAuthRoutes متسجّل في index", () => {
    expect(indexTs).toContain("registerPlatformAuthRoutes(app)");
  });
});

describe("🔑 clientIp: عنوان السوكت فقط (XFF غير موثوق)", () => {
  it("🔑 بيتجاهل X-Forwarded-For دائمًا", () => {
    const req: any = { headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "10.0.0.9" } };
    expect(clientIp(req)).toBe("10.0.0.9");
  });
});

describe("🔑 parseCredentials: نوع نصّي + حدود", () => {
  it("🔑 يرفض الأنواع غير النصية (object/array/number)", () => {
    expect(parseCredentials({ username: {}, password: "x".repeat(12) }).ok).toBe(false);
    expect(parseCredentials({ username: "admin", password: 12345678 }).ok).toBe(false);
    expect(parseCredentials({ username: ["a"], password: "x".repeat(12) }).ok).toBe(false);
    expect(parseCredentials(null).ok).toBe(false);
  });
  it("🔑 username 3..50 بعد trim+lowercase", () => {
    expect(parseCredentials({ username: "ab", password: "x".repeat(12) }).ok).toBe(false);
    expect(parseCredentials({ username: "a".repeat(51), password: "x".repeat(12) }).ok).toBe(false);
    const r = parseCredentials({ username: "  AdMin  ", password: "x".repeat(12) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.username).toBe("admin");
  });
  it("🔑 password 12..72 UTF-8 bytes (مش أحرف)", () => {
    expect(parseCredentials({ username: "admin", password: "x".repeat(11) }).ok).toBe(false);
    expect(parseCredentials({ username: "admin", password: "x".repeat(72) }).ok).toBe(true);
    expect(parseCredentials({ username: "admin", password: "x".repeat(73) }).ok).toBe(false);
    // 24 حرف عربي × 2 بايت = 48 بايت (مقبول)؛ 37 حرف عربي = 74 بايت (مرفوض).
    expect(parseCredentials({ username: "admin", password: "ك".repeat(24) }).ok).toBe(true);
    expect(parseCredentials({ username: "admin", password: "ك".repeat(37) }).ok).toBe(false);
  });
});

describe("🔑 isOriginAllowed: exact origin", () => {
  const save = { ...process.env };
  afterAll(() => { process.env.NODE_ENV = save.NODE_ENV; process.env.PLATFORM_ALLOWED_ORIGINS = save.PLATFORM_ALLOWED_ORIGINS; });
  it("🔑 production: Origin مفقود = رفض", () => {
    process.env.NODE_ENV = "production";
    process.env.PLATFORM_ALLOWED_ORIGINS = "https://admin.matjarak.net";
    expect(isOriginAllowed({ headers: {} } as any)).toBe(false);
  });
  it("🔑 production: مطابقة exact فقط (مش startsWith/substring)", () => {
    process.env.NODE_ENV = "production";
    process.env.PLATFORM_ALLOWED_ORIGINS = "https://admin.matjarak.net";
    expect(isOriginAllowed({ headers: { origin: "https://admin.matjarak.net" } } as any)).toBe(true);
    expect(isOriginAllowed({ headers: { origin: "https://admin.matjarak.net.evil.com" } } as any)).toBe(false);
    expect(isOriginAllowed({ headers: { origin: "https://evil.com" } } as any)).toBe(false);
  });
  it("🔑 dev بلا قائمة = مسموح؛ dev بقائمة = يُفرض", () => {
    process.env.NODE_ENV = "test";
    process.env.PLATFORM_ALLOWED_ORIGINS = "";
    expect(isOriginAllowed({ headers: {} } as any)).toBe(true);
    process.env.PLATFORM_ALLOWED_ORIGINS = "http://localhost:5173";
    expect(isOriginAllowed({ headers: { origin: "http://localhost:5173" } } as any)).toBe(true);
    expect(isOriginAllowed({ headers: { origin: "http://localhost:9999" } } as any)).toBe(false);
  });
});

describe("🔑 rate limiter: حد/reset/expiry/cap/eviction", () => {
  const key = "10.0.0.1::user";
  beforeEach(() => clearFailures(key));
  it("🔑 محدود بعد 5 محاولات، والنجاح يمسح", () => {
    expect(isRateLimited(key)).toBe(false);
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES; i++) recordFailure(key);
    expect(isRateLimited(key)).toBe(true);
    clearFailures(key);
    expect(isRateLimited(key)).toBe(false);
  });
  it("🔑 النافذة بتنتهي", () => {
    const past = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES; i++) recordFailure(key, past);
    expect(isRateLimited(key, past + 1000)).toBe(true);
    expect(isRateLimited(key)).toBe(false);
  });
  it("🔑 سقف الـMap ثابت + eviction (مايكبرش عن الحد)", () => {
    for (let i = 0; i < RATE_LIMIT_MAX_ENTRIES + 50; i++) recordFailure(`k${i}::u`);
    expect(rateLimitSize()).toBeLessThanOrEqual(RATE_LIMIT_MAX_ENTRIES);
  });
});

describe("🔑 bootstrap: أول أدمن فقط، 12..72، بلا طباعة سر", () => {
  it("🔑 يرفض التكرار + env/prompt مخفي + bcrypt + حدود + مايطبعش سر", () => {
    expect(bootstrap).toContain("countPlatformAdmins()");
    expect(bootstrap).toContain("رفض إنشاء أدمن ثانٍ");
    expect(bootstrap).toContain("process.env.PLATFORM_ADMIN_USERNAME");
    expect(bootstrap).toContain("readHiddenPassword");
    expect(bootstrap).toContain("bcrypt.hash(password, 12)");
    expect(bootstrap).toContain("PASSWORD_MIN_BYTES");
    expect(bootstrap).toContain("PASSWORD_MAX_BYTES");
    expect(bootstrap).not.toMatch(/console\.log[^\n]*password/i);
    expect(bootstrap).not.toMatch(/console\.log[^\n]*hash/i);
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

  it("🔑 إنشاء + جلب + bcrypt round-trip", async () => {
    const hash = await bcrypt.hash("correct-horse-battery", 12);
    createdId = await createPlatformAdmin({ username: uname, email: "pa@test.local", passwordHash: hash });
    expect(createdId).toBeGreaterThan(0);
    const fetched = await getPlatformAdminByUsername(uname);
    expect(fetched?.id).toBe(createdId);
    expect(await bcrypt.compare("correct-horse-battery", fetched!.passwordHash)).toBe(true);
    expect(await bcrypt.compare("wrong-password", fetched!.passwordHash)).toBe(false);
  });
  it("🔑 count > 0", async () => { expect(await countPlatformAdmins()).toBeGreaterThan(0); });
  it("🔑 touch lastLoginAt", async () => {
    await touchPlatformAdminLogin(createdId);
    expect((await getPlatformAdminById(createdId))?.lastLoginAt).toBeTruthy();
  });
  it("🔑 audit بلا أسرار", async () => {
    await addPlatformAuditLog({ platformAdminId: createdId, action: "login", ipAddress: "10.0.0.1" });
    const db = await getDb();
    const rows = await db!.select().from(platformAuditLogs).where(eq(platformAuditLogs.platformAdminId, createdId));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => !/password|token/i.test(r.details ?? ""))).toBe(true);
  });
});
