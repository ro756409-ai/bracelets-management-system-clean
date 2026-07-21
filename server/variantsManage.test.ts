import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
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

describe("variants management (create/update/delete) + product price", () => {
  it("variants.all returns an array for admin", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.variants.all();
    expect(Array.isArray(result)).toBe(true);
  });

  it("full lifecycle: create -> update -> delete a variant", async () => {
    const caller = appRouter.createCaller(createAdminContext());

    // pick an existing product to attach the variant to
    const products = await caller.products.list();
    expect(Array.isArray(products)).toBe(true);
    if (products.length === 0) {
      // No products to attach to in this environment; skip gracefully
      return;
    }
    const productId = products[0].id;

    // CREATE
    const created = await caller.variants.create({
      productId,
      color: "اختبار-لون",
      size: "اختبار-مقاس",
      sku: "TEST-SKU-" + Date.now(),
      price: 199,
      currentStock: 10,
      minStockLevel: 3,
    });
    expect(created.success).toBe(true);

    // find the created variant
    const all = await caller.variants.all();
    const mine = all.find(
      (v: any) => v.productId === productId && v.color === "اختبار-لون" && v.size === "اختبار-مقاس"
    );
    expect(mine).toBeDefined();
    const variantId = mine!.id;

    // UPDATE
    const updated = await caller.variants.update({
      id: variantId,
      price: 249,
      currentStock: 20,
    });
    expect(updated.success).toBe(true);

    // DELETE
    const deleted = await caller.variants.delete({ id: variantId });
    expect(deleted.success).toBe(true);
  });

  it("products.update can change price (admin only)", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const products = await caller.products.list();
    if (products.length === 0) return;
    const product = products[0];
    const originalPrice = String(product.price);

    const res = await caller.products.update({ id: product.id, price: "333" });
    expect(res.success).toBe(true);

    // restore original price to avoid side effects
    await caller.products.update({ id: product.id, price: originalPrice });
  });

  it("non-admin cannot create a variant (FORBIDDEN)", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(
      caller.variants.create({ productId: 1, color: "x", size: "y", currentStock: 0, minStockLevel: 0 })
    ).rejects.toThrow();
  });

  it("non-admin cannot delete a variant (FORBIDDEN)", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(caller.variants.delete({ id: 1 })).rejects.toThrow();
  });
});
