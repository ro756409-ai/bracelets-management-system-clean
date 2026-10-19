import { describe, it, expect, vi, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";

/** «افتكرني»: false صريحة ⇒ كوكي جلسة (بلا Max-Age/Expires)؛ غيابها أو true ⇒ نفس الكوكي الثابتة الحالية. */
const owner = vi.hoisted(() => ({ row: null as any }));
vi.mock("./db", () => ({
  getEmployeeByUsernameOrEmail: vi.fn(async () => owner.row),
  updateEmployee: vi.fn(async () => undefined),
}));
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-local-auth-remember".padEnd(40, "r");

let app: express.Express;
beforeAll(async () => {
  owner.row = { id: 1, name: "Owner", username: "owner", email: "o@example.com", role: "manager", isActive: true, passwordHash: await bcrypt.hash("correct-password", 4) };
  const { registerLocalAuthRoutes } = await import("./localAuth");
  app = express(); app.use(express.json()); registerLocalAuthRoutes(app);
});
const cookieOf = (res: request.Response) => String((res.headers["set-cookie"] as unknown as string[] | undefined)?.[0] ?? "");

describe("POST /api/auth/login — rememberMe", () => {
  it("الافتراضي (بدون الحقل) ⇒ كوكي ثابتة زي ما كانت", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "owner", password: "correct-password" });
    expect(res.status).toBe(200);
    expect(cookieOf(res)).toMatch(/Max-Age=\d+/);
  });
  it("rememberMe=true ⇒ كوكي ثابتة", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "owner", password: "correct-password", rememberMe: true });
    expect(cookieOf(res)).toMatch(/Max-Age=\d+/);
  });
  it("rememberMe=false ⇒ كوكي جلسة (تنتهي بقفل المتصفح) — نفس httpOnly", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "owner", password: "correct-password", rememberMe: false });
    const c = cookieOf(res);
    expect(res.status).toBe(200);
    expect(c).not.toMatch(/Max-Age|Expires/i);
    expect(c).toMatch(/HttpOnly/i);
  });
  it("كلمة سر غلط ⇒ مفيش كوكي في الحالتين", async () => {
    for (const rememberMe of [true, false]) {
      const res = await request(app).post("/api/auth/login").send({ username: "owner", password: "wrong", rememberMe });
      expect(res.status).not.toBe(200); expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });
});
