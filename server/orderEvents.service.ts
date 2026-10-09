import crypto from "crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { businesses } from "../drizzle/schema";
import { orderActivityEvents } from "../drizzle/orderEvents.schema";
import {
  ALLOWED_ORDER_EVENT_SOURCES,
  ALLOWED_ORDER_EVENT_TYPES,
  ORDER_EVENTS_TABLE,
  ORDER_NUMBER_SNAPSHOT_MAX,
  type OrderEventSource,
  type OrderEventType,
} from "../shared/orderEventsSpec";

/**
 * سجل أحداث الأوردرات (0041) — خلف العلم `ORDER_EVENTS_ENABLED` (افتراضيًا معطل).
 *
 *   • العلم معطل ⇒ لا أي استدعاء هنا ولا وصول للجدول؛ مسارات الأوردر تعمل بكودها القديم حرفيًا.
 *   • العلم مفعّل والجدول غائب ⇒ PRECONDITION_FAILED **قبل** أي تغيير (لا سقوط صامت).
 *   • كل حدث داخل **نفس معاملة** تغيير الأوردر وبعد قفل صف الأوردر FOR UPDATE: tenantId/businessId يُستخرجان
 *     من الأوردر ونشاطه (لا من العميل)، ونفس المفتاح + نفس الـhash = Replay، والـhash المختلف = CONFLICT.
 *   • لا حدث بلا تغيير فعلي، ولا تغيير بلا حدث (المعاملة ترجع كلها لو فشل الإدراج).
 *   • الأحداث للإضافة فقط: لا UPDATE ولا DELETE في هذا الملف ولا في غيره.
 */
export const orderEventsEnabled = () => process.env.ORDER_EVENTS_ENABLED === "true";

export type OrderEventActor =
  | { type: "employee"; employeeId: number; role?: string | null; name?: string | null }
  | { type: "system" }
  | { type: "webhook"; provider: "bosta" | "easyorders"; externalEventId?: string | null };

export type OrderEventContext = {
  actor: OrderEventActor;
  source: OrderEventSource;
  /** معرّف العملية من الواجهة — ثابت طوال دورة العملية (Retry/Double-click) */
  operationId?: string | null;
};

export type OrderEventInput = {
  eventType: OrderEventType;
  toStatus?: string | null;
  reason?: string | null;
  callAttempt?: number | null;
  assigneeEmployeeId?: number | null;
  metadata?: Record<string, unknown> | null;
};

type LockedOrder = { id: number; businessId: number | null; orderNumber: string | null; status: string | null; assignedEmployeeId?: number | null };

const OPERATION_ID = /^[A-Za-z0-9_-]{8,80}$/;

export function requireEventContext(ctx: OrderEventContext | null | undefined): OrderEventContext {
  if (!ctx)
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "سجل أحداث الأوردرات مفعّل لكن هذا المسار بلا سياق حدث — لم يُنفَّذ أي تغيير" });
  if (!ALLOWED_ORDER_EVENT_SOURCES.has(ctx.source)) throw new TRPCError({ code: "BAD_REQUEST", message: "مصدر حدث غير مسموح" });
  if (ctx.operationId != null && !OPERATION_ID.test(ctx.operationId)) throw new TRPCError({ code: "BAD_REQUEST", message: "معرّف العملية غير صالح" });
  if (ctx.actor.type === "employee" && !(Number.isInteger(ctx.actor.employeeId) && ctx.actor.employeeId > 0))
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "تعذّر تحديد الموظف المنفّذ — لم يُنفَّذ أي تغيير" });
  return ctx;
}

/** JSON قانوني (مفاتيح مرتبة) → SHA-256 hex. */
export function canonicalHash(payload: Record<string, unknown>): string {
  const canon = (v: unknown): unknown =>
    v === undefined ? null
      : Array.isArray(v) ? v.map(canon)
      : v && typeof v === "object" && !(v instanceof Date) ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canon((v as any)[k])]))
      : v instanceof Date ? v.toISOString() : v;
  return crypto.createHash("sha256").update(JSON.stringify(canon(payload))).digest("hex");
}

export function idempotencyKeyFor(eventType: string, orderId: number, ctx: OrderEventContext): string {
  const a = ctx.actor;
  const key = a.type === "webhook" && a.externalEventId
    ? `${a.provider}:${a.externalEventId}:${eventType}:${orderId}`
    : ctx.operationId
      ? `${eventType}:${orderId}:${ctx.operationId}`
      : `${eventType}:${orderId}:${crypto.randomUUID()}`;
  return key.length <= 191 ? key : `h:${crypto.createHash("sha256").update(key).digest("hex")}`;
}

const rowsOf = (r: any): any[] => (Array.isArray(r) ? (Array.isArray(r[0]) ? r[0] : r) : r?.rows ?? []);

/** الجدول موجود؟ (العلم مفعّل فقط) — غيابه = PRECONDITION_FAILED قبل أي تغيير. */
export async function assertOrderEventsReady(tx: any): Promise<void> {
  const res = await tx.execute(sql`SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${ORDER_EVENTS_TABLE}`);
  if (Number(rowsOf(res)[0]?.n ?? 0) === 0)
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "سجل أحداث الأوردرات مفعّل لكن الجدول غير موجود (0041 غير مطبّقة) — لم يُنفَّذ أي تغيير" });
}

export type PreparedOrderEvent =
  | { replay: true }
  | { replay: false; commit: (finalized: { fromStatus: string | null; toStatus?: string | null; previousAssigneeEmployeeId?: number | null }) => Promise<void> };

/**
 * يُستدعى **بعد** قفل صف الأوردر FOR UPDATE وقبل أي تعديل:
 *  - يتحقق من الجاهزية والقيم المسموحة، ويستخرج tenantId من نشاط الأوردر.
 *  - نفس المفتاح موجود: نفس الـhash ⇒ Replay (المسار يرجع بلا تغيير)، hash مختلف ⇒ CONFLICT.
 *  - غير ذلك يرجع commit() الذي يُدرج الحدث بعد التعديل الفعلي في نفس المعاملة.
 */
export async function prepareOrderEvent(tx: any, order: LockedOrder, rawCtx: OrderEventContext | null | undefined, input: OrderEventInput): Promise<PreparedOrderEvent> {
  const ctx = requireEventContext(rawCtx);
  if (!ALLOWED_ORDER_EVENT_TYPES.has(input.eventType)) throw new TRPCError({ code: "BAD_REQUEST", message: "نوع حدث غير مسموح" });
  if (input.callAttempt != null && input.eventType !== "no_answer") throw new TRPCError({ code: "BAD_REQUEST", message: "عدد المحاولات لحدث «لم يرد» فقط" });
  await assertOrderEventsReady(tx);
  if (order.businessId == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "الأوردر بلا نشاط — لا يمكن تسجيل حدثه" });
  const [biz] = await tx.select({ tenantId: businesses.tenantId }).from(businesses).where(eq(businesses.id, order.businessId)).limit(1);
  const tenantId: number | null = biz?.tenantId ?? null;
  if (tenantId == null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "نشاط الأوردر بلا tenant — لا يمكن تسجيل حدثه" });

  const actor = ctx.actor;
  const actorEmployeeId = actor.type === "employee" ? actor.employeeId : null;
  const key = idempotencyKeyFor(input.eventType, order.id, ctx);
  const payloadHash = canonicalHash({
    eventType: input.eventType, orderId: order.id, toStatus: input.toStatus ?? null, reason: input.reason ?? null,
    callAttempt: input.callAttempt ?? null, assignee: input.assigneeEmployeeId ?? null, actorType: actor.type, actorEmployeeId,
    metadata: input.metadata ?? null,
  });

  const [existing] = await tx
    .select({ id: orderActivityEvents.id, payloadHash: orderActivityEvents.payloadHash })
    .from(orderActivityEvents)
    .where(and(eq(orderActivityEvents.tenantId, tenantId), eq(orderActivityEvents.idempotencyKey, key)))
    .limit(1);
  if (existing) {
    if (existing.payloadHash === payloadHash) return { replay: true };
    throw new TRPCError({ code: "CONFLICT", message: "نفس معرّف العملية استُخدم لطلب مختلف — لم يُنفَّذ أي تغيير" });
  }

  return {
    replay: false,
    commit: async finalized => {
      const values = {
        tenantId,
        businessId: order.businessId as number,
        orderId: order.id,
        orderNumberSnapshot: String(order.orderNumber ?? `#${order.id}`).slice(0, ORDER_NUMBER_SNAPSHOT_MAX),
        eventType: input.eventType,
        fromStatus: finalized.fromStatus,
        toStatus: finalized.toStatus !== undefined ? finalized.toStatus : input.toStatus ?? null,
        actorType: actor.type,
        actorEmployeeId,
        // التقارير تعتمد attributedEmployeeId: حدث الموظف منسوب لمنفّذه؛ النظام/الويبهوك بلا نسبة.
        attributedEmployeeId: actorEmployeeId,
        actorRoleSnapshot: actor.type === "employee" ? (actor.role ?? null)?.slice(0, 50) ?? null : null,
        actorNameSnapshot: actor.type === "employee" ? (actor.name ?? null)?.slice(0, 100) ?? null : null,
        // صريح في المدخل (حتى null لسحب الإسناد) وإلا المُسنَد الحالي وقت الحدث.
        assigneeEmployeeIdAtEvent: "assigneeEmployeeId" in input ? (input.assigneeEmployeeId ?? null) : (order.assignedEmployeeId ?? null),
        previousAssigneeEmployeeId: finalized.previousAssigneeEmployeeId ?? null,
        reason: input.reason ? input.reason.slice(0, 160) : null,
        callAttempt: input.callAttempt ?? null,
        source: ctx.source,
        idempotencyKey: key,
        payloadHash,
        metadataJson: input.metadata ?? null,
      };
      try {
        // occurredAt/createdAt = وقت السيرفر من الـDB (DEFAULT CURRENT_TIMESTAMP(3)) — لا وقت من العميل.
        await tx.insert(orderActivityEvents).values(values as any);
      } catch (e: any) {
        const code = e?.code ?? e?.cause?.code;
        if (code === "ER_NO_REFERENCED_ROW_2" || code === "ER_NO_REFERENCED_ROW")
          throw new TRPCError({ code: "FORBIDDEN", message: "الموظف أو النشاط خارج نطاق الشركة — لم يُنفَّذ أي تغيير" });
        if (code === "ER_DUP_ENTRY")
          throw new TRPCError({ code: "CONFLICT", message: "العملية سُجّلت بالتوازي — أعد المحاولة" });
        throw e;
      }
    },
  };
}

/** UPDATE مشروط بالحالة المتوقعة: صفر صفوف ⇒ CONFLICT (لا حدث بلا تغيير فعلي). */
export function assertTransitioned(result: any, message = "تغيّرت حالة الأوردر أثناء التنفيذ — لم يُسجَّل شيء، أعد المحاولة"): void {
  const header = Array.isArray(result) ? result[0] : result;
  const affected = Number(header?.affectedRows ?? header?.rowsAffected ?? 0);
  if (affected < 1) throw new TRPCError({ code: "CONFLICT", message });
}

/** نوع الحدث لتغيير حالة عام. */
export function eventTypeForStatus(to: string): OrderEventType {
  return to === "cancelled" ? "cancel" : to === "postponed" ? "postpone" : to === "no_answer" ? "no_answer" : to === "confirmed" ? "confirm" : "status_change";
}
