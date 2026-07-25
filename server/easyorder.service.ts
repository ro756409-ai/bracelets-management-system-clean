/**
 * EasyOrder integration service — API client, order normalization, and the shared
 * idempotent upsert pipeline used by BOTH the webhook and the manual "Sync Now" button.
 *
 * ⚠️ API CONTRACT STATUS (read before enabling manual sync)
 * The *payload* shape below is verified — it mirrors the real webhook payloads this app has
 * been receiving in production (see the EasyOrderPayload interface that has been in
 * easyorderWebhook.ts). What is NOT verified is the *pull* API: the endpoint path, its
 * query-parameter names for a date range, its auth header, and its response envelope were
 * not available when this was written (no API key or docs were provided).
 *
 * Everything provider-specific is therefore isolated in EASYORDER_ENDPOINT below and is
 * configurable per channel (apiBaseUrl/apiToken) or via env. `syncOrdersByDateRange` will
 * refuse to run rather than guess when a channel has no token configured. Verify the three
 * marked constants against real EasyOrder docs before relying on manual sync; the webhook
 * path needs none of this and works today.
 */
import { normalizeEgyptianPhone } from "../shared/phone";
import {
  getDb,
  createOrder,
  updateOrder,
  replaceOrderItems,
  generateOrderNumber,
  getOrderByExternalId,
  getMatchCatalog,
  createSyncLog,
  finishSyncLog,
  updateSalesChannelSyncStatus,
  getSalesChannelWithSecrets,
} from "./db";
import { matchExternalItem, type MatchCatalog } from "./productMatching";

// ==================== Provider contract (VERIFY against real docs) ====================
const EASYORDER_ENDPOINT = {
  /** Default base URL; overridden per channel via sales_channels.apiBaseUrl or EASYORDER_API_BASE_URL. */
  defaultBaseUrl: process.env.EASYORDER_API_BASE_URL || "https://api.easy-orders.net/api/v1",
  /** Path appended to the base URL to list orders. ⚠️ UNVERIFIED. */
  ordersPath: "/external-apps/orders",
  /** Query param names for the date range. ⚠️ UNVERIFIED. */
  fromParam: "created_at_min",
  toParam: "created_at_max",
  pageParam: "page",
  /** Builds the auth headers. ⚠️ UNVERIFIED (assumes an Api-Key header). */
  authHeaders: (token: string): Record<string, string> => ({ "Api-Key": token }),
} as const;

// ==================== Payload types (VERIFIED — mirrors real webhook traffic) ====================
export interface EasyOrderCartItem {
  id?: string;
  product_id?: string;
  variant_id?: string;
  price: number;
  quantity: number;
  product?: { id?: string; name?: string; price?: number; sku?: string };
  variant?: {
    id?: string;
    sku?: string;
    variation_props?: Array<{ variation: string; variation_prop: string }>;
  };
}

export interface EasyOrderPayload {
  id: string;
  created_at?: string;
  updated_at?: string;
  store_id?: string;
  cost?: number;
  shipping_cost?: number;
  total_cost?: number;
  status?: string;
  full_name: string;
  phone: string;
  government?: string;
  address?: string;
  payment_method?: string;
  cart_items: EasyOrderCartItem[];
  short_id?: number;
}

/** Fetch function seam so tests can drive the client without real network access. */
export type FetchLike = (url: string, init?: any) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
  text: () => Promise<string>;
}>;

// ==================== Governorate normalization ====================
const GOVERNORATE_MAP: Record<string, string> = {
  "القاهره": "القاهرة", "الجيزه": "الجيزة",
  "الاسكندريه": "الإسكندرية", "الاسكندرية": "الإسكندرية", "اسكندرية": "الإسكندرية", "Alexandria": "الإسكندرية",
  "اسيوط": "أسيوط", "الاسيوط": "أسيوط", "اسوان": "أسوان",
  "الاسماعيليه": "الإسماعيلية", "اسماعيلية": "الإسماعيلية", "الاسماعيلية": "الإسماعيلية",
  "الفيوم": "الفيوم", "فيوم": "الفيوم", "المنيا": "المنيا", "منيا": "المنيا",
  "بنى سويف": "بني سويف", "بني سويف": "بني سويف", "سوهاج": "سوهاج", "قنا": "قنا",
  "الدقهليه": "الدقهلية", "الدقهلية": "الدقهلية", "دقهلية": "الدقهلية",
  "الغربيه": "الغربية", "الغربية": "الغربية", "غربية": "الغربية",
  "المنوفيه": "المنوفية", "المنوفية": "المنوفية", "منوفية": "المنوفية",
  "القليوبيه": "القليوبية", "القليوبية": "القليوبية", "قليوبية": "القليوبية",
  "الشرقيه": "الشرقية", "الشرقية": "الشرقية", "شرقية": "الشرقية",
  "البحيره": "البحيرة", "البحيرة": "البحيرة", "بحيرة": "البحيرة",
  "كفر الشيخ": "كفر الشيخ", "كفرالشيخ": "كفر الشيخ",
  "الاقصر": "الأقصر", "الأقصر": "الأقصر", "اقصر": "الأقصر",
  "البحر الاحمر": "البحر الأحمر", "البحر الأحمر": "البحر الأحمر",
  "الوادي الجديد": "الوادي الجديد", "مطروح": "مطروح",
  "شمال سيناء": "شمال سيناء", "جنوب سيناء": "جنوب سيناء",
  "بورسعيد": "بورسعيد", "السويس": "السويس", "دمياط": "دمياط",
};

export function normalizeGovernorate(raw: string | undefined | null): string {
  if (!raw) return "غير محدد";
  const trimmed = raw.trim();
  if (GOVERNORATE_MAP[trimmed]) return GOVERNORATE_MAP[trimmed];
  for (const [key, val] of Object.entries(GOVERNORATE_MAP)) {
    if (trimmed.includes(key) || key.includes(trimmed)) return val;
  }
  const firstWord = trimmed.split(/[\s,،]/)[0];
  if (GOVERNORATE_MAP[firstWord]) return GOVERNORATE_MAP[firstWord];
  return trimmed.length > 30 ? "غير محدد" : trimmed;
}

const DEFAULT_SHIPPING_FEE = 50;

// ==================== Normalization ====================
export interface NormalizedItem {
  externalName: string;
  externalSku: string | null;
  variantText: string | null;
  quantity: number;
  unitPrice: number;
}

export interface NormalizedOrder {
  externalOrderId: string;
  shortId: number | null;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  governorate: string;
  items: NormalizedItem[];
  itemsTotal: number;
  shippingFee: number;
  totalAmount: number;
  externalUpdatedAt: Date | null;
  createdAt: Date | null;
  rawPayload: string;
}

export function normalizeEasyOrderPayload(payload: EasyOrderPayload): NormalizedOrder {
  const items: NormalizedItem[] = (payload.cart_items ?? []).map((item) => {
    const variantText = item.variant?.variation_props?.length
      ? item.variant.variation_props.map((vp) => `${vp.variation}: ${vp.variation_prop}`).join(", ")
      : null;
    return {
      externalName: item.product?.name ?? "",
      // Prefer the variant-level SKU when present — it is the most specific identifier.
      externalSku: item.variant?.sku ?? item.product?.sku ?? null,
      variantText,
      quantity: item.quantity || 1,
      unitPrice: Number(item.price) || 0,
    };
  });

  const itemsTotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const rawShipping = Number(payload.shipping_cost);
  const shippingFee = Number.isFinite(rawShipping) && rawShipping > 0 ? rawShipping : DEFAULT_SHIPPING_FEE;

  const parseDate = (v?: string) => {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  };

  return {
    externalOrderId: String(payload.id),
    shortId: payload.short_id ?? null,
    customerName: payload.full_name,
    customerPhone: normalizeEgyptianPhone(payload.phone) || String(payload.phone ?? "").replace(/\s+/g, ""),
    customerAddress: payload.address ?? "",
    governorate: normalizeGovernorate(payload.government),
    items,
    itemsTotal,
    shippingFee,
    totalAmount: itemsTotal + shippingFee,
    externalUpdatedAt: parseDate(payload.updated_at),
    createdAt: parseDate(payload.created_at),
    rawPayload: JSON.stringify(payload),
  };
}

// ==================== Upsert pipeline ====================
export type UpsertOutcome = "created" | "updated" | "duplicate_unchanged" | "failed";

export interface UpsertResult {
  outcome: UpsertOutcome;
  orderId?: number;
  orderNumber?: string;
  needsReview: boolean;
  reviewReason?: string;
  error?: string;
}

/**
 * Idempotently creates or updates one order from an EasyOrder payload.
 *
 * - `externalOrderId` is the idempotency key: a payload for an order we already have never
 *   creates a second row.
 * - An existing order is only re-written when the incoming payload is strictly newer
 *   (`updated_at`), so replayed webhooks are no-ops.
 * - Items that can't be confidently matched do NOT block the import and are NEVER attached
 *   to an arbitrary product: the order is created with productId = null, needsReview = true
 *   and a human-readable reason, so nothing is silently lost or mis-attributed.
 */
export async function upsertEasyOrder(
  payload: EasyOrderPayload,
  opts: { businessId: number; channelId?: number | null; source?: string; catalog?: MatchCatalog }
): Promise<UpsertResult> {
  const normalized = normalizeEasyOrderPayload(payload);

  if (!normalized.externalOrderId || !normalized.customerName || normalized.items.length === 0) {
    return { outcome: "failed", needsReview: false, error: "بيانات الأوردر غير مكتملة" };
  }

  const catalog = opts.catalog ?? (await getMatchCatalog(opts.businessId));

  // Resolve every line item independently.
  const resolved = normalized.items.map((item) => ({
    item,
    match: matchExternalItem(
      { sku: item.externalSku, name: item.externalName, variantText: item.variantText },
      catalog
    ),
  }));

  const unmatched = resolved.filter((r) => !r.match.matched);
  const needsReview = unmatched.length > 0;
  const reviewReason = needsReview
    ? `أصناف غير مطابقة: ${unmatched.map((u) => (u.match.matched ? "" : u.match.reason)).join(" | ")}`
    : undefined;

  const firstMatched = resolved.find((r) => r.match.matched);
  const primaryProductId = firstMatched?.match.matched ? firstMatched.match.productId : null;
  const primaryVariantId = firstMatched?.match.matched ? firstMatched.match.variantId ?? null : null;

  const displayName = resolved
    .map((r) => {
      const base = r.match.matched
        ? r.match.variantName
          ? `${r.match.productName} - ${r.match.variantName}`
          : r.match.productName
        : r.item.externalName || "صنف غير معروف";
      return r.item.quantity > 1 ? `${base} ×${r.item.quantity}` : base;
    })
    .join(" + ");

  const totalQty = normalized.items.reduce((s, i) => s + i.quantity, 0);

  const orderFields = {
    businessId: opts.businessId,
    customerName: normalized.customerName,
    customerPhone: normalized.customerPhone,
    customerAddress: normalized.customerAddress,
    governorate: normalized.governorate,
    productId: primaryProductId,
    variantId: primaryVariantId,
    productName: displayName,
    quantity: totalQty,
    totalAmount: String(normalized.totalAmount),
    shippingFees: String(normalized.shippingFee),
    source: (opts.source ?? "easyorder") as any,
    externalOrderId: normalized.externalOrderId,
    easyOrderShortId: normalized.shortId,
    externalRawPayload: normalized.rawPayload,
    externalUpdatedAt: normalized.externalUpdatedAt,
    needsReview,
    reviewReason: reviewReason ?? null,
    websiteId: opts.channelId ?? null,
  };

  const itemRows = resolved.map((r) => ({
    productId: r.match.matched ? r.match.productId : undefined,
    variantId: r.match.matched ? r.match.variantId : undefined,
    productName: r.match.matched
      ? r.match.variantName
        ? `${r.match.productName} - ${r.match.variantName}`
        : r.match.productName
      : r.item.externalName || "صنف غير معروف",
    quantity: r.item.quantity,
    unitPrice: r.item.unitPrice,
  }));

  try {
    const existing = await getOrderByExternalId(normalized.externalOrderId);

    if (existing) {
      // Only overwrite when the provider says this payload is newer than what we stored.
      const incomingTs = normalized.externalUpdatedAt?.getTime() ?? null;
      const storedTs = existing.externalUpdatedAt ? new Date(existing.externalUpdatedAt).getTime() : null;
      if (incomingTs !== null && storedTs !== null && incomingTs <= storedTs) {
        return {
          outcome: "duplicate_unchanged",
          orderId: existing.id,
          orderNumber: existing.orderNumber,
          needsReview: existing.needsReview,
        };
      }
      if (incomingTs === null && storedTs !== null) {
        // No timestamp to compare — treat as a replay and leave the stored order alone.
        return {
          outcome: "duplicate_unchanged",
          orderId: existing.id,
          orderNumber: existing.orderNumber,
          needsReview: existing.needsReview,
        };
      }

      await updateOrder(existing.id, orderFields as any);
      await replaceOrderItems(existing.id, itemRows);
      return {
        outcome: "updated",
        orderId: existing.id,
        orderNumber: existing.orderNumber,
        needsReview,
        reviewReason,
      };
    }

    const orderNumber = await generateOrderNumber();
    const orderId = await createOrder({
      ...orderFields,
      orderNumber,
      status: "new",
      createdAt: normalized.createdAt ?? new Date(),
    } as any);

    if (orderId) await replaceOrderItems(orderId, itemRows);

    return { outcome: "created", orderId, orderNumber, needsReview, reviewReason };
  } catch (err: any) {
    return { outcome: "failed", needsReview, error: String(err?.message ?? err) };
  }
}

// ==================== Retry helper ====================
/** Retries a transient failure with exponential backoff. Non-retryable errors bubble immediately. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; isRetryable?: (err: unknown) => boolean; sleep?: (ms: number) => Promise<void> } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const isRetryable = opts.isRetryable ?? (() => true);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isRetryable(err)) break;
      await sleep(baseDelay * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

/** 429 and 5xx are worth retrying; 4xx client errors are not. */
export function isRetryableHttpError(err: unknown): boolean {
  const status = (err as any)?.status;
  if (typeof status !== "number") return true; // network/unknown → retry
  return status === 429 || status >= 500;
}

// ==================== API client ====================
export class EasyOrderApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "EasyOrderApiError";
    this.status = status;
  }
}

export interface EasyOrderClientConfig {
  apiToken: string;
  baseUrl?: string | null;
  fetchImpl?: FetchLike;
}

/** Thin client around the EasyOrder pull API. Endpoint details are provisional — see file header. */
export class EasyOrderClient {
  private token: string;
  private baseUrl: string;
  private fetchImpl: FetchLike;

  constructor(config: EasyOrderClientConfig) {
    if (!config.apiToken?.trim()) {
      throw new Error("مفتاح API الخاص بـ EasyOrder غير مضبوط لهذه القناة");
    }
    this.token = config.apiToken.trim();
    this.baseUrl = (config.baseUrl?.trim() || EASYORDER_ENDPOINT.defaultBaseUrl).replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private async request(path: string, params: Record<string, string> = {}): Promise<any> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json", ...EASYORDER_ENDPOINT.authHeaders(this.token) },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Never echo the token; only status + a truncated body.
      throw new EasyOrderApiError(
        `EasyOrder API ${res.status}: ${body.slice(0, 300)}`,
        res.status
      );
    }
    return res.json();
  }

  /** Verifies credentials by making the smallest possible authenticated call. */
  async testConnection(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.request(EASYORDER_ENDPOINT.ordersPath, { [EASYORDER_ENDPOINT.pageParam]: "1" });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  async fetchOrdersByDateRange(from: Date, to: Date): Promise<EasyOrderPayload[]> {
    const data = await this.request(EASYORDER_ENDPOINT.ordersPath, {
      [EASYORDER_ENDPOINT.fromParam]: from.toISOString(),
      [EASYORDER_ENDPOINT.toParam]: to.toISOString(),
    });
    // Accept the common envelope shapes rather than assuming exactly one.
    const list = Array.isArray(data) ? data : (data?.data ?? data?.orders ?? data?.results ?? []);
    return Array.isArray(list) ? (list as EasyOrderPayload[]) : [];
  }
}

// ==================== Manual sync ====================
export interface SyncSummary {
  syncLogId: number;
  status: "success" | "partial" | "error";
  fetched: number;
  created: number;
  updated: number;
  duplicates: number;
  needsReview: number;
  failed: number;
  error?: string;
}

/**
 * Pulls orders for a date range and upserts them. Records a sync_logs row and updates the
 * channel's connection status either way, so the UI can always show what happened.
 */
export async function syncOrdersByDateRange(opts: {
  channelId: number;
  from: Date;
  to: Date;
  performedBy?: number;
  fetchImpl?: FetchLike;
  trigger?: "manual" | "retry";
}): Promise<SyncSummary> {
  const startedAt = Date.now();
  const channel = await getSalesChannelWithSecrets(opts.channelId);
  if (!channel) throw new Error(`قناة البيع #${opts.channelId} غير موجودة`);

  const syncLogId = await createSyncLog({
    channelId: opts.channelId,
    provider: "easyorder",
    trigger: opts.trigger ?? "manual",
    status: "running",
    rangeFrom: opts.from,
    rangeTo: opts.to,
    performedBy: opts.performedBy ?? null,
  });

  const fail = async (message: string): Promise<SyncSummary> => {
    await finishSyncLog(syncLogId, {
      status: "error",
      errorMessage: message,
      durationMs: Date.now() - startedAt,
    });
    await updateSalesChannelSyncStatus(opts.channelId, { lastSyncStatus: "error", lastSyncError: message });
    return {
      syncLogId, status: "error", fetched: 0, created: 0, updated: 0,
      duplicates: 0, needsReview: 0, failed: 0, error: message,
    };
  };

  if (!channel.apiToken?.trim()) {
    // Refuse rather than silently no-op: a channel with no token can never sync.
    return fail("لا يوجد API Token مضبوط لهذه القناة — أضفه من صفحة قنوات البيع أولًا");
  }

  let payloads: EasyOrderPayload[];
  try {
    const client = new EasyOrderClient({
      apiToken: channel.apiToken,
      baseUrl: channel.apiBaseUrl,
      fetchImpl: opts.fetchImpl,
    });
    payloads = await withRetry(() => client.fetchOrdersByDateRange(opts.from, opts.to), {
      attempts: 3,
      isRetryable: isRetryableHttpError,
    });
  } catch (err: any) {
    return fail(String(err?.message ?? err));
  }

  const catalog = await getMatchCatalog(channel.businessId);
  let created = 0, updated = 0, duplicates = 0, needsReview = 0, failed = 0;
  const failures: string[] = [];

  for (const payload of payloads) {
    const result = await upsertEasyOrder(payload, {
      businessId: channel.businessId,
      channelId: channel.id,
      catalog,
    });
    switch (result.outcome) {
      case "created": created++; break;
      case "updated": updated++; break;
      case "duplicate_unchanged": duplicates++; break;
      case "failed":
        failed++;
        failures.push(`${payload.id}: ${result.error ?? "خطأ غير معروف"}`);
        break;
    }
    if (result.needsReview && result.outcome !== "failed") needsReview++;
  }

  const status: SyncSummary["status"] = failed === 0 ? "success" : (created + updated > 0 ? "partial" : "error");

  await finishSyncLog(syncLogId, {
    status,
    fetchedCount: payloads.length,
    createdCount: created,
    updatedCount: updated,
    duplicateCount: duplicates,
    needsReviewCount: needsReview,
    failedCount: failed,
    errorMessage: failures.length ? failures.slice(0, 10).join(" | ") : null,
    durationMs: Date.now() - startedAt,
  });

  await updateSalesChannelSyncStatus(opts.channelId, {
    lastSyncStatus: status === "error" ? "error" : "success",
    lastSyncError: failures.length ? failures[0] : null,
    lastSyncedOrderCount: created + updated,
  });

  return {
    syncLogId, status,
    fetched: payloads.length,
    created, updated, duplicates, needsReview, failed,
    error: failures.length ? failures[0] : undefined,
  };
}

/** Tests a channel's stored credentials without importing anything. */
export async function testChannelConnection(channelId: number, fetchImpl?: FetchLike) {
  const channel = await getSalesChannelWithSecrets(channelId);
  if (!channel) throw new Error(`قناة البيع #${channelId} غير موجودة`);
  if (!channel.apiToken?.trim()) {
    return { ok: false as const, error: "لا يوجد API Token مضبوط لهذه القناة" };
  }
  const client = new EasyOrderClient({
    apiToken: channel.apiToken,
    baseUrl: channel.apiBaseUrl,
    fetchImpl,
  });
  return client.testConnection();
}
