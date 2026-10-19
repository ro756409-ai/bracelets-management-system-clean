/**
 * Bosta API Service
 * Handles creating shipments in Bosta and saving tracking info.
 * Requires env: BOSTA_API_KEY, BOSTA_BASE_URL (optional), BOSTA_PICKUP_ADDRESS_ID (optional)
 */

import { resolveDeployEnv } from "./deployEnv";
import { Request, Response, Express } from "express";
import {
  getDb,
  getBusinessIdsByGroupSlug,
  getBusinessIdsForTenant,
  getOrderItems,
  orderContentChangedAfterShipmentCreation,
  getDefaultPackageImageUrl,
  getProductImageUrls,
  addActivityLog,
} from "./db";
import {
  resolveDeliveryImages, imageUrlForLog, PACKAGE_IMAGE_URL_PREFIX, type ResolvedPackageImage, type ResolveDeliveryImagesResult,
} from "../shared/packageImages";
import { requireAdminOrManager, type RequestWithAuth } from "./authMiddleware";
import {
  resolveBostaConnection,
  resolveBostaEndpoint,
  guardBostaRequest,
  authHeader,
  NOT_CONNECTED_MESSAGE,
  type BostaConnection,
} from "./carrierAccounts.service";
import {
  buildShipmentContents,
  SHIPMENT_STALE_WARNING,
} from "../shared/orderContent";
import { orders } from "../drizzle/schema";
import { canonicalGovernorate, NEEDS_COMPLETION_LABEL, shippingIssuesText, shippingReadiness } from "../shared/shippingReadiness";
import { eq, and, isNotNull, isNull, ne, inArray, notInArray, or } from "drizzle-orm";

/**
 * حالات إنشاء الشحنة على `orders.bostaStatus`.
 *
 * `bostaStatus` عمود نص حر (varchar) — بيخزّن حالات التسليم العربية من الـwebhook
 * بعد الإرسال. قبل الإرسال بيمرّ بالحالات دي، فمفيش migration.
 *
 *   creating   ← اتحجز للإنشاء، والنداء بيكلّم بوسطة دلوقتي
 *   uncertain  ← النداء وقع بعد ما بوسطة **ممكن** تكون أنشأت الشحنة — retry أعمى ممنوع
 *   sent       ← اتأكد الإنشاء ومعاه shipmentId
 *   failed     ← بوسطة رفضت الطلب (مفيش شحنة اتعملت) — retry آمن
 *   reset_requested ← طلب إعادة إرسال لشحنة غير مؤكدة تحت مراجعة المالك — الإرسال مقفول لحد الاعتماد
 *                     (bostaResolution.service.ts). مفيش أي مسار بيفتح الإرسال من غير اعتماد مُسجَّل.
 */
export const BOSTA_CREATING = "creating";
export const BOSTA_RESET_REQUESTED = "reset_requested";
/** حالات الأوردر المسموح شحنها لبوسطة — على السيرفر لكل مسار (فردي/جماعي/إعادة محاولة). */
export const BOSTA_SENDABLE_STATUSES = ["confirmed", "preparing", "printed"] as const;
const STATUS_LABEL_AR: Record<string, string> = {
  new: "جديد", confirmed: "مؤكد", postponed: "مؤجل", cancelled: "ملغي", preparing: "قيد التحضير", shipped: "تم الشحن",
  delivered: "تم التوصيل", no_answer: "لم يرد", returned: "مرتجع", printed: "مطبوع",
};
const notSendableMessage = (status: string | null | undefined) =>
  `لا يمكن إرسال أوردر حالته «${STATUS_LABEL_AR[String(status)] ?? status}» لبوسطة — المسموح: مؤكد، قيد التحضير، مطبوع`;
export const BOSTA_UNCERTAIN = "uncertain";
const RESET_REQUESTED_MESSAGE = "طلب إعادة إرسال الشحنة تحت مراجعة المالك — الإرسال مقفول لحد الاعتماد";
const UNCERTAIN_MESSAGE =
  "حالة إنشاء الشحنة غير مؤكدة — راجع بوسطة قبل إعادة المحاولة عشان ما تتعملش شحنة تانية";

/**
 * السبب الحقيقي لفشل نداء `fetch` بدل رسالة "fetch failed" العامة.
 *
 * `fetch` في Node بيرمي `TypeError: fetch failed` وبيحط السبب الفعلي (DNS/رفض اتصال/
 * شهادة/timeout) في `err.cause` — من غيره مفيش طريقة نعرف هل المشكلة شبكة ولا توكن ولا
 * payload. بنطلّع الرسالة + الكود اللي جوه `cause` عشان اللوج وواجهة الباتش يوضّحوا السبب.
 */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    const causeMsg = (cause as { message?: unknown }).message;
    const parts = [err.message];
    if (code) parts.push(String(code));
    if (causeMsg && causeMsg !== err.message) parts.push(String(causeMsg));
    return parts.join(" · ");
  }
  return err.message;
}

// Clean up any accidental "KEY=value" format from env
// المفتاح والإصدار ومكان الاستلام بقوا **لكل نشاط** (`resolveBostaConnection`) —
// مفيش ثوابت عامة هنا. العنوان المكتوب تحت بيتستخدم فقط مع مفتاح البيئة في فترة
// الانتقال (`legacy`)، وبيروح مع حذف `BOSTA_API_KEY` من البيئة.

/** INT-4: مهلات النداءات الخارجية لبوسطة. */
const BOSTA_CREATE_TIMEOUT_MS = 20_000;
const BOSTA_AWB_TIMEOUT_MS = 30_000;

// Bosta delivery type 10 = Deliver (COD)
const DELIVERY_TYPE = 10;

/** الرابط العام لاستقبال حالات الشحن — قابل للتغيير للـStaging عبر BOSTA_WEBHOOK_URL. */
const DEFAULT_BOSTA_WEBHOOK_URL = "https://matjarak.net/api/webhooks/bosta";
export const BOSTA_WEBHOOK_URL_MISSING_MESSAGE =
  "رابط Webhook بوسطة غير مضبوط لهذه البيئة (BOSTA_WEBHOOK_URL) — لا يُستخدم رابط Production تلقائيًا خارج production";
/**
 * INT-1: نفس قاعدة resolveBostaEndpoint (فشل مغلق). staging/preview من غير BOSTA_WEBHOOK_URL صالح (https) = رفض، بدل ما
 * شحنات Staging تسجّل Webhook الإنتاج (أحداث Staging كانت بتوصل الإنتاج). production وdevelopment/test كما كانوا
 * (في التطوير عنوان بوسطة نفسه وهمي، فالرابط مابيوصلش لبوسطة أصلًا).
 */
export function bostaWebhookUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.BOSTA_WEBHOOK_URL?.trim();
  if (fromEnv && /^https:\/\//i.test(fromEnv)) return fromEnv;
  const deploy = resolveDeployEnv(env);
  if (deploy !== "production" && deploy !== "development" && deploy !== "test") throw new Error(BOSTA_WEBHOOK_URL_MISSING_MESSAGE);
  return DEFAULT_BOSTA_WEBHOOK_URL;
}

/** أصل الموقع العام (https) الذي تجلب منه بوسطة الصور المرفوعة عندنا — نفس أصل رابط الـWebhook. */
export function publicBaseUrl(): string {
  return new URL(bostaWebhookUrl()).origin;
}

/** مرجع صورة مرفوع عندنا (مسار نسبي) → رابط عام كامل؛ الرابط الخارجي يمر كما هو. */
export function toPublicImageUrl(ref: string): string {
  return ref.startsWith(PACKAGE_IMAGE_URL_PREFIX) ? `${publicBaseUrl()}${ref}` : ref;
}

export interface ShipmentImagePreview {
  allowToOpenPackage: boolean;
  required: boolean;
  images: ResolvedPackageImage[];
  /** الشكل الرسمي الذي سيُرسل في `deliveryImages` (null لو غير مطلوب). */
  payload: { type: string; images: string[] }[] | null;
  error: string | null;
  brandDefaultUrl: string | null;
  /** صور فريدة لم تُرسل لتجاوز حد بوسطة (10) — للتنبيه في المعاينة. */
  omitted: number;
}

/**
 * صور الشحنة لأوردر بعينه حسب ترتيب الاختيار: صورة المنتج العامة → الصورة الافتراضية
 * للبراند (نشاط الأوردر نفسه) → منع. تُستخدم للمعاينة قبل الإرسال وفي الإرسال نفسه.
 */
export async function resolveShipmentImagesForOrder(
  order: { id: number; businessId: number },
  allowToOpenPackage: boolean
): Promise<ShipmentImagePreview> {
  const brandDefaultRef = await getDefaultPackageImageUrl(order.businessId);
  const brandDefaultUrl = brandDefaultRef ? toPublicImageUrl(brandDefaultRef) : null;
  const items = await getOrderItems(order.id);
  const productIds = [...new Set(items.map(i => i.productId).filter((x): x is number => x != null))];
  const productImages = await getProductImageUrls(order.businessId, productIds);
  const result: ResolveDeliveryImagesResult = resolveDeliveryImages({
    allowToOpenPackage,
    items: items.map(i => ({
      productId: i.productId ?? null,
      imageUrl: i.productId != null && productImages.has(i.productId) ? toPublicImageUrl(productImages.get(i.productId)!) : null,
    })),
    brandDefaultUrl,
  });
  return {
    allowToOpenPackage,
    required: result.required,
    images: result.ok ? [...result.images] : [],
    payload: result.ok ? result.payload : null,
    error: result.ok ? null : result.error,
    brandDefaultUrl,
    omitted: result.omitted,
  };
}

// Pickup address details (fetched from GET /api/v0/pickup-locations)
// These are static since the pickup location doesn't change
const PICKUP_ADDRESS_FIRST_LINE = "Q7WX+F9P, Masaken at Tebin Ash Shaabeyah, El Tebbin, Cairo Governorate 4011234, Egypt";
const PICKUP_ADDRESS_CITY_ID = "FceDyHXwpSYYF9zGW";
const PICKUP_ADDRESS_CITY_NAME = "Cairo";

// Map Arabic governorate names to Bosta city { _id, name }
// IDs fetched from GET /api/v0/cities
interface BostaCity {
  _id: string;
  name: string;
}

const GOV_TO_BOSTA_CITY: Record<string, BostaCity> = {
  // Cairo
  "القاهرة": { _id: "FceDyHXwpSYYF9zGW", name: "Cairo" },
  "قاهرة": { _id: "FceDyHXwpSYYF9zGW", name: "Cairo" },
  "cairo": { _id: "FceDyHXwpSYYF9zGW", name: "Cairo" },
  // Giza
  "الجيزة": { _id: "0064Qb0OgcA", name: "Giza" },
  "جيزة": { _id: "0064Qb0OgcA", name: "Giza" },
  "giza": { _id: "0064Qb0OgcA", name: "Giza" },
  // Alexandria
  "الإسكندرية": { _id: "Jrb6X6ucjiYgMP4T7", name: "Alexandria" },
  "اسكندرية": { _id: "Jrb6X6ucjiYgMP4T7", name: "Alexandria" },
  "إسكندرية": { _id: "Jrb6X6ucjiYgMP4T7", name: "Alexandria" },
  "الاسكندرية": { _id: "Jrb6X6ucjiYgMP4T7", name: "Alexandria" },
  "alexandria": { _id: "Jrb6X6ucjiYgMP4T7", name: "Alexandria" },
  // Qalyubia
  "القليوبية": { _id: "yp3atroeTwnyiBNKE", name: "El Kalioubia" },
  "قليوبية": { _id: "yp3atroeTwnyiBNKE", name: "El Kalioubia" },
  "القليوبيه": { _id: "yp3atroeTwnyiBNKE", name: "El Kalioubia" },
  // Sharqia
  "الشرقية": { _id: "6ExcoGbpYHnggP8JD", name: "Sharqia" },
  "شرقية": { _id: "6ExcoGbpYHnggP8JD", name: "Sharqia" },
  "الشرقيه": { _id: "6ExcoGbpYHnggP8JD", name: "Sharqia" },
  // Dakahlia
  "الدقهلية": { _id: "RrDhS8YYsXAwZ9Zfo", name: "Dakahlia" },
  "دقهلية": { _id: "RrDhS8YYsXAwZ9Zfo", name: "Dakahlia" },
  "الدقهليه": { _id: "RrDhS8YYsXAwZ9Zfo", name: "Dakahlia" },
  // Gharbia
  "الغربية": { _id: "K3RwC677J8kJytdZD", name: "Gharbia" },
  "غربية": { _id: "K3RwC677J8kJytdZD", name: "Gharbia" },
  "الغربيه": { _id: "K3RwC677J8kJytdZD", name: "Gharbia" },
  // Monufia
  "المنوفية": { _id: "ruBSjGBDX9wpRa3cc", name: "Monufia" },
  "منوفية": { _id: "ruBSjGBDX9wpRa3cc", name: "Monufia" },
  "المنوفيه": { _id: "ruBSjGBDX9wpRa3cc", name: "Monufia" },
  // Beheira
  "البحيرة": { _id: "g3GchTSmCgR2JynsJ", name: "Behira" },
  "بحيرة": { _id: "g3GchTSmCgR2JynsJ", name: "Behira" },
  "البحيره": { _id: "g3GchTSmCgR2JynsJ", name: "Behira" },
  // Kafr El Sheikh
  "كفر الشيخ": { _id: "ByP7rFCjL6XzF6j4S", name: "Kafr Alsheikh" },
  // Damietta
  "دمياط": { _id: "qoZvYcZ8Cqji4pGp5", name: "Damietta" },
  // Port Said
  "بورسعيد": { _id: "skFtf6ZmKo8kBEBDK", name: "Port Said" },
  "بور سعيد": { _id: "skFtf6ZmKo8kBEBDK", name: "Port Said" },
  // Ismailia
  "الإسماعيلية": { _id: "PJqNriLtFtx2cfkKP", name: "Ismailia" },
  "اسماعيلية": { _id: "PJqNriLtFtx2cfkKP", name: "Ismailia" },
  "الاسماعيليه": { _id: "PJqNriLtFtx2cfkKP", name: "Ismailia" },
  // Suez
  "السويس": { _id: "PickurJ5uJZ9rDTHW", name: "Suez" },
  "سويس": { _id: "PickurJ5uJZ9rDTHW", name: "Suez" },
  // Fayoum
  "الفيوم": { _id: "BW5MiNxEirB7tuz2y", name: "Fayoum" },
  "فيوم": { _id: "BW5MiNxEirB7tuz2y", name: "Fayoum" },
  // Beni Suef
  "بني سويف": { _id: "LzbbvTzZ7D2CgE2PL", name: "Bani Suif" },
  "بنى سويف": { _id: "LzbbvTzZ7D2CgE2PL", name: "Bani Suif" },
  // Minya
  "المنيا": { _id: "si6eLnKjXqTFTMBj9", name: "Menya" },
  "منيا": { _id: "si6eLnKjXqTFTMBj9", name: "Menya" },
  // Asyut
  "أسيوط": { _id: "7mDPAohM3ArSZmWTm", name: "Assuit" },
  "اسيوط": { _id: "7mDPAohM3ArSZmWTm", name: "Assuit" },
  // Sohag
  "سوهاج": { _id: "n3EENg2adhuR9xBZK", name: "Sohag" },
  // Qena
  "قنا": { _id: "vfTHTes3uGjAszgtg", name: "Qena" },
  // Luxor
  "الأقصر": { _id: "wgYEdH2WMzxGE2Ztp", name: "Luxor" },
  "اقصر": { _id: "wgYEdH2WMzxGE2Ztp", name: "Luxor" },
  "الاقصر": { _id: "wgYEdH2WMzxGE2Ztp", name: "Luxor" },
  // Aswan
  "أسوان": { _id: "kLvZ5JY6LJPL5chzN", name: "Aswan" },
  "اسوان": { _id: "kLvZ5JY6LJPL5chzN", name: "Aswan" },
  // Red Sea
  "البحر الأحمر": { _id: "r5TscLCNSjR2GimxQ", name: "Red Sea" },
  "البحر الاحمر": { _id: "r5TscLCNSjR2GimxQ", name: "Red Sea" },
  // New Valley
  "الوادي الجديد": { _id: "w4yDVHVJWqa4HpbzA", name: "New Valley" },
  // North Sinai
  "شمال سيناء": { _id: "ZuCaDAVQlPT", name: "North Sinai" },
  // South Sinai
  "جنوب سيناء": { _id: "nG_c44vHQht", name: "South Sinai" },
  // Matrouh
  "مطروح": { _id: "KBpGiRZJMIx", name: "Matrouh" },
  "مرسي مطروح": { _id: "KBpGiRZJMIx", name: "Matrouh" },
  // North Coast
  "الساحل الشمالي": { _id: "2hGtNLfRgqGrJjnW9", name: "North Coast" },
  // 10th of Ramadan → Cairo
  "العاشر من رمضان": { _id: "FceDyHXwpSYYF9zGW", name: "Cairo" },
  "العاشر": { _id: "FceDyHXwpSYYF9zGW", name: "Cairo" },
};

/**
 * مدينة بوسطة من المحافظة — **بلا مطابقة جزئية**: الاسم الرسمي (مطابقة دقيقة أو بديل معتمد عبر
 * `canonicalGovernorate`) ثم مفتاحه في `GOV_TO_BOSTA_CITY`. المطابقة الجزئية القديمة كانت بتربط «ال» بالقاهرة
 * بصمت — شحنة لمدينة غلط. غير معروف ⇒ null (الأوردر «محتاج استكمال بيانات»).
 */
export function mapGovToBostaCity(governorate: string): BostaCity | null {
  const canonical = canonicalGovernorate(governorate);
  return canonical ? GOV_TO_BOSTA_CITY[canonical] ?? null : null;
}

export interface BostaShipmentResult {
  success: boolean;
  shipmentId?: string;
  trackingNumber?: string;
  error?: string;
  warning?: string;
}

/**
 * Validate order data before sending to Bosta
 */
export function validateOrder(order: {
  customerName: string;
  customerPhone: string;
  governorate: string;
  customerAddress: string;
  totalAmount: string | number;
}): string | null {
  if (!order.customerName?.trim()) return "اسم العميل مفقود";
  // أوردر مستورد بهاتف غير صالح أو محافظة غير محددة بيفضل «يحتاج مراجعة» — مايتبعتش لبوسطة
  // قبل تصحيح الحقل نفسه (مش مجرد علم).
  if (!/^01\d{9}$/.test(String(order.customerPhone ?? "").replace(/\D/g, "")))
    return "رقم الهاتف غير صالح — صحّحه قبل الشحن";
  // اكتمال العنوان والمحافظة — نفس القاعدة المشتركة للتأكيد وشيت الشحن والواجهة
  const readiness = shippingReadiness(order);
  if (!readiness.ready) return `${NEEDS_COMPLETION_LABEL}: ${shippingIssuesText(readiness)} — أكمِل البيانات قبل الشحن`;
  const total = parseFloat(String(order.totalAmount));
  if (isNaN(total) || total <= 0) return "الإجمالي غير صحيح";
  return null;
}

/**
 * Create a shipment in Bosta for the given order
 */
export async function createBostaShipment(
  orderId: number,
  options?: { allowToOpenPackage?: boolean; depositAmount?: number },
  /** للاختبارات — النداء الحقيقي لبوسطة بيتحقن من هنا. */
  fetchImpl: typeof fetch = fetch
): Promise<BostaShipmentResult> {
  // Fetch order from DB
  const db = await getDb();
  if (!db) return { success: false, error: "قاعدة البيانات غير متاحة" };
  const orderRows = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!orderRows.length) {
    return { success: false, error: "الأوردر غير موجود" };
  }
  const order = orderRows[0];

  // اتصال Bosta الخاص بنشاط **الأوردر نفسه** — من جدول حسابات الشحن، بلا أي fallback
  // لنشاط تاني. مش مربوط → رفض برسالة واضحة قبل أي كتابة.
  // عنوان بوسطة لهذه البيئة أولًا (فشل مغلق برسالة إعداد — لا Live تلقائيًا خارج production).
  const endpoint = resolveBostaEndpoint();
  if (!endpoint.ok) return { success: false, error: endpoint.error };
  // INT-1: رابط Webhook (وأصل صور الشحنة) لازم يتبع البيئة — رفض واضح قبل أي حجز أو نداء لو مش مضبوط في staging/preview.
  try { bostaWebhookUrl(); } catch (err) { return { success: false, error: (err as Error).message }; }
  const conn = await resolveBostaConnection(order.businessId);
  if (!conn) return { success: false, error: NOT_CONNECTED_MESSAGE };
  // B1: نفس حاجز النداء الخارجي **قبل** أي كتابة أو حجز (`creating`) — في staging/preview عنوان Live أو غير معتمد = رفض هنا.
  const deliveriesGuard = guardBostaRequest(`${conn.baseUrl}/deliveries`, {});
  if (!deliveriesGuard.ok) return { success: false, error: deliveriesGuard.error };

  // ❌ منع إرسال أوردرات مجموعة "مفروشات وأدوات منزلية" لـ Bosta نهائياً
  // الاعتماد على مجموعة العمل (business group slug = furniture) وهو الأدق
  // مع fallback على اسم المنتج كشبكة أمان إضافية
  const furnitureBusinessIds = await getBusinessIdsByGroupSlug("furniture");
  const isFurnitureByGroup = furnitureBusinessIds.includes(order.businessId);
  const MAFROSHOT_KEYWORDS = ['كفر مرتبة', 'كفر مرتبه', 'وتر بروف', 'مفروشات', 'أدوات منزلية'];
  const isFurnitureByName = MAFROSHOT_KEYWORDS.some(kw => (order.productName || "").includes(kw));
  if (isFurnitureByGroup || isFurnitureByName) {
    const blockMsg = "أوردرات مجموعة المفروشات والأدوات المنزلية لا يمكن إرسالها لبوسطة";
    await db.update(orders)
      .set({ bostaLastError: blockMsg, bostaStatus: "failed" })
      .where(eq(orders.id, orderId));
    return { success: false, error: blockMsg };
  }

  // Prevent duplicate sending (same order already sent)
  //
  // بوسطة مالهاش عندنا مسار «تحديث شحنة» — مفيش PUT/PATCH على `/deliveries` في الملف
  // ده — فالرجوع بدري هنا معناه إن اللي عند بوسطة هو نسخة وقت الإرسال. لو المحتوى
  // اتعدّل بعدها، لازم يتقال بصراحة بدل ما الضغطة ترجع «تمام» والتاجر يفتكر إن بوسطة
  // اتحدّثت.
  if (order.bostaShipmentId) {
    const stale = await orderContentChangedAfterShipmentCreation(orderId);
    return {
      success: true,
      shipmentId: order.bostaShipmentId,
      trackingNumber: order.bostaTrackingNumber ?? undefined,
      warning: stale ? SHIPMENT_STALE_WARNING : undefined,
    };
  }

  // حالة غير مؤكدة من محاولة سابقة — retry أعمى ممنوع لأنه ممكن يكرّر الشحنة.
  //
  // بوسطة أنشأت الشحنة، بس الاتصال وقع قبل ما نحفظ الـshipmentId. مفيش عندنا مسار
  // lookup-by-reference متأكد منه، فمانقدرش نأكّد exactly-once — بنوقف ونطلب مراجعة
  // بشرية بدل ما نبعت تاني على الأعمى.
  if (order.bostaStatus === BOSTA_UNCERTAIN || order.bostaStatus === BOSTA_CREATING) {
    return { success: false, error: UNCERTAIN_MESSAGE };
  }
  if (order.bostaStatus === BOSTA_RESET_REQUESTED) {
    return { success: false, error: RESET_REQUESTED_MESSAGE };
  }

  // حالة الأوردر على السيرفر (الواجهة كانت البوابة الوحيدة، والإرسال الجماعي بلا فلتر): الشحن فقط لمؤكد/قيد
  // التحضير/مطبوع. بلا كتابة على حقول بوسطة — دي مش محاولة شحن فاشلة. تُعاد في شرط الحجز الذرّي تحت.
  if (!BOSTA_SENDABLE_STATUSES.includes(order.status as any)) {
    return { success: false, error: notSendableMessage(order.status) };
  }

  // تحذير (ليس منع): إذا كان نفس رقم التليفون له شحنة بوسطة في أوردر آخر
  // يسمح بإرسال أوردرات متعددة لنفس العميل مع تسجيل تنبيه للمراجعة
  //
  // **داخل نشاط الأوردر نفسه فقط.** البحث بالهاتف وحده كان بيطلع رقم أوردر نشاط تاني
  // (مؤسسة تانية) في التحذير وفي `bostaLastError` — تسريب عبر الأنشطة.
  let duplicatePhoneWarning: string | undefined;
  const duplicateRows = await db.select({ id: orders.id, orderNumber: orders.orderNumber })
    .from(orders)
    .where(
      and(
        eq(orders.businessId, order.businessId),
        eq(orders.customerPhone, order.customerPhone),
        isNotNull(orders.bostaShipmentId),
        ne(orders.id, orderId)
      )
    )
    .limit(1);

  if (duplicateRows.length > 0) {
    const dupOrder = duplicateRows[0];
    duplicatePhoneWarning = `تنبيه: رقم التليفون سبق إرساله لبوسطة في أوردر ${dupOrder.orderNumber} - يُرجى المراجعة`;
  }

  // Validate
  const validationError = validateOrder({
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    governorate: order.governorate,
    customerAddress: order.customerAddress,
    totalAmount: order.totalAmount,
  });

  if (validationError) {
    await db!.update(orders).set({ bostaLastError: validationError, bostaStatus: "failed" }).where(eq(orders.id, orderId));
    return { success: false, error: validationError };
  }

  // Map city
  const city = mapGovToBostaCity(order.governorate);
  if (!city) {
    const errMsg = `المحافظة "${order.governorate}" غير مدعومة في Bosta`;
    await db!.update(orders).set({ bostaLastError: errMsg, bostaStatus: "failed" }).where(eq(orders.id, orderId));
    return { success: false, error: errMsg };
  }

  // `totalAmount` is already the full amount the customer pays — every source stores it that
  // way: EasyOrder sets it to `itemsTotal + shippingFee` (easyorder.service.ts), the Facebook
  // entry form submits a total its own calculator computed as `pieces + shippingCost`, and a
  // manual order is a single typed total with no separate shipping input at all. `shippingFees`
  // is only the breakdown — how much of that total is shipping — never an extra charge on top.
  // Adding it here double-charged the customer at Bosta by exactly the shipping fee on every
  // EasyOrder/Facebook order (the only sources that populate shippingFees).
  const totalCOD = parseFloat(String(order.totalAmount));

  // الفتح الافتراضي من إعداد حساب الشحن (كان ثابتًا true بغضّ النظر عن الإعداد).
  const allowToOpenPackage = options?.allowToOpenPackage ?? conn.allowOpenPackageDefault;
  // صور الشحنة: منتج عام → صورة البراند الافتراضية → منع الإرسال برسالة واضحة. قبل أي نداء.
  const shipmentImages = await resolveShipmentImagesForOrder(order, allowToOpenPackage);
  if (shipmentImages.error) return { success: false, error: shipmentImages.error };

  // جلب بنود الأوردر لبناء وصف وعدد قطع دقيق من الأصناف المتعددة.
  //
  // **بالجوين على `product_variants`.** ده كان `db.select().from(orderItems)` على طول،
  // والنتيجة إن نوع الحفر مكانش بيتجاب أصلاً — فأوردر فيه تلات قطع بتلات نقوش مختلفة
  // كان بيوصل بوسطة كـ«أسورة نحاس ×3»، ومندوب التسليم مش عارف مين ياخد إيه، والعميل
  // بيستلم قطعة مش بتاعته.
  //
  // `getOrderItems` هي نفس الدالة اللي الشاشة بتعرض بيها البنود، فاللي التاجر بيشوفه
  // في «تفاصيل الحفر لكل قطعة» هو بالحرف اللي بيتبعت لبوسطة.
  //
  // **القراءة دي بتحصل هنا، وقت الإرسال.** مفيش snapshot متخزّن من الموقع ولا وصف
  // متكاش من إرسال سابق: أي تعديل اتحفظ قبل الضغطة دي بيبقى موجود في الـpayload.
  const bostaItems = await getOrderItems(orderId);
  const { description: bostaDescription, itemsCount: bostaItemsCount } =
    buildShipmentContents(
      bostaItems.map(it => ({
        productName: it.productName,
        variantName: it.variantName,
        quantity: it.quantity,
        size: it.size,
        color: it.color,
      })),
      { productName: order.productName, quantity: order.quantity }
    );

  const payload: Record<string, unknown> = {
    type: DELIVERY_TYPE,
    specs: {
      packageDetails: {
        itemsCount: bostaItemsCount,
        description: bostaDescription,
      },
    },
    cod: Math.round(totalCOD),
    dropOffAddress: {
      city: { _id: city._id, name: city.name },
      firstLine: order.customerAddress,
      ...(order.city ? { district: order.city } : {}),
    },
    receiver: {
      firstName: order.customerName.split(" ")[0] || order.customerName,
      lastName: order.customerName.split(" ").slice(1).join(" ") || "-",
      phone: order.customerPhone,
      ...(order.customerPhone2 ? { secondPhone: order.customerPhone2 } : {}),
    },
    businessReference: order.orderNumber,
    notes: order.notes ?? undefined,
    allowToOpenPackage,
  };
  // «السماح بفتح الشحنة» يستلزم صورًا في `deliveryImages` (الشكل الرسمي، على مستوى الشحنة).
  if (shipmentImages.payload) (payload as Record<string, unknown>).deliveryImages = shipmentImages.payload;

  // مكان الاستلام من حساب النشاط (`businessLocationId` الموثّق). في فترة الانتقال بس
  // (مفتاح البيئة) بنبعت الشكل القديم بالعنوان المكتوب.
  if (conn.legacy) {
    if (conn.pickupLocationId) {
      (payload as Record<string, unknown>).pickupAddress = {
        _id: conn.pickupLocationId,
        firstLine: PICKUP_ADDRESS_FIRST_LINE,
        city: { _id: PICKUP_ADDRESS_CITY_ID, name: PICKUP_ADDRESS_CITY_NAME },
      };
    }
  } else if (conn.pickupLocationId) {
    (payload as Record<string, unknown>).businessLocationId = conn.pickupLocationId;
  }

  // الديبوزيت (`escrowInfo.amountToBeCollected` الموثّق): أكبر من صفر ولا يتجاوز
  // تحصيل الأوردر. مستقل عن فليكس شيب — الاتنين بيشتغلوا معًا.
  const deposit = clampDeposit(options?.depositAmount, totalCOD);
  if (deposit != null) {
    (payload as Record<string, unknown>).escrowInfo = { amountToBeCollected: deposit };
  }

  // سر الـwebhook الخاص بالنشاط بيتبعت مع الشحنة — بوسطة بترجّعه في كل حدث، وده
  // اللي الـwebhook بيحدد بيه النشاط قبل ما يلمس أي أوردر.
  // `webhookUrl` + `webhookCustomHeaders` في طلب الإنشاء (الموثّق رسميًا) = الشحنة الجديدة
  // بتسجّل الـwebhook لنفسها بلا أي إعداد يدوي في لوحة بوسطة. من غير سر مفيش رابط — الحدث
  // كان هيترفض 401 أصلًا. السر مابيتطبعش في أي لوج ولا بيرجع في أي response.
  if (conn.webhookSecret) {
    (payload as Record<string, unknown>).webhookUrl = bostaWebhookUrl();
    (payload as Record<string, unknown>).webhookCustomHeaders = { "x-bosta-secret": conn.webhookSecret };
  }

  // الحجز الذرّي — أهم سطر في الحماية من الشحنة المزدوجة.
  //
  // UPDATE واحد بشرط: النقل لـ"creating" بينجح **مرة واحدة** لأوردر لسه ماتشحنش. الطلب
  // التاني المتزامن (ضغطة تانية، أو bulk متداخل مع فردي) بيلاقي الصف اتقفل وبقى
  // "creating" فبيطابق صفر صفوف — فمابيكلّمش بوسطة. مفيش transaction مفتوح على نداء
  // الشبكة؛ القفل لحظي على مستوى الصف في MySQL وقت الـUPDATE بس.
  const claim = await db.update(orders)
    .set({ bostaStatus: BOSTA_CREATING })
    .where(and(
      eq(orders.id, orderId),
      isNull(orders.bostaShipmentId),
      inArray(orders.status, [...BOSTA_SENDABLE_STATUSES]),
      or(
        isNull(orders.bostaStatus),
        notInArray(orders.bostaStatus, [BOSTA_CREATING, BOSTA_UNCERTAIN, BOSTA_RESET_REQUESTED])
      )
    ));
  const claimed = Number((claim as any)?.[0]?.affectedRows ?? (claim as any)?.affectedRows ?? 0);
  if (claimed !== 1) {
    // طلب تاني كسب الحجز، أو الأوردر بقى uncertain في اللحظة دي. نعيد القراءة عشان
    // نرجّع الرسالة الصح: لو اتشحن فعلًا نرجّع الشحنة، غير كده «تحت الإنشاء/غير مؤكد».
    const [fresh] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (fresh?.bostaShipmentId) {
      return {
        success: true,
        shipmentId: fresh.bostaShipmentId,
        trackingNumber: fresh.bostaTrackingNumber ?? undefined,
      };
    }
    // الحالة اتغيّرت بين القراءة والحجز (اتلغى/اتأجّل) — مش «غير مؤكد»، مجرد غير قابل للشحن
    if (fresh && !BOSTA_SENDABLE_STATUSES.includes(fresh.status as any)) return { success: false, error: notSendableMessage(fresh.status) };
    return { success: false, error: UNCERTAIN_MESSAGE };
  }

  // بوسطة ممكن ترجّع الشحنة كاملة (ومعاها webhookCustomHeaders) في الرد أو في رسالة خطأ —
  // السر والمفتاح بيتشالوا من أي نص قبل ما يتطبع في اللوج أو يتخزّن/يتعرض كرسالة خطأ.
  const redact = (text: string): string => {
    let out = text;
    for (const secret of [conn.webhookSecret, conn.apiKey]) if (secret) out = out.split(secret).join("[REDACTED]");
    return out;
  };

  // Log request (without API key)
  console.log("[Bosta] Sending shipment:", JSON.stringify({
    orderId,
    orderNumber: order.orderNumber,
    cityId: city._id,
    cityName: city.name,
    cod: Math.round(totalCOD),
  }));

  try {
    const response = await fetchImpl(`${conn.baseUrl}/deliveries`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(conn.authScheme, conn.apiKey),
      },
      body: JSON.stringify(payload),
      // INT-4: نداء معلّق مايقفلش الطلب للأبد — المهلة بتدخل مسار «uncertain» تحت (بلا retry تلقائي)
      signal: AbortSignal.timeout(BOSTA_CREATE_TIMEOUT_MS),
      // B1: في staging/preview ممنوع متابعة أي redirect (الحاجز اتشيّك قبل الحجز)
      ...(deliveriesGuard.init.redirect ? { redirect: deliveriesGuard.init.redirect } : {}),
    });

    const responseBody = await response.json() as Record<string, unknown>;
    // INT-5: رد بوسطة بيرجّع بيانات المستلم (اسم/هاتف/عنوان) — اللوج فيه الحالة والمعرّفات بس
    console.log("[Bosta] Response:", redact(JSON.stringify({
      orderId, status: response.status, shipmentId: responseBody._id ?? null, trackingNumber: responseBody.trackingNumber ?? null,
      ...(response.ok ? {} : { message: String((responseBody as any).message ?? "").slice(0, 200) }),
    })));

    // نجاح HTTP من غير رقم شحنة واضح في الشكل المتوقع (`_id` على المستوى الأعلى): **مش** فشل مؤكد — الشحنة ممكن
    // تكون اتعملت بشكل رد مختلف. «failed» كان بيفتح إعادة إرسال ممكن تعمل شحنة مكررة؛ دلوقتي uncertain لحد الحسم
    // اليدوي (ربط برقم الشحنة من لوحة بوسطة، أو طلب إعادة إرسال باعتماد المالك). مانفترضش أي شكل رد تاني غير موثّق.
    if (response.ok && !responseBody._id) {
      const detail = `HTTP ${response.status} بدون رقم شحنة واضح في الرد`;
      await db!.update(orders).set({
        bostaLastError: `${UNCERTAIN_MESSAGE} — ${detail}`,
        bostaStatus: BOSTA_UNCERTAIN,
      }).where(eq(orders.id, orderId));
      return { success: false, error: `${UNCERTAIN_MESSAGE} — ${detail}` };
    }

    if (response.ok && responseBody._id) {
      const shipmentId = String(responseBody._id);
      const trackingNumber = responseBody.trackingNumber ? String(responseBody.trackingNumber) : undefined;

      await db!.update(orders).set({
        bostaShipmentId: shipmentId,
        bostaTrackingNumber: trackingNumber ?? null,
        bostaSentAt: new Date(),
        bostaStatus: "sent",
        bostaLastError: duplicatePhoneWarning ?? null,
      }).where(eq(orders.id, orderId));

      // سجل مصدر الصور المرسلة (product / brand_default) — بلا الـpayload ولا أي سر.
      if (shipmentImages.payload) {
        // (وصف سجل النشاط — لا علاقة له بوصف الشحنة الذي يُبنى من البنود فقط.)
        const imagesLogText = `صور شحنة بوسطة للأوردر #${order.orderNumber}: ${shipmentImages.images.map(i => i.source).join(", ")}`;
        await addActivityLog({
          action: "bosta_shipment_images",
          entityType: "order",
          entityId: orderId,
          description: imagesLogText,
          metadata: {
            shipmentId,
            sources: shipmentImages.images.map(i => ({ source: i.source, productId: i.productId ?? null, url: imageUrlForLog(i.url) })),
            omitted: shipmentImages.omitted,
          },
          performedBy: 0,
          performedByName: "النظام",
          performedByRole: "system",
          businessId: order.businessId,
        }).catch(err => console.error("[Bosta] تعذر تسجيل مصدر الصور:", err instanceof Error ? err.message : err));
      }
      return { success: true, shipmentId, trackingNumber, warning: duplicatePhoneWarning };
    } else {
      // بوسطة ردّت بس رفضت — الرد وصل فمفيش شحنة اتعملت (retry آمن). بنطلّع الرسالة
      // الحقيقية + كود الحالة عشان يتضح هل توكن (401/403) ولا payload/عنوان (400/422).
      const bodyMsg = (responseBody as Record<string, unknown>).message
        ?? (responseBody as Record<string, unknown>).error
        ?? JSON.stringify(responseBody);
      const errMsg = redact(`HTTP ${response.status} — ${String(bodyMsg)}`);
      await db!.update(orders).set({
        bostaLastError: errMsg,
        bostaStatus: "failed",
      }).where(eq(orders.id, orderId));
      return { success: false, error: errMsg };
    }
  } catch (err: unknown) {
    // النداء نفسه رمى (شبكة/DNS/شهادة/timeout) — «fetch failed» العامة مش كافية للحكم.
    // بنطلّع السبب الحقيقي من err.cause (ENOTFOUND/ECONNREFUSED/timeout...) في اللوج
    // وفي الرسالة المرجّعة، مع إبقاء الحالة "uncertain": النداء ممكن يكون وصل بوسطة
    // فعلاً (timeout بين الإرسال والرد)، فـ"failed" كان هيغري بـretry يعمل شحنة تانية.
    // الطلب الجاي بيترفض لحد ما التاجر يراجع بوسطة يدويًا — من غير أي retry تلقائي.
    const detail = describeFetchError(err);
    console.error("[Bosta] Network/exception (uncertain):", detail, JSON.stringify({
      orderId, url: `${conn.baseUrl}/deliveries`,
    }));
    await db!.update(orders).set({
      bostaLastError: `${UNCERTAIN_MESSAGE} — ${detail}`,
      bostaStatus: BOSTA_UNCERTAIN,
    }).where(eq(orders.id, orderId));
    return { success: false, error: `${UNCERTAIN_MESSAGE} — ${detail}` };
  }
}

/** الديبوزيت: null لو مش مطلوب/غير صالح؛ وإلا ≥ 1 و ≤ تحصيل الأوردر. */
export function clampDeposit(amount: number | undefined, cod: number): number | null {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null;
  const max = Math.max(0, Math.round(cod));
  if (max <= 0) return null;
  return Math.min(Math.round(amount), max);
}

/** هل النشاط ده يقدر يبعت لبوسطة؟ — من اتصاله هو بس. */
export async function isBostaEnabledForBusiness(businessId: number): Promise<boolean> {
  return (await resolveBostaConnection(businessId)) != null;
}

// ==================== Official Bosta AWB (Air Waybill) ====================
//
// يجلب بوليصة الشحن الرسمية من Bosta نفسها (مش الملصق الداخلي البديل في exportExcel.ts).
// يستخدم نفس endpoint لحالة الطلب الفردي والمجموعة (Bosta يقبل معرّفات شحنات مفصولة بفاصلة).
//
// ⚠️ ملحوظة مهمة: هذا الـ endpoint (`/deliveries/business/awb?deliveries=...`) هو الأكثر
// توثيقًا في تكاملات Bosta المعروفة، لكن معنديش وصول لشبكة الإنترنت ولا لمفتاح Bosta حقيقي
// من هنا عشان أختبره فعليًا. لازم يتجرّب على السيرفر الحقيقي بمفتاح صالح قبل الاعتماد عليه؛
// لو Bosta رجّعت شكل استجابة مختلف، الكود تحت بيتعامل مع احتمالين (PDF مباشر، أو JSON فيه
// رابط) ويرجع رسالة خطأ واضحة بدل ما يكسر لو الشكل مختلف تمامًا عن المتوقع.

export type BostaAwbFetchResult =
  | { ok: true; kind: "pdf"; contentType: string; buffer: Buffer }
  | { ok: true; kind: "redirect"; url: string }
  | { ok: false; error: string };

export async function fetchBostaAwb(
  businessId: number,
  shipmentIds: string[],
  fetchImpl: typeof fetch = fetch
): Promise<BostaAwbFetchResult> {
  // الطباعة بمفتاح نشاط الأوردر بس — مش مربوط → رفض. وعنوان البيئة أولًا (فشل مغلق).
  const endpoint = resolveBostaEndpoint();
  if (!endpoint.ok) return { ok: false, error: endpoint.error };
  const conn: BostaConnection | null = await resolveBostaConnection(businessId);
  if (!conn) return { ok: false, error: NOT_CONNECTED_MESSAGE };
  if (shipmentIds.length === 0) return { ok: false, error: "لا توجد شحنات بوسطة صالحة لطباعة AWB لها" };

  const query = encodeURIComponent(shipmentIds.join(","));
  const url = `${conn.baseUrl}/deliveries/business/awb?deliveries=${query}`;
  // B1: حاجز النداء الخارجي (أصل معتمد + بلا redirects في staging/preview)
  const g = guardBostaRequest(url, {
    method: "GET",
    headers: authHeader(conn.authScheme, conn.apiKey),
    signal: AbortSignal.timeout(BOSTA_AWB_TIMEOUT_MS), // INT-4
  });
  if (!g.ok) return { ok: false, error: g.error };

  try {
    const response = await fetchImpl(url, g.init);

    const contentType = response.headers.get("content-type") || "";

    if (!response.ok) {
      const bodyText = await response.text();
      console.error("[Bosta AWB] Request failed:", response.status, bodyText.slice(0, 500));
      return { ok: false, error: `فشل جلب AWB من Bosta (HTTP ${response.status})` };
    }

    if (contentType.includes("application/pdf")) {
      const arrayBuffer = await response.arrayBuffer();
      return { ok: true, kind: "pdf", contentType, buffer: Buffer.from(arrayBuffer) };
    }

    // بعض أشكال استجابة Bosta المحتملة بترجع JSON فيه رابط الملف بدل الملف نفسه
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const possibleUrl =
      (body?.awbUrl as string | undefined) ||
      (body?.url as string | undefined) ||
      (body?.deliveryLabelUrl as string | undefined) ||
      (body?.link as string | undefined);
    if (typeof possibleUrl === "string" && possibleUrl.startsWith("http")) {
      return { ok: true, kind: "redirect", url: possibleUrl };
    }

    console.error("[Bosta AWB] Unexpected response shape:", JSON.stringify(body).slice(0, 500));
    return { ok: false, error: "استجابة غير متوقعة من Bosta عند جلب AWB — راجع الـ logs" };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[Bosta AWB] Error:", errMsg);
    return { ok: false, error: errMsg };
  }
}

function sendAwbResult(res: Response, result: BostaAwbFetchResult) {
  if (!result.ok) return res.status(502).json({ error: result.error });
  if (result.kind === "redirect") return res.redirect(result.url);
  res.setHeader("Content-Type", result.contentType);
  res.setHeader("Content-Disposition", 'inline; filename="bosta-awb.pdf"');
  return res.send(result.buffer);
}

/**
 * أنشطة التينانت المسموح بها للطلب (من `authInfo.tenantId` اللي علّقها requireAdminOrManager،
 * مش من العميل). fail-closed: بلا tenant / DB مش متاحة → `null` (المتصل يرفض).
 */
async function allowedBusinessIdsForReq(req: Request): Promise<number[] | null> {
  const auth = (req as RequestWithAuth).authInfo;
  if (!auth || auth.tenantId == null) return null;
  return await getBusinessIdsForTenant(auth.tenantId);
}

async function handleSingleAwb(req: Request, res: Response) {
  try {
    const orderId = Number(req.params.id);
    if (!orderId) return res.status(400).json({ error: "معرّف الأوردر غير صالح" });

    const db = await getDb();
    if (!db) return res.status(500).json({ error: "قاعدة البيانات غير متاحة" });

    // عزل التينانت: لازم نحدّد أنشطة المستخدم قبل أي جلب. null = تعذّر التحديد → رفض.
    const allowed = await allowedBusinessIdsForReq(req);
    if (allowed == null) return res.status(403).json({ error: "الحساب غير مرتبط بمؤسسة صالحة" });

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) return res.status(404).json({ error: "الأوردر غير موجود" });
    // fail-closed: الأوردر لازم يكون ضمن أنشطة المستخدم — يمنع IDOR بزيادة الـid.
    if (order.businessId == null || !allowed.includes(order.businessId)) {
      return res.status(403).json({ error: "هذا الأوردر خارج نطاق حسابك" });
    }
    if (!order.bostaShipmentId) {
      return res.status(400).json({ error: "لم يتم إرسال هذا الأوردر لبوسطة بعد" });
    }

    const result = await fetchBostaAwb(order.businessId, [order.bostaShipmentId]);
    return sendAwbResult(res, result);
  } catch (err) {
    console.error("[Bosta AWB] single order error:", err);
    return res.status(500).json({ error: "خطأ في جلب AWB" });
  }
}

async function handleBulkAwb(req: Request, res: Response) {
  try {
    const idsParam = req.query.ids;
    if (!idsParam) return res.status(400).json({ error: "يرجى تحديد أوردرات" });

    const ids = String(idsParam).split(",").map(Number).filter(Boolean);
    if (ids.length === 0) return res.status(400).json({ error: "لم يتم تحديد أوردرات صالحة" });

    const db = await getDb();
    if (!db) return res.status(500).json({ error: "قاعدة البيانات غير متاحة" });

    // عزل التينانت: نحدّد أنشطة المستخدم، وأي id مطلوب خارجها → رفض كامل (مش تجاهل صامت).
    const allowed = await allowedBusinessIdsForReq(req);
    if (allowed == null) return res.status(403).json({ error: "الحساب غير مرتبط بمؤسسة صالحة" });

    const rows = await db.select().from(orders).where(inArray(orders.id, ids));
    const owned = rows.filter((o) => o.businessId != null && allowed.includes(o.businessId));
    if (owned.length !== ids.length) {
      return res.status(403).json({ error: "بعض الأوردرات خارج نطاق حسابك" });
    }
    // طباعة جماعية بمفتاح نشاط واحد — أوردرات من أنشطة مختلفة ماينفعش تتطبع بنداء واحد.
    const businessIds = Array.from(new Set(owned.map((o) => o.businessId)));
    if (businessIds.length !== 1) {
      return res.status(400).json({ error: "اختر أوردرات من نشاط واحد لطباعة البوليصة" });
    }
    const shipmentIds = owned
      .map((o) => o.bostaShipmentId)
      .filter((v): v is string => Boolean(v));

    if (shipmentIds.length === 0) {
      return res.status(400).json({
        error: "لا يوجد من ضمن الأوردرات المحددة أي أوردر تم إرساله لبوسطة",
      });
    }

    const result = await fetchBostaAwb(businessIds[0], shipmentIds);
    return sendAwbResult(res, result);
  } catch (err) {
    console.error("[Bosta AWB] bulk error:", err);
    return res.status(500).json({ error: "خطأ في جلب AWB" });
  }
}

/** يسجّل مسارات طباعة/تحميل AWB الرسمية — فردي وجماعي، بنفس صلاحية أدمن/مدير الموجودة على باقي مسارات التصدير. */
export function registerBostaAwbRoutes(app: Express) {
  app.get("/api/orders/:id/bosta-awb", requireAdminOrManager, handleSingleAwb);
  app.get("/api/orders/bosta-awb", requireAdminOrManager, handleBulkAwb);
}
