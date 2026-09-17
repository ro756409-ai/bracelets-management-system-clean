import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * Phase 3.4 — Platform Admin: إدارة طلبات التسجيل عبر HTTP (supertest, mocked DB).
 * بيتحقق: الصلاحية (Platform Admin فقط)، القبول، الرفض، منع التكرار، وعدم تسريب passwordHash.
 */

const PLATFORM_SECRET = "platform-secret-".padEnd(48, "x");
process.env.PLATFORM_SESSION_SECRET = PLATFORM_SECRET;
process.env.JWT_SECRET = "jwt-secret-".padEnd(48, "y");
process.env.NODE_ENV = "production";
process.env.PLATFORM_ALLOWED_ORIGINS = "https://admin.matjarak.net";

const db = {
  admin: { id: 7, username: "root", isActive: true } as any,
  listRows: [] as any[],
  approveResult: null as any,
  rejectResult: null as any,
  approveCalls: [] as number[],
};
vi.mock("./db", () => ({
  getPlatformAdminById: vi.fn(async (id: number) => (db.admin && db.admin.id === id ? db.admin : undefined)),
  listSignupRequests: vi.fn(async (_status?: string) => db.listRows),
  getSignupRequestById: vi.fn(async (id: number) => db.listRows.find(r => r.id === id)),
  approveSignupRequest: vi.fn(async (id: number) => { db.approveCalls.push(id); return db.approveResult; }),
  rejectSignupRequest: vi.fn(async () => db.rejectResult),
  addPlatformAuditLog: vi.fn(async () => {}),
}));

const ORIGIN = "https://admin.matjarak.net";
let app: Express;
let PLATFORM_COOKIE = "platform_admin_session";
let validCookie = "";

beforeAll(async () => {
  const auth = await import("./platformAuth");
  const admin = await import("./platformAdmin");
  PLATFORM_COOKIE = auth.PLATFORM_COOKIE;
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  admin.registerPlatformAdminRoutes(app);
  const token = jwt.sign({ platformAdminId: 7, sessionType: "platform_admin" }, PLATFORM_SECRET,
    { algorithm: "HS256", issuer: auth.PLATFORM_ISSUER, audience: auth.PLATFORM_AUDIENCE, expiresIn: "8h" });
  validCookie = `${PLATFORM_COOKIE}=${token}`;
});

beforeEach(() => {
  db.admin = { id: 7, username: "root", isActive: true };
  db.listRows = [
    { id: 1, businessName: "متجر A", ownerName: "أحمد", email: "a@x.io", phone: "0100", username: "a_owner", status: "pending", createdAt: new Date().toISOString() },
  ];
  db.approveResult = { ok: true, tenantId: 10, businessId: 20, employeeId: 30 };
  db.rejectResult = { ok: true };
  db.approveCalls = [];
});

describe("🔑 الصلاحية: Platform Admin فقط", () => {
  it("🔑 بلا جلسة → 401", async () => {
    expect((await request(app).get("/api/platform/signup-requests")).status).toBe(401);
  });
  it("🔑 كوكي عميل (JWT_SECRET) → 401", async () => {
    const tenantTok = jwt.sign({ platformAdminId: 7, sessionType: "platform_admin" }, process.env.JWT_SECRET as string, { algorithm: "HS256", issuer: "matjarak-platform", audience: "matjarak-platform-admin" });
    expect((await request(app).get("/api/platform/signup-requests").set("Cookie", `${PLATFORM_COOKIE}=${tenantTok}`)).status).toBe(401);
  });
  it("🔑 أدمن غير نشط → 401", async () => {
    db.admin.isActive = false;
    expect((await request(app).get("/api/platform/signup-requests").set("Cookie", validCookie)).status).toBe(401);
  });
});

describe("🔑 list/detail — بلا passwordHash", () => {
  it("🔑 list بجلسة صحيحة → 200 ومفيش passwordHash", async () => {
    const res = await request(app).get("/api/platform/signup-requests?status=pending").set("Cookie", validCookie);
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/i);
  });
});

describe("🔑 approve", () => {
  it("🔑 قبول ناجح → 200 + tenantId", async () => {
    const res = await request(app).post("/api/platform/signup-requests/1/approve").set("Cookie", validCookie).set("Origin", ORIGIN).set("Content-Type", "application/json").send("{}");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, tenantId: 10, businessId: 20 });
  });
  it("🔑 منع القبول المتكرر → 409 (not_pending)", async () => {
    db.approveResult = { ok: false, code: "not_pending", message: "الطلب تمت معالجته بالفعل" };
    const res = await request(app).post("/api/platform/signup-requests/1/approve").set("Cookie", validCookie).set("Origin", ORIGIN).set("Content-Type", "application/json").send("{}");
    expect(res.status).toBe(409);
  });
  it("🔑 Origin غير مسموح → 403", async () => {
    const res = await request(app).post("/api/platform/signup-requests/1/approve").set("Cookie", validCookie).set("Origin", "https://evil.com").set("Content-Type", "application/json").send("{}");
    expect(res.status).toBe(403);
  });
  it("🔑 بلا جلسة → 401 (ومفيش استدعاء للـapprove)", async () => {
    const res = await request(app).post("/api/platform/signup-requests/1/approve").set("Origin", ORIGIN).set("Content-Type", "application/json").send("{}");
    expect(res.status).toBe(401);
    expect(db.approveCalls).toHaveLength(0);
  });
});

describe("🔑 reject", () => {
  it("🔑 رفض ناجح → 200", async () => {
    const res = await request(app).post("/api/platform/signup-requests/1/reject").set("Cookie", validCookie).set("Origin", ORIGIN).set("Content-Type", "application/json").send({ reason: "بيانات ناقصة" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
  it("🔑 رفض طلب متعالج → 409", async () => {
    db.rejectResult = { ok: false, code: "not_pending" };
    const res = await request(app).post("/api/platform/signup-requests/1/reject").set("Cookie", validCookie).set("Origin", ORIGIN).set("Content-Type", "application/json").send({});
    expect(res.status).toBe(409);
  });
});
