/**
 * Bosta API Service
 * Handles creating shipments in Bosta and saving tracking info.
 * Requires env: BOSTA_API_KEY, BOSTA_BASE_URL (optional), BOSTA_PICKUP_ADDRESS_ID (optional)
 */

import { getDb, getBusinessIdsByGroupSlug } from "./db";
import { orders, orderItems } from "../drizzle/schema";
import { eq, and, isNotNull, ne } from "drizzle-orm";

// Clean up any accidental "KEY=value" format from env
const BOSTA_BASE_URL = (process.env.BOSTA_BASE_URL || "https://app.bosta.co/api/v0")
  .replace(/^BOSTA_BASE_URL=/i, "").trim();
const BOSTA_API_KEY = process.env.BOSTA_API_KEY || "";
const BOSTA_PICKUP_ADDRESS_ID = process.env.BOSTA_PICKUP_ADDRESS_ID || "";

// Bosta delivery type 10 = Deliver (COD)
const DELIVERY_TYPE = 10;

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

function mapGovToBostaCity(governorate: string): BostaCity | null {
  const lower = governorate.trim().toLowerCase();
  // Try direct match first (case-insensitive)
  for (const [key, val] of Object.entries(GOV_TO_BOSTA_CITY)) {
    if (key.toLowerCase() === lower) return val;
  }
  // Partial match fallback
  for (const [key, val] of Object.entries(GOV_TO_BOSTA_CITY)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) return val;
  }
  return null; // unknown city
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
function validateOrder(order: {
  customerName: string;
  customerPhone: string;
  governorate: string;
  customerAddress: string;
  totalAmount: string | number;
}): string | null {
  if (!order.customerName?.trim()) return "اسم العميل مفقود";
  if (!order.customerPhone?.trim() || order.customerPhone.length < 10) return "رقم الهاتف غير صحيح";
  if (!order.governorate?.trim()) return "المحافظة مفقودة";
  if (!order.customerAddress?.trim()) return "العنوان مفقود";
  const total = parseFloat(String(order.totalAmount));
  if (isNaN(total) || total <= 0) return "الإجمالي غير صحيح";
  return null;
}

/**
 * Create a shipment in Bosta for the given order
 */
export async function createBostaShipment(orderId: number, options?: { allowToOpenPackage?: boolean }): Promise<BostaShipmentResult> {
  // Check if Bosta is configured
  if (!BOSTA_API_KEY) {
    return { success: false, error: "BOSTA_API_KEY غير مضبوط" };
  }

  // Fetch order from DB
  const db = await getDb();
  if (!db) return { success: false, error: "قاعدة البيانات غير متاحة" };
  const orderRows = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!orderRows.length) {
    return { success: false, error: "الأوردر غير موجود" };
  }
  const order = orderRows[0];

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
  if (order.bostaShipmentId) {
    return {
      success: true,
      shipmentId: order.bostaShipmentId,
      trackingNumber: order.bostaTrackingNumber ?? undefined,
    };
  }

  // تحذير (ليس منع): إذا كان نفس رقم التليفون له شحنة بوسطة في أوردر آخر
  // يسمح بإرسال أوردرات متعددة لنفس العميل مع تسجيل تنبيه للمراجعة
  let duplicatePhoneWarning: string | undefined;
  const duplicateRows = await db.select({ id: orders.id, orderNumber: orders.orderNumber })
    .from(orders)
    .where(
      and(
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

  const totalCOD = parseFloat(String(order.totalAmount)) + parseFloat(String(order.shippingFees ?? 0));

  // جلب بنود الأوردر لبناء وصف وعدد قطع دقيق من الأصناف المتعددة
  const bostaItems = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  let bostaDescription = order.productName || "أساور نحاسية";
  let bostaItemsCount = order.quantity ?? 1;
  if (bostaItems.length > 0) {
    bostaDescription = bostaItems.map((it) => `${it.productName} ×${it.quantity}`).join("، ");
    const sumQty = bostaItems.reduce((s, it) => s + (it.quantity || 0), 0);
    if (sumQty > 0) bostaItemsCount = sumQty;
  }

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
    allowToOpenPackage: options?.allowToOpenPackage ?? true,
  };

  // Add pickup address if configured (with full details required by Bosta)
  if (BOSTA_PICKUP_ADDRESS_ID) {
    (payload as Record<string, unknown>).pickupAddress = {
      _id: BOSTA_PICKUP_ADDRESS_ID,
      firstLine: PICKUP_ADDRESS_FIRST_LINE,
      city: {
        _id: PICKUP_ADDRESS_CITY_ID,
        name: PICKUP_ADDRESS_CITY_NAME,
      },
    };
  }

  // Log request (without API key)
  console.log("[Bosta] Sending shipment:", JSON.stringify({
    orderId,
    orderNumber: order.orderNumber,
    cityId: city._id,
    cityName: city.name,
    cod: Math.round(totalCOD),
  }));

  try {
    const response = await fetch(`${BOSTA_BASE_URL}/deliveries`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: BOSTA_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const responseBody = await response.json() as Record<string, unknown>;
    console.log("[Bosta] Response:", JSON.stringify({ orderId, status: response.status, body: responseBody }));

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

      return { success: true, shipmentId, trackingNumber, warning: duplicatePhoneWarning };
    } else {
      const errMsg = String((responseBody as Record<string, unknown>).message ?? JSON.stringify(responseBody));
      await db!.update(orders).set({
        bostaLastError: errMsg,
        bostaStatus: "failed",
      }).where(eq(orders.id, orderId));
      return { success: false, error: errMsg };
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[Bosta] Error:", errMsg);
    await db!.update(orders).set({
      bostaLastError: errMsg,
      bostaStatus: "failed",
    }).where(eq(orders.id, orderId));
    return { success: false, error: errMsg };
  }
}

/**
 * Check if Bosta integration is enabled
 */
export function isBostaEnabled(): boolean {
  return Boolean(BOSTA_API_KEY);
}
