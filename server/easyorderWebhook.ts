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
import {
  getDb, getSalesChannelByWebhookSecret, getSalesChannelWithSecrets, getOrderByExternalId, updateOrder, confirmOrder,
  StockShortfallError, OrderConfirmBlockedError, OrderStockInconsistencyError, OrderStatusGuardError,
} from "./db";
import { webhookLogs, businesses } from "../drizzle/schema";
import { resolveTenantAccessForBusiness } from "./tenantAccess";
import { orderEventsEnabled } from "./orderEvents.service";
import { and, desc, eq, inArray } from "drizzle-orm";
import { upsertEasyOrder, fetchEasyOrderById, type EasyOrderPayload } from "./easyorder.service";
import { recordIntegrationOrderEvent } from "./shippingV2.service";
import { IdempotencyConflictError } from "./accountingV2.service";

/**
 * الحدث المحاسبي للتكامل: مجمّد → `accounting_not_active` (التشغيل يكمل)؛ تعارض idempotency
 * (نفس payment_ref_id بحمولة مختلفة) → لا حركة مالية، يُسجّل كخطأ، والتشغيل يكمل كذلك.
 */
async function integrationAccountingEvent(
  input: Parameters<typeof recordIntegrationOrderEvent>[0],
  log: (entry: { eventType: string; status: "error"; externalOrderId?: string; message: string }) => Promise<unknown>,
  externalOrderId: string | undefined,
  orderNumber: string
) {
  try {
    return await recordIntegrationOrderEvent(input);
  } catch (err) {
    if (!(err instanceof IdempotencyConflictError)) throw err;
    await log({
      eventType: "order-status-update", status: "error", externalOrderId,
      message: `تعارض معرّف الحدث المالي للأوردر #${orderNumber}: ${err.message} — لم تُسجَّل أي حركة مالية`,
    });
    return { ignored: true as const, reason: "accounting_not_active" as const };
  }
}

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

/** Stable provider-neutral source label. Business names and numeric IDs are never encoded. */
function sourceLabelFor(channel: { id: number; platform: string }): string {
  return `${channel.platform}:${channel.id}`;
}

/** EasyOrder status → local order status. Unknown values are logged, never guessed. */
/**
 * تطبيق حالة خارجية على أوردر موجود بالسياسة نفسها المطبَّقة على الواجهة:
 *  - «مؤكد» يمر عبر confirmOrder (يخصم المخزون) — لا يُكتب مباشرة. عجز المخزون أو أوردر غير
 *    جاهز = الأوردر يبقى كما هو ويُسجَّل الرفض (بلا 500 ولا كسر للتكامل).
 *  - «تم التسليم» مرفوض لكل الأوردرات من هنا: شحنات بوسطة تُسلَّم من الحالة 45 عبر Webhook بوسطة،
 *    والتسليم اليدوي له مسار مستقل باعتماد المالك (قيد البناء).
 */
export async function applyExternalStatus(orderId: number, mapped: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  // سجل الأحداث (العلم مفعّل فقط): سطر Audit بفاعل ويبهوك بلا نسبة لموظف. الـRetry بنفس الحالة لا يغيّر شيئًا
  // فلا حدث ثانٍ. لا تغيير في منطق Easy Orders ولا أي كتابة مالية.
  const eventCtx = orderEventsEnabled() ? { actor: { type: "webhook" as const, provider: "easyorders" as const }, source: "webhook_easyorders" as const } : undefined;
  try {
    if (mapped === "confirmed") {
      await confirmOrder(orderId, 0, "EasyOrder", eventCtx);
      return { ok: true };
    }
    // «تم التسليم» لا تمر من أي Webhook عام — التسليم من بوسطة (45) أو من المسار اليدوي المعتمد.
    if (mapped === "delivered")
      return { ok: false, reason: "حالة «تم التسليم» لا تُطبَّق من EasyOrder — التسليم من شركة الشحن أو المسار اليدوي المعتمد" };
    await updateOrder(orderId, { status: mapped as any }, eventCtx);
    return { ok: true };
  } catch (err) {
    if (err instanceof StockShortfallError || err instanceof OrderConfirmBlockedError || err instanceof OrderStockInconsistencyError || err instanceof OrderStatusGuardError)
      return { ok: false, reason: err.message };
    if (err instanceof Error && /لا يمكن تغيير حالة الأوردر/.test(err.message)) return { ok: false, reason: err.message };
    throw err;
  }
}

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
  /** نشاط القناة اللي وصلها الويبهوك — يُختم على السجل للعزل. غير معروف (فشل auth قبل تحديد
   * القناة) → يُترك للـdefault فمايتنسبش لتينانت بعينه. */
  businessId?: number;
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
      // نختم businessId لما يكون معروف (بعد تحديد القناة). لو مش معروف نسيبه للـdefault
      // بدل ما ننسبه غلط لتينانت.
      ...(entry.businessId != null ? { businessId: entry.businessId } : {}),
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

/**
 * سجلات الويبهوك مقيّدة بأنشطة التينانت (فيها PII). `businessIds` **إلزامية** ولازم تكون
 * مقصوصة server-side؛ نطاق فاضي → لا صفوف (fail-closed).
 */
export async function getWebhookLog(businessIds: number[], limit = 200) {
  try {
    const drizzle = await getDb();
    if (!drizzle) return [];
    const scope = businessIds.length ? businessIds : [-1];
    return await drizzle
      .select()
      .from(webhookLogs)
      .where(inArray(webhookLogs.businessId, scope))
      .orderBy(desc(webhookLogs.receivedAt))
      .limit(limit);
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

    // كل سجلات الويبهوك تُختم بنشاط القناة للعزل. قبل تحديد القناة (فشل auth) بيفضل
    // businessId غير معروف → addLog بيسيبه للـdefault فمايتنسبش لتينانت بعينه.
    const logWebhook = (entry: Omit<WebhookLogInsert, "businessId">) =>
      addLog({ ...entry, businessId: channel?.businessId });

    if (!authenticated) {
      const detail = receivedSecret
        ? `سر غير معروف (${receivedSecret.slice(0, 6)}…)`
        : "لم يُرسَل أي سر";
      if (mode === "enforce") {
        await logWebhook({
          eventType: "auth",
          status: "error",
          message: `❌ طلب webhook مرفوض — ${detail}`,
        });
        return res.status(401).json({ error: "Unauthorized" });
      }
      // log_only: record what WOULD have been rejected, then continue.
      await logWebhook({
        eventType: "auth",
        status: "error",
        message: `⚠️ [log_only] كان سيُرفض هذا الطلب — ${detail}. فعّل EASYORDER_WEBHOOK_ENFORCE_SECRET=enforce بعد التأكد.`,
      });
    }

    // Resolve the channel before branching: the status-update path needs its API token to
    // recover an unknown order, not just the create path.
    if (!channel) {
      await logWebhook({ eventType: "auth", status: "error", message: "تعذر تحديد قناة البيع والـ Business من Secret صالح" });
      return res.status(401).json({ error: "A configured channel secret is required" });
    }

    // إنفاذ حالة الشركة (خلف TENANT_ACCESS_ENFORCEMENT_ENABLED، معطل = full بلا قراءة): شركة غير مفعّلة للكتابة
    // ⇒ الطلب يُخزَّن كاملًا في سجل الويبهوك كـ«مؤجل» بلا أي معالجة، ويُعالج مرة واحدة بعد إعادة التفعيل
    // (drainDeferredEasyOrders). payload أكبر من العمود ⇒ 503 ليعيد المرسل لاحقًا (لا فقد ولا قص).
    const access = await resolveTenantAccessForBusiness(channel.businessId);
    if (!access.processWebhooks) {
      const raw = JSON.stringify(req.body ?? null);
      if (raw.length > DEFERRED_PAYLOAD_MAX) return res.status(503).set("Retry-After", "3600").json({ received: false, deferred: true });
      await logWebhook({ eventType: DEFERRED_EVENT, status: "error", rawPayload: raw, message: `${deferredMarker(channel.id)} ⏸️ مؤجل — الشركة غير مفعّلة للكتابة؛ يُعالج تلقائيًا بعد إعادة التفعيل` });
      return res.status(202).json({ received: true, action: "deferred" });
    }

    return await processEasyOrderBody(channel, req.body, logWebhook, res);
  } catch (err: any) {
    console.error("[EasyOrder Webhook] Error:", err);
    // خطأ عام خارج نطاق القناة — بلا businessId (يُترك للـdefault).
    await addLog({ eventType: "unknown", status: "error", message: `خطأ داخلي: ${err.message}` });
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ==================== Body processing (shared by the live handler and the deferred drain) ====================
type EasyOrderChannel = NonNullable<Awaited<ReturnType<typeof getSalesChannelByWebhookSecret>>>;
type WebhookLogFn = (entry: Omit<WebhookLogInsert, "businessId">) => Promise<void>;
type ResLike = Pick<Response, "status" | "json">;

async function processEasyOrderBody(channel: EasyOrderChannel, body: any, logWebhook: WebhookLogFn, res: ResLike) {
  try {

    // ---- Status-update events ----
    if (body?.event_type === "order-status-update") {
      const payload = body as EasyOrderStatusUpdate;
      const mapped = EXTERNAL_STATUS_MAP[String(payload.new_status ?? "").toLowerCase()];
      const existing = payload.order_id ? await getOrderByExternalId(payload.order_id, channel.businessId) : undefined;

      if (existing && mapped) {
        const accountingEvent = await integrationAccountingEvent({
          businessId: channel.businessId,
          orderId: existing.id,
          integrationCode: channel.platform,
          providerStatusCode: String(payload.new_status ?? ""),
          occurredAt: new Date(),
          payload,
          providerEventId: payload.payment_ref_id,
        }, logWebhook as any, payload.order_id, existing.orderNumber);
        if ((accountingEvent as any).reason === "accounting_not_active") {
          const applied = await applyExternalStatus(existing.id, mapped);
          if (!applied.ok) {
            await logWebhook({
              eventType: "order-status-update",
              status: "error", // لا قيمة enum جديدة بلا Migration — الرسالة توضّح أنه رفض سياسة
              externalOrderId: payload.order_id,
              message: `لم تُطبَّق حالة "${payload.new_status}" على الأوردر #${existing.orderNumber}: ${applied.reason}`,
            });
            return res.json({ received: true, action: "status_rejected", reason: applied.reason });
          }
        }
        await logWebhook({
          eventType: "order-status-update",
          status: "status_update",
          externalOrderId: payload.order_id,
          message: `تم تحديث حالة الأوردر #${existing.orderNumber}: ${payload.old_status} → ${payload.new_status} (محليًا: ${mapped})`,
        });
        return res.json({ received: true, action: "status_updated", status: mapped });
      }

      // Unknown status on a known order: nothing safe to do, never guess a mapping.
      if (existing) {
        await logWebhook({
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
        await logWebhook({
          eventType: "order-status-update",
          status: "error",
          externalOrderId: payload.order_id,
          message: `تحديث حالة لأوردر غير موجود محليًا (${payload.order_id}) وتعذّر جلبه: ${backfill.error ?? "سبب غير معروف"}`,
        });
        return res.json({ received: true, action: "status_ignored" });
      }

      const businessIdForBackfill = channel.businessId;
      const backfilled = await upsertEasyOrder(backfill.order, {
        businessId: businessIdForBackfill,
        channelId: channel.id,
        source: sourceLabelFor(channel),
      });

      if (backfilled.outcome === "failed") {
        await logWebhook({
          eventType: "order-status-update",
          status: "error",
          externalOrderId: payload.order_id,
          message: `فشل حفظ أوردر مُستعاد بالـ API (${payload.order_id}): ${backfilled.error}`,
        });
        return res.json({ received: true, action: "status_ignored" });
      }

      // Apply the new status on top of the freshly stored order, when we understand it.
      const restored = await getOrderByExternalId(payload.order_id, channel.businessId);
      if (restored && mapped) {
        const accountingEvent = await integrationAccountingEvent({
          businessId: channel.businessId,
          orderId: restored.id,
          integrationCode: channel.platform,
          providerStatusCode: String(payload.new_status ?? ""),
          occurredAt: new Date(),
          payload,
          providerEventId: payload.payment_ref_id,
        }, logWebhook as any, payload.order_id, restored.orderNumber);
        if ((accountingEvent as any).reason === "accounting_not_active") await applyExternalStatus(restored.id, mapped);
      }

      await logWebhook({
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
      await logWebhook({
        eventType: "order",
        status: "error",
        rawPayload: JSON.stringify(body ?? {}).slice(0, 4000),
        message: "بيانات الأوردر غير مكتملة أو الـ payload غير صحيح",
      });
      return res.status(400).json({ error: "Invalid payload" });
    }

    const businessId = channel.businessId;

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
      await logWebhook({
        eventType: "order",
        status: "error",
        externalOrderId: payload.id,
        message: `تعذّر جلب النسخة الرسمية للأوردر (${payload.id}) — تم استخدام بيانات الـ webhook: ${canonical.error ?? "سبب غير معروف"}`,
      });
    }

    const result = await upsertEasyOrder(effectivePayload, {
      businessId,
      channelId: channel.id,
      source: sourceLabelFor(channel),
    });

    if (result.outcome === "failed") {
      await logWebhook({
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
      await logWebhook({
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
    await logWebhook({
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

// ==================== Deferred (tenant not writable) ====================
export const DEFERRED_EVENT = "deferred";
const DEFERRED_CLAIMED = "deferred_claimed";
const DEFERRED_DONE = "deferred_done";
const DEFERRED_PAYLOAD_MAX = 60_000;
const deferredMarker = (channelId: number) => `[channel:${channelId}]`;

/**
 * يعالج طلبات Easy Orders المؤجلة لشركة أصبحت full — كل صف يُطالَب به شرطيًا (deferred → deferred_claimed)
 * فيُعالج مرة واحدة فقط، بنفس مسار المعالجة الحي، ثم يُعلَّم deferred_done. القناة يجب أن تبقى فعّالة.
 */
export async function drainDeferredEasyOrders(tenantId: number, limit = 200): Promise<{ processed: number; skipped: number }> {
  const drizzle = await getDb();
  if (!drizzle) return { processed: 0, skipped: 0 };
  const rows = await drizzle.select({ id: webhookLogs.id, businessId: webhookLogs.businessId, rawPayload: webhookLogs.rawPayload, message: webhookLogs.message })
    .from(webhookLogs).innerJoin(businesses, eq(businesses.id, webhookLogs.businessId))
    .where(and(eq(businesses.tenantId, tenantId), eq(webhookLogs.eventType, DEFERRED_EVENT))).orderBy(webhookLogs.id).limit(limit);
  let processed = 0, skipped = 0;
  for (const row of rows) {
    const [claim]: any = await drizzle.update(webhookLogs).set({ eventType: DEFERRED_CLAIMED }).where(and(eq(webhookLogs.id, row.id), eq(webhookLogs.eventType, DEFERRED_EVENT)));
    if (Number(claim?.affectedRows ?? 0) !== 1) { skipped++; continue; }
    const channelId = Number(/\[channel:(\d+)\]/.exec(row.message ?? "")?.[1]);
    const channel = Number.isFinite(channelId) ? await getSalesChannelWithSecrets(channelId) : undefined;
    let outcome = "تعذّر إيجاد قناة فعّالة — لم يُعالج";
    if (channel && channel.isActive && channel.businessId === row.businessId) {
      const res: ResLike & { code: number; body: any } = { code: 200, body: null, status(c: number) { this.code = c; return this as any; }, json(b: any) { this.body = b; return this as any; } } as any;
      const logWebhook: WebhookLogFn = entry => addLog({ ...entry, businessId: channel.businessId });
      await processEasyOrderBody(channel, JSON.parse(row.rawPayload ?? "null"), logWebhook, res);
      outcome = `عولج بعد إعادة التفعيل (HTTP ${res.code}${res.body?.action ? ` · ${res.body.action}` : ""})`;
      processed++;
    } else skipped++;
    await drizzle.update(webhookLogs).set({ eventType: DEFERRED_DONE, message: `${row.message ?? ""} → ${outcome}`.slice(0, 2000) }).where(eq(webhookLogs.id, row.id));
  }
  return { processed, skipped };
}

// ==================== Register routes ====================
export function registerWebhookRoutes(app: Express) {
  app.post("/api/webhooks/easyorder", handleEasyOrderWebhook);

  // ملاحظة: مسار REST القديم `GET /api/webhooks/easyorder/log` اتشال — كان بلا auth وبيسرّب
  // PII كل التينانتات. القراءة الوحيدة دلوقتي عبر tRPC `webhook.log` (adminProcedure + scope).

  // Reports the current enforcement mode so the admin UI can warn while still in log_only.
  app.get("/api/webhooks/easyorder/health", (_req: Request, res: Response) => {
    res.json({ ok: true, secretEnforcement: getEnforcementMode() });
  });
}
