/**
 * Easy Order Webhook Handler
 * يستقبل الأوردرات الجديدة من Easy Order تلقائيًا فور إنشائها
 *
 * Webhook URL: /api/webhooks/easyorder
 * Header: secret: <GENERATED_SECRET>
 *
 * Payload types:
 * - Orders (new order)
 * - Order Status Update
 */

import { Request, Response, Express } from "express";
import * as db from "./db";
import { getDb } from "./db";
import { getSalesChannelByWebhookSecret, getSalesChannelByPlatformAndBusiness } from "./db";
import { webhookLogs } from "../drizzle/schema";
import { desc } from "drizzle-orm";
import { normalizeEgyptianPhone } from "../shared/phone";

// ==================== Types ====================

interface EasyOrderCartItem {
  id: string;
  product_id: string;
  variant_id?: string;
  price: number;
  quantity: number;
  product: {
    id: string;
    name: string;
    price: number;
    sku?: string;
  };
  variant?: {
    id: string;
    variation_props?: Array<{
      variation: string;
      variation_prop: string;
    }>;
  };
}

interface EasyOrderPayload {
  id: string;
  created_at: string;
  updated_at: string;
  store_id: string;
  cost: number;
  shipping_cost: number;
  total_cost: number;
  status: string;
  full_name: string;
  phone: string;
  government: string;
  address: string;
  payment_method: string;
  cart_items: EasyOrderCartItem[];
  short_id?: number;
}

interface EasyOrderStatusUpdate {
  event_type: "order-status-update";
  order_id: string;
  old_status: string;
  new_status: string;
  payment_ref_id?: string;
}

// ==================== Governorate normalization ====================

const GOVERNORATE_MAP: Record<string, string> = {
  "القاهره": "القاهرة",
  "الجيزه": "الجيزة",
  "الاسكندريه": "الإسكندرية",
  "الاسكندرية": "الإسكندرية",
  "اسكندرية": "الإسكندرية",
  "Alexandria": "الإسكندرية",
  "اسيوط": "أسيوط",
  "الاسيوط": "أسيوط",
  "اسوان": "أسوان",
  "الاسماعيليه": "الإسماعيلية",
  "اسماعيلية": "الإسماعيلية",
  "الفيوم": "الفيوم",
  "فيوم": "الفيوم",
  "المنيا": "المنيا",
  "منيا": "المنيا",
  "بنى سويف": "بني سويف",
  "بني سويف": "بني سويف",
  "سوهاج": "سوهاج",
  "قنا": "قنا",
  "الدقهليه": "الدقهلية",
  "الدقهلية": "الدقهلية",
  "دقهلية": "الدقهلية",
  "الغربيه": "الغربية",
  "الغربية": "الغربية",
  "غربية": "الغربية",
  "المنوفيه": "المنوفية",
  "المنوفية": "المنوفية",
  "منوفية": "المنوفية",
  "القليوبيه": "القليوبية",
  "القليوبية": "القليوبية",
  "قليوبية": "القليوبية",
  "الشرقيه": "الشرقية",
  "الشرقية": "الشرقية",
  "شرقية": "الشرقية",
  "البحيره": "البحيرة",
  "البحيرة": "البحيرة",
  "بحيرة": "البحيرة",
  "كفر الشيخ": "كفر الشيخ",
  "كفرالشيخ": "كفر الشيخ",
  "الاقصر": "الأقصر",
  "الأقصر": "الأقصر",
  "اقصر": "الأقصر",
  "البحر الاحمر": "البحر الأحمر",
  "البحر الأحمر": "البحر الأحمر",
  "الوادي الجديد": "الوادي الجديد",
  "مطروح": "مطروح",
  "شمال سيناء": "شمال سيناء",
  "جنوب سيناء": "جنوب سيناء",
  "بورسعيد": "بورسعيد",
  "السويس": "السويس",
  "الاسماعيلية": "الإسماعيلية",
  "دمياط": "دمياط",
  "شراملس": "الدقهلية",
  "منطقة الرياض": "غير محدد",
};

function normalizeGov(raw: string): string {
  if (!raw) return "غير محدد";
  const trimmed = raw.trim();
  if (GOVERNORATE_MAP[trimmed]) return GOVERNORATE_MAP[trimmed];
  for (const [key, val] of Object.entries(GOVERNORATE_MAP)) {
    if (trimmed.includes(key) || key.includes(trimmed)) return val;
  }
  const firstWord = trimmed.split(/[\s,،]/)[0];
  if (GOVERNORATE_MAP[firstWord]) return GOVERNORATE_MAP[firstWord];
  return trimmed.length > 30 ? "غير محدد" : trimmed;
}

// ==================== Product matching ====================

function normalizeArabic(text: string): string {
  return text
    .replace(/[أإآا]/g, "ا")
    .replace(/[ةه]/g, "ه")
    .replace(/[يى]/g, "ي")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function matchProduct(productNameRaw: string, variantRaw: string, products: any[]): any | null {
  const engravePatterns = [
    /نوع\s*الحفر\s*[:\-]\s*(.+)/,
    /الحفر\s*[:\-]\s*(.+)/,
    /النوع\s*[:\-]\s*(.+)/,
    /حفر\s*[:\-]\s*(.+)/,
  ];

  function tryMatch(text: string): any | null {
    if (!text) return null;
    const t = text.trim();
    const tNorm = normalizeArabic(t);
    let m = products.find((p: any) => t === p.name || tNorm === normalizeArabic(p.name));
    if (m) return m;
    m = products.find((p: any) => t.includes(p.name) || p.name.includes(t));
    if (m) return m;
    m = products.find((p: any) => {
      const pn = normalizeArabic(p.name);
      return tNorm.includes(pn) || pn.includes(tNorm);
    });
    if (m) return m;
    for (const p of products) {
      const keywords = normalizeArabic(p.name).split(/\s+/).filter((w: string) => w.length > 2);
      if (keywords.length > 0 && keywords.every((kw: string) => tNorm.includes(kw))) return p;
    }
    return null;
  }

  const raw = (productNameRaw || "").trim();
  const variantFirst = (variantRaw || "").split("\n")[0].trim();

  if (variantFirst) {
    const m = tryMatch(raw + " - " + variantFirst);
    if (m) return m;
  }

  const m1 = tryMatch(raw);
  if (m1) return m1;

  if (variantFirst) {
    for (const pattern of engravePatterns) {
      const match = variantFirst.match(pattern);
      if (match) {
        const engraveName = match[1].trim();
        const m = tryMatch(engraveName);
        if (m) return m;
        if (normalizeArabic(engraveName) === normalizeArabic("سادة")) {
          const plain = products.find((p: any) => normalizeArabic(p.name).includes(normalizeArabic("سادة")));
          if (plain) return plain;
        }
      }
    }
    const m2 = tryMatch(variantFirst);
    if (m2) return m2;
  }

  for (const pattern of engravePatterns) {
    const match = raw.match(pattern);
    if (match) {
      const m = tryMatch(match[1].trim());
      if (m) return m;
    }
  }

  const parts = raw.split(" - ").map((s: string) => s.trim());
  for (const part of parts) {
    const m = tryMatch(part);
    if (m) return m;
  }

  const stripped = normalizeArabic(raw)
    .replace(/اسوره?\s*/g, "")
    .replace(/نحاس\s*/g, "")
    .replace(/احمر\s*/g, "")
    .replace(/طبي\s*/g, "")
    .replace(/نوع\s*الحفر\s*[:\-]?\s*/g, "")
    .replace(/[\-–—]\s*/g, "")
    .trim();
  if (stripped) {
    const m = tryMatch(stripped);
    if (m) return m;
  }

  return null;
}

// ==================== Webhook log helpers ====================

type WebhookLogInsert = {
  eventType: string;
  status: "success" | "duplicate" | "error" | "status_update";
  externalOrderId?: string;
  customerName?: string;
  customerPhone?: string;
  governorate?: string;
  totalAmount?: number;
  itemsCount?: number;
  importedCount?: number;
  rawPayload?: string;
  message: string;
};

async function addLog(entry: WebhookLogInsert): Promise<void> {
  try {
    const drizzle = await getDb();
    if (!drizzle) return;
    await drizzle.insert(webhookLogs).values({
      eventType: entry.eventType,
      status: entry.status,
      externalOrderId: entry.externalOrderId ?? null,
      customerName: entry.customerName ?? null,
      customerPhone: entry.customerPhone ?? null,
      governorate: entry.governorate ?? null,
      totalAmount: entry.totalAmount != null ? String(entry.totalAmount) : null,
      itemsCount: entry.itemsCount ?? null,
      importedCount: entry.importedCount ?? null,
      rawPayload: entry.rawPayload ?? null,
      message: entry.message,
    });
  } catch (err) {
    console.error("[Webhook] Failed to save log:", err);
  }
}

export async function getWebhookLog(limit = 200) {
  try {
    const drizzle = await getDb();
    if (!drizzle) return [];
    return await drizzle
      .select()
      .from(webhookLogs)
      .orderBy(desc(webhookLogs.receivedAt))
      .limit(limit);
  } catch (err) {
    console.error("[Webhook] Failed to get log:", err);
    return [];
  }
}

// ==================== Main handler ====================

async function handleEasyOrderWebhook(req: Request, res: Response) {
  try {
    // ==================== Secret validation DISABLED ====================
    // Accept ALL incoming webhooks without secret validation
    // The secret is still used for channel matching below, but NOT for auth rejection
    // This ensures webhooks always get through regardless of secret configuration
    const receivedSecretForAuth =
      (req.query?.secret as string) ||
      (req.headers["secret"] as string) ||
      (req.headers["x-webhook-secret"] as string) ||
      (req.headers["authorization"] as string)?.replace(/^Bearer\s+/i, "");
    
    // Log the incoming webhook for debugging
    await addLog({
      eventType: "auth",
      status: "success",
      message: `Webhook received | secret: ${receivedSecretForAuth?.slice(0,8) || 'none'}... | headers: ${Object.keys(req.headers).length}`,
    });

    const body = req.body;

    // Determine event type
    const isStatusUpdate = body?.event_type === "order-status-update";

    if (isStatusUpdate) {
      // Status update — log only, no action needed currently
      const payload = body as EasyOrderStatusUpdate;
      await addLog({
        eventType: "order-status-update",
        status: "status_update",
        externalOrderId: payload.order_id,
        message: `تحديث حالة الأوردر ${payload.order_id}: ${payload.old_status} → ${payload.new_status}`,
      });
      return res.json({ received: true, action: "status_logged" });
    }

    // New order
    const payload = body as EasyOrderPayload;

    if (!payload?.id || !payload?.full_name || !payload?.cart_items?.length) {
      await addLog({
        eventType: "order",
        status: "error",
        rawPayload: JSON.stringify(body).slice(0, 2000),
        message: "بيانات الأوردر غير مكتملة أو الـ payload غير صحيح",
      });
      return res.status(400).json({ error: "Invalid payload" });
    }

    // ==================== Match Sales Channel ====================
    // Strategy: 
    // 1. Try to match by webhook secret (if the sales channel has a webhookSecret configured)
    // 2. Fall back to matching by store_id from payload
    // 3. Fall back to first active EasyOrder sales channel
    let matchedChannelId: number | null = null;
    let matchedBusinessId: number | null = null;

    const receivedSecret =
      (req.query?.secret as string) ||
      (req.headers["secret"] as string) ||
      (req.headers["x-webhook-secret"] as string) ||
      (req.headers["authorization"] as string)?.replace(/^Bearer\s+/i, "");

    if (receivedSecret) {
      const channelBySecret = await getSalesChannelByWebhookSecret(receivedSecret);
      if (channelBySecret) {
        matchedChannelId = channelBySecret.id;
        matchedBusinessId = channelBySecret.businessId;
      }
    }

    // If no match by secret, try to find an EasyOrder channel
    if (!matchedChannelId) {
      const channelByPlatform = await getSalesChannelByPlatformAndBusiness("easyorder");
      if (channelByPlatform) {
        matchedChannelId = channelByPlatform.id;
        matchedBusinessId = channelByPlatform.businessId;
      }
    }

    // Check duplicate by external order ID (payload.id from Easy Order)
    const existingOrders = await db.getOrders({ limit: 100000 });
    const existingExternalIds = new Set(
      existingOrders.orders
        .map((o: any) => o.externalOrderId)
        .filter(Boolean)
    );

    if (existingExternalIds.has(payload.id)) {
      await addLog({
        eventType: "order",
        status: "duplicate",
        externalOrderId: payload.id,
        customerName: payload.full_name,
        customerPhone: (payload.phone || "").replace(/\s+/g, ""),
        message: `أوردر مكرر بالـ externalOrderId — تم تخطيه (${payload.id})`,
      });
      return res.json({ received: true, action: "duplicate_skipped" });
    }

    // Get all products for matching
    const products = await db.getAllProducts();

    const governorate = normalizeGov(payload.government || "");
    const phone = normalizeEgyptianPhone(payload.phone) || (payload.phone || "").replace(/\s+/g, "");

    // ============================================================
    // ONE REQUEST = ONE ORDER
    // Combine all cart_items into a single order with combined productName
    // ============================================================
    const productParts: string[] = [];
    let totalQty = 0;
    let extractedColor: string | null = null;
    let extractedSize: string | null = null;
    let totalAmt = 0;
    let firstMatchedProductId: number | null = null;
    const unmatchedItems: string[] = [];

    for (const item of payload.cart_items) {
      const productName = item.product?.name || "";
      let variantRaw = "";
      if (item.variant?.variation_props?.length) {
        variantRaw = item.variant.variation_props
          .map((vp) => `${vp.variation}: ${vp.variation_prop}`)
          .join(", ");
        // Extract color and size from variation_props
        for (const vp of item.variant.variation_props) {
          const varName = (vp.variation || "").toLowerCase().trim();
          const varValue = (vp.variation_prop || "").trim();
          if (varName.includes("لون") || varName.includes("color") || varName.includes("colour")) {
            if (!extractedColor) extractedColor = varValue;
          } else if (varName.includes("مقاس") || varName.includes("size") || varName.includes("حجم")) {
            if (!extractedSize) extractedSize = varValue;
          }
        }
      }

      const matchedProduct = matchProduct(productName, variantRaw, products);
      const qty = item.quantity || 1;
      const displayName = matchedProduct?.name ?? productName;

      if (matchedProduct && firstMatchedProductId === null) {
        firstMatchedProductId = matchedProduct.id;
      }
      if (!matchedProduct) {
        unmatchedItems.push(`${productName}${variantRaw ? ` (${variantRaw})` : ""}`);
      }

      // Format: "اسم المنتج ×3" or just "اسم المنتج" if qty=1
      productParts.push(qty > 1 ? `${displayName} ×${qty}` : displayName);
      totalQty += qty;
      totalAmt += item.price * qty;
    }

    const combinedProductName = productParts.join(" + ");
    const notes = unmatchedItems.length > 0
      ? `منتجات غير مطابقة: ${unmatchedItems.join(", ")}`
      : undefined;

    // ==================== Shipping fees handling ====================
    // إصلاح مصاريف الشحن: Easy Order كان بيبعت سعر المنتجات فقط (270ج) بدون شحن (50ج)
    // فكان الإجمالي يجي 270 بدل 320. الحل: نأخذ shipping_cost من الـ payload،
    // ولو غير موجود/صفر نستخدم 50ج كافتراضي، ونضيفها على إجمالي المنتجات.
    const DEFAULT_SHIPPING_FEE = 50;
    const rawShipping = Number(payload.shipping_cost);
    const shippingFee = Number.isFinite(rawShipping) && rawShipping > 0
      ? rawShipping
      : DEFAULT_SHIPPING_FEE;
    // الإجمالي النهائي = سعر المنتجات + الشحن (270 + 50 = 320)
    const finalTotalAmt = totalAmt + shippingFee;

    // ==================== Determine businessId from matched product ====================
    // If the matched product belongs to a specific business, use that business instead of the channel's default
    // This ensures that bracelet orders from flash box go to فرحات للنحاس (id=1)
    // and كفر/مسن orders go to مفروشات السعد (id=6)
    let finalBusinessId = matchedBusinessId ?? 1;
    // Determine source label based on channel's businessId
    let sourceLabel: "easyorder" | "easyorder_ataba" | "easyorder_farhat" = "easyorder";
    if (matchedBusinessId === 3) sourceLabel = "easyorder_ataba";
    else if (matchedBusinessId === 1) sourceLabel = "easyorder_farhat";
    if (firstMatchedProductId) {
      const matchedProductObj = products.find((p: any) => p.id === firstMatchedProductId);
      if (matchedProductObj && matchedProductObj.businessId) {
        finalBusinessId = matchedProductObj.businessId;
      }
    }

    // Generate ONE order number for the entire request
    let orderNumber: string;
    try {
      orderNumber = await db.generateOrderNumber();
    } catch (err: any) {
      await addLog({
        eventType: "order",
        status: "error",
        externalOrderId: payload.id,
        customerName: payload.full_name,
        customerPhone: phone,
        message: `فشل توليد رقم الأوردر: ${err.message}`,
      });
      return res.status(500).json({ error: "Failed to generate order number" });
    }

    try {
      await db.createOrder({
        orderNumber,
        customerName: payload.full_name,
        customerPhone: phone,
        customerAddress: payload.address || "",
        governorate,
        productId: firstMatchedProductId ?? 1,
        productName: combinedProductName,
        quantity: totalQty,
        totalAmount: String(finalTotalAmt),
        shippingFees: String(shippingFee),
        source: sourceLabel,
        status: "new",
        notes,
        externalOrderId: payload.id,
        easyOrderShortId: payload.short_id ?? null,
        websiteId: matchedChannelId,
        businessId: finalBusinessId,
        color: extractedColor,
        size: extractedSize,
      });
    } catch (err: any) {
      await addLog({
        eventType: "order",
        status: "error",
        externalOrderId: payload.id,
        customerName: payload.full_name,
        customerPhone: phone,
        governorate,
        rawPayload: JSON.stringify(body).slice(0, 2000),
        message: `فشل حفظ الأوردر: ${err.message}`,
      });
      return res.status(500).json({ error: "Failed to create order" });
    }

    const channelInfo = matchedChannelId ? ` | قناة: #${matchedChannelId}` : " | بدون قناة";
    await addLog({
      eventType: "order",
      status: "success",
      externalOrderId: payload.id.slice(0, 100),
      customerName: payload.full_name,
      customerPhone: phone,
      governorate,
      totalAmount: finalTotalAmt,
      itemsCount: payload.cart_items.length,
      importedCount: 1,
      rawPayload: JSON.stringify(body).slice(0, 2000),
      message: `تم استيراد الأوردر #${orderNumber} بنجاح — ${payload.full_name} — ${governorate} — ${combinedProductName}${channelInfo}`,
    });

    return res.json({
      received: true,
      action: "imported",
      imported: 1,
      orderNumber,
    });

  } catch (err: any) {
    console.error("[EasyOrder Webhook] Error:", err);
    await addLog({
      eventType: "unknown",
      status: "error",
      message: `خطأ داخلي: ${err.message}`,
    });
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ==================== Register routes ====================

export function registerWebhookRoutes(app: Express) {
  // Main webhook endpoint — no auth required (Easy Order calls it)
  app.post("/api/webhooks/easyorder", handleEasyOrderWebhook);

  // Log endpoint — for the admin UI to view recent webhook events
  app.get("/api/webhooks/easyorder/log", async (req: Request, res: Response) => {
    const log = await getWebhookLog();
    res.json({ log });
  });
}
