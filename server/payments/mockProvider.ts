import { createHmac, timingSafeEqual } from "crypto";
import type { PaymentRow, VerifiedProviderEvent } from "../subscriptionBilling.service";
import type { CheckoutSession, SubscriptionPaymentProvider } from "./provider";

/**
 * مزوّد **وهمي** للاختبارات والتجربة المحلية فقط — مش مزوّد حقيقي ومابيلمسش أي شبكة.
 * التوقيع (عقد داخلي من تصميمنا، مش صيغة أي مزوّد حقيقي): `x-mock-signature = hex(HMAC-SHA256(secret, "<timestamp>.<rawBody>"))`
 * و`x-mock-timestamp` بالثواني؛ فرق أكتر من 5 دقايق ⇒ مرفوض (منع إعادة الإرسال). السر من MOCK_PAYMENT_WEBHOOK_SECRET.
 * مقفول في الإنتاج (registry بيرفضه لو DEPLOY_ENV=production).
 */
export const MOCK_TOLERANCE_MS = 5 * 60 * 1000;
const OUTCOMES = new Set(["succeeded", "failed", "refunded"]);

export function signMockPayload(secret: string, rawBody: string | Buffer, timestampSec: number): string {
  return createHmac("sha256", secret).update(`${timestampSec}.`).update(rawBody).digest("hex");
}

const header = (h: Record<string, string | string[] | undefined>, k: string) => { const v = h[k]; return Array.isArray(v) ? v[0] : v; };

export function createMockProvider(secret: string | undefined): SubscriptionPaymentProvider {
  return {
    id: "mock",
    async createCheckout(payment: PaymentRow): Promise<CheckoutSession> {
      return { mode: "mock", providerRef: `mock-${payment.id}-${payment.idempotencyKey}`.slice(0, 120) };
    },
    verifyWebhook(rawBody, headers, now = new Date()): VerifiedProviderEvent | null {
      if (!secret || secret.length < 16) return null; // بلا سر كافي ⇒ مفيش حدث يتقبل (fail-closed)
      const sig = header(headers, "x-mock-signature") ?? "";
      const ts = Number(header(headers, "x-mock-timestamp"));
      if (!/^[0-9a-f]{64}$/.test(sig) || !Number.isInteger(ts)) return null;
      if (Math.abs(now.getTime() - ts * 1000) > MOCK_TOLERANCE_MS) return null;
      const expected = Buffer.from(signMockPayload(secret, rawBody, ts), "hex");
      const got = Buffer.from(sig, "hex");
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
      let body: any;
      try { body = JSON.parse(rawBody.toString("utf8")); } catch { return null; }
      const paymentId = Number(body?.paymentId), amountMinor = Number(body?.amountMinor);
      if (!Number.isInteger(paymentId) || paymentId <= 0 || !Number.isInteger(amountMinor) || !OUTCOMES.has(body?.outcome)) return null;
      if (typeof body.providerRef !== "string" || !body.providerRef || typeof body.currency !== "string") return null;
      return { provider: "mock", paymentId, providerRef: body.providerRef.slice(0, 120), outcome: body.outcome, amountMinor, currency: body.currency, reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : null };
    },
  };
}
