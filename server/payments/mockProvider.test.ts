import { describe, it, expect, afterEach } from "vitest";
import { createMockProvider, signMockPayload, MOCK_TOLERANCE_MS } from "./mockProvider";
import { getPaymentProvider, configuredProviderId } from "./registry";
import { ProviderBlockedError } from "./provider";

const SECRET = "mock-test-secret-".padEnd(40, "s");
const now = new Date("2026-06-01T12:00:00Z");
const ts = Math.floor(now.getTime() / 1000);
const body = (o: object = {}) => Buffer.from(JSON.stringify({ paymentId: 5, providerRef: "mock-5", outcome: "succeeded", amountMinor: 50000, currency: "EGP", ...o }));
const headers = (raw: Buffer, t = ts, secret = SECRET) => ({ "x-mock-signature": signMockPayload(secret, raw, t), "x-mock-timestamp": String(t) });

describe("💳 المزوّد الوهمي — التحقق من التوقيع", () => {
  const p = createMockProvider(SECRET);
  it("توقيع صحيح ⇒ حدث متحقَّق", () => {
    const raw = body();
    expect(p.verifyWebhook(raw, headers(raw), now)).toEqual({ provider: "mock", paymentId: 5, providerRef: "mock-5", outcome: "succeeded", amountMinor: 50000, currency: "EGP", reason: null });
  });
  it("أي تعديل في البايتات بعد التوقيع ⇒ مرفوض", () => {
    const raw = body(); const h = headers(raw);
    expect(p.verifyWebhook(body({ amountMinor: 1 }), h, now)).toBeNull();
    expect(p.verifyWebhook(Buffer.from(raw.toString() + " "), h, now)).toBeNull();
  });
  it("سر مختلف / توقيع ناقص / وقت قديم أو مستقبلي ⇒ مرفوض", () => {
    const raw = body();
    expect(p.verifyWebhook(raw, headers(raw, ts, "other-secret-".padEnd(40, "o")), now)).toBeNull();
    expect(p.verifyWebhook(raw, { "x-mock-timestamp": String(ts) }, now)).toBeNull();
    expect(p.verifyWebhook(raw, { ...headers(raw), "x-mock-signature": "zz" }, now)).toBeNull();
    const old = ts - MOCK_TOLERANCE_MS / 1000 - 1;
    expect(p.verifyWebhook(raw, headers(raw, old), now)).toBeNull();
    const future = ts + MOCK_TOLERANCE_MS / 1000 + 1;
    expect(p.verifyWebhook(raw, headers(raw, future), now)).toBeNull();
  });
  it("صيغة غير صالحة (نتيجة/مبلغ/JSON) ⇒ مرفوض حتى بتوقيع صحيح", () => {
    for (const raw of [body({ outcome: "paid" }), body({ amountMinor: "50000.5" }), body({ paymentId: 0 }), Buffer.from("not json")])
      expect(p.verifyWebhook(raw, headers(raw), now)).toBeNull();
  });
  it("بلا سر أو سر قصير ⇒ لا حدث يتقبل أبدًا", () => {
    const raw = body();
    expect(createMockProvider(undefined).verifyWebhook(raw, headers(raw), now)).toBeNull();
    expect(createMockProvider("short").verifyWebhook(raw, headers(raw, ts, "short"), now)).toBeNull();
  });
});

describe("💳 السجل — الافتراضي لا مزوّد، الوهمي ممنوع في الإنتاج، Paymob/Fawry BLOCKED", () => {
  const saved = { ...process.env };
  afterEach(() => { for (const k of ["SUBSCRIPTION_PAYMENT_PROVIDER", "DEPLOY_ENV", "NODE_ENV", "MOCK_PAYMENT_WEBHOOK_SECRET"]) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } });
  it("بلا إعداد ⇒ null", () => { delete process.env.SUBSCRIPTION_PAYMENT_PROVIDER; expect(configuredProviderId()).toBeNull(); expect(getPaymentProvider()).toBeNull(); });
  it("mock: متاح في test/staging، ممنوع في production (صراحةً أو NODE_ENV بلا DEPLOY_ENV)", () => {
    process.env.SUBSCRIPTION_PAYMENT_PROVIDER = "mock";
    process.env.DEPLOY_ENV = "test"; expect(getPaymentProvider()?.id).toBe("mock");
    process.env.DEPLOY_ENV = "production"; expect(getPaymentProvider()).toBeNull();
    delete process.env.DEPLOY_ENV; process.env.NODE_ENV = "production"; expect(getPaymentProvider()).toBeNull();
  });
  it("paymob/fawry ⇒ ProviderBlockedError (لا endpoints ولا توقيعات مخترعة)", () => {
    expect(() => getPaymentProvider("paymob")).toThrow(ProviderBlockedError);
    expect(() => getPaymentProvider("fawry")).toThrow(ProviderBlockedError);
  });
});
