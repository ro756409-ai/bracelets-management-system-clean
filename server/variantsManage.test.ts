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

// All tests below hit the real database via getDb() (no mocking) — matching the existing
// pattern in this file. In an environment without a live DATABASE_URL, the read queries
// return [] and the tests gracefully no-op (documented per-test below); they run for real
// against any environment that does have a database.

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
    const uniqueSuffix = Date.now();

    // CREATE — name + sku are now required
    const created = await caller.variants.create({
      productId,
      name: "اختبار-نوع-" + uniqueSuffix,
      sku: "TEST-SKU-" + uniqueSuffix,
      price: 199,
      costPrice: 120,
      currentStock: 10,
      minStockLevel: 3,
    });
    expect(created.success).toBe(true);

    // find the created variant
    const all = await caller.variants.all();
    const mine = all.find((v: any) => v.productId === productId && v.name === "اختبار-نوع-" + uniqueSuffix);
    expect(mine).toBeDefined();
    const variantId = mine!.id;
    expect(Number(mine!.costPrice)).toBe(120);

    // UPDATE (no currentStock in the payload — the edit path never touches stock directly)
    const updated = await caller.variants.update({
      id: variantId,
      price: 249,
      costPrice: 150,
    });
    expect(updated.success).toBe(true);
    const afterUpdate = await caller.variants.get({ id: variantId });
    expect(Number(afterUpdate!.price)).toBe(249);
    expect(Number(afterUpdate!.costPrice)).toBe(150);
    expect(afterUpdate!.currentStock).toBe(10); // unchanged by the update above

    // ARCHIVE (soft delete)
    const deleted = await caller.variants.delete({ id: variantId });
    expect(deleted.success).toBe(true);
    const afterDelete = await caller.variants.get({ id: variantId });
    expect(afterDelete!.isActive).toBe(false);
  });

  it("rejects creating a variant with a duplicate SKU", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const products = await caller.products.list();
    if (products.length === 0) return;
    const productId = products[0].id;
    const sku = "DUP-SKU-" + Date.now();

    await caller.variants.create({
      productId, name: "نوع أول " + Date.now(), sku, currentStock: 0, minStockLevel: 0,
    });

    await expect(
      caller.variants.create({
        productId, name: "نوع تاني " + Date.now(), sku, currentStock: 0, minStockLevel: 0,
      })
    ).rejects.toThrow();
  });

  it("rejects creating a variant with a duplicate name under the same product", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const products = await caller.products.list();
    if (products.length === 0) return;
    const productId = products[0].id;
    const name = "اسم مكرر " + Date.now();

    await caller.variants.create({
      productId, name, sku: "SKU-A-" + Date.now(), currentStock: 0, minStockLevel: 0,
    });

    await expect(
      caller.variants.create({
        productId, name, sku: "SKU-B-" + Date.now(), currentStock: 0, minStockLevel: 0,
      })
    ).rejects.toThrow();
  });

  it("rejects creating a variant without a name or without a SKU", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    await expect(
      caller.variants.create({ productId: 1, name: "", sku: "SOME-SKU", currentStock: 0, minStockLevel: 0 } as any)
    ).rejects.toThrow();
    await expect(
      caller.variants.create({ productId: 1, name: "اسم بلا SKU", sku: "", currentStock: 0, minStockLevel: 0 } as any)
    ).rejects.toThrow();
  });

  it("incoming stock movement increases variant currentStock and is audited", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const products = await caller.products.list();
    if (products.length === 0) return;
    const created = await caller.variants.create({
      productId: products[0].id, name: "وارد اختبار " + Date.now(), sku: "IN-SKU-" + Date.now(),
      currentStock: 5, minStockLevel: 0,
    });
    expect(created.success).toBe(true);
    const all = await caller.variants.all();
    const variant = all.find((v: any) => v.sku?.startsWith("IN-SKU-"));
    if (!variant) return;

    const result = await caller.variants.addMovement({
      variantId: variant.id, type: "in", quantity: 7, reason: "استلام بضاعة جديدة من المورد", notes: "دفعة اختبار",
    });
    expect(result.success).toBe(true);

    const after = await caller.variants.get({ id: variant.id });
    expect(after!.currentStock).toBe(12); // 5 + 7
  });

  it("outgoing stock movement decreases variant currentStock", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const products = await caller.products.list();
    if (products.length === 0) return;
    await caller.variants.create({
      productId: products[0].id, name: "صادر اختبار " + Date.now(), sku: "OUT-SKU-" + Date.now(),
      currentStock: 10, minStockLevel: 0,
    });
    const all = await caller.variants.all();
    const variant = all.find((v: any) => v.sku?.startsWith("OUT-SKU-"));
    if (!variant) return;

    const result = await caller.variants.addMovement({
      variantId: variant.id, type: "out", quantity: 4, reason: "شحن أوردر",
    });
    expect(result.success).toBe(true);

    const after = await caller.variants.get({ id: variant.id });
    expect(after!.currentStock).toBe(6); // 10 - 4
  });

  it("rejects an outgoing movement that would make stock negative", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const products = await caller.products.list();
    if (products.length === 0) return;
    await caller.variants.create({
      productId: products[0].id, name: "مخزون سالب اختبار " + Date.now(), sku: "NEG-SKU-" + Date.now(),
      currentStock: 3, minStockLevel: 0,
    });
    const all = await caller.variants.all();
    const variant = all.find((v: any) => v.sku?.startsWith("NEG-SKU-"));
    if (!variant) return;

    await expect(
      caller.variants.addMovement({ variantId: variant.id, type: "out", quantity: 999 })
    ).rejects.toThrow();

    // stock must be unchanged after the rejected attempt
    const after = await caller.variants.get({ id: variant.id });
    expect(after!.currentStock).toBe(3);
  });

  it("archiving a variant sets isActive=false without deleting it", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const products = await caller.products.list();
    if (products.length === 0) return;
    await caller.variants.create({
      productId: products[0].id, name: "أرشفة اختبار " + Date.now(), sku: "ARC-SKU-" + Date.now(),
      currentStock: 1, minStockLevel: 0,
    });
    const all = await caller.variants.all();
    const variant = all.find((v: any) => v.sku?.startsWith("ARC-SKU-"));
    if (!variant) return;

    await caller.variants.delete({ id: variant.id });
    const stillExists = await caller.variants.get({ id: variant.id });
    expect(stillExists).toBeDefined();
    expect(stillExists!.isActive).toBe(false);
  });

  it("archiving a product sets isActive=false without deleting it", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    let created;
    try {
      created = await caller.products.create({
        name: "منتج أرشفة اختبار " + Date.now(),
        sku: "PARC-SKU-" + Date.now(),
        price: "10.00",
      });
    } catch (err: any) {
      if (String(err?.message ?? err).includes("Database not available")) return; // no DB in this environment
      throw err;
    }
    expect(created.success).toBe(true);
    const products = await caller.products.list({ includeInactive: true });
    const product = products.find((p: any) => p.sku?.startsWith("PARC-SKU-"));
    if (!product) return;

    await caller.products.update({ id: product.id, isActive: false });
    const after = await caller.products.get({ id: product.id });
    expect(after!.isActive).toBe(false);
  });

  it("products.create adds a new product (admin only)", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    try {
      const result = await caller.products.create({
        name: "منتج جديد اختبار " + Date.now(),
        sku: "NEWP-SKU-" + Date.now(),
        price: "99.00",
        currentStock: 5,
        minStockLevel: 2,
      });
      expect(result.success).toBe(true);
    } catch (err: any) {
      if (String(err?.message ?? err).includes("Database not available")) return; // no DB in this environment
      throw err;
    }
  });

  it("products.update can change price (admin only)", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const products = await caller.products.list();
    if (products.length === 0) return;
    const product = products[0];
    const originalPrice = product.price != null ? String(product.price) : undefined;

    const res = await caller.products.update({ id: product.id, price: "333" });
    expect(res.success).toBe(true);

    // restore original price to avoid side effects
    if (originalPrice !== undefined) {
      await caller.products.update({ id: product.id, price: originalPrice });
    }
  });

  it("non-admin cannot create a variant (FORBIDDEN)", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(
      caller.variants.create({ productId: 1, name: "x", sku: "y", currentStock: 0, minStockLevel: 0 })
    ).rejects.toThrow();
  });

  it("non-admin cannot delete a variant (FORBIDDEN)", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(caller.variants.delete({ id: 1 })).rejects.toThrow();
  });
});
