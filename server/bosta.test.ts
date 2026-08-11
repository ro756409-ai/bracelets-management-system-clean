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

// ───────────────── وصف الشحنة ─────────────────

describe("🔑 نوع الحفر بيوصل بوسطة", () => {
  const service = fs.readFileSync("server/bosta.service.ts", "utf-8");
  const code = service.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  const block = code.slice(
    code.indexOf("const bostaItems ="),
    code.indexOf("const payload")
  );

  it("🔑 البنود بتتجاب بالجوين على أنواع الحفر — مش خام", () => {
    // كان `db.select().from(orderItems)` على طول، و`variantId` عمود لوحده — يعني اسم
    // النوع مكانش بيتجاب أصلاً. أوردر بتلات نقوش مختلفة كان بيوصل «أسورة نحاس ×3».
    expect(block).toContain("await getOrderItems(orderId)");
    expect(block).not.toContain("db.select().from(orderItems)");
  });

  /*
    تكوين الوصف نفسه اتنقل لـ`shared/orderContent.ts` عشان يبقى قابل للاختبار
    بالتشغيل مش بقراءة النص — الاختبارات السلوكية بتاعته في
    `orderContentLifecycle.test.ts` (نوع الحفر، البند من غير نوع، المقاس واللون،
    مجموع الكميات، والقص). اللي فاضل هنا هو **الوصلة**: الخدمة بتقرا البنود الحالية
    وبتسلّمها للدالة المشتركة، ومابتكوّنش وصف تاني لوحدها.
  */
  it("🔑 الوصف بيتبني من البنود عن طريق الدالة المشتركة", () => {
    expect(block).toContain("buildShipmentContents(");
    expect(block).toContain("variantName: it.variantName");
    expect(block).toContain("quantity: it.quantity");
  });

  it("🔑 والمقاس واللون بيتبعتوا كمان — دول جزء من اللي جوه الصندوق", () => {
    expect(block).toContain("size: it.size");
    expect(block).toContain("color: it.color");
  });

  it("🔑 الهيدر fallback بس — مش مصدر موازي", () => {
    expect(block).toContain("{ productName: order.productName, quantity: order.quantity }");
    // مفيش وصف بيتلزق بالإيد في الخدمة؛ لو رجع، الاختلاف بيرجع معاه.
    expect(block).not.toContain(".join(");
    expect(block).not.toContain(".slice(");
  });

  it("🔑 نفس الدالة اللي الشاشة بتعرض بيها — فاللي التاجر شايفه هو اللي بيتبعت", () => {
    const orders = fs.readFileSync("client/src/pages/Orders.tsx", "utf-8");
    expect(orders).toContain("item.variantName");
    const db = fs.readFileSync("server/db.ts", "utf-8");
    expect(db).toContain("export async function getOrderItems");
    expect(db).toContain("variantName: productVariants.name");
  });
});
