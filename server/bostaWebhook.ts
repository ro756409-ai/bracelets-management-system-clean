/**
 * Bosta Webhook Handler
 * يستقبل تحديثات حالة الشحنات من Bosta تلقائياً
 *
 * Webhook URL: /api/webhooks/bosta
 * Header: x-bosta-secret: <BOSTA_WEBHOOK_SECRET>
 *
 * يحدّث bostaStatus (النص الكامل من Bosta) دائماً، ويحدّث orders.status الأساسي فقط
 * عند وصول كود حالة معروف ومؤكد (راجع BOSTA_STATUS_TO_ORDER_STATUS تحت) — الحالات غير
 * المعروفة/غير الحاسمة تحدّث bostaStatus فقط ولا تلمس status الأساسي.
 */
import { Request, Response, Express } from "express";
import { timingSafeEqual } from "crypto";
import { getDb } from "./db";
import { orders } from "../drizzle/schema";
import type { Order } from "../drizzle/schema";
import { eq } from "drizzle-orm";

type OrderStatus = Order["status"];

// ==================== Bosta Status Mapping ====================
// حالات Bosta الرسمية وترجمتها (تُحفظ كاملة في bostaStatus بغض النظر عن الخريطة تحت)
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

/**
 * خريطة مركزية: أكواد Bosta المؤكدة/الحاسمة فقط → orders.status الداخلي.
 *
 * "مؤكدة" يعني نتيجة نهائية واضحة، مش مرحلة عابرة. مُستبعد عمداً:
 * - 50 (في طريق الإرجاع) — لسه ما اترجعش فعلياً، مجرد نقل.
 * أي كود مش موجود هنا (بما فيها أكواد Bosta جديدة غير معروفة) يسيب status الأساسي زي ما هو.
 *
 * ملحوظة: 31 (تم التسليم جزئياً) اتحطت "delivered" كأقرب حالة متاحة في enum الحالي —
 * لو ده مش الصح تجاريًا (مثلاً محتاج يبقى preparing/no_answer أو حالة منفصلة)، عدّلها هنا.
 */
const BOSTA_STATUS_TO_ORDER_STATUS: Record<number, OrderStatus> = {
  10: "shipped", // تم الاستلام من عندنا
  20: "shipped", // في المستودع
  21: "shipped",
  22: "shipped",
  24: "shipped", // في طريق التسليم
  30: "delivered", // تم التسليم
  31: "delivered", // تم التسليم جزئياً — أقرب حالة متاحة، راجع الملحوظة فوق
  41: "returned",
  42: "returned",
  43: "returned",
  44: "returned",
  45: "returned",
  46: "returned",
  47: "returned",
  48: "returned",
  49: "returned",
  60: "returned", // تم الإرجاع فعليًا
};

/** مقارنة آمنة (constant-time) لتفادي تسريب معلومات عن السر عبر توقيت الاستجابة. */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ==================== Webhook Handler ====================
async function handleBostaWebhook(req: Request, res: Response) {
  try {
    // 1. رفض أي طلب لو BOSTA_WEBHOOK_SECRET غير مضبوط في البيئة — بدون أي استثناء.
    const expectedSecret = process.env.BOSTA_WEBHOOK_SECRET;
    if (!expectedSecret) {
      console.error("[Bosta Webhook] BOSTA_WEBHOOK_SECRET غير مضبوط في البيئة — رفض الطلب");
      return res.status(503).json({ error: "Webhook not configured" });
    }

    // 2. التحقق من مفتاح التوثيق عبر header ثابت واحد + مقارنة آمنة
    const receivedSecret = req.headers["x-bosta-secret"];
    if (typeof receivedSecret !== "string" || !safeCompare(receivedSecret, expectedSecret)) {
      console.warn("[Bosta Webhook] Unauthorized request - invalid or missing secret");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = req.body;
    console.log("[Bosta Webhook] Received:", JSON.stringify(payload).slice(0, 500));

    // 3. استخراج بيانات الشحنة
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

    // 4. تحديد الحالة العربية الكاملة (تُحفظ في bostaStatus دائمًا)
    const arabicStatus =
      (stateCode ? BOSTA_STATUS_MAP[stateCode] : undefined) ||
      stateValue ||
      "تم التحديث";

    // 5. تحديد هل الكود ده يغيّر status الأساسي أم لا (حالات مؤكدة فقط)
    const mappedOrderStatus = stateCode ? BOSTA_STATUS_TO_ORDER_STATUS[stateCode] : undefined;

    // 6. البحث عن الأوردر في قاعدة البيانات
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

    // 7. تحديث حالة الشحنة في قاعدة البيانات — bostaStatus دائمًا، status الأساسي فقط لو الكود مؤكد
    await drizzle
      .update(orders)
      .set({
        bostaStatus: arabicStatus,
        ...(trackingNumber ? { bostaTrackingNumber: trackingNumber } : {}),
        ...(mappedOrderStatus ? { status: mappedOrderStatus } : {}),
      })
      .where(eq(orders.id, order.id));

    console.log(
      `[Bosta Webhook] ✅ Order #${order.orderNumber} updated → bostaStatus=${arabicStatus} (code: ${stateCode})` +
        (mappedOrderStatus ? `, status → ${mappedOrderStatus}` : ", status unchanged (unmapped code)")
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

  // Health check للتأكد من أن الـ endpoint شغال — قيم منطقية فقط، بدون أي كشف لقيم الأسرار
  app.get("/api/webhooks/bosta/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      message: "Bosta webhook endpoint is active",
      hasApiKey: Boolean(process.env.BOSTA_API_KEY),
      hasWebhookSecret: Boolean(process.env.BOSTA_WEBHOOK_SECRET),
      hasPickupAddressId: Boolean(process.env.BOSTA_PICKUP_ADDRESS_ID),
    });
  });
}
