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
import { timingSafeEqual, createHash } from "crypto";
import { getDb } from "./db";
import { businesses, orders } from "../drizzle/schema";
import type { Order } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { processProviderWebhook } from "./providerWebhookV2.service";
import { findAccountByWebhookSecret, getCarrierAccountRow, recordWebhookEvent, PROVIDER_BOSTA } from "./carrierAccounts.service";

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
  // 31 (partially delivered) is intentionally pending and never recognizes Revenue/COGS.
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
//
// ترتيب العزل **ثابت**: السر → hash → حساب الشحن والنشاط → الأوردر بشرط
// (businessId + bostaShipmentId). ممنوع البحث عن الشحنة عالميًا ثم استنتاج النشاط —
// ده اللي كان بيسمح لحدث نشاط يلمس أوردر نشاط تاني. الـidempotency بقيد فريد على
// (businessId, provider, eventHash). مسار المفتاح العام (`BOSTA_WEBHOOK_SECRET`) بيفضل
// لفترة الانتقال بس، ومقيّد بالأنشطة اللي **مالهاش** صف حساب شحن.
export async function handleBostaWebhook(req: Request, res: Response) {
  try {
    const receivedSecret = req.headers["x-bosta-secret"];
    if (typeof receivedSecret !== "string" || !receivedSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 1) السر → hash → النشاط. مفيش أي قراءة أوردر قبل السطر ده.
    const account = await findAccountByWebhookSecret(receivedSecret);
    let businessId: number | null = account?.businessId ?? null;
    let legacy = false;
    if (!businessId) {
      const envSecret = process.env.BOSTA_WEBHOOK_SECRET;
      if (envSecret && safeCompare(receivedSecret, envSecret)) legacy = true;
      else {
        console.warn("[Bosta Webhook] Unauthorized request - unknown secret");
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const payload = req.body ?? {};
    console.log("[Bosta Webhook] Received:", JSON.stringify(payload).slice(0, 500));
    const shipmentId: string | undefined = payload._id || payload.id || payload.shipmentId;
    const trackingNumber: string | undefined = payload.trackingNumber || payload.tracking_number;
    const stateCode: number | undefined = payload.state?.code || payload.status_code;
    const stateValue: string | undefined = payload.state?.value || payload.status;
    if (!shipmentId && !trackingNumber) {
      return res.status(400).json({ error: "Missing shipment identifier" });
    }
    const occurredAtRaw = payload.updatedAt || payload.updated_at || payload.timestamp;
    const occurredAt = occurredAtRaw && !Number.isNaN(new Date(occurredAtRaw).getTime()) ? new Date(occurredAtRaw) : new Date();

    const drizzle = await getDb();
    if (!drizzle) return res.status(500).json({ error: "DB not available" });

    // 2) الأوردر داخل النشاط المحدد بس.
    const byShipment = shipmentId ? eq(orders.bostaShipmentId, shipmentId) : eq(orders.bostaTrackingNumber, trackingNumber!);
    let order: typeof orders.$inferSelect | undefined;
    if (businessId != null) {
      [order] = await drizzle.select().from(orders).where(and(eq(orders.businessId, businessId), byShipment)).limit(1);
    } else {
      // فترة الانتقال: السر العام بيوصل للأوردر بشرط إن نشاطه **مالوش** حساب شحن.
      const [candidate] = await drizzle.select().from(orders).where(byShipment).limit(1);
      if (candidate && !(await getCarrierAccountRow(candidate.businessId))) {
        order = candidate;
        businessId = candidate.businessId;
      } else if (candidate) {
        console.warn("[Bosta Webhook] legacy secret used for a business that has its own account — rejected");
        return res.status(401).json({ error: "Unauthorized" });
      }
    }
    if (!order || businessId == null) {
      console.warn(`[Bosta Webhook] Order not found in business scope for shipmentId=${shipmentId} trackingNumber=${trackingNumber}`);
      return res.status(200).json({ ok: true, message: "Order not found, ignored" });
    }

    // 3) idempotency لكل نشاط.
    const eventHash = createHash("sha256")
      .update(`${businessId}|${shipmentId ?? ""}|${trackingNumber ?? ""}|${stateCode ?? ""}|${occurredAt.toISOString()}|${payload.eventId ?? payload.event_id ?? ""}`)
      .digest("hex");
    const fresh = await recordWebhookEvent({ businessId, provider: PROVIDER_BOSTA, eventHash, shipmentId, stateCode: stateCode ?? null });
    if (!fresh) return res.status(200).json({ ok: true, duplicate: true });

    // 4) مسار المحاسبة V2 — لو جداوله ناقصة مايوقعش التحديث الأساسي.
    if (stateCode != null) {
      try {
        const v2 = await processProviderWebhook({
          providerCode: "bosta",
          externalShipmentId: shipmentId,
          trackingNumber,
          providerEventId: payload.eventId || payload.event_id,
          providerStatusCode: String(stateCode),
          occurredAt,
          payload,
        });
        if (v2.status === "processed") return res.status(200).json({ ok: true, accountingV2: true });
      } catch (error) {
        console.error("[Bosta Webhook] Accounting V2 processing failed (continuing with legacy status update):", error);
      }
    }

    const arabicStatus = (stateCode ? BOSTA_STATUS_MAP[stateCode] : undefined) || stateValue || "تم التحديث";
    const mappedOrderStatus = stateCode ? BOSTA_STATUS_TO_ORDER_STATUS[stateCode] : undefined;

    const [business] = await drizzle.select({ accountingGoLiveAt: businesses.accountingGoLiveAt })
      .from(businesses).where(eq(businesses.id, businessId)).limit(1);
    if (business?.accountingGoLiveAt && stateCode != null) {
      return res.status(200).json({ ok: true, message: "Provider event is unmatched in Business configuration; legacy mapping skipped" });
    }

    // 5) التحديث مقيّد بالنشاط كمان — مش بالـid بس.
    await drizzle
      .update(orders)
      .set({
        bostaStatus: arabicStatus,
        ...(trackingNumber ? { bostaTrackingNumber: trackingNumber } : {}),
        ...(mappedOrderStatus ? { status: mappedOrderStatus } : {}),
      })
      .where(and(eq(orders.id, order.id), eq(orders.businessId, businessId)));

    console.log(`[Bosta Webhook] ✅ Order #${order.orderNumber} (business ${businessId}${legacy ? ", legacy secret" : ""}) → bostaStatus=${arabicStatus} (code: ${stateCode})`);
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
