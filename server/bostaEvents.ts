import { createHash } from "crypto";

/**
 * تطبيع أحداث Bosta — **المصدر: توثيق Bosta الرسمي «Get Shipment Status via Webhook»**.
 *
 * شكل الحدث الفعلي (مش `state: { code }`):
 *   { _id: string, trackingNumber: number|string, state: number, type: string,
 *     timeStamp: number(ms), cod?, isConfirmedDelivery?, deliveryPromiseDate?,
 *     exceptionReason?, exceptionCode?, businessReference?, numberOfAttempts? }
 *
 * الملف نقي (بلا قاعدة بيانات): يتحقق من الـpayload، يستخرج المعرّفات والحالة والوقت
 * والنوع، يبني مفتاح idempotency ثابتًا، ويحوّل كود Bosta لحدث داخلي موحّد. أي كود غير
 * موجود في جدول التوثيق = `unknown` → بيتسجّل للمراجعة وبلا أي تعديل على الأوردر.
 *
 * **مفيش أي أثر محاسبي هنا** — حالات تشغيلية فقط.
 */

export type BostaOrderType = "SEND" | "EXCHANGE" | "CUSTOMER_RETURN_PICKUP" | "RTO" | "SIGN_AND_RETURN" | "FXF_SEND";
const KNOWN_TYPES: readonly string[] = ["SEND", "EXCHANGE", "CUSTOMER_RETURN_PICKUP", "RTO", "SIGN_AND_RETURN", "FXF_SEND"];
/** أنواع «الإرسال للعميل» — هي بس اللي حالة 45 فيها = تسليم ناجح لأوردر بيع. */
const FORWARD_TYPES: readonly string[] = ["SEND", "FXF_SEND"];

/** الحدث الداخلي الموحّد. */
export type BostaEventKind =
  | "awaiting_pickup"      // 10/11/20 — لسه ماتستلمتش مننا
  | "picked_up"            // 21 — استلمها المندوب من النشاط
  | "in_transit"           // 24/30 — في المخزن/بين الفروع
  | "out_for_delivery"     // 41 (إرسال) — خرجت للعميل
  | "out_for_return"       // 41 (إرجاع/استبدال) — راجعة للنشاط
  | "delivered"            // 45 (إرسال)
  | "returned"             // 46 / 60
  | "exception"            // 47 — محاولة فاشلة بسبب (NDR)
  | "terminated"           // 48
  | "canceled"             // 49
  | "lost"                 // 100
  | "damaged"              // 101
  | "informational"        // حالات موثّقة بلا أثر على حالة الأوردر (22/23/25/40 أو 45 لغير الإرسال)
  | "needs_attention"      // 102–105 — تتحفظ وتظهر للمراجعة، بلا تعديل
  | "unknown";             // كود غير موثّق

export type InternalOrderStatus = "shipped" | "delivered" | "returned";

interface StateSpec {
  /** الاسم الرسمي في التوثيق. */
  name: string;
  /** الاسم العربي المختصر (≤ 50 حرفًا — عمود orders.bostaStatus). */
  label: string;
}

/** كل أكواد التوثيق الرسمي — لا كود هنا من خارج الجدول المنشور. */
export const BOSTA_STATES: Record<number, StateSpec> = {
  10: { name: "Pickup requested", label: "طلب استلام (جديد)" },
  11: { name: "Waiting for route", label: "في انتظار خط السير" },
  20: { name: "Route Assigned", label: "تم تعيين خط السير" },
  21: { name: "Picked up from business", label: "تم الاستلام من النشاط" },
  22: { name: "Picking up from consignee", label: "جارٍ الاستلام من العميل" },
  23: { name: "Picked up from consignee", label: "تم الاستلام من العميل" },
  24: { name: "Received at warehouse", label: "في مخزن بوسطة" },
  25: { name: "Fulfilled", label: "تم التجهيز (Fulfillment)" },
  30: { name: "In transit between Hubs", label: "بين فروع بوسطة" },
  40: { name: "Picking up", label: "جارٍ التحصيل من العميل" },
  41: { name: "Picked up", label: "خرجت مع المندوب" },
  45: { name: "Delivered", label: "تم التسليم" },
  46: { name: "Returned to business", label: "تم الإرجاع للنشاط" },
  47: { name: "Exception", label: "استثناء — محاولة غير ناجحة" },
  48: { name: "Terminated", label: "منتهية (Terminated)" },
  49: { name: "Canceled", label: "ملغاة في بوسطة" },
  60: { name: "Returned to stock", label: "تم الإرجاع للمخزون" },
  100: { name: "Lost", label: "مفقودة" },
  101: { name: "Damaged", label: "تالفة" },
  102: { name: "Investigation", label: "قيد التحقيق" },
  103: { name: "Awaiting your action", label: "في انتظار إجراء منك" },
  104: { name: "Archived", label: "مؤرشفة" },
  105: { name: "On hold", label: "معلّقة (On hold)" },
};

export interface NormalizedBostaEvent {
  shipmentId: string | null;
  trackingNumber: string | null;
  state: number;
  /** وقت تغيّر الحالة من Bosta (ms) — null لو الحدث ماحملوش. */
  timeStamp: number | null;
  type: string | null;
  typeKnown: boolean;
  cod: number | null;
  isConfirmedDelivery: boolean | null;
  numberOfAttempts: number | null;
  businessReference: string | null;
  exceptionReason: string | null;
  exceptionCode: number | null;
  /** مفتاح idempotency الثابت: provider + shipment + state + timeStamp (بلا وقت الاستقبال). */
  eventKey: string;
  /** معرّف الحدث للعرض/السجل. */
  eventId: string;
  kind: BostaEventKind;
  stateName: string;
  /** نص الحالة العربي لعمود orders.bostaStatus (≤ 50 حرفًا). */
  label: string;
  /** حالة الأوردر الداخلية المقترحة — null = لا تغيير لحالة الأوردر. */
  orderStatus: InternalOrderStatus | null;
  /** الحدث يستدعي مراجعة بشرية للأوردر (منتهية/ملغاة/مفقودة/تالفة). */
  flagsReview: boolean;
  /** الحدث يتحفظ بس بلا أي تعديل على الأوردر (102–105 والأكواد غير المعروفة). */
  storeOnly: boolean;
}

const toInt = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
};
const toNum = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const toStr = (v: unknown): string | null => {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
};

/** حدود الأعمدة — قيمة أطول/أكبر منها ماتنفعش تتخزّن ولا تطابق أي أوردر. */
const MAX_ID_LENGTH = 100;
const MAX_STATE_CODE = 1_000_000;
const MAX_TIMESTAMP_MS = 1e14;
const MAX_REASON_LENGTH = 300;

/** الوقت: رقم ms رسميًا؛ بنقبل ثواني (10 أرقام) ونص ISO كتوافق خلفي. قيمة خارج المدى = بلا وقت. */
function parseTimeStamp(p: Record<string, unknown>): number | null {
  const raw = p.timeStamp ?? p.timestamp ?? p.updatedAt ?? p.updated_at;
  const n = toNum(raw);
  if (n != null && n > 0) {
    const ms = n < 1e11 ? Math.trunc(n * 1000) : Math.trunc(n);
    return ms < MAX_TIMESTAMP_MS ? ms : null;
  }
  if (typeof raw === "string") {
    const d = new Date(raw).getTime();
    if (!Number.isNaN(d)) return d;
  }
  return null;
}

/** الحالة: **رقم مباشر** رسميًا. `state.code` / `status_code` توافق خلفي للقراءة فقط. */
function parseState(p: Record<string, unknown>): number | null {
  const direct = toInt(p.state);
  if (direct != null) return direct;
  if (p.state && typeof p.state === "object") {
    const nested = toInt((p.state as Record<string, unknown>).code);
    if (nested != null) return nested;
  }
  return toInt(p.status_code);
}

function classify(state: number, type: string | null): Pick<NormalizedBostaEvent, "kind" | "orderStatus" | "flagsReview" | "storeOnly"> {
  const forward = type != null && FORWARD_TYPES.includes(type);
  const none = { orderStatus: null, flagsReview: false, storeOnly: false } as const;
  switch (state) {
    case 10: case 11: case 20:
      return { kind: "awaiting_pickup", ...none };
    case 21:
      return { kind: "picked_up", ...none, orderStatus: forward ? "shipped" : null };
    case 24: case 30:
      return { kind: "in_transit", ...none, orderStatus: forward ? "shipped" : null };
    case 41:
      // «Picked up» معناها بيختلف بالنوع: خرجت للعميل (إرسال) أو راجعة للنشاط (إرجاع/استبدال).
      return forward ? { kind: "out_for_delivery", ...none, orderStatus: "shipped" } : { kind: "out_for_return", ...none };
    case 45:
      // تسليم ناجح **لأوردر إرسال فقط**. لغير الإرسال (أو نوع غير معروف) مفيش delivered.
      return forward ? { kind: "delivered", ...none, orderStatus: "delivered" } : { kind: "informational", ...none };
    case 46: case 60:
      return { kind: "returned", ...none, orderStatus: "returned" };
    case 47:
      return { kind: "exception", ...none };
    case 48:
      return { kind: "terminated", ...none, flagsReview: true };
    case 49:
      return { kind: "canceled", ...none, flagsReview: true };
    case 100:
      return { kind: "lost", ...none, flagsReview: true };
    case 101:
      return { kind: "damaged", ...none, flagsReview: true };
    case 22: case 23: case 25: case 40:
      return { kind: "informational", ...none };
    case 102: case 103: case 104: case 105:
      return { kind: "needs_attention", ...none, storeOnly: true };
    default:
      return { kind: "unknown", ...none, storeOnly: true };
  }
}

export function bostaEventKey(parts: { shipmentId: string | null; trackingNumber: string | null; state: number; timeStamp: number | null }): string {
  return createHash("sha256")
    .update(`bosta|${parts.shipmentId ?? ""}|${parts.shipmentId ? "" : (parts.trackingNumber ?? "")}|${parts.state}|${parts.timeStamp ?? "no-ts"}`)
    .digest("hex");
}

/**
 * payload خام → حدث موحّد، أو سبب رفض واضح.
 * الرفض: مش object، بلا معرّف شحنة/تتبع، أو حالة غير رقمية.
 */
export function normalizeBostaEvent(payload: unknown): { ok: true; event: NormalizedBostaEvent } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "payload غير صالح: المتوقع JSON object" };
  const p = payload as Record<string, unknown>;
  const shipmentId = toStr(p._id) ?? toStr(p.id) ?? toStr(p.shipmentId);
  const trackingNumber = toStr(p.trackingNumber) ?? toStr(p.tracking_number);
  if (!shipmentId && !trackingNumber) return { ok: false, error: "payload غير صالح: لا يوجد _id ولا trackingNumber" };
  if ((shipmentId?.length ?? 0) > MAX_ID_LENGTH || (trackingNumber?.length ?? 0) > MAX_ID_LENGTH)
    return { ok: false, error: "payload غير صالح: _id أو trackingNumber أطول من المسموح" };
  const state = parseState(p);
  if (state == null) return { ok: false, error: "payload غير صالح: الحقل state مفقود أو ليس رقمًا" };
  if (Math.abs(state) > MAX_STATE_CODE) return { ok: false, error: "payload غير صالح: الحقل state خارج المدى" };

  const timeStamp = parseTimeStamp(p);
  const rawType = toStr(p.type);
  const type = rawType ? rawType.toUpperCase() : null;
  const spec = BOSTA_STATES[state];
  const cls = classify(state, type);
  const exceptionReason = toStr(p.exceptionReason)?.slice(0, MAX_REASON_LENGTH) ?? null;
  const exceptionCode = toInt(p.exceptionCode);
  const eventKey = bostaEventKey({ shipmentId, trackingNumber, state, timeStamp });

  let label = spec?.label ?? `حالة غير معروفة (${state})`;
  if (cls.kind === "out_for_delivery") label = "خرجت للتسليم";
  if (cls.kind === "out_for_return") label = "خرجت للإرجاع للنشاط";
  // التوثيق بيعرّف isConfirmedDelivery كعلامة «إثبات تسليم» فقط — الحالة 45 هي مصدر التسليم.
  // false صريحة = تسليم بلا إثبات: بيتسجّل delivered والنص بيوضّح ده للمراجعة.
  if (cls.kind === "delivered" && p.isConfirmedDelivery === false) label = "تم التسليم بدون تأكيد استلام";

  return {
    ok: true,
    event: {
      shipmentId, trackingNumber, state, timeStamp, type, typeKnown: type != null && KNOWN_TYPES.includes(type),
      cod: toNum(p.cod),
      isConfirmedDelivery: typeof p.isConfirmedDelivery === "boolean" ? p.isConfirmedDelivery : null,
      numberOfAttempts: toInt(p.numberOfAttempts),
      businessReference: toStr(p.businessReference),
      exceptionReason, exceptionCode,
      eventKey,
      eventId: `${shipmentId ?? trackingNumber}:${state}:${timeStamp ?? "no-ts"}`,
      stateName: spec?.name ?? "Unknown",
      label: label.slice(0, 50),
      ...cls,
    },
  };
}

/** ترتيب تقدّم حالة الأوردر — حدث متأخر مايرجّعش الأوردر لورا. */
const STATUS_RANK: Record<string, number> = { shipped: 1, delivered: 2, returned: 3 };

/**
 * هل الانتقال مسموح؟ قبل الشحن → أي حالة شحن؛ shipped → delivered/returned؛
 * delivered → returned (مرتجع بعد تسليم)؛ ولا رجوع من delivered/returned لـshipped، ولا من
 * returned لـdelivered. أوردر ملغي داخليًا مابيتغيّرش من الـwebhook.
 */
export function canAdvanceOrderStatus(current: string, next: InternalOrderStatus): boolean {
  if (current === "cancelled") return false;
  const cur = STATUS_RANK[current] ?? 0;
  return STATUS_RANK[next] > cur;
}
