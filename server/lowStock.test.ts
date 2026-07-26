import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { getDb, getLowStockProducts } from "./db";
import { products, productVariants } from "../drizzle/schema";
import { eq, inArray } from "drizzle-orm";

/**
 * Low-stock alerts for the parent/variant catalog.
 *
 * A product whose stock lives on its variants keeps `products.currentStock` at 0 forever.
 * Judging it by that column raised a permanent false "0 قطعة" alert for "أسورة نحاس" while
 * its nine engravings actually held 1795 pieces. These tests pin the corrected rule:
 * a product with active variants is not judged on its own column; a standalone product is.
 *
 * Needs a real database. Without one every test no-ops rather than failing, so the suite
 * stays green in the offline sandbox — but it then proves nothing, and must be run against
 * a real environment to mean anything.
 */
describe("getLowStockProducts — parent/variant stock", () => {
  let parentId: number | undefined;
  let standaloneId: number | undefined;
  let healthyId: number | undefined;
  const createdProductIds: number[] = [];

  beforeAll(async () => {
    const db = await getDb();
    if (!db) return;
    const stamp = Date.now() % 100000000;

    // Parent product: holds no stock of its own; its variants do.
    const [parent] = await db.insert(products).values({
      businessId: 1,
      name: `اختبار أب ${stamp}`,
      sku: `TEST-PARENT-${stamp}`,
      currentStock: 0,
      minStockLevel: 15,
      isActive: true,
    } as any).$returningId();
    parentId = (parent as any)?.id;
    if (parentId) {
      createdProductIds.push(parentId);
      await db.insert(productVariants).values([
        { productId: parentId, name: "نوع أ", currentStock: 180, minStockLevel: 15, isActive: true },
        { productId: parentId, name: "نوع ب", currentStock: 230, minStockLevel: 15, isActive: true },
      ] as any);
    }

    // Standalone product at zero: genuinely out of stock.
    const [standalone] = await db.insert(products).values({
      businessId: 1,
      name: `اختبار مستقل ${stamp}`,
      sku: `TEST-SOLO-${stamp}`,
      currentStock: 0,
      minStockLevel: 15,
      isActive: true,
    } as any).$returningId();
    standaloneId = (standalone as any)?.id;
    if (standaloneId) createdProductIds.push(standaloneId);

    // Standalone product well above its threshold: must never be flagged.
    const [healthy] = await db.insert(products).values({
      businessId: 1,
      name: `اختبار وفير ${stamp}`,
      sku: `TEST-OK-${stamp}`,
      currentStock: 500,
      minStockLevel: 15,
      isActive: true,
    } as any).$returningId();
    healthyId = (healthy as any)?.id;
    if (healthyId) createdProductIds.push(healthyId);
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db || createdProductIds.length === 0) return;
    await db.delete(productVariants).where(inArray(productVariants.productId, createdProductIds));
    await db.delete(products).where(inArray(products.id, createdProductIds));
  });

  it("does not flag a product whose stock lives on its variants", async () => {
    const db = await getDb();
    if (!db || !parentId) return;
    const low = await getLowStockProducts();
    // currentStock 0 <= minStockLevel 15, yet 410 pieces exist across its variants.
    expect(low.some(p => p.id === parentId)).toBe(false);
  });

  it("still flags a standalone product that is actually out of stock", async () => {
    const db = await getDb();
    if (!db || !standaloneId) return;
    const low = await getLowStockProducts();
    expect(low.some(p => p.id === standaloneId)).toBe(true);
  });

  it("does not flag a standalone product above its threshold", async () => {
    const db = await getDb();
    if (!db || !healthyId) return;
    const low = await getLowStockProducts();
    expect(low.some(p => p.id === healthyId)).toBe(false);
  });

  it("flags a parent again once its variants are archived", async () => {
    const db = await getDb();
    if (!db || !parentId) return;
    // With no ACTIVE variants left, the parent's own column is the only stock it has.
    await db.update(productVariants).set({ isActive: false })
      .where(eq(productVariants.productId, parentId));
    const low = await getLowStockProducts();
    expect(low.some(p => p.id === parentId)).toBe(true);

    await db.update(productVariants).set({ isActive: true })
      .where(eq(productVariants.productId, parentId));
  });
});
