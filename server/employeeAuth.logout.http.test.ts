import { describe, it, expect, vi, beforeAll } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * BUG-19 — خروج موظف البوابة يُنهي الجلسة من السيرفر: `POST /api/employee/logout` يرسل
 * Set-Cookie يمسح `employee_token` (httpOnly — الـJS ماكانش يقدر يمسحه)، وبعدها المتصفح
 * نفسه مايقدرش يستخدم الجلسة: `/me` يرجع 401. اختبار HTTP حقيقي (supertest + Express) بـmock
 * لقاعدة البيانات — بلا أي DB حقيقية.
 */
process.env.JWT_SECRET = "jwt-secret-".padEnd(48, "y");

const EMPLOYEE = { id: 7, name: "موظف مخزن", role: "warehouse", username: "wh.user", isActive: true, businessId: 3, tenantId: 1 };
vi.mock("./db", () => ({
  getDb: vi.fn(async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [EMPLOYEE] }) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  })),
}));

let app: Express;
const token = () => jwt.sign({ employeeId: EMPLOYEE.id, name: EMPLOYEE.name, role: EMPLOYEE.role, username: EMPLOYEE.username }, process.env.JWT_SECRET!, { expiresIn: "7d" });

beforeAll(async () => {
  const { default: router } = await import("./employeeAuth");
  app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api/employee", router);
});

describe("BUG-19 — /api/employee/logout ينهي جلسة المتصفح", () => {
  it("يرسل Set-Cookie يمسح employee_token بنفس المسار والخصائص", async () => {
    const res = await request(app).post("/api/employee/logout").set("Cookie", `employee_token=${token()}`);
    expect(res.status).toBe(200);
    const set = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    const cleared = set.find(c => c.startsWith("employee_token="));
    expect(cleared).toBeDefined();
    expect(cleared).toMatch(/^employee_token=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/Path=\//);
    expect(cleared).toMatch(/HttpOnly/);
    expect(cleared).toMatch(/SameSite=Lax/);
  });

  it("الجلسة مقبولة قبل الخروج ومرفوضة بعده من نفس المتصفح", async () => {
    const agent = request.agent(app);
    // كوكي الجلسة في «متصفح» الوكيل كما يضعه /login
    agent.jar.setCookie(`employee_token=${token()}; Path=/; HttpOnly`, "127.0.0.1", "/");
    const before = await agent.get("/api/employee/me");
    expect(before.status).toBe(200);
    expect(before.body.id).toBe(EMPLOYEE.id);

    const out = await agent.post("/api/employee/logout");
    expect(out.status).toBe(200);

    const after = await agent.get("/api/employee/me");
    expect(after.status).toBe(401);
    expect(after.body.error).toBe("غير مسجل الدخول");
  });

  it("الخروج بلا جلسة أصلًا لا يفشل (نقرة مكررة / كوكي منتهي)", async () => {
    const res = await request(app).post("/api/employee/logout");
    expect(res.status).toBe(200);
  });
});
