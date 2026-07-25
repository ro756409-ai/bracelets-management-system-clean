/**
 * Easy Order Webhook Handler — receives new/updated orders from EasyOrder.
 *
 * Webhook URL: POST /api/webhooks/easyorder
 * Auth: the channel's `sales_channels.webhookSecret`, sent as `secret` / `x-webhook-secret`
 *       header, `Authorization: Bearer <secret>`, or a `?secret=` query param.
 *
 * ==================== Secret enforcement ====================
 * Secret validation was previously DISABLED outright (every request accepted), which let
 * anyone who knew the URL inject orders. It is now enforced, but behind a deliberate
 * grace switch so turning it on cannot silently drop real orders:
 *
 *   EASYORDER_WEBHOOK_ENFORCE_SECRET = "log_only" (default) → unauthenticated requests are
 *       still processed, but every rejection-that-would-have-happened is written to
 *       webhook_logs with status "error". Run this for a day, confirm the log is empty,
 *       then switch to "enforce".
 *   EASYORDER_WEBHOOK_ENFORCE_SECRET = "enforce" → unauthenticated requests get 401.
 *
 * Order creation itself goes through the shared pipeline in easyorder.service.ts, so the
 * webhook and the manual "Sync Now" button behave identically (same matching, same
 * idempotency, same review flagging).
 */
import { Request, Response, Express } from "express";
import { getDb, getSalesChannelByWebhookSecret, getSalesChannelByPlatformAndBusiness, getOrderByExternalId, updateOrder } from "./db";
import { webhookLogs } from "../drizzle/schema";
import { desc } from "drizzle-orm";
import { upsertEasyOrder, type EasyOrderPayload } from "./easyorder.service";

type EnforcementMode = "log_only" | "enforce";

function getEnforcementMode(): EnforcementMode {
  return process.env.EASYORDER_WEBHOOK_ENFORCE_SECRET === "enforce" ? "enforce" : "log_only";
}

interface EasyOrderStatusUpdate {
  event_type: "order-status-update";
  order_id: string;
  old_status: string;
  new_status: string;
  payment_ref_id?: string;
}

/** EasyOrder status → local order status. Unknown values are logged, never guessed. */
const EXTERNAL_STATUS_MAP: Record<string, string> = {
  pending: "new",
  new: "new",
  confirmed: "confirmed",
  processing: "confirmed",
  shipped: "shipped",
  delivered: "delivered",
  cancelled: "cancelled",
  canceled: "cancelled",
  refunded: "returned",
  returned: "returned",
};

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
    return await drizzle.select().from(webhookLogs).orderBy(desc(webhookLogs.receivedAt)).limit(limit);
  } catch (err) {
    console.error("[Webhook] Failed to get log:", err);
    return [];
  }
}

function extractSecret(req: Request): string | undefined {
  return (
    (req.query?.secret as string) ||
    (req.headers["secret"] as string) ||
    (req.headers["x-webhook-secret"] as string) ||
    (req.headers["authorization"] as string)?.replace(/^Bearer\s+/i, "")
  );
}

// ==================== Main handler ====================
async function handleEasyOrderWebhook(req: Request, res: Response) {
  try {
    const receivedSecret = extractSecret(req);
    const mode = getEnforcementMode();

    // ---- Resolve the channel from the secret ----
    let channel = receivedSecret ? await getSalesChannelByWebhookSecret(receivedSecret) : undefined;
    const authenticated = Boolean(channel);

    if (!authenticated) {
      const detail = receivedSecret
        ? `سر غير معروف (${receivedSecret.slice(0, 6)}…)`
        : "لم يُرسَل أي سر";
      if (mode === "enforce") {
        await addLog({
          eventType: "auth",
          status: "error",
          message: `❌ طلب webhook مرفوض — ${detail}`,
        });
        return res.status(401).json({ error: "Unauthorized" });
      }
      // log_only: record what WOULD have been rejected, then continue.
      await addLog({
        eventType: "auth",
        status: "error",
        message: `⚠️ [log_only] كان سيُرفض هذا الطلب — ${detail}. فعّل EASYORDER_WEBHOOK_ENFORCE_SECRET=enforce بعد التأكد.`,
      });
    }

    const body = req.body;

    // ---- Status-update events ----
    if (body?.event_type === "order-status-update") {
      const payload = body as EasyOrderStatusUpdate;
      const mapped = EXTERNAL_STATUS_MAP[String(payload.new_status ?? "").toLowerCase()];
      const existing = payload.order_id ? await getOrderByExternalId(payload.order_id) : undefined;

      if (existing && mapped) {
        await updateOrder(existing.id, { status: mapped as any });
        await addLog({
          eventType: "order-status-update",
          status: "status_update",
          externalOrderId: payload.order_id,
          message: `تم تحديث حالة الأوردر #${existing.orderNumber}: ${payload.old_status} → ${payload.new_status} (محليًا: ${mapped})`,
        });
        return res.json({ received: true, action: "status_updated", status: mapped });
      }

      await addLog({
        eventType: "order-status-update",
        status: existing ? "error" : "duplicate",
        externalOrderId: payload.order_id,
        message: existing
          ? `حالة خارجية غير معروفة "${payload.new_status}" — لم يتم تغيير حالة الأوردر #${existing.orderNumber}`
          : `تحديث حالة لأوردر غير موجود محليًا (${payload.order_id})`,
      });
      return res.json({ received: true, action: "status_ignored" });
    }

    // ---- New / updated order ----
    const payload = body as EasyOrderPayload;
    if (!payload?.id || !payload?.full_name || !payload?.cart_items?.length) {
      await addLog({
        eventType: "order",
        status: "error",
        rawPayload: JSON.stringify(body ?? {}).slice(0, 4000),
        message: "بيانات الأوردر غير مكتملة أو الـ payload غير صحيح",
      });
      return res.status(400).json({ error: "Invalid payload" });
    }

    // Fall back to any active EasyOrder channel when running unauthenticated in log_only mode.
    if (!channel) {
      channel = await getSalesChannelByPlatformAndBusiness("easyorder");
    }

    const businessId = channel?.businessId ?? 1;
    const sourceLabel =
      businessId === 3 ? "easyorder_ataba" : businessId === 1 ? "easyorder_farhat" : "easyorder";

    const result = await upsertEasyOrder(payload, {
      businessId,
      channelId: channel?.id ?? null,
      source: sourceLabel,
    });

    if (result.outcome === "failed") {
      await addLog({
        eventType: "order",
        status: "error",
        externalOrderId: payload.id,
        customerName: payload.full_name,
        rawPayload: JSON.stringify(body).slice(0, 4000),
        message: `فشل حفظ الأوردر: ${result.error}`,
      });
      return res.status(500).json({ error: "Failed to create order" });
    }

    if (result.outcome === "duplicate_unchanged") {
      await addLog({
        eventType: "order",
        status: "duplicate",
        externalOrderId: payload.id,
        customerName: payload.full_name,
        message: `أوردر مكرر بلا تغيير — تم تخطيه (${payload.id})`,
      });
      return res.json({ received: true, action: "duplicate_skipped" });
    }

    const reviewNote = result.needsReview ? " ⚠️ يحتاج مراجعة يدوية للمنتجات" : "";
    await addLog({
      eventType: "order",
      status: "success",
      externalOrderId: payload.id.slice(0, 100),
      customerName: payload.full_name,
      customerPhone: payload.phone,
      itemsCount: payload.cart_items.length,
      importedCount: 1,
      rawPayload: JSON.stringify(body).slice(0, 4000),
      message:
        result.outcome === "created"
          ? `تم استيراد الأوردر #${result.orderNumber} بنجاح${reviewNote}`
          : `تم تحديث الأوردر #${result.orderNumber}${reviewNote}`,
    });

    return res.json({
      received: true,
      action: result.outcome,
      orderNumber: result.orderNumber,
      needsReview: result.needsReview,
    });
  } catch (err: any) {
    console.error("[EasyOrder Webhook] Error:", err);
    await addLog({ eventType: "unknown", status: "error", message: `خطأ داخلي: ${err.message}` });
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ==================== Register routes ====================
export function registerWebhookRoutes(app: Express) {
  app.post("/api/webhooks/easyorder", handleEasyOrderWebhook);

  app.get("/api/webhooks/easyorder/log", async (_req: Request, res: Response) => {
    const log = await getWebhookLog();
    res.json({ log });
  });

  // Reports the current enforcement mode so the admin UI can warn while still in log_only.
  app.get("/api/webhooks/easyorder/health", (_req: Request, res: Response) => {
    res.json({ ok: true, secretEnforcement: getEnforcementMode() });
  });
}
