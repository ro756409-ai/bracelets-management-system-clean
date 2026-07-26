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
 * ==================== Order capture (webhook-only design) ====================
 * The public API exposes NO list-orders endpoint, so the webhook is the only way orders
 * arrive. Two documented events are handled:
 *
 *   order-created        → the payload already carries the FULL order. It is stored through
 *                          the shared pipeline. When the channel has an API token we also
 *                          re-read the order via GET /external-apps/orders/:id and prefer
 *                          that canonical copy; if that read fails for any reason we keep
 *                          the webhook payload rather than lose the order.
 *   order-status-update  → carries only {order_id, old_status, new_status}. For a known
 *                          order the status is mapped and applied. For an order we have
 *                          never seen, it is recovered via GET /external-apps/orders/:id
 *                          and then the status is applied — previously such events were
 *                          logged and dropped.
 *
 * Order creation goes through the shared pipeline in easyorder.service.ts, so every path
 * behaves identically (same matching, same idempotency, same review flagging).
 * Manual "Sync Now" is deliberately NOT wired up — it has no documented endpoint.
 */
import { Request, Response, Express } from "express";
import { getDb, getSalesChannelByWebhookSecret, getSalesChannelByPlatformAndBusiness, getOrderByExternalId, updateOrder } from "./db";
import { webhookLogs } from "../drizzle/schema";
import { desc } from "drizzle-orm";
import { upsertEasyOrder, fetchEasyOrderById, type EasyOrderPayload } from "./easyorder.service";

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

/** Per-business source label, shared by the create and backfill paths. */
function sourceLabelFor(businessId: number): string {
  return businessId === 3 ? "easyorder_ataba" : businessId === 1 ? "easyorder_farhat" : "easyorder";
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

    // Resolve the channel before branching: the status-update path needs its API token to
    // recover an unknown order, not just the create path.
    if (!channel) {
      channel = await getSalesChannelByPlatformAndBusiness("easyorder");
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

      // Unknown status on a known order: nothing safe to do, never guess a mapping.
      if (existing) {
        await addLog({
          eventType: "order-status-update",
          status: "error",
          externalOrderId: payload.order_id,
          message: `حالة خارجية غير معروفة "${payload.new_status}" — لم يتم تغيير حالة الأوردر #${existing.orderNumber}`,
        });
        return res.json({ received: true, action: "status_ignored" });
      }

      // Status change for an order we have never seen — it predates the integration, or its
      // create webhook was missed. This used to be logged and dropped, losing the order for
      // good. The single-order endpoint is the documented way to recover it.
      const backfill = await fetchEasyOrderById(payload.order_id, {
        apiToken: channel?.apiToken,
        baseUrl: channel?.apiBaseUrl,
      });

      if (!backfill.order) {
        await addLog({
          eventType: "order-status-update",
          status: "error",
          externalOrderId: payload.order_id,
          message: `تحديث حالة لأوردر غير موجود محليًا (${payload.order_id}) وتعذّر جلبه: ${backfill.error ?? "سبب غير معروف"}`,
        });
        return res.json({ received: true, action: "status_ignored" });
      }

      const businessIdForBackfill = channel?.businessId ?? 1;
      const backfilled = await upsertEasyOrder(backfill.order, {
        businessId: businessIdForBackfill,
        channelId: channel?.id ?? null,
        source: sourceLabelFor(businessIdForBackfill),
      });

      if (backfilled.outcome === "failed") {
        await addLog({
          eventType: "order-status-update",
          status: "error",
          externalOrderId: payload.order_id,
          message: `فشل حفظ أوردر مُستعاد بالـ API (${payload.order_id}): ${backfilled.error}`,
        });
        return res.json({ received: true, action: "status_ignored" });
      }

      // Apply the new status on top of the freshly stored order, when we understand it.
      const restored = await getOrderByExternalId(payload.order_id);
      if (restored && mapped) await updateOrder(restored.id, { status: mapped as any });

      await addLog({
        eventType: "order-status-update",
        status: "success",
        externalOrderId: payload.order_id,
        customerName: backfill.order.full_name,
        customerPhone: backfill.order.phone,
        itemsCount: backfill.order.cart_items.length,
        importedCount: 1,
        message: `تم استرجاع الأوردر #${backfilled.orderNumber} عبر API بعد تحديث حالة لأوردر غير موجود محليًا${mapped ? ` وضبط حالته إلى ${mapped}` : ` (حالة "${payload.new_status}" غير معروفة — تُركت كما هي)`}`,
      });
      return res.json({ received: true, action: "backfilled_from_api", orderNumber: backfilled.orderNumber });
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

    const businessId = channel?.businessId ?? 1;

    // The create webhook already carries the whole order, so this call is not needed to
    // capture it. It is made anyway to store the provider's canonical copy: the pushed body
    // can be stale by the time it arrives, or truncated in transit. On ANY failure we keep
    // the webhook payload — an order must never be lost because a secondary read failed.
    let effectivePayload = payload;
    let payloadSource: "webhook" | "api" = "webhook";
    const canonical = await fetchEasyOrderById(payload.id, {
      apiToken: channel?.apiToken,
      baseUrl: channel?.apiBaseUrl,
    });
    if (canonical.order) {
      effectivePayload = canonical.order;
      payloadSource = "api";
    } else if (channel?.apiToken) {
      // Only worth logging when a token existed and the read still failed.
      await addLog({
        eventType: "order",
        status: "error",
        externalOrderId: payload.id,
        message: `تعذّر جلب النسخة الرسمية للأوردر (${payload.id}) — تم استخدام بيانات الـ webhook: ${canonical.error ?? "سبب غير معروف"}`,
      });
    }

    const result = await upsertEasyOrder(effectivePayload, {
      businessId,
      channelId: channel?.id ?? null,
      source: sourceLabelFor(businessId),
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
    // Record which copy was stored, so a data question later can be traced to its source.
    const sourceNote = payloadSource === "api" ? " (بيانات مؤكَّدة من API)" : " (بيانات الـ webhook)";
    await addLog({
      eventType: "order",
      status: "success",
      externalOrderId: String(effectivePayload.id).slice(0, 100),
      customerName: effectivePayload.full_name,
      customerPhone: effectivePayload.phone,
      itemsCount: effectivePayload.cart_items.length,
      importedCount: 1,
      rawPayload: JSON.stringify(body).slice(0, 4000),
      message:
        result.outcome === "created"
          ? `تم استيراد الأوردر #${result.orderNumber} بنجاح${sourceNote}${reviewNote}`
          : `تم تحديث الأوردر #${result.orderNumber}${sourceNote}${reviewNote}`,
    });

    return res.json({
      received: true,
      action: result.outcome,
      orderNumber: result.orderNumber,
      needsReview: result.needsReview,
      payloadSource,
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
