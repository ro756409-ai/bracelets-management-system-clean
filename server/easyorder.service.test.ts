import { describe, expect, it, vi } from "vitest";
import {
  normalizeEasyOrderPayload,
  normalizeGovernorate,
  withRetry,
  isRetryableHttpError,
  EasyOrderClient,
  EasyOrderApiError,
  extractStoreIdentity,
  connectionErrorCode,
  sanitizeErrorMessage,
  isUsableOrderPayload,
  fetchEasyOrderById,
  type EasyOrderPayload,
  type FetchLike,
} from "./easyorder.service";

function makePayload(overrides: Partial<EasyOrderPayload> = {}): EasyOrderPayload {
  return {
    id: "ext-123",
    full_name: "أحمد محمد",
    phone: "01012345678",
    government: "القاهره",
    address: "شارع النيل",
    shipping_cost: 50,
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-01T10:00:00Z",
    cart_items: [
      {
        price: 180,
        quantity: 2,
        product: { name: "أسورة نحاس", sku: "AYAT-001" },
      },
    ],
    ...overrides,
  };
}

/** Builds a fetch stub with a scripted sequence of responses. */
function makeFetch(responses: Array<{ ok: boolean; status: number; body: any }>): { fn: FetchLike; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fn: FetchLike = async (url: string) => {
    calls.push(url);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
  return { fn, calls };
}

describe("normalizeGovernorate", () => {
  it("normalizes common misspellings", () => {
    expect(normalizeGovernorate("القاهره")).toBe("القاهرة");
    expect(normalizeGovernorate("الاسكندريه")).toBe("الإسكندرية");
    expect(normalizeGovernorate("Alexandria")).toBe("الإسكندرية");
  });
  it("falls back to 'غير محدد' for empty input", () => {
    expect(normalizeGovernorate(null)).toBe("غير محدد");
    expect(normalizeGovernorate("")).toBe("غير محدد");
  });
});

describe("normalizeEasyOrderPayload", () => {
  it("extracts items, quantities and prices", () => {
    const n = normalizeEasyOrderPayload(makePayload());
    expect(n.externalOrderId).toBe("ext-123");
    expect(n.items).toHaveLength(1);
    expect(n.items[0].externalSku).toBe("AYAT-001");
    expect(n.items[0].quantity).toBe(2);
    expect(n.itemsTotal).toBe(360); // 180 * 2
  });

  it("adds shipping to the items total", () => {
    const n = normalizeEasyOrderPayload(makePayload({ shipping_cost: 50 }));
    expect(n.totalAmount).toBe(410); // 360 + 50
  });

  it("applies the default shipping fee when the payload reports none", () => {
    const n = normalizeEasyOrderPayload(makePayload({ shipping_cost: 0 }));
    expect(n.shippingFee).toBe(50);
    expect(n.totalAmount).toBe(410);
  });

  it("prefers the variant SKU over the product SKU", () => {
    const n = normalizeEasyOrderPayload(
      makePayload({
        cart_items: [
          {
            price: 100, quantity: 1,
            product: { name: "منتج", sku: "PRODUCT-SKU" },
            variant: { sku: "VARIANT-SKU" },
          },
        ],
      })
    );
    expect(n.items[0].externalSku).toBe("VARIANT-SKU");
  });

  it("builds variant text from variation props", () => {
    const n = normalizeEasyOrderPayload(
      makePayload({
        cart_items: [
          {
            price: 100, quantity: 1,
            product: { name: "أسورة" },
            variant: { variation_props: [{ variation: "نوع الحفر", variation_prop: "آية الكرسي" }] },
          },
        ],
      })
    );
    expect(n.items[0].variantText).toBe("نوع الحفر: آية الكرسي");
  });

  it("normalizes the Egyptian phone number", () => {
    const n = normalizeEasyOrderPayload(makePayload({ phone: "+20 101 234 5678" }));
    expect(n.customerPhone).toBe("01012345678");
  });

  it("preserves the full raw payload (not truncated)", () => {
    const payload = makePayload({ address: "ع".repeat(5000) });
    const n = normalizeEasyOrderPayload(payload);
    expect(n.rawPayload.length).toBeGreaterThan(5000);
    expect(JSON.parse(n.rawPayload).id).toBe("ext-123");
  });

  it("parses external timestamps used for change detection", () => {
    const n = normalizeEasyOrderPayload(makePayload({ updated_at: "2026-07-05T12:00:00Z" }));
    expect(n.externalUpdatedAt?.toISOString()).toBe("2026-07-05T12:00:00.000Z");
  });
});

describe("withRetry", () => {
  it("returns immediately on first success without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const result = await withRetry(async () => "ok", { sleep });
    expect(result).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a transient failure and eventually succeeds", async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new EasyOrderApiError("boom", 500);
        return "recovered";
      },
      { attempts: 3, sleep, isRetryable: isRetryableHttpError }
    );
    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("uses exponential backoff between attempts", async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => { delays.push(ms); });
    await expect(
      withRetry(async () => { throw new EasyOrderApiError("always", 500); }, {
        attempts: 3, baseDelayMs: 100, sleep, isRetryable: isRetryableHttpError,
      })
    ).rejects.toThrow();
    expect(delays).toEqual([100, 200]);
  });

  it("does NOT retry a non-retryable (4xx) error", async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;
    await expect(
      withRetry(async () => { attempts++; throw new EasyOrderApiError("bad request", 400); }, {
        attempts: 3, sleep, isRetryable: isRetryableHttpError,
      })
    ).rejects.toThrow();
    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the configured number of attempts", async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;
    await expect(
      withRetry(async () => { attempts++; throw new Error("nope"); }, { attempts: 4, sleep })
    ).rejects.toThrow("nope");
    expect(attempts).toBe(4);
  });
});

describe("isRetryableHttpError", () => {
  it("retries 429 and 5xx", () => {
    expect(isRetryableHttpError(new EasyOrderApiError("x", 429))).toBe(true);
    expect(isRetryableHttpError(new EasyOrderApiError("x", 500))).toBe(true);
    expect(isRetryableHttpError(new EasyOrderApiError("x", 503))).toBe(true);
  });
  it("does not retry 4xx client errors", () => {
    expect(isRetryableHttpError(new EasyOrderApiError("x", 400))).toBe(false);
    expect(isRetryableHttpError(new EasyOrderApiError("x", 401))).toBe(false);
    expect(isRetryableHttpError(new EasyOrderApiError("x", 404))).toBe(false);
  });
  it("retries unknown/network errors that carry no status", () => {
    expect(isRetryableHttpError(new Error("ECONNRESET"))).toBe(true);
  });
});

describe("EasyOrderClient", () => {
  it("refuses to construct without an API token", () => {
    expect(() => new EasyOrderClient({ apiToken: "" })).toThrow();
    expect(() => new EasyOrderClient({ apiToken: "   " })).toThrow();
  });

  it("sends the date range as query params", async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, body: [] }]);
    const client = new EasyOrderClient({ apiToken: "tok", baseUrl: "https://api.test/v1", fetchImpl: fn });
    await client.fetchOrdersByDateRange(new Date("2026-07-01"), new Date("2026-07-08"));
    expect(calls[0]).toContain("https://api.test/v1");
    expect(calls[0]).toContain("2026-07-01");
    expect(calls[0]).toContain("2026-07-08");
  });

  it("accepts the common response envelope shapes", async () => {
    const bare = new EasyOrderClient({
      apiToken: "t", fetchImpl: makeFetch([{ ok: true, status: 200, body: [makePayload()] }]).fn,
    });
    expect(await bare.fetchOrdersByDateRange(new Date(), new Date())).toHaveLength(1);

    const wrapped = new EasyOrderClient({
      apiToken: "t", fetchImpl: makeFetch([{ ok: true, status: 200, body: { data: [makePayload()] } }]).fn,
    });
    expect(await wrapped.fetchOrdersByDateRange(new Date(), new Date())).toHaveLength(1);

    const odd = new EasyOrderClient({
      apiToken: "t", fetchImpl: makeFetch([{ ok: true, status: 200, body: { unexpected: true } }]).fn,
    });
    expect(await odd.fetchOrdersByDateRange(new Date(), new Date())).toEqual([]);
  });

  it("throws EasyOrderApiError carrying the HTTP status", async () => {
    const client = new EasyOrderClient({
      apiToken: "t", fetchImpl: makeFetch([{ ok: false, status: 401, body: { message: "bad token" } }]).fn,
    });
    await expect(client.fetchOrdersByDateRange(new Date(), new Date())).rejects.toMatchObject({ status: 401 });
  });

  it("never leaks the API token in an error message", async () => {
    const secret = "super-secret-token-abcdef";
    const client = new EasyOrderClient({
      apiToken: secret, fetchImpl: makeFetch([{ ok: false, status: 500, body: { message: "server error" } }]).fn,
    });
    await expect(client.fetchOrdersByDateRange(new Date(), new Date())).rejects.toSatisfy((err: any) => {
      expect(String(err.message)).not.toContain(secret);
      return true;
    });
  });

});

// ==================== Connection test ====================

describe("extractStoreIdentity", () => {
  it("prefers a human-readable name over an id", () => {
    expect(extractStoreIdentity({ store_name: "متجر فرحات", id: 7 })).toBe("متجر فرحات");
    expect(extractStoreIdentity({ name: "Matjarak" })).toBe("Matjarak");
  });
  it("unwraps a data/store envelope", () => {
    expect(extractStoreIdentity({ data: { name: "من داخل data" } })).toBe("من داخل data");
    expect(extractStoreIdentity({ store: { title: "من داخل store" } })).toBe("من داخل store");
  });
  it("falls back to an id when no name is present", () => {
    expect(extractStoreIdentity({ store_id: "abc123" })).toBe("#abc123");
    expect(extractStoreIdentity({ id: 42 })).toBe("#42");
  });
  it("returns null when nothing identifying is present", () => {
    expect(extractStoreIdentity({ unrelated: true })).toBeNull();
    expect(extractStoreIdentity(null)).toBeNull();
    expect(extractStoreIdentity([])).toBeNull();
  });
});

describe("connectionErrorCode", () => {
  it("maps auth failures, separating a bad key from a missing scope", () => {
    expect(connectionErrorCode(401)).toBe("INVALID_CREDENTIALS");
    // 403 = key valid, scope missing (e.g. no products:read) — a different fix entirely
    expect(connectionErrorCode(403)).toBe("INSUFFICIENT_PERMISSIONS");
  });
  it("maps the remaining statuses to stable codes", () => {
    expect(connectionErrorCode(404)).toBe("ENDPOINT_NOT_FOUND");
    expect(connectionErrorCode(429)).toBe("RATE_LIMITED");
    expect(connectionErrorCode(500)).toBe("PROVIDER_ERROR");
    expect(connectionErrorCode(418)).toBe("REQUEST_FAILED");
    expect(connectionErrorCode(undefined)).toBe("NETWORK_ERROR");
  });
});

describe("sanitizeErrorMessage", () => {
  it("redacts the channel's own token wherever it appears", () => {
    const token = "sk-live-abcdef123456";
    const out = sanitizeErrorMessage(`request failed with ${token} in the url`, token);
    expect(out).not.toContain(token);
    expect(out).toContain("«محذوف»");
  });
  it("redacts bearer tokens and api-key style values it was not given", () => {
    expect(sanitizeErrorMessage("Authorization: Bearer abcdefgh12345678")).not.toContain("abcdefgh12345678");
    expect(sanitizeErrorMessage('{"api_key":"zyxwvut987654321"}')).not.toContain("zyxwvut987654321");
  });
  it("truncates very long provider errors", () => {
    expect(sanitizeErrorMessage("x".repeat(2000)).length).toBeLessThanOrEqual(401);
  });
  it("leaves a harmless message intact", () => {
    expect(sanitizeErrorMessage("store not found")).toBe("store not found");
  });
});

describe("EasyOrderClient.testConnection", () => {
  it("reports connected and surfaces the store name", async () => {
    const client = new EasyOrderClient({
      apiToken: "t",
      fetchImpl: makeFetch([{ ok: true, status: 200, body: { store_name: "متجر الاختبار" } }]).fn,
    });
    const r = await client.testConnection();
    expect(r.connected).toBe(true);
    expect(r.storeName).toBe("متجر الاختبار");
  });

  it("still reports connected when the endpoint exposes no store identity", async () => {
    const client = new EasyOrderClient({
      apiToken: "t",
      fetchImpl: makeFetch([{ ok: true, status: 200, body: { unrelated: 1 } }]).fn,
    });
    const r = await client.testConnection();
    expect(r.connected).toBe(true);
    expect(r.storeName).toBeNull();
  });

  it("uses only GET requests — a connection test can never mutate anything", async () => {
    const methods: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      methods.push(init?.method ?? "GET");
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    };
    await new EasyOrderClient({ apiToken: "t", fetchImpl }).testConnection();
    expect(methods.every((m) => m === "GET")).toBe(true);
  });

  // The endpoint is no longer guessed: the public API docs specify
  // GET /api/v1/external-apps/products with an `Api-Key` header.
  it("calls the documented products endpoint on the documented base URL", async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, body: {} }]);
    await new EasyOrderClient({ apiToken: "t", fetchImpl: fn }).testConnection();
    expect(calls.length).toBe(1); // one verified path, no guessing
    expect(calls[0]).toBe("https://api.easy-orders.net/api/v1/external-apps/products");
  });

  it("authenticates with the Api-Key header, not Authorization: Bearer", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl: FetchLike = async (_url, init) => {
      headers = (init?.headers ?? {}) as Record<string, string>;
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    };
    await new EasyOrderClient({ apiToken: "secret-token", fetchImpl }).testConnection();
    expect(headers["Api-Key"]).toBe("secret-token");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("reports a 404 as ENDPOINT_NOT_FOUND — the documented path moved", async () => {
    const { fn, calls } = makeFetch([{ ok: false, status: 404, body: {} }]);
    const r = await new EasyOrderClient({ apiToken: "t", fetchImpl: fn }).testConnection();
    expect(r.connected).toBe(false);
    expect(r.errorCode).toBe("ENDPOINT_NOT_FOUND");
    expect(calls.length).toBe(1);
  });

  it("reports a 403 as a missing scope, not a bad token", async () => {
    const { fn } = makeFetch([{ ok: false, status: 403, body: { message: "forbidden" } }]);
    const r = await new EasyOrderClient({ apiToken: "t", fetchImpl: fn }).testConnection();
    expect(r.connected).toBe(false);
    // The key is valid; it just lacks products:read — a different fix for the user.
    expect(r.errorCode).toBe("INSUFFICIENT_PERMISSIONS");
  });

  it("stops immediately on 401 — a rejected credential is conclusive", async () => {
    const { fn, calls } = makeFetch([{ ok: false, status: 401, body: { message: "unauthorized" } }]);
    const r = await new EasyOrderClient({ apiToken: "t", fetchImpl: fn }).testConnection();
    expect(r.connected).toBe(false);
    expect(r.errorCode).toBe("INVALID_CREDENTIALS");
    expect(calls.length).toBe(1); // conclusive — no retry
  });

  it("returns a structured failure with code, message and status", async () => {
    const client = new EasyOrderClient({
      apiToken: "t",
      fetchImpl: makeFetch([{ ok: false, status: 500, body: { message: "boom" } }]).fn,
    });
    const r = await client.testConnection();
    expect(r.connected).toBe(false);
    expect(r.errorCode).toBe("PROVIDER_ERROR");
    expect(r.status).toBe(500);
    expect(typeof r.errorMessage).toBe("string");
  });

  it("never leaks the API token in a connection-test failure", async () => {
    const secret = "super-secret-token-abcdef";
    const client = new EasyOrderClient({
      apiToken: secret,
      // Provider echoes the token back in its error body — worst case.
      fetchImpl: makeFetch([{ ok: false, status: 500, body: { message: `bad token ${secret}` } }]).fn,
    });
    const r = await client.testConnection();
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});


// ==================== Single-order read (the only documented order pull) ====================
const FULL_ORDER = {
  id: "eo-1",
  full_name: "منى سيد",
  phone: "01012345678",
  cart_items: [{ price: 180, quantity: 2, product: { name: "آية الكرسي" } }],
};

describe("isUsableOrderPayload", () => {
  it("accepts a payload with id, name and at least one item", () => {
    expect(isUsableOrderPayload(FULL_ORDER)).toBe(true);
  });

  it("rejects anything missing the essentials", () => {
    expect(isUsableOrderPayload(null)).toBe(false);
    expect(isUsableOrderPayload({})).toBe(false);
    expect(isUsableOrderPayload({ ...FULL_ORDER, cart_items: [] })).toBe(false);
    expect(isUsableOrderPayload({ ...FULL_ORDER, full_name: "  " })).toBe(false);
    expect(isUsableOrderPayload({ ...FULL_ORDER, id: "" })).toBe(false);
  });
});

describe("EasyOrderClient.fetchOrderById", () => {
  it("calls the documented single-order path with the id encoded", async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, body: FULL_ORDER }]);
    await new EasyOrderClient({ apiToken: "t", fetchImpl: fn }).fetchOrderById("a/b 1");
    expect(calls[0]).toBe("https://api.easy-orders.net/api/v1/external-apps/orders/a%2Fb%201");
  });

  it("unwraps a data envelope", async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, body: { data: FULL_ORDER } }]);
    const order = await new EasyOrderClient({ apiToken: "t", fetchImpl: fn }).fetchOrderById("eo-1");
    expect(order?.full_name).toBe("منى سيد");
  });

  it("returns null rather than a half-built order when the response is unusable", async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, body: { id: "eo-1" } }]);
    const order = await new EasyOrderClient({ apiToken: "t", fetchImpl: fn }).fetchOrderById("eo-1");
    expect(order).toBeNull();
  });
});

describe("fetchEasyOrderById", () => {
  it("returns the order on success", async () => {
    const { fn } = makeFetch([{ ok: true, status: 200, body: FULL_ORDER }]);
    const r = await fetchEasyOrderById("eo-1", { apiToken: "t", fetchImpl: fn });
    expect(r.order?.id).toBe("eo-1");
    expect(r.error).toBeUndefined();
  });

  it("never throws on an HTTP failure — the caller must be able to fall back", async () => {
    const { fn } = makeFetch([{ ok: false, status: 500, body: { message: "boom" } }]);
    const r = await fetchEasyOrderById("eo-1", { apiToken: "t", fetchImpl: fn });
    expect(r.order).toBeNull();
    expect(typeof r.error).toBe("string");
  });

  it("reports a missing token instead of attempting a call", async () => {
    const { fn, calls } = makeFetch([{ ok: true, status: 200, body: FULL_ORDER }]);
    const r = await fetchEasyOrderById("eo-1", { apiToken: null, fetchImpl: fn });
    expect(r.order).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("never leaks the token into the error message", async () => {
    const { fn } = makeFetch([{ ok: false, status: 401, body: { message: "bad key super-secret-token" } }]);
    const r = await fetchEasyOrderById("eo-1", { apiToken: "super-secret-token", fetchImpl: fn });
    expect(r.error).not.toContain("super-secret-token");
  });
});
