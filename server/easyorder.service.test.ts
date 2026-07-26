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
  it("maps auth failures to INVALID_CREDENTIALS", () => {
    expect(connectionErrorCode(401)).toBe("INVALID_CREDENTIALS");
    expect(connectionErrorCode(403)).toBe("INVALID_CREDENTIALS");
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

  it("falls through to the next candidate path on 404", async () => {
    const { fn, calls } = makeFetch([
      { ok: false, status: 404, body: {} },           // /store missing
      { ok: true, status: 200, body: { name: "متجر" } }, // /me works
    ]);
    const r = await new EasyOrderClient({ apiToken: "t", fetchImpl: fn }).testConnection();
    expect(r.connected).toBe(true);
    expect(calls.length).toBe(2);
  });

  it("stops immediately on 401 — a rejected credential is conclusive", async () => {
    const { fn, calls } = makeFetch([{ ok: false, status: 401, body: { message: "unauthorized" } }]);
    const r = await new EasyOrderClient({ apiToken: "t", fetchImpl: fn }).testConnection();
    expect(r.connected).toBe(false);
    expect(r.errorCode).toBe("INVALID_CREDENTIALS");
    expect(calls.length).toBe(1); // did NOT try the other paths
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
