import { createMockProvider } from "./mockProvider";
import { ProviderBlockedError, type ProviderId, type SubscriptionPaymentProvider } from "./provider";

/**
 * المزوّدين المتاحين للاشتراك. الافتراضي: **لا شيء** (الدفع اليدوي من أدمن المنصة بس).
 *   SUBSCRIPTION_PAYMENT_PROVIDER=mock ⇒ المزوّد الوهمي — مرفوض لو DEPLOY_ENV=production.
 *   paymob / fawry ⇒ ProviderBlockedError (BLOCKED لحد وصول الوثائق الرسمية والـSandbox).
 */
export function configuredProviderId(): ProviderId | null {
  const v = (process.env.SUBSCRIPTION_PAYMENT_PROVIDER ?? "").trim();
  return v === "mock" || v === "paymob" || v === "fawry" ? v : null;
}

export function getPaymentProvider(id: string | null | undefined = configuredProviderId()): SubscriptionPaymentProvider | null {
  if (!id) return null;
  if (id === "mock") {
    const deployEnv = (process.env.DEPLOY_ENV ?? "").trim();
    // الإنتاج (صراحةً، أو NODE_ENV=production بلا DEPLOY_ENV) ⇒ لا مزوّد وهمي أبدًا.
    if (deployEnv === "production" || (process.env.NODE_ENV === "production" && deployEnv === "")) return null;
    return createMockProvider(process.env.MOCK_PAYMENT_WEBHOOK_SECRET);
  }
  if (id === "paymob" || id === "fawry") throw new ProviderBlockedError(id);
  return null;
}

/** للعرض بس: فيه مزوّد أونلاين شغال؟ (BLOCKED/غير مضبوط ⇒ false). */
export function onlineCheckoutAvailable(): boolean {
  try { return getPaymentProvider() != null; } catch { return false; }
}
