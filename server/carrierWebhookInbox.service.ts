import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { carrierWebhookInbox } from "../drizzle/schema";
import { getDb } from "./db";
import { isMissingTableError } from "./carrierAccounts.service";

/**
 * صندوق وارد أحداث شركات الشحن — الحدث الخام بيتحفظ **قبل** المعالجة، وحالته بتتحدّث بعدها.
 *
 * التكرار: القيد الفريد (businessId, provider, eventKey) بيمنع صفًا تاني لنفس الحدث؛ بدل كده
 * `duplicateCount` بيزيد على الصف الأصلي. الـpayload ممكن يحمل بيانات عميل — بيتخزّن في
 * القاعدة بس، ومابيتطبعش في اللوج.
 *
 * **Fail-safe قبل Migration 0039:** غياب الجدول = `unavailable` والمعالجة بتكمل بلا سجل خام.
 */

export type InboxStatus = "received" | "processed" | "unmatched" | "ignored" | "failed";
export type InboxRow = typeof carrierWebhookInbox.$inferSelect;

let warned = false;
function warnMissingOnce() {
  if (warned) return;
  warned = true;
  console.warn("[carrierWebhookInbox] جدول carrier_webhook_inbox غير موجود — شغّل migration 0039 (الأحداث بتتعالج بلا سجل خام)");
}
const isDup = (err: any) => err?.code === "ER_DUP_ENTRY" || err?.errno === 1062 || err?.cause?.errno === 1062;

export interface ReceiveInput {
  tenantId: number | null;
  businessId: number | null;
  provider: string;
  shipmentId: string | null;
  trackingNumber: string | null;
  eventKey: string;
  stateCode: number | null;
  eventType: string | null;
  eventTimestamp: number | null;
  payload: unknown;
}

export type ReceiveResult =
  | { mode: "stored"; id: number }
  | { mode: "duplicate"; row: InboxRow }
  | { mode: "unavailable" };

/** يحفظ الحدث الخام بحالة received، أو يرجّع الصف الأصلي لو الحدث مكرر. */
export async function receiveInboxEvent(input: ReceiveInput): Promise<ReceiveResult> {
  const db = await getDb();
  if (!db) return { mode: "unavailable" };
  const scope = and(
    input.businessId == null ? isNull(carrierWebhookInbox.businessId) : eq(carrierWebhookInbox.businessId, input.businessId),
    eq(carrierWebhookInbox.provider, input.provider),
    eq(carrierWebhookInbox.eventKey, input.eventKey)
  );
  const bumpDuplicate = async (): Promise<ReceiveResult | null> => {
    const [row] = await db.select().from(carrierWebhookInbox).where(scope).limit(1);
    if (!row) return null;
    await db.update(carrierWebhookInbox).set({ duplicateCount: sql`${carrierWebhookInbox.duplicateCount} + 1` }).where(eq(carrierWebhookInbox.id, row.id));
    return { mode: "duplicate", row };
  };
  try {
    // businessId = NULL مش داخل في القيد الفريد (NULL ≠ NULL) → فحص صريح قبل الإدراج.
    if (input.businessId == null) {
      const dup = await bumpDuplicate();
      if (dup) return dup;
    }
    const [res]: any = await db.insert(carrierWebhookInbox).values({
      tenantId: input.tenantId,
      businessId: input.businessId,
      provider: input.provider,
      shipmentId: input.shipmentId,
      trackingNumber: input.trackingNumber,
      eventKey: input.eventKey,
      stateCode: input.stateCode,
      eventType: input.eventType,
      eventTimestamp: input.eventTimestamp,
      processingStatus: "received",
      payloadJson: JSON.stringify(input.payload ?? null),
    });
    return { mode: "stored", id: Number(res?.insertId) };
  } catch (err) {
    if (isMissingTableError(err)) { warnMissingOnce(); return { mode: "unavailable" }; }
    if (isDup(err)) {
      const dup = await bumpDuplicate();
      if (dup) return dup;
    }
    throw err;
  }
}

/** يحدّث حالة المعالجة — processedAt بيتسجّل لكل حالة نهائية. */
export async function markInboxEvent(
  id: number,
  patch: { status: InboxStatus; failureReason?: string | null; orderId?: number | null; businessId?: number | null; tenantId?: number | null; bumpAttempts?: boolean }
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.update(carrierWebhookInbox).set({
      processingStatus: patch.status,
      failureReason: patch.failureReason ?? null,
      ...(patch.orderId !== undefined ? { orderId: patch.orderId } : {}),
      ...(patch.businessId != null ? { businessId: patch.businessId } : {}),
      ...(patch.tenantId != null ? { tenantId: patch.tenantId } : {}),
      ...(patch.bumpAttempts ? { attempts: sql`${carrierWebhookInbox.attempts} + 1` } : {}),
      processedAt: patch.status === "received" ? null : new Date(),
    }).where(eq(carrierWebhookInbox.id, id));
  } catch (err) {
    if (isMissingTableError(err)) { warnMissingOnce(); return; }
    throw err;
  }
}

/** أحدث وقت حدث اتطبّق فعلًا على نفس الشحنة داخل النشاط — لمنع حدث أقدم من الرجوع بالحالة. */
export async function latestProcessedEventTimestamp(businessId: number, shipmentId: string, excludeId?: number): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const [row] = await db
      .select({ ts: sql<number | null>`MAX(${carrierWebhookInbox.eventTimestamp})` })
      .from(carrierWebhookInbox)
      .where(and(
        eq(carrierWebhookInbox.businessId, businessId),
        eq(carrierWebhookInbox.shipmentId, shipmentId),
        eq(carrierWebhookInbox.processingStatus, "processed"),
        ...(excludeId != null ? [ne(carrierWebhookInbox.id, excludeId)] : [])
      ));
    return row?.ts != null ? Number(row.ts) : null;
  } catch (err) {
    if (isMissingTableError(err)) { warnMissingOnce(); return null; }
    throw err;
  }
}

export async function getInboxEvent(id: number): Promise<InboxRow | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const [row] = await db.select().from(carrierWebhookInbox).where(eq(carrierWebhookInbox.id, id)).limit(1);
    return row ?? null;
  } catch (err) {
    if (isMissingTableError(err)) { warnMissingOnce(); return null; }
    throw err;
  }
}

/** قائمة أحداث نشاط للمراجعة — بلا الـpayload الخام (ممكن يحمل بيانات عميل). */
export async function listInboxEvents(businessId: number, opts: { statuses?: InboxStatus[]; limit?: number } = {}) {
  const db = await getDb();
  if (!db) return [];
  try {
    return await db
      .select({
        id: carrierWebhookInbox.id, provider: carrierWebhookInbox.provider, shipmentId: carrierWebhookInbox.shipmentId,
        trackingNumber: carrierWebhookInbox.trackingNumber, stateCode: carrierWebhookInbox.stateCode, eventType: carrierWebhookInbox.eventType,
        eventTimestamp: carrierWebhookInbox.eventTimestamp, orderId: carrierWebhookInbox.orderId, processingStatus: carrierWebhookInbox.processingStatus,
        failureReason: carrierWebhookInbox.failureReason, attempts: carrierWebhookInbox.attempts, duplicateCount: carrierWebhookInbox.duplicateCount,
        receivedAt: carrierWebhookInbox.receivedAt, processedAt: carrierWebhookInbox.processedAt,
      })
      .from(carrierWebhookInbox)
      .where(and(
        eq(carrierWebhookInbox.businessId, businessId),
        ...(opts.statuses?.length ? [inArray(carrierWebhookInbox.processingStatus, opts.statuses)] : [])
      ))
      .orderBy(desc(carrierWebhookInbox.id))
      .limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  } catch (err) {
    if (isMissingTableError(err)) { warnMissingOnce(); return []; }
    throw err;
  }
}
