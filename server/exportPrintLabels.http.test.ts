import { describe, it, expect, vi, beforeAll } from "vitest";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * SEC-1 — GET /api/export/print-labels عبر HTTP فعلي (supertest، قاعدة بيانات mocked): المسار الحقيقي، والحارس
 * الحقيقي (requireAdminOrManager)، وبناء البوليصة الحقيقي، والهيدرز الحقيقية — بجلستي /login و/employee-login.
 */
process.env.JWT_SECRET = "jwt-secret-".padEnd(48, "y");

const EVIL = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
const state = {
  employee: { id: 11, tenantId: 1, businessId: 5, role: "manager", isActive: true } as any,
  printed: [] as number[][],
};
const order = {
  id: 501, businessId: 5, orderNumber: "1001", serialNumber: "SN-1", customerName: EVIL, customerPhone: EVIL,
  customerPhone2: EVIL, governorate: "القاهرة", city: EVIL, customerAddress: EVIL, notes: EVIL, color: EVIL, size: EVIL,
  productName: `${EVIL} - x`, quantity: 1, totalAmount: "250", source: "easyorder", adName: EVIL,
  createdAt: new Date("2026-10-01T10:00:00Z"),
};

vi.mock("./db", () => ({
  // requireAdminOrManager: select().from(employees).where(...).limit(1)
  getDb: vi.fn(async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (state.employee ? [state.employee] : []) }) }) }),
  })),
  getBusinessIdsForTenant: vi.fn(async () => [5]),
  getOrders: vi.fn(async () => ({ orders: [{ ...order }], total: 1 })),
  getOrderItemsForOrders: vi.fn(async () => new Map([[501, [{ productName: `${EVIL} - y`, quantity: 2 }]]])),
  markOrdersAsPrinted: vi.fn(async (ids: number[]) => { state.printed.push(ids); }),
  getAllEmployees: vi.fn(async () => []),
  getAllProducts: vi.fn(async () => []),
  getAllBusinesses: vi.fn(async () => []),
  getBusinessIdsByGroupId: vi.fn(async () => []),
}));
vi.mock("./shippingConfigV2.service", () => ({ listShippingConfiguration: vi.fn(async () => []) }));

let app: Express;
beforeAll(async () => {
  const { registerExportRoutes } = await import("./exportExcel");
  app = express();
  app.use(cookieParser());
  registerExportRoutes(app);
});
const cookie = (name: string, employeeId: number) => `${name}=${jwt.sign({ employeeId }, process.env.JWT_SECRET as string)}`;
const tagsOf = (html: string) => html.match(/<[a-zA-Z][^>]*>/g) ?? [];

describe("🛡️ SEC-1 — GET /api/export/print-labels (استجابة HTTP فعلية)", () => {
  for (const session of ["app_session_id", "employee_token"]) {
    it(`(${session}) text/html + nosniff + CSP بـnonce مطابق للسكربت الوحيد، ولا HTML قابل للتنفيذ من بيانات الأوردر`, async () => {
      state.printed = [];
      const res = await request(app).get("/api/export/print-labels?orderIds=501").set("Cookie", cookie(session, 11));
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^text\/html; charset=utf-8/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");

      const csp = String(res.headers["content-security-policy"] ?? "");
      for (const d of ["default-src 'none'", "style-src 'unsafe-inline'", "img-src data: https://d2xsxph8kpxj0f.cloudfront.net", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"])
        expect(csp, d).toContain(d);
      const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
      expect(nonce).toBeTruthy();

      const tags = tagsOf(res.text);
      const scripts = tags.filter(t => /^<script\b/i.test(t));
      expect(scripts).toEqual([`<script nonce="${nonce}">`]);
      // لا event handlers inline في أي وسم — أسماء الخصائص الفعلية بعد حذف القيم المقتبسة (المهرّبة جواها نص بريء)
      const attrNames = (t: string) => t.replace(/"[^"]*"/g, '""');
      expect(tags.filter(t => /\son[a-z]+\s*=/i.test(attrNames(t)))).toEqual([]);
      const imgs = tags.filter(t => /^<img\b/i.test(t));
      expect(imgs).toHaveLength(2); // اللوجو + QR فقط
      for (const img of imgs) expect(img).toMatch(/src="(https:\/\/d2xsxph8kpxj0f\.cloudfront\.net\/|data:image\/png;base64,)/);
      expect(res.text).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
      expect(res.text).toContain('id="print-btn"');
      expect(state.printed).toEqual([[501]]);
    });
  }

  it("nonce جديد لكل طلب", async () => {
    const get = async () => String((await request(app).get("/api/export/print-labels?orderIds=501").set("Cookie", cookie("employee_token", 11))).headers["content-security-policy"]);
    expect(await get()).not.toBe(await get());
  });

  it("بلا جلسة = 401، ولا HTML", async () => {
    const res = await request(app).get("/api/export/print-labels?orderIds=501");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(/json/);
  });
});
