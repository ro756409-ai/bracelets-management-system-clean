import type { Express, Request, Response } from "express";
import { applyProviderEvent, BillingError, subscriptionBillingEnabled } from "../subscriptionBilling.service";
import { getPaymentProvider } from "./registry";
import { ProviderBlockedError } from "./provider";

/**
 * POST /api/webhooks/payments/:provider — body **خام** (express.raw قبل JSON العام) عشان التحقق من التوقيع على البايتات نفسها.
 *  • العلم معطل / المزوّد مش هو المفعّل ⇒ 404 (مفيش سطح غير مستخدم).
 *  • توقيع غير صالح ⇒ 401 بلا أي قراءة/كتابة. حدث صالح ⇒ applyProviderEvent (idempotent): 200 حتى للتكرار.
 *  • تعارض (مبلغ/مرجع/حالة) ⇒ 409 — المزوّد ممكن يعيد، والنتيجة نفسها؛ ومفيش تفعيل.
 */
export function registerPaymentWebhookRoutes(app: Express) {
  app.post("/api/webhooks/payments/:provider", async (req: Request, res: Response) => {
    if (!subscriptionBillingEnabled()) return res.status(404).json({ error: "Not found" });
    let provider;
    try { provider = getPaymentProvider(); } catch (e) { if (e instanceof ProviderBlockedError) return res.status(404).json({ error: "Not found" }); throw e; }
    if (!provider || provider.id !== req.params.provider) return res.status(404).json({ error: "Not found" });
    const raw = Buffer.isBuffer(req.body) ? req.body : null;
    if (!raw || raw.length === 0 || raw.length > 64 * 1024) return res.status(400).json({ error: "Bad request" });
    const event = provider.verifyWebhook(raw, req.headers);
    if (!event) return res.status(401).json({ error: "Unauthorized" });
    try {
      const r = await applyProviderEvent(event);
      return res.status(200).json({ received: true, status: r.status, changed: r.changed });
    } catch (e) {
      if (e instanceof BillingError) return res.status(e.code === "not_found" ? 404 : e.code === "unavailable" ? 503 : 409).json({ received: false, error: e.message });
      console.error("[payments webhook] failed:", (e as Error)?.message);
      return res.status(500).json({ error: "Internal server error" });
    }
  });
}
