/**
 * Bosta Webhook Handler — استقبال حالات الشحن فقط (بلا أي أثر محاسبي أو مخزني).
 *
 * Webhook URL: POST /api/webhooks/bosta
 * Header: x-bosta-secret: <سر حساب الشحن الخاص بالنشاط>
 *
 * المصدر: توثيق Bosta الرسمي «Get Shipment Status via Webhook» — `state` رقم مباشر و
 * `timeStamp` رقم (ms). التطبيع وخريطة الحالات في `bostaEvents.ts`.
 *
 * ترتيب العزل **ثابت**: السر → hash → حساب الشحن والنشاط → الأوردر بشرط
 * (businessId + bostaShipmentId). ممنوع البحث عن الشحنة عالميًا ثم استنتاج النشاط. مسار
 * المفتاح العام (`BOSTA_WEBHOOK_SECRET`) لفترة الانتقال بس ومقيّد بالأنشطة اللي **مالهاش**
 * صف حساب شحن.
 *
 * مسار المحاسبة V2 (`processProviderWebhook`) **مابيتنادَش من هنا** في المرحلة دي: قراءة
 * الحالة الحقيقية كانت هتفعّله لأول مرة وتولّد أثرًا ماليًا — وده خارج نطاق استقبال الحالات.
 */
import { Request, Response, Express } from "express";
import { timingSafeEqual } from "crypto";
import { getDb } from "./db";
import { businesses, orders } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { findAccountByWebhookSecret, getCarrierAccountRow, recordWebhookEvent, PROVIDER_BOSTA } from "./carrierAccounts.service";
import { normalizeBostaEvent, canAdvanceOrderStatus, type NormalizedBostaEvent } from "./bostaEvents";
import {
  receiveInboxEvent, markInboxEvent, latestProcessedEventTimestamp, getInboxEvent,
  type InboxRow, type InboxStatus,
} from "./carrierWebhookInbox.service";

/** مقارنة آمنة (constant-time) لتفادي تسريب معلومات عن السر عبر توقيت الاستجابة. */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * نص خطأ آمن للّوج ولسجل الحدث: رسالة خطأ الـORM بتحمل نص الاستعلام **والـparams** — ومنها
 * الـpayload الخام — فمابتتطبعش ولا بتتخزّن أبدًا. بيرجع كود الخطأ بس.
 */
export function safeErrorText(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown; errno?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code ?? e?.cause?.errno;
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (code != null || /^Failed query/i.test(message)) return `خطأ داخلي${code != null ? ` (${String(code).slice(0, 40)})` : ""}`;
  return message ? message.slice(0, 200) : "خطأ داخلي";
}

export interface ApplyResult {
  status: Exclude<InboxStatus, "received" | "failed">;
  reason?: string;
  orderId?: number;
  orderStatus?: string;
}

/** أسباب المراجعة اللي الـwebhook بيضيفها — بتتضاف مرة واحدة بس. */
function appendReview(existing: string | null, reason: string): string {
  const parts = (existing ?? "").split(" | ").map(s => s.trim()).filter(Boolean);
  if (!parts.includes(reason)) parts.push(reason);
  return parts.join(" | ");
}

/**
 * تطبيق حدث موحّد على أوردر **داخل النشاط المحدد فقط**. نفس الدالة للاستقبال ولإعادة
 * المعالجة — وهي idempotent: مابتعملش غير set لحالة/نص، فإعادتها ماتكررش أي أثر.
 *
 *   • شحنة مش موجودة في النشاط → unmatched (ولا أوردر بيتلمس).
 *   • كود غير معروف أو 102–105 → ignored (يتحفظ للمراجعة، بلا تعديل).
 *   • حدث أقدم من آخر حدث مطبَّق على نفس الشحنة → ignored.
 *   • غير كده: نص حالة بوسطة + حالة الأوردر لو الانتقال للأمام مسموح.
 */
export async function applyBostaEvent(businessId: number, event: NormalizedBostaEvent, inboxId?: number): Promise<ApplyResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const byShipment = event.shipmentId
    ? eq(orders.bostaShipmentId, event.shipmentId)
    : eq(orders.bostaTrackingNumber, event.trackingNumber as string);
  const [order] = await db.select().from(orders).where(and(eq(orders.businessId, businessId), byShipment)).limit(1);
  if (!order) return { status: "unmatched", reason: "لا توجد شحنة مطابقة داخل هذا النشاط" };

  if (event.storeOnly) {
    return {
      status: "ignored", orderId: order.id,
      reason: event.kind === "unknown" ? `كود حالة غير معروف (${event.state}) — للمراجعة` : `${event.stateName} (${event.state}) — للمراجعة، بلا تعديل على الأوردر`,
    };
  }

  // حدث قديم وصل بعد حدث أحدث لنفس الشحنة → مايرجّعش الأوردر لورا.
  const shipmentKey = event.shipmentId ?? order.bostaShipmentId;
  if (event.timeStamp != null && shipmentKey) {
    const latest = await latestProcessedEventTimestamp(businessId, shipmentKey, inboxId);
    if (latest != null && event.timeStamp < latest)
      return { status: "ignored", orderId: order.id, reason: "حدث أقدم من آخر حالة مسجّلة لهذه الشحنة" };
  }

  const advance = event.orderStatus != null && canAdvanceOrderStatus(order.status, event.orderStatus);
  // حالة شحن أقدم (shipped) بعد delivered/returned مابتغيّرش حتى نص الحالة.
  const regress = event.orderStatus != null && !advance && order.status !== event.orderStatus;
  if (regress)
    return { status: "ignored", orderId: order.id, reason: `الأوردر في حالة «${order.status}» — حدث «${event.label}» لا يرجّعه للخلف` };

  const exceptionNote = event.kind === "exception"
    ? `استثناء بوسطة: ${event.exceptionReason ?? "بلا سبب مذكور"}${event.exceptionCode != null ? ` (كود ${event.exceptionCode})` : ""}`
    : null;

  await db
    .update(orders)
    .set({
      bostaStatus: event.label,
      ...(event.trackingNumber ? { bostaTrackingNumber: event.trackingNumber } : {}),
      ...(advance ? { status: event.orderStatus as any } : {}),
      ...(exceptionNote ? { bostaLastError: exceptionNote } : {}),
      ...(event.flagsReview ? { needsReview: true, reviewReason: appendReview(order.reviewReason, `بوسطة: ${event.label}`) } : {}),
    })
    .where(and(eq(orders.id, order.id), eq(orders.businessId, businessId)));

  return { status: "processed", orderId: order.id, orderStatus: advance ? (event.orderStatus as string) : order.status };
}

/** يطبّق الحدث ويسجّل النتيجة في صندوق الوارد؛ الفشل بيتسجّل failed بسببه. */
async function processAndMark(businessId: number, tenantId: number | null, event: NormalizedBostaEvent, inboxId: number | null, bumpAttempts = false): Promise<ApplyResult> {
  try {
    const result = await applyBostaEvent(businessId, event, inboxId ?? undefined);
    if (inboxId != null)
      await markInboxEvent(inboxId, { status: result.status, failureReason: result.reason ?? null, orderId: result.orderId ?? null, businessId, tenantId, bumpAttempts });
    return result;
  } catch (err) {
    if (inboxId != null)
      await markInboxEvent(inboxId, { status: "failed", failureReason: safeErrorText(err), businessId, tenantId, bumpAttempts });
    throw err;
  }
}

// ==================== Webhook Handler ====================
export async function handleBostaWebhook(req: Request, res: Response) {
  try {
    const receivedSecret = req.headers["x-bosta-secret"];
    if (typeof receivedSecret !== "string" || !receivedSecret) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 1) السر → hash → النشاط. مفيش أي قراءة أوردر ولا حفظ قبل السطر ده.
    const account = await findAccountByWebhookSecret(receivedSecret);
    let businessId: number | null = account?.businessId ?? null;
    let tenantId: number | null = account?.tenantId ?? null;
    let legacy = false;
    if (!businessId) {
      const envSecret = process.env.BOSTA_WEBHOOK_SECRET;
      if (envSecret && safeCompare(receivedSecret, envSecret)) legacy = true;
      else {
        console.warn("[Bosta Webhook] Unauthorized request - unknown secret");
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const drizzle = await getDb();
    if (!drizzle) return res.status(500).json({ error: "DB not available" });

    // 2) التطبيع — payload غير صالح بيترفض برسالة واضحة (ومابيتطبعش في اللوج).
    const payload = req.body ?? {};
    const normalized = normalizeBostaEvent(payload);
    if (!normalized.ok) {
      console.warn(`[Bosta Webhook] invalid payload rejected: ${normalized.error}`);
      return res.status(400).json({ error: normalized.error });
    }
    const event = normalized.event;

    // فترة الانتقال: السر العام بيوصل للأوردر بشرط إن نشاطه **مالوش** حساب شحن.
    if (legacy) {
      const byShipment = event.shipmentId ? eq(orders.bostaShipmentId, event.shipmentId) : eq(orders.bostaTrackingNumber, event.trackingNumber as string);
      const [candidate] = await drizzle.select({ businessId: orders.businessId }).from(orders).where(byShipment).limit(1);
      if (candidate) {
        if (await getCarrierAccountRow(candidate.businessId)) {
          console.warn("[Bosta Webhook] legacy secret used for a business that has its own account — rejected");
          return res.status(401).json({ error: "Unauthorized" });
        }
        businessId = candidate.businessId;
        const [b] = await drizzle.select({ tenantId: businesses.tenantId }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
        tenantId = b?.tenantId ?? null;
      }
    }

    // 3) حفظ الحدث الخام **قبل** المعالجة + idempotency بمفتاح ثابت (shipment + state + timeStamp).
    const received = await receiveInboxEvent({
      tenantId, businessId, provider: PROVIDER_BOSTA,
      shipmentId: event.shipmentId, trackingNumber: event.trackingNumber, eventKey: event.eventKey,
      stateCode: event.state, eventType: event.type, eventTimestamp: event.timeStamp, payload,
    });

    let inboxId: number | null = null;
    if (received.mode === "duplicate") {
      const prev: InboxRow = received.row;
      // حدث اتسجّل قبل كده: لو اتعالج (أو اتصنّف) → نجاح idempotent بلا أي تحديث. لو لسه
      // received/failed (المعالجة ماكملتش) → نكمّلها دلوقتي على نفس الصف، مش صف جديد.
      if (prev.processingStatus !== "received" && prev.processingStatus !== "failed")
        return res.status(200).json({ ok: true, duplicate: true, status: prev.processingStatus });
      inboxId = prev.id;
    } else if (received.mode === "stored") {
      inboxId = received.id;
    } else if (businessId != null) {
      // قبل Migration 0039: مفيش صندوق وارد — الـidempotency من جدول 0037.
      const fresh = await recordWebhookEvent({ businessId, provider: PROVIDER_BOSTA, eventHash: event.eventKey, shipmentId: event.shipmentId, stateCode: event.state });
      if (!fresh) return res.status(200).json({ ok: true, duplicate: true });
    }

    if (businessId == null) {
      // سر عام صحيح لكن مفيش أوردر بالشحنة دي → unmatched، ومفيش أوردر بيتلمس.
      if (inboxId != null) await markInboxEvent(inboxId, { status: "unmatched", failureReason: "لا توجد شحنة مطابقة" });
      console.warn(`[Bosta Webhook] unmatched shipment (legacy secret) state=${event.state}`);
      return res.status(200).json({ ok: true, status: "unmatched" });
    }

    // 4) التطبيق داخل النشاط المحدد بس.
    const result = await processAndMark(businessId, tenantId, event, inboxId, received.mode === "duplicate");
    console.log(`[Bosta Webhook] business ${businessId}${legacy ? " (legacy secret)" : ""} state=${event.state} type=${event.typeKnown ? event.type : "other"} → ${result.status}${result.orderStatus ? ` (order ${result.orderStatus})` : ""}`);
    return res.status(200).json({ ok: true, status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
  } catch (err) {
    console.error(`[Bosta Webhook] Error: ${safeErrorText(err)}`);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * إعادة معالجة حدث unmatched/failed — **داخل نشاط الحدث نفسه**. آمنة للتكرار: التطبيق
 * مجرد set لحالة/نص بشروط التقدّم، والحدث المعالَج فعلًا (processed/ignored) مابيتعادش.
 */
export async function reprocessBostaInboxEvent(inboxId: number, businessId: number): Promise<{ ok: boolean; status: InboxStatus; reason?: string }> {
  const row = await getInboxEvent(inboxId);
  if (!row || row.businessId !== businessId || row.provider !== PROVIDER_BOSTA)
    return { ok: false, status: "failed", reason: "الحدث غير موجود في هذا النشاط" };
  if (row.processingStatus !== "unmatched" && row.processingStatus !== "failed")
    return { ok: true, status: row.processingStatus as InboxStatus, reason: "الحدث تمت معالجته من قبل — لا إعادة" };
  let payload: unknown = null;
  try { payload = JSON.parse(row.payloadJson); } catch { /* يتعامل معاه التطبيع */ }
  const normalized = normalizeBostaEvent(payload);
  if (!normalized.ok) {
    await markInboxEvent(row.id, { status: "failed", failureReason: normalized.error, bumpAttempts: true });
    return { ok: false, status: "failed", reason: normalized.error };
  }
  try {
    const result = await processAndMark(businessId, row.tenantId, normalized.event, row.id, true);
    return { ok: true, status: result.status, reason: result.reason };
  } catch (err) {
    return { ok: false, status: "failed", reason: safeErrorText(err) };
  }
}

// ==================== Register Routes ====================
export function registerBostaWebhookRoutes(app: Express) {
  // POST فقط — أي method تاني على نفس المسار 405.
  app.post("/api/webhooks/bosta", handleBostaWebhook);
  app.all("/api/webhooks/bosta", (_req: Request, res: Response) => res.status(405).set("Allow", "POST").json({ error: "Method Not Allowed" }));

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
