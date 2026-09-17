import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

/**
 * Phase 3.2 — اختبار HTTP فعلي للـPlatform Admin auth (supertest + Express حقيقي)، بـmock
 * لدوال DB — **بدون أي DB إنتاج**. بيغطّي التدفّق الكامل والعزل وأعلام الكوكي والـrate-limit.
 */

// ── بيئة قبل استيراد الموديول (ENABLED/NODE_ENV بيتقروا وقت التحميل) ──
const PLATFORM_SECRET = "platform-secret-".padEnd(48, "x"); // ≥32، مختلف عن JWT_SECRET
process.env.PLATFORM_SESSION_SECRET = PLATFORM_SECRET;
process.env.JWT_SECRET = "jwt-secret-".padEnd(48, "y");
process.env.NODE_ENV = "production";
process.env.PLATFORM_ALLOWED_ORIGINS = "https://admin.matjarak.net";
delete process.env.PLATFORM_TRUST_PROXY;

// ── mock لدوال DB اللي platformAuth بيستوردها ──
const state: { admin: any } = { admin: null };
vi.mock("./db", () => ({
  getPlatformAdminByUsername: vi.fn(async (u: string) => (state.admin && state.admin.username === u ? state.admin : undefined)),
  getPlatformAdminById: vi.fn(async (id: number) => (state.admin && state.admin.id === id ? state.admin : undefined)),
  touchPlatformAdminLogin: vi.fn(async () => {}),
  addPlatformAuditLog: vi.fn(async () => {}),
}));

const ISSUER = "matjarak-platform";
const AUDIENCE = "matjarak-platform-admin";
const ORIGIN = "https://admin.matjarak.net";
const GOOD_PW = "correct-horse-1234"; // 18 bytes

let app: Express;
let PLATFORM_COOKIE = "platform_admin_session";
let signValid: (over?: Record<string, any>, opts?: jwt.SignOptions) => string;

beforeAll(async () => {
  const mod = await import("./platformAuth");
  PLATFORM_COOKIE = mod.PLATFORM_COOKIE;
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  mod.registerPlatformAuthRoutes(app);
  signValid = (over = {}, opts = {}) =>
    jwt.sign(
      { platformAdminId: 1, sessionType: "platform_admin", ...over },
      PLATFORM_SECRET,
      { algorithm: "HS256", issuer: ISSUER, audience: AUDIENCE, expiresIn: "8h", ...opts }
    );
});

beforeEach(async () => {
  state.admin = {
    id: 1,
    username: "owner",
    email: "o@x.io",
    passwordHash: await bcrypt.hash(GOOD_PW, 10),
    isActive: true,
  };
});

function login(body: any, origin = ORIGIN) {
  return request(app).post("/api/platform/auth/login").set("Origin", origin).set("Content-Type", "application/json").send(body);
}
function cookieHeader(token: string) {
  return `${PLATFORM_COOKIE}=${token}`;
}

describe("🔑 login", () => {
  it("🔑 صحيح → 200 + Set-Cookie بالأعلام الصحيحة", async () => {
    const res = await login({ username: "owner", password: GOOD_PW });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, admin: { id: 1, username: "owner" } });
    const setCookie = String(res.headers["set-cookie"]?.[0] ?? "");
    expect(setCookie).toContain(`${PLATFORM_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure"); // production
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/api/platform");
    expect(setCookie).toMatch(/Max-Age=\d+/);
    // مفيش أسرار في الرد.
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|mfaSecret|token/i);
  });

  it("🔑 password خطأ → 401 عام", async () => {
    const res = await login({ username: "owner", password: "wrong-horse-1234" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("بيانات الدخول غير صحيحة");
  });

  it("🔑 username غير موجود → 401 بنفس الرسالة", async () => {
    const res = await login({ username: "ghost", password: GOOD_PW });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("بيانات الدخول غير صحيحة");
  });

  it("🔑 admin غير نشط → 401 عام", async () => {
    state.admin.isActive = false;
    const res = await login({ username: "owner", password: GOOD_PW });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("بيانات الدخول غير صحيحة");
  });

  it("🔑 Content-Type غير JSON → 415", async () => {
    const res = await request(app)
      .post("/api/platform/auth/login")
      .set("Origin", ORIGIN)
      .set("Content-Type", "text/plain")
      .send("username=owner&password=correct-horse-1234");
    expect(res.status).toBe(415);
  });

  it("🔑 Origin مفقود (production) → 403", async () => {
    const res = await request(app).post("/api/platform/auth/login").set("Content-Type", "application/json").send({ username: "owner", password: GOOD_PW });
    expect(res.status).toBe(403);
  });
  it("🔑 Origin غير مسموح → 403", async () => {
    const res = await login({ username: "owner", password: GOOD_PW }, "https://evil.com");
    expect(res.status).toBe(403);
  });

  it("🔑 إدخال غير نصّي → 400 عام", async () => {
    const res = await login({ username: { a: 1 }, password: GOOD_PW });
    expect(res.status).toBe(400);
  });

  it("🔑 rate limit: 429 بعد 5 محاولات فاشلة", async () => {
    const u = "ratelimited";
    state.admin.username = u;
    for (let i = 0; i < 5; i++) {
      const r = await login({ username: u, password: "wrong-pass-xxxx" });
      expect(r.status).toBe(401);
    }
    const blocked = await login({ username: u, password: GOOD_PW });
    expect(blocked.status).toBe(429);
  });
});

describe("🔑 /me + عزل الجلسة", () => {
  it("🔑 جلسة صحيحة → 200", async () => {
    const res = await request(app).get("/api/platform/auth/me").set("Cookie", cookieHeader(signValid()));
    expect(res.status).toBe(200);
    expect(res.body.admin).toEqual({ id: 1, username: "owner" });
  });
  it("🔑 بلا كوكي → 401", async () => {
    expect((await request(app).get("/api/platform/auth/me")).status).toBe(401);
  });
  it("🔑 Authorization Bearer لا يعمل (كوكي فقط)", async () => {
    const res = await request(app).get("/api/platform/auth/me").set("Authorization", `Bearer ${signValid()}`);
    expect(res.status).toBe(401);
  });
  it("🔑 كوكي العميل (app_session_id) لا تدخل platform", async () => {
    const res = await request(app).get("/api/platform/auth/me").set("Cookie", `app_session_id=${signValid()}`);
    expect(res.status).toBe(401);
  });
  it("🔑 token منتهي → 401", async () => {
    const res = await request(app).get("/api/platform/auth/me").set("Cookie", cookieHeader(signValid({}, { expiresIn: "-1s" })));
    expect(res.status).toBe(401);
  });
  it("🔑 token تالف → 401", async () => {
    const res = await request(app).get("/api/platform/auth/me").set("Cookie", cookieHeader("not.a.jwt"));
    expect(res.status).toBe(401);
  });
  it("🔑 issuer/audience خطأ → 401", async () => {
    const badIss = jwt.sign({ platformAdminId: 1, sessionType: "platform_admin" }, PLATFORM_SECRET, { algorithm: "HS256", issuer: "evil", audience: AUDIENCE });
    const badAud = jwt.sign({ platformAdminId: 1, sessionType: "platform_admin" }, PLATFORM_SECRET, { algorithm: "HS256", issuer: ISSUER, audience: "evil" });
    expect((await request(app).get("/api/platform/auth/me").set("Cookie", cookieHeader(badIss))).status).toBe(401);
    expect((await request(app).get("/api/platform/auth/me").set("Cookie", cookieHeader(badAud))).status).toBe(401);
  });
  it("🔑 algorithm خطأ (HS384) → 401", async () => {
    const badAlg = jwt.sign({ platformAdminId: 1, sessionType: "platform_admin" }, PLATFORM_SECRET, { algorithm: "HS384", issuer: ISSUER, audience: AUDIENCE });
    expect((await request(app).get("/api/platform/auth/me").set("Cookie", cookieHeader(badAlg))).status).toBe(401);
  });
  it("🔑 sessionType خطأ → 401", async () => {
    const badType = signValid({ sessionType: "tenant" });
    expect((await request(app).get("/api/platform/auth/me").set("Cookie", cookieHeader(badType))).status).toBe(401);
  });
  it("🔑 توكن موقّع بـJWT_SECRET (توكن عميل) → 401", async () => {
    const tenantToken = jwt.sign({ platformAdminId: 1, sessionType: "platform_admin" }, process.env.JWT_SECRET as string, { algorithm: "HS256", issuer: ISSUER, audience: AUDIENCE });
    expect((await request(app).get("/api/platform/auth/me").set("Cookie", cookieHeader(tenantToken))).status).toBe(401);
  });
});

describe("🔑 logout", () => {
  it("🔑 بيمسح نفس الكوكي (Path=/api/platform)", async () => {
    const res = await request(app).post("/api/platform/auth/logout").set("Origin", ORIGIN).set("Cookie", cookieHeader(signValid()));
    expect(res.status).toBe(200);
    const setCookie = String(res.headers["set-cookie"]?.[0] ?? "");
    expect(setCookie).toContain(`${PLATFORM_COOKIE}=`);
    expect(setCookie).toContain("Path=/api/platform");
  });
});
