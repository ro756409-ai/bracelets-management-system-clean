import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { COOKIE_NAME } from "@shared/const";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import {
  __setDbForTests, createEmployee, createSalesChannel, getDailyOrdersChart, cancelPayrollPeriod,
} from "./db";
import { registerWebhookRoutes } from "./easyorderWebhook";
import { bostaWebhookUrl, BOSTA_WEBHOOK_URL_MISSING_MESSAGE } from "./bosta.service";
import { EasyOrderClient } from "./easyorder.service";
import { safeErrorText } from "./logSafety";
import { businessDateKey, businessDayRange } from "../shared/businessTime";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * المرحلة 2 — التكاملات وسلامة البيانات: سجلات Easy Order تحت التاجر الصح وبلا بيانات عملاء، رابط Webhook بوسطة حسب
 * البيئة، مهلات النداءات الخارجية، حد الإرسال الجماعي، توقيت القاهرة بالتوقيت الصيفي، البذرة خارج التطوير، وإلغاء
 * دورة رواتب مدفوعة بالنظام الجديد.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? e?.name ?? "ERR"; } }

describe("🔌 المرحلة 2 — وحدات (بلا قاعدة)", () => {
  it("INT-1 · رابط Webhook بوسطة: staging/preview بلا رابط https صالح = رفض؛ production/test كما كانوا؛ الرابط المضبوط يتحترم", () => {
    expect(() => bostaWebhookUrl({ DEPLOY_ENV: "staging" } as any)).toThrow(BOSTA_WEBHOOK_URL_MISSING_MESSAGE);
    expect(() => bostaWebhookUrl({ DEPLOY_ENV: "preview" } as any)).toThrow(BOSTA_WEBHOOK_URL_MISSING_MESSAGE);
    expect(() => bostaWebhookUrl({ DEPLOY_ENV: "staging", BOSTA_WEBHOOK_URL: "http://insecure.example/hook" } as any)).toThrow(BOSTA_WEBHOOK_URL_MISSING_MESSAGE);
    expect(bostaWebhookUrl({ DEPLOY_ENV: "staging", BOSTA_WEBHOOK_URL: "https://staging.example/api/webhooks/bosta" } as any)).toBe("https://staging.example/api/webhooks/bosta");
    expect(bostaWebhookUrl({ DEPLOY_ENV: "production" } as any)).toBe("https://matjarak.net/api/webhooks/bosta");
    expect(bostaWebhookUrl({ DEPLOY_ENV: "test" } as any)).toBe("https://matjarak.net/api/webhooks/bosta");
  });

  it("INT-4 · نداء Easy Order الخارجي بيتبعت بمهلة (AbortSignal)", async () => {
    let seen: any;
    const client = new EasyOrderClient({ apiToken: "tok", fetchImpl: (async (_url: string, init: any) => { seen = init; return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" }; }) as any });
    await client.fetchOrderById("x").catch(() => {});
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it("INT-4/INT-5/INT-6 · حراس على الكود: مهلات بوسطة وS3، لوج رد بوسطة بلا جسم الرد، حد وتوازي للإرسال الجماعي", () => {
    const bosta = fs.readFileSync("server/bosta.service.ts", "utf-8");
    expect(bosta).toContain("signal: AbortSignal.timeout(BOSTA_CREATE_TIMEOUT_MS)");
    expect(bosta).toContain("signal: AbortSignal.timeout(BOSTA_AWB_TIMEOUT_MS)");
    expect(bosta).not.toContain("body: responseBody })");
    expect(fs.readFileSync("server/carrierAccounts.service.ts", "utf-8")).toContain("signal: AbortSignal.timeout(15_000)");
    expect(fs.readFileSync("server/objectStorage.ts", "utf-8")).toContain("requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 }");
    const routers = fs.readFileSync("server/routers.ts", "utf-8");
    expect(routers).toContain("orderIds: z.array(z.number()).min(1).max(BOSTA_BULK_MAX)");
    expect(routers).toContain("settleWithConcurrency(input.orderIds, BOSTA_BULK_CONCURRENCY,");
    const hook = fs.readFileSync("server/easyorderWebhook.ts", "utf-8");
    expect(hook).not.toMatch(/console\.error\([^)]*,\s*err\)/);
    expect(hook).not.toContain("receivedSecret.slice(");
  });

  it("safeErrorText · رسالة الـORM (فيها params = بيانات العميل) مابتطلعش", () => {
    const err = Object.assign(new Error("Failed query: insert into `orders` ... params: عميل-سري,01055544433"), { cause: { code: "ER_SIGNAL_EXCEPTION" } });
    expect(safeErrorText(err)).toBe("خطأ داخلي (ER_SIGNAL_EXCEPTION)");
    expect(safeErrorText(new Error("Failed query: x params: 0105"))).toBe("خطأ داخلي");
  });
});

describe.runIf(CAN)("🔌 المرحلة 2 — على MySQL مؤقتة", { timeout: 60_000 }, () => {
  let tmp: TempSchema; let A: CoreTestFixture; let B: CoreTestFixture;
  let ownerA = 0;
  const secretA = `sec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const app = express(); app.use(express.json()); registerWebhookRoutes(app);

  beforeAll(async () => {
    tmp = await createTempSchema("integ_p2");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("p2-a"); B = await createCoreTestFixture("p2-b");
    ownerA = insId(await createEmployee({ name: "owner-p2", role: "super_admin", isActive: true, tenantId: A.tenantId, businessId: A.businessId,
      username: `p2_${tmp.name}`.slice(0, 50), passwordHash: "h" } as any));
    await createSalesChannel({ businessId: A.businessId, name: "Easy Orders", platform: "easyorder", webhookSecret: secretA, isActive: true } as any);
  }, 180_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("INT-2 · سر غلط: 401 ومفيش أي سطر في webhook_logs (كان بيتسجّل تحت التاجر 1)", async () => {
    const before = Number((await q("SELECT COUNT(*) AS n FROM webhook_logs"))[0].n);
    const r = await request(app).post("/api/webhooks/easyorder").set("x-webhook-secret", "wrong-secret-123456").send({ id: "x" });
    expect(r.status).toBe(401);
    expect(Number((await q("SELECT COUNT(*) AS n FROM webhook_logs"))[0].n)).toBe(before);
  });

  it("INT-2 · فشل حفظ الأوردر: السجل تحت نشاط القناة وبلا اسم/هاتف العميل (حتى لو رسالة الـORM فيها params)", async () => {
    await q(`CREATE TRIGGER p2_fail_order BEFORE INSERT ON orders FOR EACH ROW BEGIN
      IF NEW.externalOrderId LIKE 'EO-P2-%' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced'; END IF; END`);
    try {
      const r = await request(app).post("/api/webhooks/easyorder").set("x-webhook-secret", secretA).send({
        id: `EO-P2-${tmp.name}`.slice(0, 60), full_name: "عميل-سري-جدًا", phone: "01055544433", government: "الجيزة",
        address: "شارع النيل رقم 5 الدقي", total_cost: 350, shipping_cost: 50, updated_at: "2026-10-01T10:00:00Z",
        cart_items: [{ price: 300, quantity: 1, product: { name: "منتج" } }],
      });
      expect([200, 500]).toContain(r.status);
    } finally {
      await q("DROP TRIGGER IF EXISTS p2_fail_order");
    }
    const rows = await q("SELECT businessId, message FROM webhook_logs WHERE status = 'error' ORDER BY id DESC LIMIT 5");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((l: any) => l.businessId === A.businessId)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("01055544433");
    expect(JSON.stringify(rows)).not.toContain("params:");
    expect(Number((await q("SELECT COUNT(*) AS n FROM webhook_logs WHERE businessId = 1 AND businessId <> ?", [A.businessId]))[0].n)).toBe(0);
  });

  it("DATA-1 · الرسم اليومي بيوم القاهرة الفعلي: أوردر بعد منتصف ليل القاهرة بنص ساعة يتحسب على اليوم ده (مش اللي قبله)", async () => {
    const today = businessDateKey(new Date(), "Africa/Cairo");
    const halfPastMidnight = new Date(businessDayRange(today, "Africa/Cairo").from.getTime() + 30 * 60_000);
    // FROM_UNIXTIME: اللحظة نفسها بغض النظر عن منطقة Node أو جلسة MySQL (Date كنص محلي كان بيتخزّن مزاح)
    await q("INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, quantity, totalAmount, status, source, createdAt) VALUES (?, ?, 'c', '01000000000', 'x', 'القاهرة', 'p', 1, '1.00', 'confirmed', 'manual', FROM_UNIXTIME(?))",
      [B.businessId, `P2D${Date.now() % 1e9}`, Math.floor(halfPastMidnight.getTime() / 1000)]);
    const chart = await getDailyOrdersChart(3, undefined, [B.businessId]);
    expect(chart.find(d => d.date === today)).toMatchObject({ total: 1, confirmed: 1 });
    expect(chart.reduce((n, d) => n + d.total, 0)).toBe(1);
  });

  it("DATA-12 · «تهيئة البيانات» خارج development/test مابتكتبش منتجات على النشاط 1", async () => {
    const saved = process.env.DEPLOY_ENV;
    process.env.DEPLOY_ENV = "staging";
    try {
      await q("DELETE FROM products WHERE businessId = 1");
      const before = Number((await q("SELECT COUNT(*) AS n FROM products"))[0].n);
      const r: any = await (await web(ownerA)).seed.init();
      expect(r).toMatchObject({ success: true, skipped: true });
      expect(Number((await q("SELECT COUNT(*) AS n FROM products"))[0].n)).toBe(before);
    } finally {
      if (saved == null) delete process.env.DEPLOY_ENV; else process.env.DEPLOY_ENV = saved;
    }
  });

  it("DATA-9 · إلغاء دورة رواتب مدفوعة بالنظام الجديد (بلا expenseId) مرفوض بلا أي تغيير — الدورة والسلف كما هما", async () => {
    const pid = insId(await q("INSERT INTO payroll_periods (businessId, year, month, status, createdBy, createdByName) VALUES (?, 2026, 9, 'paid', ?, 'o')", [A.businessId, ownerA]));
    const aid = insId(await q("INSERT INTO employee_advances (businessId, employeeId, employeeName, amount, advanceDate, createdBy, createdByName, status, settledPeriodId) VALUES (?, ?, 'e', '100.00', NOW(), ?, 'o', 'settled', ?)", [A.businessId, ownerA, ownerA, pid]));
    const before = JSON.stringify([await q("SELECT * FROM payroll_periods WHERE id = ?", [pid]), await q("SELECT * FROM employee_advances WHERE id = ?", [aid])]);
    await expect(cancelPayrollPeriod(pid, "x", { id: ownerA, name: "o" })).rejects.toThrow("عكس الصرف من الدفتر");
    expect(JSON.stringify([await q("SELECT * FROM payroll_periods WHERE id = ?", [pid]), await q("SELECT * FROM employee_advances WHERE id = ?", [aid])])).toBe(before);
  });

  it("INT-6 · الإرسال الجماعي لبوسطة فوق 200 أوردر بيترفض قبل أي نداء", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    expect(await code(async () => (await web(ownerA)).orders.bulkSendToBosta({ orderIds: ids }))).toBe("BAD_REQUEST");
  });
});
