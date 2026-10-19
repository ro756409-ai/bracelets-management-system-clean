import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { activityLogs, orders } from "../drizzle/schema";
import { getDb, addActivityLog } from "./db";
import { BOSTA_CREATING, BOSTA_RESET_REQUESTED, BOSTA_UNCERTAIN } from "./bosta.service";
import { ClientSafeError } from "./logSafety";

/**
 * حسم شحنات بوسطة **غير المؤكدة** — مراجعة بشرية موثّقة، من غير أي نداء لبوسطة.
 *
 * الحالات اللي بتحتاج حسم: `uncertain` (النداء وقع أو الرد ماكانش واضح)، و`creating` **القديمة** (السيرفر وقع وسط
 * الإرسال). `creating` الحديثة (أقل من CREATING_STALE_MS) = إرسال شغال دلوقتي، فممنوع لمسها.
 *
 *   • ربط (link): المراجع شاف الشحنة في لوحة بوسطة → يسجّل رقمها (+ رقم التتبع لو ظاهر) مع دليل إلزامي.
 *     رقم الشحنة ممنوع يتربط بأكتر من أوردر (في كل التجار)، تحت قفل باسم الرقم عشان طلبين متزامنين مايعدّوش.
 *   • إعادة الإرسال: **مسار مراجعة من خطوتين**، مش زر بيفتح الإرسال:
 *       1) طلب (requestReset) بدليل إن الشحنة ماتعملتش عند بوسطة → الحالة reset_requested والإرسال لسه مقفول.
 *       2) اعتماد مالك **تاني** (approveReset) بتوثيق تحقق منظّم من لوحة بوسطة → الحالة failed (= مفيش شحنة، والإرسال اتفتح).
 *     مقدّم الطلب مايعتمدش طلبه أبدًا (B2) — مرور الوقت مابيدّيش أي صلاحية.
 * كل خطوة بتتسجّل في سجل الأنشطة بالدليل (من غير أسرار). التحديثات شرطية على الحالة المقروءة (لا سباق).
 */
export const CREATING_STALE_MS = 10 * 60 * 1000;
const SHIPMENT_ID_RE = /^[A-Za-z0-9_-]{4,100}$/;
const TRACKING_RE = /^[A-Za-z0-9-]{4,100}$/;

export class BostaResolutionError extends ClientSafeError {
  constructor(message: string) { super(message); this.name = "BostaResolutionError"; }
}

export type ResolutionActor = { id: number; name: string; role: string };
type OrderRow = typeof orders.$inferSelect;

function assertEvidence(evidence: string): string {
  const e = (evidence ?? "").trim();
  if (e.length < 10) throw new BostaResolutionError("الدليل مطلوب (10 حروف على الأقل): مرجع من لوحة بوسطة أو رابط صورة أو وصف المراجعة");
  return e.slice(0, 1000);
}

/** الأوردر قابل للحسم؟ uncertain، أو creating قديمة — من غير رقم شحنة. */
export function resolvableState(order: Pick<OrderRow, "bostaShipmentId" | "bostaStatus" | "updatedAt">, now = new Date()): "uncertain" | "stale_creating" | null {
  if (order.bostaShipmentId) return null;
  if (order.bostaStatus === BOSTA_UNCERTAIN) return "uncertain";
  if (order.bostaStatus === BOSTA_CREATING && order.updatedAt && now.getTime() - new Date(order.updatedAt).getTime() >= CREATING_STALE_MS) return "stale_creating";
  return null;
}

async function loadScoped(orderId: number, allowedBusinessIds: number[]): Promise<OrderRow> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [o] = await db.select().from(orders)
    .where(and(eq(orders.id, orderId), inArray(orders.businessId, allowedBusinessIds.length ? allowedBusinessIds : [-1]))).limit(1);
  if (!o) throw new BostaResolutionError("الأوردر غير موجود");
  return o;
}

export async function linkUncertainShipment(input: {
  orderId: number; allowedBusinessIds: number[]; shipmentId: string; trackingNumber?: string | null; evidence: string; actor: ResolutionActor; now?: Date;
}): Promise<{ shipmentId: string; trackingNumber: string | null }> {
  const shipmentId = input.shipmentId.trim();
  const tracking = input.trackingNumber?.trim() || null;
  if (!SHIPMENT_ID_RE.test(shipmentId)) throw new BostaResolutionError("رقم الشحنة غير صالح — انسخه كما هو من لوحة بوسطة");
  if (tracking && !TRACKING_RE.test(tracking)) throw new BostaResolutionError("رقم التتبع غير صالح");
  const evidence = assertEvidence(input.evidence);
  const order = await loadScoped(input.orderId, input.allowedBusinessIds);
  const state = resolvableState(order, input.now);
  if (!state) throw new BostaResolutionError("الأوردر ده مش في حالة شحنة غير مؤكدة — مفيش حاجة تتربط");
  const db = (await getDb())!;
  // قفل باسم رقم الشحنة على مستوى القاعدة: طلبين بنفس الرقم على أوردرين مايعدّوش الفحص سوا.
  const lockName = `bosta-link:${shipmentId}`;
  const [[lock]] = (await db.execute(sql`SELECT GET_LOCK(${lockName}, 10) AS l`)) as any;
  if (Number(lock?.l) !== 1) throw new BostaResolutionError("عملية ربط تانية بنفس رقم الشحنة شغالة — حاول تاني");
  try {
    const [taken] = await db.select({ id: orders.id }).from(orders).where(eq(orders.bostaShipmentId, shipmentId)).limit(1);
    if (taken) throw new BostaResolutionError("رقم الشحنة ده مربوط بأوردر تاني بالفعل — مينفعش يتربط بأكتر من أوردر");
    if (tracking) {
      const [t] = await db.select({ id: orders.id }).from(orders).where(eq(orders.bostaTrackingNumber, tracking)).limit(1);
      if (t) throw new BostaResolutionError("رقم التتبع ده مربوط بأوردر تاني بالفعل");
    }
    const r: any = await db.update(orders).set({
      bostaShipmentId: shipmentId,
      bostaTrackingNumber: tracking,
      bostaStatus: "sent",
      bostaSentAt: order.bostaSentAt ?? order.updatedAt ?? new Date(),
      bostaLastError: null,
    }).where(and(eq(orders.id, order.id), isNull(orders.bostaShipmentId), eq(orders.bostaStatus, String(order.bostaStatus))));
    if (Number(r?.[0]?.affectedRows ?? r?.affectedRows ?? 0) !== 1)
      throw new BostaResolutionError("حالة الأوردر اتغيّرت أثناء الربط — راجعه تاني");
  } finally {
    await db.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
  }
  await addActivityLog({
    action: "bosta_link_shipment", entityType: "order", entityId: order.id, businessId: order.businessId,
    description: `ربط شحنة بوسطة يدويًا بالأوردر #${order.orderNumber} بعد مراجعة (${state === "uncertain" ? "غير مؤكدة" : "إنشاء متوقف"})`,
    metadata: { shipmentId, trackingNumber: tracking, previousStatus: order.bostaStatus, evidence },
    performedBy: input.actor.id, performedByName: input.actor.name, performedByRole: input.actor.role,
  });
  return { shipmentId, trackingNumber: tracking };
}

export async function requestBostaReset(input: {
  orderId: number; allowedBusinessIds: number[]; evidence: string; actor: ResolutionActor; now?: Date;
}): Promise<{ status: typeof BOSTA_RESET_REQUESTED }> {
  const evidence = assertEvidence(input.evidence);
  const order = await loadScoped(input.orderId, input.allowedBusinessIds);
  if (!resolvableState(order, input.now)) throw new BostaResolutionError("طلب إعادة الإرسال متاح بس لشحنة غير مؤكدة (أو إنشاء متوقف من 10 دقايق على الأقل)");
  const db = (await getDb())!;
  const r: any = await db.update(orders).set({
    bostaStatus: BOSTA_RESET_REQUESTED,
    bostaLastError: `طلب إعادة إرسال تحت مراجعة المالك — مقدَّم من ${input.actor.name}`,
  }).where(and(eq(orders.id, order.id), isNull(orders.bostaShipmentId), eq(orders.bostaStatus, String(order.bostaStatus))));
  if (Number(r?.[0]?.affectedRows ?? r?.affectedRows ?? 0) !== 1) throw new BostaResolutionError("حالة الأوردر اتغيّرت — راجعه تاني");
  await addActivityLog({
    action: "bosta_reset_requested", entityType: "order", entityId: order.id, businessId: order.businessId,
    description: `طلب إعادة إرسال لبوسطة للأوردر #${order.orderNumber} (الشحنة غير مؤكدة) — بانتظار اعتماد المالك`,
    metadata: { previousStatus: order.bostaStatus, evidence },
    performedBy: input.actor.id, performedByName: input.actor.name, performedByRole: input.actor.role,
  });
  return { status: BOSTA_RESET_REQUESTED };
}

/**
 * B2 (2026-10-20) — توثيق تحقق منظّم إن الشحنة **ماتعملتش** عند بوسطة. النص الحر لوحده مش كفاية.
 *   • method: بحث في لوحة بوسطة (الطريقة الوحيدة المتاحة من غير API — مفيش أي نداء لبوسطة هنا).
 *   • searchedAt: وقت البحث — بعد وقت طلب إعادة الإرسال ومش في المستقبل.
 *   • searchQuery: اللي اتبحث بيه، ولازم يحتوي رقم الأوردر (المرجع اللي اتبعت لبوسطة كـbusinessReference).
 *   • resultCount: لازم 0 — أي نتيجة = الشحنة ممكن تكون اتعملت ⇒ الاعتماد مرفوض والحالة تفضل reset_requested.
 *   • screenshotUrl: رابط https لصورة نتيجة البحث (دليل قابل للمراجعة).
 */
export type ResetVerification = {
  method: "bosta_dashboard_search";
  searchedAt: string | Date;
  searchQuery: string;
  resultCount: number;
  screenshotUrl: string;
  notes?: string | null;
};

function assertVerification(v: ResetVerification | null | undefined, order: Pick<OrderRow, "orderNumber">, requestedAt: Date, now: Date) {
  if (!v || v.method !== "bosta_dashboard_search") throw new BostaResolutionError("مطلوب توثيق تحقق من لوحة بوسطة (بحث برقم الأوردر) — النص الحر لوحده مش كفاية");
  const at = new Date(v.searchedAt as any);
  if (Number.isNaN(at.getTime())) throw new BostaResolutionError("وقت البحث في لوحة بوسطة غير صالح");
  if (at.getTime() < requestedAt.getTime()) throw new BostaResolutionError("البحث في لوحة بوسطة لازم يكون بعد طلب إعادة الإرسال");
  if (at.getTime() > now.getTime() + 60_000) throw new BostaResolutionError("وقت البحث في لوحة بوسطة في المستقبل");
  const query = String(v.searchQuery ?? "").trim();
  if (!query || !query.toLowerCase().includes(String(order.orderNumber).toLowerCase()))
    throw new BostaResolutionError(`البحث لازم يكون برقم الأوردر (${order.orderNumber}) — ده المرجع اللي اتبعت لبوسطة`);
  if (!Number.isInteger(v.resultCount) || v.resultCount !== 0)
    throw new BostaResolutionError("البحث رجّع نتايج — الشحنة ممكن تكون اتعملت عند بوسطة. اربطها بدل إعادة الإرسال");
  const shot = String(v.screenshotUrl ?? "").trim();
  if (!/^https:\/\/\S{3,490}$/.test(shot)) throw new BostaResolutionError("رابط صورة نتيجة البحث (https) مطلوب");
  return { method: v.method, searchedAt: at.toISOString(), searchQuery: query.slice(0, 200), resultCount: 0, screenshotUrl: shot, notes: (v.notes ?? "").trim().slice(0, 1000) || null };
}

/**
 * B2 — اعتماد إعادة الإرسال:
 *   • مالك (super_admin) في نطاق النشاط، و**مختلف** عن مقدّم الطلب — مقدّم الطلب مايعتمدش طلبه تحت أي ظرف، ومرور الوقت مابيدّيش
 *     أي صلاحية. طلب مالوش أثر في السجل (مايتعرفش مين قدّمه) = مرفوض.
 *   • توثيق تحقق منظّم (assertVerification). أي فشل = الحالة تفضل reset_requested، ومفيش إعادة إرسال.
 *   • مسار أدمن المنصة: **BLOCKED** — مفيش صلاحية منصة منفصلة وآمنة لده دلوقتي (مش هنعيد استخدام صلاحية الفوترة). نشاط بمالك
 *     واحد ⇒ الطلب يفضل معلّق لحد ما يتقرر المسار.
 *   • التحديث شرطي على الحالة (reset_requested ومن غير رقم شحنة) ⇒ اعتمادين متزامنين = واحد بس؛ و`creating` مستحيلة جنب
 *     reset_requested (حجز الإرسال بيستبعدها).
 *   • سجل نشاط بالقرار (approved / denied): مقدّم الطلب ووقته، المعتمد، التحقق، ووقت القرار.
 */
export async function approveBostaReset(input: {
  orderId: number; allowedBusinessIds: number[]; verification: ResetVerification; actor: ResolutionActor; now?: Date;
}): Promise<{ status: "failed" }> {
  if (input.actor.role !== "super_admin") throw new BostaResolutionError("اعتماد إعادة الإرسال لمالك غير مقدّم الطلب فقط");
  const now = input.now ?? new Date();
  const order = await loadScoped(input.orderId, input.allowedBusinessIds);
  if (order.bostaShipmentId || order.bostaStatus !== BOSTA_RESET_REQUESTED) throw new BostaResolutionError("مفيش طلب إعادة إرسال قائم على الأوردر ده");
  const db = (await getDb())!;
  const [req] = await db.select({ performedBy: activityLogs.performedBy, performedByName: activityLogs.performedByName, createdAt: activityLogs.createdAt }).from(activityLogs)
    .where(and(eq(activityLogs.action, "bosta_reset_requested"), eq(activityLogs.entityId, order.id), eq(activityLogs.businessId, order.businessId)))
    .orderBy(desc(activityLogs.id)).limit(1);
  const deny = async (reason: string): Promise<never> => {
    await addActivityLog({
      action: "bosta_reset_denied", entityType: "order", entityId: order.id, businessId: order.businessId,
      description: `رفض اعتماد إعادة إرسال الأوردر #${order.orderNumber} — ${reason}`,
      metadata: { decision: "denied", reason, requestedBy: req?.performedBy ?? null, requestedAt: req?.createdAt ?? null, attemptedBy: input.actor.id, decidedAt: now.toISOString() },
      performedBy: input.actor.id, performedByName: input.actor.name, performedByRole: input.actor.role,
    });
    throw new BostaResolutionError(reason);
  };
  if (!req) return deny("مايتعرفش مين قدّم طلب إعادة الإرسال — الاعتماد مرفوض والطلب يفضل معلّق");
  if (req.performedBy === input.actor.id) return deny("مقدّم الطلب مايقدرش يعتمده — الاعتماد لمالك تاني (مرور الوقت مابيغيّرش ده)");
  let verification;
  try { verification = assertVerification(input.verification, order, new Date(req.createdAt), now); }
  catch (e) { return deny((e as Error).message); }
  const r: any = await db.update(orders).set({
    bostaStatus: "failed",
    bostaLastError: `إعادة الإرسال اعتُمدت بعد تحقق من لوحة بوسطة (${input.actor.name}) — مفيش شحنة حسب البحث`,
  }).where(and(eq(orders.id, order.id), isNull(orders.bostaShipmentId), eq(orders.bostaStatus, BOSTA_RESET_REQUESTED)));
  if (Number(r?.[0]?.affectedRows ?? r?.affectedRows ?? 0) !== 1) throw new BostaResolutionError("حالة الأوردر اتغيّرت — راجعه تاني");
  await addActivityLog({
    action: "bosta_reset_approved", entityType: "order", entityId: order.id, businessId: order.businessId,
    description: `اعتماد إعادة إرسال الأوردر #${order.orderNumber} لبوسطة بعد تحقق من لوحة بوسطة`,
    metadata: { decision: "approved", requestedBy: req.performedBy, requestedByName: req.performedByName, requestedAt: req.createdAt, approvedBy: input.actor.id, approvedByName: input.actor.name, decidedAt: now.toISOString(), verification },
    performedBy: input.actor.id, performedByName: input.actor.name, performedByRole: input.actor.role,
  });
  return { status: "failed" };
}
