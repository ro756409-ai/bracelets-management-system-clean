/**
 * Platform Admin — فوترة الاشتراك (0055). REST تحت /api/platform/billing، محمي بجلسة المنصة (requirePlatformAdmin) +
 * Origin للكتابة. خلف SUBSCRIPTION_BILLING_ENABLED (معطل ⇒ 503 بلا أي قراءة لجداول 0055).
 *
 *  • العرض: أي أدمن منصة. الكتابة (تسجيل شركة، دفع يدوي، استرداد): أدمن منصة **مخوَّل للفوترة** بس (PLATFORM_BILLING_ADMIN_IDS)
 *    — صلاحية منفصلة عن قبول التسجيلات.
 *  • الدفع اليدوي: مرجع دفع + دليل (رابط https أو وصف) + مفتاح idempotency إلزامي. الاسترداد: سبب إلزامي.
 *  • كل محاولة كتابة (ناجحة أو مرفوضة) بتتسجّل في platform_audit_logs — من غير أسرار ولا بيانات بطاقات.
 */
import { Router, type Express, type Request, type Response } from "express";
import { addPlatformAuditLog, getDb } from "./db";
import { requirePlatformAdmin, isOriginAllowed, clientIp, type PlatformRequest } from "./platformAuth";
import {
  BillingError, enrollTenant, getBillingOverview, isBillingPlatformAdmin, recordManualPayment, refundPayment, subscriptionBillingEnabled,
} from "./subscriptionBilling.service";

const STATUS_BY_CODE = { not_found: 404, conflict: 409, invalid: 400, unavailable: 503 } as const;

function fail(res: Response, e: unknown) {
  if (e instanceof BillingError) return res.status(STATUS_BY_CODE[e.code]).json({ success: false, error: e.message });
  console.error("[platformBilling] failed:", (e as Error)?.message);
  return res.status(500).json({ success: false, error: "خطأ داخلي" });
}
const idParam = (v: string) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

export function registerPlatformBillingRoutes(app: Express) {
  const router = Router();
  router.use("/billing", (_req, res, next) => (subscriptionBillingEnabled() ? next() : res.status(503).json({ error: "نظام الاشتراك غير مفعّل" })));
  router.use("/billing", requirePlatformAdmin);

  /** حارس الكتابة: Origin + JSON + أدمن مخوَّل للفوترة. الرفض بيتسجّل. */
  const guardWrite = async (req: Request, res: Response, action: string, targetType: string, targetId: number | null) => {
    const admin = (req as PlatformRequest).platformAdmin!;
    if (!isOriginAllowed(req)) { res.status(403).json({ success: false, error: "مصدر غير مسموح" }); return null; }
    if (!req.is("application/json")) { res.status(415).json({ success: false, error: "نوع المحتوى غير مدعوم" }); return null; }
    if (!isBillingPlatformAdmin(admin.id)) {
      await addPlatformAuditLog({ platformAdminId: admin.id, action: `${action}_denied`, targetType, targetId, details: JSON.stringify({ reason: "not_billing_admin" }), ipAddress: clientIp(req) });
      res.status(403).json({ success: false, error: "الفوترة لأدمن منصة مخوَّل فقط" });
      return null;
    }
    return admin;
  };

  // GET /api/platform/billing/tenants/:id
  router.get("/billing/tenants/:id", async (req, res) => {
    const tenantId = idParam(req.params.id);
    if (!tenantId) return res.status(400).json({ error: "معرّف غير صالح" });
    try { return res.json({ tenantId, ...(await getBillingOverview(tenantId)) }); } catch (e) { return fail(res, e); }
  });

  // POST /api/platform/billing/tenants/:id/enroll — تسجيل شركة قائمة صراحةً (قرار انتقال لكل شركة على حدة)
  router.post("/billing/tenants/:id/enroll", async (req, res) => {
    const tenantId = idParam(req.params.id);
    if (!tenantId) return res.status(400).json({ error: "معرّف غير صالح" });
    const admin = await guardWrite(req, res, "billing_enroll", "tenant", tenantId);
    if (!admin) return;
    try {
      const db = await getDb();
      if (!db) throw new BillingError("قاعدة البيانات غير متاحة", "unavailable");
      const r = await enrollTenant(db, { tenantId, by: "platform_admin", platformAdminId: admin.id });
      await addPlatformAuditLog({ platformAdminId: admin.id, action: "billing_enroll", targetType: "tenant", targetId: tenantId, details: JSON.stringify({ created: r.created }), ipAddress: clientIp(req) });
      return res.json({ success: true, created: r.created });
    } catch (e) { return fail(res, e); }
  });

  // POST /api/platform/billing/tenants/:id/manual-payment { planCode, idempotencyKey, paymentReference, evidenceUrl?, note? }
  router.post("/billing/tenants/:id/manual-payment", async (req, res) => {
    const tenantId = idParam(req.params.id);
    if (!tenantId) return res.status(400).json({ error: "معرّف غير صالح" });
    const admin = await guardWrite(req, res, "billing_manual_payment", "tenant", tenantId);
    if (!admin) return;
    const b = req.body ?? {};
    try {
      const r = await recordManualPayment({
        tenantId, planCode: str(b.planCode, 20) ?? "", idempotencyKey: str(b.idempotencyKey, 100) ?? "",
        paymentReference: str(b.paymentReference, 200) ?? "", evidenceUrl: str(b.evidenceUrl, 500) ?? null, note: str(b.note, 2000) ?? null,
        platformAdminId: admin.id,
      });
      if (!r.replay)
        await addPlatformAuditLog({
          platformAdminId: admin.id, action: "billing_manual_payment", targetType: "tenant", targetId: tenantId, ipAddress: clientIp(req),
          details: JSON.stringify({ paymentId: r.payment.id, planCode: r.payment.planCode, amountMinor: r.payment.amountMinor, paymentReference: r.payment.paymentReference, hasEvidenceUrl: Boolean(b.evidenceUrl), periodStartsAt: r.period.startsAt, periodEndsAt: r.period.endsAt }),
        });
      return res.json({ success: true, replay: r.replay, paymentId: r.payment.id, period: { startsAt: r.period.startsAt, endsAt: r.period.endsAt } });
    } catch (e) {
      await addPlatformAuditLog({ platformAdminId: admin.id, action: "billing_manual_payment_failed", targetType: "tenant", targetId: tenantId, ipAddress: clientIp(req), details: JSON.stringify({ error: e instanceof BillingError ? e.code : "internal" }) });
      return fail(res, e);
    }
  });

  // POST /api/platform/billing/payments/:id/refund { reason }
  router.post("/billing/payments/:id/refund", async (req, res) => {
    const paymentId = idParam(req.params.id);
    if (!paymentId) return res.status(400).json({ error: "معرّف غير صالح" });
    const admin = await guardWrite(req, res, "billing_refund", "subscription_payment", paymentId);
    if (!admin) return;
    try {
      const r = await refundPayment({ paymentId, reason: str(req.body?.reason, 300) ?? "" });
      await addPlatformAuditLog({ platformAdminId: admin.id, action: "billing_refund", targetType: "subscription_payment", targetId: paymentId, ipAddress: clientIp(req), details: JSON.stringify({ tenantId: r.payment.tenantId, periodId: r.period.id }) });
      return res.json({ success: true });
    } catch (e) { return fail(res, e); }
  });

  app.use("/api/platform", router);
}
