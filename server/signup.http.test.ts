import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

/**
 * Phase 3.3 — التسجيل العام POST /api/signup. اختبار HTTP فعلي (supertest) بـmock لدوال DB،
 * بدون DB إنتاج. بيغطّي: النجاح **بعد insert حقيقي**، فشل insert → 500 (مفيش نجاح وهمي)،
 * التحقق، 415، rate-limit.
 */

const state: { created: any[]; failInsert: boolean } = { created: [], failInsert: false };
vi.mock("./db", () => ({
  createSignupRequest: vi.fn(async (input: any) => {
    if (state.failInsert) throw new Error("db down");
    state.created.push(input);
    return state.created.length; // id > 0
  }),
}));

const validBody = {
  ownerName: "أحمد التاجر",
  businessName: "متجر النور",
  phone: "01000000000",
  email: "Owner@Example.com",
  username: "OwnerUser",
  password: "correct-horse-1234",
};

let app: Express;
let clearLimiter: (key?: string) => void;

beforeAll(async () => {
  const mod = await import("./signup");
  clearLimiter = mod._clearSignupLimiter;
  app = express();
  app.use(express.json());
  mod.registerSignupRoutes(app);
});

beforeEach(() => {
  state.created = [];
  state.failInsert = false;
  clearLimiter(); // نبدأ كل تست بحد نظيف
});

function post(body: any, contentType = "application/json") {
  const r = request(app).post("/api/signup").set("Content-Type", contentType);
  return contentType === "application/json" ? r.send(body) : r.send(String(body));
}

describe("🔑 signup", () => {
  it("🔑 صحيح → 200 + طلب pending + email/username مطبّعين", async () => {
    const res = await post(validBody);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(state.created).toHaveLength(1);
    expect(state.created[0].email).toBe("owner@example.com");
    expect(state.created[0].username).toBe("owneruser");
    // مفيش passwordHash/tenantId/businessId في الرد.
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tenantId|businessId|password/i);
  });

  it("🔑 فشل الـinsert → 500 (مفيش نجاح وهمي) — إصلاح bug الإنتاج", async () => {
    state.failInsert = true;
    const res = await post(validBody);
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(state.created).toHaveLength(0);
  });

  it("🔑 password أقصر من 12 بايت → 400", async () => {
    const res = await post({ ...validBody, password: "short" });
    expect(res.status).toBe(400);
    expect(state.created).toHaveLength(0);
  });

  it("🔑 email غير صالح → 400", async () => {
    const res = await post({ ...validBody, email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("🔑 نوع غير نصّي (username object) → 400", async () => {
    const res = await post({ ...validBody, username: { x: 1 } });
    expect(res.status).toBe(400);
  });

  it("🔑 Content-Type غير JSON → 415", async () => {
    const res = await post("ownerName=x", "text/plain");
    expect(res.status).toBe(415);
  });

  it("🔑 rate limit: بعد 10 طلبات → 429", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await post({ ...validBody, email: `u${i}@example.com`, username: `user${i}` });
      expect(r.status).toBe(200);
    }
    const blocked = await post({ ...validBody, email: "u11@example.com", username: "user11" });
    expect(blocked.status).toBe(429);
  }, 20000); // 10× bcrypt(12) فعلية بطيئة — timeout أوسع يمنع الوميض تحت الحمل المتوازي.
});
