import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee, createSalesChannel, insertOrderWithItems, createProductWithVariants } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { canRunTenantJob, resolveTenantAccess, tenantAccessExpressGuard } from "./tenantAccess";
import { drainDeferredWebhooks } from "./tenantAccessDrain";
import { handleBostaWebhook } from "./bostaWebhook";
import { registerWebhookRoutes } from "./easyorderWebhook";
import { registerImportRoutes } from "./importExcel";
import { registerExportRoutes } from "./exportExcel";
import { registerBrandingRoutes } from "./brandingUpload";
import { connectCarrierAccount, PROVIDER_BOSTA } from "./carrierAccounts.service";
import { deriveWebhookSecret } from "./crypto/secretBox";
import { COOKIE_NAME } from "@shared/const";

/**
 * إنفاذ حالة الشركة (TENANT_ACCESS_ENFORCEMENT_ENABLED) على قاعدة مؤقتة: كل حالة، tRPC query/mutation للويب
 * والبوابة، Express (رفع/استيراد/تصدير)، المهام الخلفية، صندوق الويبهوك (Bosta + Easy Orders) والمعالجة مرة
 * واحدة بعد إعادة التفعيل، Platform Admin مستثنى، A لا تؤثر على B، والعلم معطل = السلوك الحالي.
 * (تغيير حالة الشركات هنا على القاعدة المؤقتة فقط لمحاكاة الحالات — الكود لا يغيّر أي حالة.)
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const resStub = { cookie: () => {}, clearCookie: () => {} } as any;
const caller = async (cookies: Record<string, string>) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies }, res: resStub } as any));
const web = (id: number) => caller({ [COOKIE_NAME]: sign(id) });
const portal = (id: number, ownerOf?: number) => caller({ employee_token: sign(id), ...(ownerOf ? { [COOKIE_NAME]: sign(ownerOf) } : {}) });
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const DAY = 86_400_000;

describe.runIf(CAN)("🔒 إنفاذ حالة الشركة", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const emp: Record<string, number> = {};
  const saved = { flag: process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED, key: process.env.CARRIER_SECRETS_KEY };
  let secretA = "", channelSecretA = "", planId = 0;
  const setTenant = (tenantId: number, status: string, trialEndsAt: Date | null = null) =>
    // epoch عبر FROM_UNIXTIME — الاتصال الخام بتوقيت محلي كان بيزيح الـDate ثلاث ساعات.
    tmp.raw.query("UPDATE tenants SET status = ?, trialEndsAt = IF(? IS NULL, NULL, FROM_UNIXTIME(?)) WHERE id = ?", [status, trialEndsAt ? 1 : null, trialEndsAt ? trialEndsAt.getTime() / 1000 : null, tenantId]);

  beforeAll(async () => {
    tmp = await createTempSchema("tacc");
    __setDbForTests(drizzle(tmp.url));
    process.env.CARRIER_SECRETS_KEY = randomBytes(32).toString("base64");
    A = await createCoreTestFixture("ta-a"); B = await createCoreTestFixture("ta-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { emp[k] = insId(await createEmployee({ name: `${k}-ta`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("agentA", "agent", A); await mk("ownerB", "super_admin", B); await mk("agentB", "agent", B);
    const key = "whk-key-tenant-access";
    const fetchImpl = (async (url: any) => String(url).includes("/pickup-locations") ? new Response(JSON.stringify({ data: [{ _id: "LOC1", locationName: "المخزن" }] }), { status: 200 }) : new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect((await connectCarrierAccount({ tenantId: A.tenantId, businessId: A.businessId, apiKey: key, pickupLocationId: "LOC1", pickupLocationName: "المخزن", allowOpenPackageDefault: true, actorId: 1, fetchImpl })).ok).toBe(true);
    const [[acct]] = (await tmp.raw.query("SELECT webhookSalt FROM business_carrier_accounts WHERE businessId = ?", [A.businessId])) as any;
    secretA = deriveWebhookSecret(PROVIDER_BOSTA, A.businessId, acct.webhookSalt);
    channelSecretA = `eo-secret-${tmp.name}`;
    await createSalesChannel({ businessId: A.businessId, name: "Easy Orders", platform: "easyorder", webhookSecret: channelSecretA, isActive: true } as any);
    const [p]: any = await tmp.raw.query("INSERT INTO subscription_plans (name, slug, priceMonthly) VALUES ('خطة', ?, 100)", [`plan-${tmp.name}`.slice(0, 50)]);
    planId = Number(p.insertId);
  }, 240_000);
  afterAll(async () => {
    for (const [k, v] of [["TENANT_ACCESS_ENFORCEMENT_ENABLED", saved.flag], ["CARRIER_SECRETS_KEY", saved.key]] as const) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    __setDbForTests(null); await tmp?.drop();
  }, 120_000);
  beforeEach(async () => { process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED = "true"; await setTenant(A.tenantId, "active"); await setTenant(B.tenantId, "active"); });

  it("العلم معطل: شركة منتهية تكتب كالمعتاد، والحالة enforced:false، والتصريف لا يعمل", async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED = "false";
    await setTenant(A.tenantId, "suspended");
    expect(await code(async () => (await web(emp.ownerA)).tasks.create({ title: "مهمة" }))).toBe("ok");
    expect(await (await web(emp.ownerA)).tenantAccess.status()).toEqual({ enforced: false });
    expect((await resolveTenantAccess(A.tenantId)).level).toBe("full");
    expect((await drainDeferredWebhooks()).skipped).toBe(true);
  });

  it("كل حالة على tRPC الويب: query/mutation، الخروج مسموح، وA لا تؤثر على B", async () => {
    const cases: Array<[string, Date | null, "ok" | "FORBIDDEN", "ok" | "FORBIDDEN"]> = [
      ["active", null, "ok", "ok"],
      ["trialing", new Date(Date.now() + DAY), "ok", "ok"],
      ["trialing", new Date(Date.now() - 1000), "ok", "FORBIDDEN"],
      ["expired", null, "ok", "FORBIDDEN"],
      ["suspended", null, "FORBIDDEN", "FORBIDDEN"],
      ["canceled", null, "FORBIDDEN", "FORBIDDEN"],
    ];
    for (const [status, end, q, m] of cases) {
      await setTenant(A.tenantId, status, end);
      const o = await web(emp.ownerA);
      expect(await code(() => o.tasks.list({})), `${status} query`).toBe(q);
      expect(await code(() => o.tasks.create({ title: "مهمة" })), `${status} mutation`).toBe(m);
      expect(await code(() => o.tenantAccess.status()), `${status} status`).toBe("ok");
      expect(await code(() => o.auth.logout()), `${status} logout`).toBe("ok");
      expect(await code(async () => (await web(emp.ownerB)).tasks.create({ title: "مهمة B" })), `${status} B`).toBe("ok");
    }
    await setTenant(A.tenantId, "expired");
    const s = await (await web(emp.ownerA)).tenantAccess.status();
    expect(s.enforced && s.level).toBe("read_only");
  });

  it("past_due: مهلة 7 أيام من نهاية الفترة ثم قراءة فقط؛ بلا اشتراك قراءة فقط", async () => {
    await setTenant(A.tenantId, "past_due");
    expect((await resolveTenantAccess(A.tenantId)).level).toBe("read_only");
    await tmp.raw.query("INSERT INTO subscriptions (tenantId, planId, status, currentPeriodEnd) VALUES (?, ?, 'past_due', FROM_UNIXTIME(?))", [A.tenantId, planId, (Date.now() - 3 * DAY) / 1000]);
    expect((await resolveTenantAccess(A.tenantId)).level).toBe("full");
    expect((await resolveTenantAccess(A.tenantId, new Date(Date.now() + 5 * DAY))).level).toBe("read_only");
    await tmp.raw.query("DELETE FROM subscriptions WHERE tenantId = ?", [A.tenantId]);
  });

  it("البوابة: حالة شركة الموظف (الكوكي) — قراءة مسموحة، كتابة مرفوضة، ومالك B المفتوح لا يغيّر شيئًا", async () => {
    await setTenant(A.tenantId, "expired");
    const a = await portal(emp.agentA);
    expect(await code(() => a.employeePortal.tasks.listMine())).toBe("ok");
    expect(await code(() => a.employeePortal.tasks.updateMyStatus({ taskId: 999_999, status: "done" }))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(emp.agentA, emp.ownerB)).employeePortal.tasks.updateMyStatus({ taskId: 999_999, status: "done" }))).toBe("FORBIDDEN");
    expect(await code(async () => (await portal(emp.agentB)).employeePortal.tasks.updateMyStatus({ taskId: 999_999, status: "done" }))).toBe("NOT_FOUND");
    await setTenant(A.tenantId, "suspended");
    expect(await code(() => a.employeePortal.tasks.listMine())).toBe("FORBIDDEN");
    expect(await code(() => a.employeePortal.me())).toBe("ok");
  });

  it("Express: الرفع والاستيراد مرفوضان في القراءة فقط، والتصدير مسموح؛ blocked يرفض الكل؛ المنصة والدخول مستثناة", async () => {
    const app = express(); app.use(express.json()); app.use(cookieParser());
    app.use(tenantAccessExpressGuard(async (req, res) => (await createContext({ req, res } as any)).tenantId));
    registerImportRoutes(app); registerExportRoutes(app); registerBrandingRoutes(app);
    app.post("/api/platform/probe", (_q, r) => r.json({ platform: true }));
    const cookie = (id: number) => `${COOKIE_NAME}=${sign(id)}`;
    const tenantDenied = (r: request.Response) => r.status === 403 && /^TENANT_/.test(r.body?.error?.code ?? "");
    await setTenant(A.tenantId, "expired");
    expect(tenantDenied(await request(app).post("/api/import/preview").set("Cookie", cookie(emp.ownerA)))).toBe(true);
    expect(tenantDenied(await request(app).post("/api/branding/upload").set("Cookie", cookie(emp.ownerA)))).toBe(true);
    expect(tenantDenied(await request(app).get("/api/export/confirmed").set("Cookie", cookie(emp.ownerA)))).toBe(false);
    expect(tenantDenied(await request(app).post("/api/import/preview").set("Cookie", cookie(emp.ownerB)))).toBe(false);
    expect((await request(app).post("/api/platform/probe").set("Cookie", cookie(emp.ownerA))).body).toEqual({ platform: true });
    await setTenant(A.tenantId, "suspended");
    const r = await request(app).get("/api/export/confirmed").set("Cookie", cookie(emp.ownerA));
    expect(tenantDenied(r) && r.body.error.code).toBe("TENANT_BLOCKED");
    process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED = "false";
    expect(tenantDenied(await request(app).post("/api/import/preview").set("Cookie", cookie(emp.ownerA)))).toBe(false);
  });

  it("المهام الخلفية: لا تشغيل لشركة غير full", async () => {
    await setTenant(A.tenantId, "expired");
    expect(await canRunTenantJob(A.tenantId)).toBe(false);
    expect(await canRunTenantJob(B.tenantId)).toBe(true);
  });

  it("Bosta: الحدث يُخزَّن مؤجلًا بلا معالجة، التكرار لا يعالجه، ثم يُعالج مرة واحدة بعد إعادة التفعيل", async () => {
    const pv = await createProductWithVariants(A.businessId, { name: `منتج ${tmp.name}` }, [{ name: "سادة", sku: `TA-${tmp.name}`.slice(0, 60), currentStock: 10, price: "500" }]);
    const orderId = await insertOrderWithItems({ orderNumber: `TA-${Date.now() % 1e9}`, businessId: A.businessId, customerName: "عميل", customerPhone: "01000000001", governorate: "القاهرة", customerAddress: "شارع 10", productName: "p", quantity: 1, totalAmount: "500.00", source: "facebook", status: "confirmed" } as any, [{ productId: pv.productId, productName: "p", quantity: 1, variantId: pv.variantIds[0], unitPrice: 500 }]);
    const sid = `SHP-TA-${tmp.name}`;
    await tmp.raw.query("UPDATE orders SET bostaShipmentId = ?, bostaStatus = 'sent' WHERE id = ?", [sid, orderId]);
    const call = async () => { let status = 0, json: any = null; const r: any = { status: (s: number) => { status = s; return r; }, json: (j: any) => { json = j; return r; }, set: () => r };
      await handleBostaWebhook({ headers: { "x-bosta-secret": secretA }, body: { _id: sid, trackingNumber: 4808, state: 21, type: "SEND", cod: 500, timeStamp: 1790000000000 } } as any, r); return { status, json }; };
    const orderStatus = async () => (((await tmp.raw.query("SELECT status FROM orders WHERE id = ?", [orderId])) as any)[0][0].status);
    const inbox = async () => ((await tmp.raw.query("SELECT processingStatus AS s, attempts FROM carrier_webhook_inbox WHERE shipmentId = ?", [sid])) as any)[0];
    await setTenant(A.tenantId, "expired");
    expect((await call()).json).toEqual({ ok: true, status: "deferred" });
    expect((await call()).json.duplicate).toBe(true);
    expect(await orderStatus()).toBe("confirmed");
    expect((await inbox()).map((r: any) => r.s)).toEqual(["deferred"]);
    expect((await drainDeferredWebhooks()).tenants[A.tenantId]).toBe("not_full");
    expect(await orderStatus()).toBe("confirmed");
    await setTenant(A.tenantId, "active");
    const [d1, d2] = await Promise.all([drainDeferredWebhooks(), drainDeferredWebhooks()]);
    const processed = [d1, d2].map(d => (d.tenants[A.tenantId] as any)?.bosta ?? 0).reduce((x, y) => x + y, 0);
    expect(processed).toBe(1);
    expect(await orderStatus()).toBe("shipped");
    expect((await inbox()).map((r: any) => r.s)).toEqual(["processed"]);
    expect(((await drainDeferredWebhooks()).tenants[A.tenantId] as any)?.bosta ?? 0).toBe(0);
  });

  it("Easy Orders: يُخزَّن مؤجلًا (202) بلا معالجة، ثم يُعالج مرة واحدة بعد إعادة التفعيل", async () => {
    const app = express(); app.use(express.json()); registerWebhookRoutes(app);
    const body = { event_type: "order-status-update", order_id: `ext-${tmp.name}`, new_status: "confirmed" };
    const logs = async () => ((await tmp.raw.query("SELECT eventType FROM webhook_logs WHERE businessId = ? ORDER BY id", [A.businessId])) as any)[0].map((r: any) => r.eventType);
    await setTenant(A.tenantId, "expired");
    const r = await request(app).post("/api/webhooks/easyorder").set("x-webhook-secret", channelSecretA).send(body);
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ received: true, action: "deferred" });
    expect(await logs()).toEqual(["deferred"]);
    await drainDeferredWebhooks();
    expect(await logs()).toEqual(["deferred"]);
    await setTenant(A.tenantId, "active");
    await Promise.all([drainDeferredWebhooks(), drainDeferredWebhooks()]);
    const after = await logs();
    expect(after[0]).toBe("deferred_done");
    expect(after.length).toBeGreaterThan(1);
    await drainDeferredWebhooks();
    expect(await logs()).toEqual(after);
    const live = await request(app).post("/api/webhooks/easyorder").set("x-webhook-secret", channelSecretA).send(body);
    expect(live.status).not.toBe(202);
  });
});
