import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import express from "express";
import request from "supertest";
import { randomBytes } from "crypto";
import { drizzle } from "drizzle-orm/mysql2";
import { __setDbForTests, createSalesChannel, insertOrderWithItems, createProductWithVariants, getDb } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { SUBSCRIPTION_BILLING_MIGRATION, SUBSCRIPTION_BILLING_FILE } from "./subscriptionBillingMigration";
import { enrollTenant, recordManualPayment } from "./subscriptionBilling.service";
import { resolveTenantAccess } from "./tenantAccess";
import { assertTrpcTenantAccess } from "./_core/trpc";
import { drainDeferredWebhooks } from "./tenantAccessDrain";
import { handleBostaWebhook } from "./bostaWebhook";
import { registerWebhookRoutes } from "./easyorderWebhook";
import { connectCarrierAccount, PROVIDER_BOSTA } from "./carrierAccounts.service";
import { deriveWebhookSecret } from "./crypto/secretBox";

/**
 * اشتراك منتهي (restricted) على قاعدة مؤقتة معزولة — قرارات المالك:
 *   • ويبهوك بوسطة للشحنات **القائمة** بيتعالج فورًا (مش مؤجل) بعد انتهاء الاشتراك.
 *   • Easy Order: الأوردر **الجديد** بيتأجل (مايتعملش) من غير فقد، وبيتعالج مرة واحدة بعد التجديد؛ تحديث حالة أوردر قائم بيتعالج.
 *   • العمليات التجارية الجديدة ممنوعة على tRPC، والتصحيح مسموح.
 *   • الشركات الحالية (من غير صف فوترة) مايتغيرش قرارها بتفعيل SUBSCRIPTION_BILLING_ENABLED.
 * كل نداءات بوسطة وهمية (fetchImpl) — مفيش أي اتصال خارجي.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const ENV = ["TENANT_ACCESS_ENFORCEMENT_ENABLED", "SUBSCRIPTION_BILLING_ENABLED", "CARRIER_SECRETS_KEY"] as const;

describe.runIf(CAN)("💳 اشتراك منتهي — الويبهوك والعمليات", { timeout: 120_000 }, () => {
  let tmp: TempSchema; let A: CoreTestFixture; let L: CoreTestFixture; let T: CoreTestFixture;
  const saved: Record<string, string | undefined> = {};
  let secretA = "", channelSecretA = "";
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const T0 = new Date(Date.now() - 120 * 86_400_000); // دفعة شهر من 120 يوم ⇒ منتهي بعد السماح دلوقتي
  let seq = 0;

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.CARRIER_SECRETS_KEY = randomBytes(32).toString("base64");
    tmp = await createTempSchema("subwh");
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [SUBSCRIPTION_BILLING_MIGRATION, SUBSCRIPTION_BILLING_FILE, "0055"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("subwh-a"); L = await createCoreTestFixture("subwh-legacy"); T = await createCoreTestFixture("subwh-trial");
    const fetchImpl = (async (url: any) => String(url).includes("/pickup-locations") ? new Response(JSON.stringify({ data: [{ _id: "LOC1", locationName: "المخزن" }] }), { status: 200 }) : new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect((await connectCarrierAccount({ tenantId: A.tenantId, businessId: A.businessId, apiKey: "whk-key-subwh", pickupLocationId: "LOC1", pickupLocationName: "المخزن", allowOpenPackageDefault: true, actorId: 1, fetchImpl })).ok).toBe(true);
    const [acct] = await q("SELECT webhookSalt FROM business_carrier_accounts WHERE businessId = ?", [A.businessId]);
    secretA = deriveWebhookSecret(PROVIDER_BOSTA, A.businessId, acct.webhookSalt);
    channelSecretA = `eo-secret-${tmp.name}`;
    await createSalesChannel({ businessId: A.businessId, name: "Easy Orders", platform: "easyorder", webhookSecret: channelSecretA, isActive: true } as any);
    // A على نموذج الاشتراك بدفعة قديمة منتهية؛ L شركة حالية active بلا صف فوترة؛ T شركة حالية trialing انتهت تجربتها.
    await enrollTenant((await getDb())!, { tenantId: A.tenantId, by: "platform_admin", platformAdminId: 1 });
    await recordManualPayment({ tenantId: A.tenantId, planCode: "month_1", idempotencyKey: `old-${tmp.name}`, paymentReference: `OLD-${tmp.name.slice(-6)}`, note: "دفعة قديمة للاختبار", platformAdminId: 1, now: T0 });
    await q("UPDATE tenants SET status = 'trialing', trialEndsAt = NOW() - INTERVAL 3 DAY WHERE id = ?", [T.tenantId]);
  }, 240_000);
  afterAll(async () => {
    for (const k of ENV) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
    __setDbForTests(null); await tmp?.drop();
  }, 120_000);
  beforeEach(() => { process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED = "true"; process.env.SUBSCRIPTION_BILLING_ENABLED = "true"; });

  it("الشركات الحالية: تفعيل العلم مابيغيّرش قرارها (active تفضل full، والتجربة المنتهية تفضل read_only زي ما كانت)", async () => {
    const before = { L: await resolveTenantAccess(L.tenantId), T: await resolveTenantAccess(T.tenantId) };
    process.env.SUBSCRIPTION_BILLING_ENABLED = "false";
    const off = { L: await resolveTenantAccess(L.tenantId), T: await resolveTenantAccess(T.tenantId) };
    expect([before.L.level, before.L.reason]).toEqual([off.L.level, off.L.reason]);
    expect([before.T.level, before.T.reason]).toEqual([off.T.level, off.T.reason]);
    expect(before.L.level).toBe("full");
    expect(before.T.reason).toBe("trial_ended");
    const a = await resolveTenantAccess(A.tenantId);
    process.env.SUBSCRIPTION_BILLING_ENABLED = "true";
    expect(a.level).toBe("full"); // العلم مقفول ⇒ حتى المسجّلة بسلوكها القديم
    expect((await resolveTenantAccess(A.tenantId)).reason).toBe("subscription_expired");
  });

  it("بوسطة: حدث شحنة قائمة بيتعالج فورًا للشركة المنتهية (مش مؤجل) والأوردر بيتحدّث", async () => {
    const pv = await createProductWithVariants(A.businessId, { name: `منتج ${tmp.name}` }, [{ name: "سادة", sku: `SW-${tmp.name}`.slice(0, 60), currentStock: 10, price: "500" }]);
    const orderId = await insertOrderWithItems({ orderNumber: `SW-${Date.now() % 1e9}`, businessId: A.businessId, customerName: "عميل", customerPhone: "01000000001", governorate: "القاهرة", customerAddress: "شارع 10", productName: "p", quantity: 1, totalAmount: "500.00", source: "facebook", status: "confirmed" } as any, [{ productId: pv.productId, productName: "p", quantity: 1, variantId: pv.variantIds[0], unitPrice: 500 }]);
    const sid = `SHP-SW-${tmp.name}`;
    await q("UPDATE orders SET bostaShipmentId = ?, bostaStatus = 'sent' WHERE id = ?", [sid, orderId]);
    let json: any = null; const r: any = { status: () => r, json: (j: any) => { json = j; return r; }, set: () => r };
    await handleBostaWebhook({ headers: { "x-bosta-secret": secretA }, body: { _id: sid, trackingNumber: 4808, state: 21, type: "SEND", cod: 500, timeStamp: 1790000000000 } } as any, r);
    expect(json?.status).not.toBe("deferred");
    const [o] = await q("SELECT status FROM orders WHERE id = ?", [orderId]);
    expect(o.status).toBe("shipped");
    const inbox = (await q("SELECT processingStatus s FROM carrier_webhook_inbox WHERE shipmentId = ?", [sid])).map((x: any) => x.s);
    expect(inbox).toEqual(["processed"]);
  });

  it("Easy Order: الأوردر الجديد بيتأجل (مايتعملش ومايضيعش)، وتحديث حالة أوردر قائم مابيتأجلش", async () => {
    const app = express(); app.use(express.json()); registerWebhookRoutes(app);
    const logs = async () => (await q("SELECT eventType FROM webhook_logs WHERE businessId = ? ORDER BY id", [A.businessId])).map((x: any) => x.eventType);
    const ordersBefore = (await q("SELECT COUNT(*) n FROM orders WHERE businessId = ?", [A.businessId]))[0].n;
    const create = { id: `new-${tmp.name}-${++seq}`, full_name: "عميل جديد", phone: "01011111111", government: "القاهرة", address: "شارع 5", cart_items: [{ product: { name: "سوار" }, quantity: 1, price: 450 }], total_cost: 450 };
    const r = await request(app).post("/api/webhooks/easyorder").set("x-webhook-secret", channelSecretA).send(create);
    expect([r.status, r.body]).toEqual([202, { received: true, action: "deferred" }]);
    expect(await logs()).toEqual(["deferred"]);
    expect((await q("SELECT COUNT(*) n FROM orders WHERE businessId = ?", [A.businessId]))[0].n).toBe(ordersBefore);
    const [saved] = await q("SELECT rawPayload FROM webhook_logs WHERE businessId = ? AND eventType = 'deferred'", [A.businessId]);
    expect(JSON.parse(saved.rawPayload).id).toBe(create.id); // الـpayload محفوظ كامل
    const upd = await request(app).post("/api/webhooks/easyorder").set("x-webhook-secret", channelSecretA).send({ event_type: "order-status-update", order_id: `ext-missing-${tmp.name}`, new_status: "confirmed" });
    expect(upd.body?.action).not.toBe("deferred");
    expect((await logs()).filter((e: string) => e === "deferred")).toHaveLength(1);
    // التصريف مابيشتغلش والشركة منتهية؛ بعد التجديد بيتعالج مرة واحدة.
    expect((await drainDeferredWebhooks()).tenants[A.tenantId]).toBe("not_full");
    expect((await logs())[0]).toBe("deferred");
    await recordManualPayment({ tenantId: A.tenantId, planCode: "month_1", idempotencyKey: `renew-${tmp.name}`, paymentReference: `RENEW-${tmp.name.slice(-6)}`, note: "تجديد بعد الانتهاء", platformAdminId: 1 });
    expect((await resolveTenantAccess(A.tenantId)).level).toBe("full");
    await Promise.all([drainDeferredWebhooks(), drainDeferredWebhooks()]);
    expect((await logs())[0]).toBe("deferred_done");
    expect((await logs()).filter((e: string) => e === "deferred")).toHaveLength(0);
  });

  it("tRPC للشركة المنتهية: العمليات التجارية الجديدة مرفوضة، والتصحيح والعرض والاشتراك مسموحين", async () => {
    // ترجيع A لحالة منتهية: إلغاء فترة التجديد مباشرة على القاعدة المؤقتة بس (محاكاة)، بدون تعديل أي كود.
    await q("UPDATE subscription_periods SET voidedAt = NOW(3), voidReason = 'test reset' WHERE tenantId = ? AND voidedAt IS NULL AND endsAt > NOW()", [A.tenantId]);
    expect((await resolveTenantAccess(A.tenantId)).reason).toBe("subscription_expired");
    for (const p of ["orders.create", "orders.confirm", "orders.sendToBosta", "orders.bulkSendToBosta", "facebookEntry.create", "orders.duplicate"])
      await expect(assertTrpcTenantAccess(A.tenantId, "mutation", p), p).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const p of ["orders.cancel", "returns.markAsReturned", "printLogs.create", "orders.bostaLinkShipment", "subscription.createCheckout", "auth.logout"])
      await expect(assertTrpcTenantAccess(A.tenantId, "mutation", p), p).resolves.toBeUndefined();
    await expect(assertTrpcTenantAccess(A.tenantId, "query", "orders.list")).resolves.toBeUndefined();
    await expect(assertTrpcTenantAccess(L.tenantId, "mutation", "orders.create")).resolves.toBeUndefined();
  });
});
