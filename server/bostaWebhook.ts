/**
 * Bosta Webhook Handler
 * يستقبل تحديثات حالة الشحنات من Bosta تلقائياً
 *
 * Webhook URL: /api/webhooks/bosta
 * Header: x-bosta-secret: <BOSTA_WEBHOOK_SECRET>
 *
 * يحدّث bostaStatus في جدول orders عند تغيير حالة الشحنة
 */
import { Request, Response, Express } from "express";
import { getDb } from "./db";
import { orders } from "../drizzle/schema";
import { eq } from "drizzle-orm";

// ==================== Bosta Status Mapping ====================
// حالات Bosta الرسمية وترجمتها
const BOSTA_STATUS_MAP: Record<number, string> = {
  10: "تم الاستلام",
  20: "في المستودع",
  21: "في مستودع الفرع",
  22: "في مستودع المنطقة",
  24: "في طريق التسليم",
  30: "تم التسليم",
  31: "تم التسليم جزئياً",
  41: "مرتجع - لم يُستلم",
  42: "مرتجع - رُفض",
  43: "مرتجع - عنوان خاطئ",
  44: "مرتجع - لم يُتصل به",
  45: "مرتجع - تالف",
  46: "مرتجع",
  47: "مرتجع - تأجيل",
  48: "مرتجع - طلب العميل",
  49: "مرتجع - مشكلة في الدفع",
  50: "في طريق الإرجاع",
  60: "تم الإرجاع",
};

// ==================== Webhook Handler ====================
async function handleBostaWebhook(req: Request, res: Response) {
  try {
    // 1. التحقق من مفتاح التوثيق
    const expectedSecret = process.env.BOSTA_WEBHOOK_SECRET;
    if (expectedSecret) {
      const receivedSecret =
        (req.headers["x-bosta-secret"] as string) ||
        (req.headers["x-webhook-secret"] as string);
      if (!receivedSecret || receivedSecret !== expectedSecret) {
        console.warn("[Bosta Webhook] Unauthorized request - invalid secret");
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const payload = req.body;
    console.log("[Bosta Webhook] Received:", JSON.stringify(payload).slice(0, 500));

    // 2. استخراج بيانات الشحنة
    // Bosta ترسل: { _id, trackingNumber, state: { code, value }, ... }
    const shipmentId: string | undefined =
      payload._id || payload.id || payload.shipmentId;
    const trackingNumber: string | undefined =
      payload.trackingNumber || payload.tracking_number;
    const stateCode: number | undefined =
      payload.state?.code || payload.status_code;
    const stateValue: string | undefined =
      payload.state?.value || payload.status;

    if (!shipmentId && !trackingNumber) {
      console.warn("[Bosta Webhook] Missing shipmentId and trackingNumber");
      return res.status(400).json({ error: "Missing shipment identifier" });
    }

    // 3. تحديد الحالة العربية
    const arabicStatus =
      (stateCode ? BOSTA_STATUS_MAP[stateCode] : undefined) ||
      stateValue ||
      "تم التحديث";

    // 4. البحث عن الأوردر في قاعدة البيانات
    const drizzle = await getDb();
    if (!drizzle) {
      console.error("[Bosta Webhook] DB not available");
      return res.status(500).json({ error: "DB not available" });
    }
    let order = null;

    if (shipmentId) {
      const [found] = await drizzle
        .select()
        .from(orders)
        .where(eq(orders.bostaShipmentId, shipmentId))
        .limit(1);
      order = found;
    }

    if (!order && trackingNumber) {
      const [found] = await drizzle
        .select()
        .from(orders)
        .where(eq(orders.bostaTrackingNumber, trackingNumber))
        .limit(1);
      order = found;
    }

    if (!order) {
      console.warn(
        `[Bosta Webhook] Order not found for shipmentId=${shipmentId} trackingNumber=${trackingNumber}`
      );
      // نرجع 200 عشان Bosta ما تكررش الإرسال
      return res.status(200).json({ ok: true, message: "Order not found, ignored" });
    }

    // 5. تحديث حالة الشحنة في قاعدة البيانات
    await drizzle
      .update(orders)
      .set({
        bostaStatus: arabicStatus,
        ...(trackingNumber ? { bostaTrackingNumber: trackingNumber } : {}),
      })
      .where(eq(orders.id, order.id));

    console.log(
      `[Bosta Webhook] ✅ Order #${order.orderNumber} updated → ${arabicStatus} (code: ${stateCode})`
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[Bosta Webhook] Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ==================== Register Routes ====================
export function registerBostaWebhookRoutes(app: Express) {
  // Bosta webhook endpoint
  app.post("/api/webhooks/bosta", handleBostaWebhook);

  // Health check للتأكد من أن الـ endpoint شغال
  app.get("/api/webhooks/bosta/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      message: "Bosta webhook endpoint is active",
      hasSecret: !!process.env.BOSTA_WEBHOOK_SECRET,
    });
  });
}
