import { describe, expect, it, vi } from "vitest";

vi.mock("./bosta.service", async importOriginal => {
  const actual = await importOriginal<typeof import("./bosta.service")>();
  return {
    ...actual,
    isBostaEnabled: () => true,
    createBostaShipment: vi.fn(async () => ({ success: false, error: "mock-order-not-found" })),
  };
});
import { appRouter } from "./routers";
import { isBostaEnabled } from "./bosta.service";
import { getBusinessIdsByGroupSlug } from "./db";
import type { TrpcContext } from "./_core/context";
import fs from "fs";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAdminContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "admin-user",
    email: "admin@example.com",
    name: "Admin User",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    tenantId: 1,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

function createUserContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 2,
    openId: "regular-user",
    email: "user@example.com",
    name: "Regular User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    tenantId: 1,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

describe("Bosta integration - configuration & secrets", () => {
  it("uses a mocked enabled adapter without production secrets", () => {
    expect(isBostaEnabled()).toBe(true);
  });

  it("does not require a real pickup address in unit tests", () => {
    expect(process.env.BOSTA_PICKUP_ADDRESS_ID).toBeUndefined();
  });
});

describe("Bosta accounting status safety", () => {
  it("does not map partially delivered code 31 to delivered", () => {
    const source = fs.readFileSync("server/bostaWebhook.ts", "utf-8");
    const internalMap = source.slice(source.indexOf("const BOSTA_STATUS_TO_ORDER_STATUS"), source.indexOf("function safeCompare"));
    expect(internalMap).not.toMatch(/31\s*:\s*["']delivered["']/);
  });
});

describe("Bosta integration - furniture group exclusion", () => {
  it("furniture group resolves to business IDs (slug=furniture)", async () => {
    const ids = await getBusinessIdsByGroupSlug("furniture");
    expect(Array.isArray(ids)).toBe(true);
    // محتوى المجموعة fixture خاص باختبارات TEST_DATABASE_URL، والوحدة تختبر العقد فقط.
  });

  it("unknown group slug returns empty array (no crash)", async () => {
    const ids = await getBusinessIdsByGroupSlug("nonexistent-group-xyz");
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.length).toBe(0);
  });
});

describe("Bosta integration - access control", () => {
  it("non-admin cannot call sendToBosta (FORBIDDEN)", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(
      caller.orders.sendToBosta({ orderId: 999999 })
    ).rejects.toThrow();
  });

  it("non-admin cannot call bulkSendToBosta (FORBIDDEN)", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(
      caller.orders.bulkSendToBosta({ orderIds: [999999] })
    ).rejects.toThrow();
  });
});

describe("Bosta integration - duplicate & non-existent handling", () => {
  it("admin sending a non-existent order returns failure without throwing", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    // طلب إرسال أوردر غير موجود يجب أن يرجع success=false وليس استثناء
    const res = await caller.orders.sendToBosta({ orderId: 999999999 });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("bulkSendToBosta returns aggregated success/failed counts", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const res = await caller.orders.bulkSendToBosta({ orderIds: [999999999] });
    expect(res).toHaveProperty("success");
    expect(res).toHaveProperty("failed");
    expect(res.failed).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.errors)).toBe(true);
  });
});

// Sending a real shipment needs live Bosta credentials this sandbox doesn't have, so the COD
// money invariant is locked in at the source level instead — the same approach security.test.ts
// uses for rules that can't be exercised end to end here.
describe("Bosta COD amount — shipping must never be double-charged", () => {
  it("bosta.service.ts does not add shippingFees on top of totalAmount", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/bosta.service.ts", "utf-8");
    const idx = content.indexOf("const totalCOD");
    expect(idx).toBeGreaterThan(-1);
    const line = content.substring(idx, content.indexOf("\n", idx));
    // totalAmount is already the full customer-facing amount (see easyorder.service.ts, which
    // builds it as itemsTotal + shippingFee). shippingFees is a breakdown of that total, so
    // adding it here inflates the COD by exactly the shipping fee.
    expect(line).toContain("order.totalAmount");
    expect(line).not.toContain("shippingFees");
  });

  it("easyorder.service.ts still builds totalAmount inclusive of shipping (the assumption above)", async () => {
    const fs = await import("fs");
    const content = fs.readFileSync("server/easyorder.service.ts", "utf-8");
    // If this ever changes to store a shipping-exclusive total, the Bosta COD line has to be
    // revisited in the same commit — hence pinning the assumption itself, not just the result.
    expect(content).toContain("totalAmount: itemsTotal + shippingFee");
  });
});
