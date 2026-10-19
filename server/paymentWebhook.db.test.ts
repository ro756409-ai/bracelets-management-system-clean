import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import express from "express";
import request from "supertest";
import { drizzle } from "drizzle-orm/mysql2";
import { __setDbForTests, getDb } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { runHandMigration, confirmPhrase } from "./handMigration.service";
import { ORDER_EVENTS_MIGRATION } from "./orderEventsMigration";
import { SUBSCRIPTION_BILLING_MIGRATION, SUBSCRIPTION_BILLING_FILE } from "./subscriptionBillingMigration";
import { createPendingPayment, enrollTenant } from "./subscriptionBilling.service";
import { registerPaymentWebhookRoutes } from "./payments/webhook";
import { signMockPayload } from "./payments/mockProvider";

/** ويبهوك الدفع من أوله لآخره: body خام ⇒ توقيع ⇒ applyProviderEvent ⇒ فترة — قاعدة مؤقتة ومزوّد وهمي بس. */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const ENV = ["SUBSCRIPTION_BILLING_ENABLED", "SUBSCRIPTION_PAYMENT_PROVIDER", "MOCK_PAYMENT_WEBHOOK_SECRET", "DEPLOY_ENV"] as const;
const SECRET = "mock-webhook-secret-".padEnd(40, "w");

describe.runIf(CAN)("💳 ويبهوك الدفع (mock) على قاعدة مؤقتة", { timeout: 120_000 }, () => {
  let tmp: TempSchema; let A: CoreTestFixture;
  const saved: Record<string, string | undefined> = {};
  const app = express();
  app.use("/api/webhooks/payments", express.raw({ type: "*/*", limit: "64kb" }));
  app.use(express.json());
  registerPaymentWebhookRoutes(app);
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const send = (o: object, opts: { secret?: string; ts?: number; provider?: string } = {}) => {
    const raw = JSON.stringify(o); const t = opts.ts ?? Math.floor(Date.now() / 1000);
    return request(app).post(`/api/webhooks/payments/${opts.provider ?? "mock"}`).set("Content-Type", "application/json")
      .set("x-mock-timestamp", String(t)).set("x-mock-signature", signMockPayload(opts.secret ?? SECRET, raw, t)).send(raw);
  };

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, { SUBSCRIPTION_BILLING_ENABLED: "true", SUBSCRIPTION_PAYMENT_PROVIDER: "mock", MOCK_PAYMENT_WEBHOOK_SECRET: SECRET, DEPLOY_ENV: "test" });
    tmp = await createTempSchema("paywh");
    for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [SUBSCRIPTION_BILLING_MIGRATION, SUBSCRIPTION_BILLING_FILE, "0055"]] as const)
      expect((await runHandMigration(def, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync(file, "utf-8"), deployEnv: "test", confirm: confirmPhrase(id, "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("paywh-a");
    await enrollTenant((await getDb())!, { tenantId: A.tenantId, by: "signup" });
  }, 240_000);
  afterAll(async () => {
    for (const k of ENV) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
    __setDbForTests(null); await tmp?.drop();
  }, 120_000);

  it("توقيع غلط/مزوّد غير مفعّل ⇒ رفض بلا أي كتابة؛ صحيح ⇒ تفعيل مرة واحدة؛ التكرار بلا أثر؛ مبلغ غلط ⇒ 409", async () => {
    const { payment } = await createPendingPayment({ tenantId: A.tenantId, planCode: "month_5", provider: "mock", idempotencyKey: `wh-${Date.now()}` });
    const ev = { paymentId: payment.id, providerRef: `mock-ref-${payment.id}`, outcome: "succeeded", amountMinor: 199_900, currency: "EGP" };

    expect((await send(ev, { secret: "attacker-secret-".padEnd(40, "a") })).status).toBe(401);
    expect((await send(ev, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await send(ev, { provider: "paymob" })).status).toBe(404);
    expect((await send({ ...ev, amountMinor: 50_000 })).status).toBe(409);
    expect((await q("SELECT COUNT(*) n FROM subscription_periods WHERE tenantId = ?", [A.tenantId]))[0].n).toBe(0);

    const ok = await send(ev);
    expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ status: "succeeded", changed: true });
    const dup = await send(ev);
    expect(dup.status).toBe(200); expect(dup.body).toMatchObject({ status: "succeeded", changed: false });
    expect((await q("SELECT COUNT(*) n FROM subscription_periods WHERE tenantId = ?", [A.tenantId]))[0].n).toBe(1);
    const [p] = await q("SELECT status, providerRef FROM subscription_payments WHERE id = ?", [payment.id]);
    expect(p).toMatchObject({ status: "succeeded", providerRef: `mock-ref-${payment.id}` });

    process.env.SUBSCRIPTION_BILLING_ENABLED = "false";
    expect((await send(ev)).status).toBe(404);
    process.env.SUBSCRIPTION_BILLING_ENABLED = "true";
  });
});
