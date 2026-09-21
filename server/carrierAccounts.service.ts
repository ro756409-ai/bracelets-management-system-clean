import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { businessCarrierAccounts, carrierWebhookEvents, orders } from "../drizzle/schema";
import {
  encryptSecret,
  decryptSecret,
  hashSecret,
  deriveWebhookSecret,
  randomSalt,
  isSecretBoxConfigured,
} from "./crypto/secretBox";

/**
 * حساب Bosta **لكل نشاط** — الربط، الاختبار، الفصل، وحلّ الاتصال وقت الإرسال.
 *
 * القاعدة الحاكمة: `resolveBostaConnection(businessId)` هي المصدر الوحيد لأي مفتاح
 * بيتبعت لبوسطة. النشاط بيتحدد من جلسة السيرفر (المستدعي بيمرّر `order.businessId`
 * أو نطاق الجلسة) — مش من قيمة يبعتها العميل. مفيش fallback لمفتاح نشاط تاني أبدًا.
 *
 * **الانتقال (بلا توقف):** المفتاح العام `BOSTA_API_KEY` بيفضل شغالًا **فقط** للنشاط
 * اللي عنده شحنات بوسطة سابقة **ومالوش أي صف** في `business_carrier_accounts`. أول ما
 * المالك يربط حساب النشاط من الواجهة (أو يفصله) بيتعمل صف، والـfallback بيتوقف لهذا
 * النشاط نهائيًا. نشاط جديد (بلا تاريخ شحن) مايوصلش للمفتاح العام مطلقًا. القاعدة
 * مبنية على البيانات — مفيش businessId ولا اسم نشاط في الكود.
 */

export const PROVIDER_BOSTA = "bosta";
export const NOT_CONNECTED_MESSAGE = "اربط حساب بوسطة الخاص بنشاطك أولًا من قنوات البيع";

type AuthScheme = "raw" | "bearer";

export interface BostaConnection {
  businessId: number;
  apiKey: string;
  baseUrl: string;
  authScheme: AuthScheme;
  pickupLocationId: string | null;
  allowOpenPackageDefault: boolean;
  /** سر الـwebhook لهذا النشاط — بيتبعت في webhookCustomHeaders وقت الإنشاء. */
  webhookSecret: string | null;
  /** مفتاح البيئة العام (فترة الانتقال بس). */
  legacy: boolean;
}

const ENV_BASE_URL = (process.env.BOSTA_BASE_URL || "https://app.bosta.co/api/v0")
  .replace(/^BOSTA_BASE_URL=/i, "")
  .trim();
const V2_BASE_URL = "https://app.bosta.co/api/v2";

export function authHeader(scheme: AuthScheme, apiKey: string): Record<string, string> {
  return { Authorization: scheme === "bearer" ? `Bearer ${apiKey}` : apiKey };
}

// ── الاختبار: الإصدار وصيغة التوثيق بيتثبتوا بالتجربة، مش بالتخمين ──

export interface PickupLocation {
  id: string;
  name: string;
}

export interface ProbeResult {
  ok: boolean;
  baseUrl?: string;
  authScheme?: AuthScheme;
  pickupLocations?: PickupLocation[];
  error?: string;
}

function parsePickupLocations(body: unknown): PickupLocation[] {
  const b = body as any;
  const list: any[] = Array.isArray(b) ? b : Array.isArray(b?.data) ? b.data : Array.isArray(b?.data?.list) ? b.data.list : Array.isArray(b?.list) ? b.list : [];
  return list
    .map(x => ({
      id: String(x?._id ?? x?.id ?? ""),
      name: String(x?.locationName ?? x?.name ?? x?.address?.firstLine ?? x?._id ?? ""),
    }))
    .filter(x => x.id);
}

/**
 * يجرّب المفتاح على قايمة أماكن الاستلام الرسمية بكل تركيبة (إصدار × صيغة توثيق) لحد
 * ما واحدة تنجح، وبيرجّع اللي نجحت — دي اللي بتتخزّن وبتتستخدم بعدين. 401/403 = جرّب
 * التالية؛ خطأ شبكة = فشل بسبب واضح.
 */
export async function probeBostaKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<ProbeResult> {
  const bases = Array.from(new Set([ENV_BASE_URL, V2_BASE_URL]));
  const schemes: AuthScheme[] = ["raw", "bearer"];
  let lastErr = "";
  for (const baseUrl of bases) {
    for (const authScheme of schemes) {
      try {
        const res = await fetchImpl(`${baseUrl}/pickup-locations`, {
          method: "GET",
          headers: { "Content-Type": "application/json", ...authHeader(authScheme, apiKey) },
        });
        if (res.ok) {
          const body = await res.json().catch(() => null);
          return { ok: true, baseUrl, authScheme, pickupLocations: parsePickupLocations(body) };
        }
        lastErr = `HTTP ${res.status}`;
        if (res.status !== 401 && res.status !== 403 && res.status !== 404) {
          return { ok: false, error: `فشل اختبار الاتصال ببوسطة (${lastErr})` };
        }
      } catch (err) {
        return { ok: false, error: `تعذّر الوصول لبوسطة: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }
  return { ok: false, error: `المفتاح مرفوض من بوسطة (${lastErr || "غير مصرّح"})` };
}

// ── قبل Migration 0037 ──
//
// الكود ده ممكن يتنشر قبل ما الجدولين يتعملوا. في الفجوة دي القراءة لازم تتصرّف كأن
// **مفيش صف** (فالنشاط اللي عنده تاريخ شحن يفضل على مفتاح البيئة، والجديد ممنوع) بدل
// ما ترمي 500 على صفحة الأوردرات أو قنوات البيع أو الـwebhook. الكتابة (الربط) بترفض
// برسالة واضحة. مفيش أي fallback تاني: غياب الجدول ≠ ربط.
export const MIGRATION_0037_MISSING_MESSAGE =
  "جدول حسابات الشحن غير موجود بعد — شغّل migration 0037 (business_carrier_accounts) أولًا";

export function isMissingTableError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; cause?: { code?: string; errno?: number } } | null;
  return e?.code === "ER_NO_SUCH_TABLE" || e?.errno === 1146 || e?.cause?.code === "ER_NO_SUCH_TABLE" || e?.cause?.errno === 1146;
}

let warnedMissingTable = false;
function warnMissingTableOnce() {
  if (warnedMissingTable) return;
  warnedMissingTable = true;
  console.warn(`[carrierAccounts] ${MIGRATION_0037_MISSING_MESSAGE} — القراءة بتتعامل كأن مفيش صف حساب`);
}

// ── القراءة ──

export async function getCarrierAccountRow(businessId: number, provider = PROVIDER_BOSTA) {
  const db = await getDb();
  if (!db) return null;
  try {
    const [row] = await db
      .select()
      .from(businessCarrierAccounts)
      .where(and(eq(businessCarrierAccounts.businessId, businessId), eq(businessCarrierAccounts.provider, provider)))
      .limit(1);
    return row ?? null;
  } catch (err) {
    if (isMissingTableError(err)) { warnMissingTableOnce(); return null; }
    throw err;
  }
}

/** هل النشاط ده مؤهل للمفتاح العام (فترة الانتقال)؟ = عنده شحنات سابقة ومفيش صف حساب. */
async function legacyEligible(businessId: number): Promise<boolean> {
  if (!process.env.BOSTA_API_KEY) return false;
  const db = await getDb();
  if (!db) return false;
  const row = await getCarrierAccountRow(businessId);
  if (row) return false; // أي صف (حتى disconnected) = الانتقال حصل
  const [hist] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(orders)
    .where(and(eq(orders.businessId, businessId), isNotNull(orders.bostaShipmentId)))
    .limit(1);
  return Number(hist?.n ?? 0) > 0;
}

/** اتصال Bosta لنشاط واحد، أو null لو مش مربوط. مفيش fallback لأي نشاط تاني. */
export async function resolveBostaConnection(businessId: number): Promise<BostaConnection | null> {
  const row = await getCarrierAccountRow(businessId);
  if (row) {
    if (row.status !== "connected" || !row.encryptedApiKey || !row.encryptionIv || !row.encryptionTag) return null;
    const apiKey = decryptSecret({ ciphertext: row.encryptedApiKey, iv: row.encryptionIv, tag: row.encryptionTag });
    return {
      businessId,
      apiKey,
      baseUrl: row.apiBaseUrl || ENV_BASE_URL,
      authScheme: (row.apiAuthScheme as AuthScheme) || "raw",
      pickupLocationId: row.pickupLocationId,
      allowOpenPackageDefault: row.allowOpenPackageDefault,
      webhookSecret: deriveWebhookSecret(PROVIDER_BOSTA, businessId, row.webhookSalt),
      legacy: false,
    };
  }
  if (await legacyEligible(businessId)) {
    return {
      businessId,
      apiKey: process.env.BOSTA_API_KEY as string,
      baseUrl: ENV_BASE_URL,
      authScheme: "raw",
      pickupLocationId: process.env.BOSTA_PICKUP_ADDRESS_ID || null,
      allowOpenPackageDefault: true,
      webhookSecret: process.env.BOSTA_WEBHOOK_SECRET || null,
      legacy: true,
    };
  }
  return null;
}

export interface CarrierAccountStatus {
  status: "connected" | "disconnected" | "legacy" | "not_connected";
  apiKeyLast4: string | null;
  pickupLocationId: string | null;
  pickupLocationName: string | null;
  allowOpenPackageDefault: boolean;
  lastVerifiedAt: Date | null;
  lastError: string | null;
  canSend: boolean;
  reason: string | null;
}

/** حالة الربط للواجهة — بلا أي سر (آخر 4 أحرف بس). */
export async function getCarrierAccountStatus(businessId: number): Promise<CarrierAccountStatus> {
  const row = await getCarrierAccountRow(businessId);
  if (row) {
    const connected = row.status === "connected" && !!row.encryptedApiKey;
    return {
      status: connected ? "connected" : "disconnected",
      apiKeyLast4: connected ? row.apiKeyLast4 : null,
      pickupLocationId: row.pickupLocationId,
      pickupLocationName: row.pickupLocationName,
      allowOpenPackageDefault: row.allowOpenPackageDefault,
      lastVerifiedAt: row.lastVerifiedAt,
      lastError: row.lastError,
      canSend: connected,
      reason: connected ? null : NOT_CONNECTED_MESSAGE,
    };
  }
  const legacy = await legacyEligible(businessId);
  return {
    status: legacy ? "legacy" : "not_connected",
    apiKeyLast4: null,
    pickupLocationId: null,
    pickupLocationName: null,
    allowOpenPackageDefault: true,
    lastVerifiedAt: null,
    lastError: null,
    canSend: legacy,
    reason: legacy ? "يعمل مؤقتًا بالمفتاح العام — اربط حساب النشاط من قنوات البيع" : NOT_CONNECTED_MESSAGE,
  };
}

// ── الربط والفصل ──

export async function connectCarrierAccount(input: {
  tenantId: number;
  businessId: number;
  apiKey: string;
  pickupLocationId: string | null;
  pickupLocationName: string | null;
  allowOpenPackageDefault: boolean;
  actorId: number;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; apiKeyLast4: string } | { ok: false; error: string }> {
  if (!isSecretBoxConfigured()) return { ok: false, error: "CARRIER_SECRETS_KEY غير مضبوط على السيرفر — لا يمكن حفظ المفتاح" };
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 8) return { ok: false, error: "المفتاح قصير جدًا" };
  // الحفظ **بعد نجاح الاختبار فقط**.
  const probe = await probeBostaKey(apiKey, input.fetchImpl);
  if (!probe.ok) return { ok: false, error: probe.error ?? "فشل الاختبار" };

  const db = await getDb();
  if (!db) return { ok: false, error: "قاعدة البيانات غير متاحة" };
  const sealed = encryptSecret(apiKey);
  const salt = randomSalt();
  const secretHash = hashSecret(deriveWebhookSecret(PROVIDER_BOSTA, input.businessId, salt));
  const last4 = apiKey.slice(-4);
  const values = {
    tenantId: input.tenantId,
    businessId: input.businessId,
    provider: PROVIDER_BOSTA,
    encryptedApiKey: sealed.ciphertext,
    apiKeyLast4: last4,
    encryptionIv: sealed.iv,
    encryptionTag: sealed.tag,
    apiBaseUrl: probe.baseUrl!,
    apiAuthScheme: probe.authScheme!,
    pickupLocationId: input.pickupLocationId,
    pickupLocationName: input.pickupLocationName,
    allowOpenPackageDefault: input.allowOpenPackageDefault,
    webhookSalt: salt,
    webhookSecretHash: secretHash,
    status: "connected",
    lastVerifiedAt: new Date(),
    lastError: null,
    createdBy: input.actorId,
    updatedBy: input.actorId,
  };
  const { tenantId: _t, businessId: _b, provider: _p, createdBy: _c, ...update } = values;
  try {
    await db.insert(businessCarrierAccounts).values(values).onDuplicateKeyUpdate({ set: update });
  } catch (err) {
    if (isMissingTableError(err)) return { ok: false, error: MIGRATION_0037_MISSING_MESSAGE };
    throw err;
  }
  return { ok: true, apiKeyLast4: last4 };
}

/** الفصل: مسح المفتاح فعليًا (NULL) وبقاء الصف كأثر بالحالة disconnected. */
export async function disconnectCarrierAccount(businessId: number, actorId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(businessCarrierAccounts)
    .set({
      encryptedApiKey: null,
      apiKeyLast4: null,
      encryptionIv: null,
      encryptionTag: null,
      status: "disconnected",
      updatedBy: actorId,
    })
    .where(and(eq(businessCarrierAccounts.businessId, businessId), eq(businessCarrierAccounts.provider, PROVIDER_BOSTA)));
}

// ── الـwebhook ──

/** النشاط من سر الـwebhook (بعد hash) — قبل أي بحث عن شحنة. */
export async function findAccountByWebhookSecret(secret: string) {
  const db = await getDb();
  if (!db) return null;
  try {
    const [row] = await db
      .select({ businessId: businessCarrierAccounts.businessId, provider: businessCarrierAccounts.provider, status: businessCarrierAccounts.status })
      .from(businessCarrierAccounts)
      .where(eq(businessCarrierAccounts.webhookSecretHash, hashSecret(secret)))
      .limit(1);
    return row ?? null;
  } catch (err) {
    if (isMissingTableError(err)) { warnMissingTableOnce(); return null; }
    throw err;
  }
}

/** true لو الحدث جديد؛ false لو مكرر (القيد الفريد businessId+provider+eventHash). */
export async function recordWebhookEvent(input: {
  businessId: number;
  provider: string;
  eventHash: string;
  shipmentId?: string | null;
  stateCode?: number | null;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  try {
    await db.insert(carrierWebhookEvents).values({
      businessId: input.businessId,
      provider: input.provider,
      eventHash: input.eventHash,
      shipmentId: input.shipmentId ?? null,
      stateCode: input.stateCode ?? null,
    });
    return true;
  } catch (err: any) {
    if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062 || err?.cause?.errno === 1062) return false;
    // قبل 0037: مفيش idempotency (زي السلوك القديم بالظبط) — الحدث بيتعامل كجديد.
    if (isMissingTableError(err)) { warnMissingTableOnce(); return true; }
    throw err;
  }
}
