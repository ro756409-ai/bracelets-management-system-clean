import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { isBostaEnabled } from "./bosta.service";
import { getBusinessIdsByGroupSlug } from "./db";
import type { TrpcContext } from "./_core/context";

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
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

describe("Bosta integration - configuration & secrets", () => {
  it("BOSTA_API_KEY is configured (isBostaEnabled = true)", () => {
    // يتحقق من ضبط المفتاح في البيئة
    expect(isBostaEnabled()).toBe(true);
  });

  it("BOSTA_PICKUP_ADDRESS_ID secret is set", () => {
    expect(process.env.BOSTA_PICKUP_ADDRESS_ID).toBeTruthy();
    expect((process.env.BOSTA_PICKUP_ADDRESS_ID || "").length).toBeGreaterThan(3);
  });
});

describe("Bosta integration - furniture group exclusion", () => {
  it("furniture group resolves to business IDs (slug=furniture)", async () => {
    const ids = await getBusinessIdsByGroupSlug("furniture");
    expect(Array.isArray(ids)).toBe(true);
    // مجموعة المفروشات يجب أن تحتوي على أعمال (مفروشات السعد، غطي)
    expect(ids.length).toBeGreaterThan(0);
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
