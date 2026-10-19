import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * فوترة المنصة عبر HTTP (supertest، خدمة وقاعدة وهمية): العلم، جلسة المنصة، Origin، صلاحية الفوترة المنفصلة، والتدقيق.
 */
const PLATFORM_SECRET = "platform-secret-".padEnd(48, "x");
process.env.PLATFORM_SESSION_SECRET = PLATFORM_SECRET;
process.env.JWT_SECRET = "jwt-secret-".padEnd(48, "y");
process.env.NODE_ENV = "production";
process.env.PLATFORM_ALLOWED_ORIGINS = "https://admin.matjarak.net";

const state = { admin: { id: 7, username: "root", isActive: true } as any, audits: [] as any[], manualCalls: [] as any[], refundCalls: [] as any[] };
vi.mock("./db", () => ({
  getPlatformAdminById: vi.fn(async (id: number) => (state.admin && state.admin.id === id ? state.admin : undefined)),
  addPlatformAuditLog: vi.fn(async (e: any) => { state.audits.push(e); }),
  getDb: vi.fn(async () => ({})),
}));
vi.mock("./subscriptionBilling.service", async () => {
  const real = await vi.importActual<any>("./subscriptionBilling.service");
  return {
    ...real,
    getBillingOverview: vi.fn(async () => ({ enrolled: true, status: { state: "active" }, periods: [], payments: [] })),
    enrollTenant: vi.fn(async () => ({ created: true })),
    recordManualPayment: vi.fn(async (input: any) => {
      state.manualCalls.push(input);
      if (input.paymentReference === "DUP") throw new real.BillingError("مرجع مكرر", "conflict");
      return { replay: false, payment: { id: 5, planCode: input.planCode, amountMinor: 50000, paymentReference: input.paymentReference }, period: { startsAt: new Date(0), endsAt: new Date(1) } };
    }),
    refundPayment: vi.fn(async (input: any) => { state.refundCalls.push(input); return { payment: { tenantId: 3 }, period: { id: 9 } }; }),
  };
});

const ORIGIN = "https://admin.matjarak.net";
let app: Express; let cookie = "";
beforeAll(async () => {
  const auth = await import("./platformAuth");
  const billing = await import("./platformBilling");
  app = express(); app.use(express.json()); app.use(cookieParser());
  billing.registerPlatformBillingRoutes(app);
  const token = jwt.sign({ platformAdminId: 7, sessionType: "platform_admin" }, PLATFORM_SECRET, { algorithm: "HS256", issuer: auth.PLATFORM_ISSUER, audience: auth.PLATFORM_AUDIENCE, expiresIn: "8h" });
  cookie = `${auth.PLATFORM_COOKIE}=${token}`;
});
beforeEach(() => {
  process.env.SUBSCRIPTION_BILLING_ENABLED = "true";
  process.env.PLATFORM_BILLING_ADMIN_IDS = "7";
  state.admin = { id: 7, username: "root", isActive: true }; state.audits = []; state.manualCalls = []; state.refundCalls = [];
});
const body = { planCode: "month_1", idempotencyKey: "manual-key-0001", paymentReference: "INSTA-123", evidenceUrl: "https://e.example/r.png" };
const post = (path: string, b: object = body) => request(app).post(path).set("Cookie", cookie).set("Origin", ORIGIN).send(b);

describe("💳 فوترة المنصة", () => {
  it("العلم معطل ⇒ 503 قبل أي شيء", async () => {
    process.env.SUBSCRIPTION_BILLING_ENABLED = "false";
    expect((await request(app).get("/api/platform/billing/tenants/3").set("Cookie", cookie)).status).toBe(503);
    expect((await post("/api/platform/billing/tenants/3/manual-payment")).status).toBe(503);
    expect(state.manualCalls).toHaveLength(0);
  });
  it("بلا جلسة منصة ⇒ 401", async () => {
    expect((await request(app).get("/api/platform/billing/tenants/3")).status).toBe(401);
    expect((await request(app).post("/api/platform/billing/tenants/3/manual-payment").set("Origin", ORIGIN).send(body)).status).toBe(401);
  });
  it("العرض لأي أدمن منصة", async () => {
    process.env.PLATFORM_BILLING_ADMIN_IDS = "";
    const r = await request(app).get("/api/platform/billing/tenants/3").set("Cookie", cookie);
    expect(r.status).toBe(200); expect(r.body.enrolled).toBe(true);
  });
  it("الكتابة لأدمن فوترة مخوَّل بس (قائمة فاضية = لا أحد) والرفض بيتسجّل", async () => {
    for (const ids of ["", "8,9"]) {
      process.env.PLATFORM_BILLING_ADMIN_IDS = ids;
      expect((await post("/api/platform/billing/tenants/3/manual-payment")).status).toBe(403);
      expect((await post("/api/platform/billing/payments/5/refund", { reason: "استرداد" })).status).toBe(403);
      expect((await post("/api/platform/billing/tenants/3/enroll", {})).status).toBe(403);
    }
    expect(state.manualCalls).toHaveLength(0); expect(state.refundCalls).toHaveLength(0);
    expect(state.audits.filter(a => String(a.action).endsWith("_denied"))).toHaveLength(6);
  });
  it("Origin غير مسموح ⇒ 403 بلا تنفيذ", async () => {
    const r = await request(app).post("/api/platform/billing/tenants/3/manual-payment").set("Cookie", cookie).set("Origin", "https://evil.example").send(body);
    expect(r.status).toBe(403); expect(state.manualCalls).toHaveLength(0);
  });
  it("دفع يدوي ناجح ⇒ 200 + تدقيق بالمرجع (بلا أسرار)، والأدمن من الجلسة مش من الطلب", async () => {
    const r = await post("/api/platform/billing/tenants/3/manual-payment", { ...body, platformAdminId: 999 });
    expect(r.status).toBe(200); expect(r.body.paymentId).toBe(5);
    expect(state.manualCalls[0]).toMatchObject({ tenantId: 3, platformAdminId: 7, paymentReference: "INSTA-123" });
    const audit = state.audits.find(a => a.action === "billing_manual_payment");
    expect(audit).toMatchObject({ platformAdminId: 7, targetType: "tenant", targetId: 3 });
    expect(JSON.parse(audit.details)).toMatchObject({ paymentReference: "INSTA-123", amountMinor: 50000 });
  });
  it("تعارض من الخدمة ⇒ 409 + تدقيق الفشل", async () => {
    const r = await post("/api/platform/billing/tenants/3/manual-payment", { ...body, paymentReference: "DUP" });
    expect(r.status).toBe(409);
    expect(state.audits.some(a => a.action === "billing_manual_payment_failed")).toBe(true);
  });
  it("استرداد ⇒ 200 + تدقيق؛ معرّف غير صالح ⇒ 400", async () => {
    expect((await post("/api/platform/billing/payments/5/refund", { reason: "استرداد بطلب التاجر" })).status).toBe(200);
    expect(state.refundCalls[0]).toMatchObject({ paymentId: 5 });
    expect(state.audits.some(a => a.action === "billing_refund")).toBe(true);
    expect((await post("/api/platform/billing/payments/abc/refund", { reason: "x" })).status).toBe(400);
  });
});
