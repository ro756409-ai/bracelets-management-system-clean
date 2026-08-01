import { eq } from "drizzle-orm";
import { businesses, products, tenants, warehouses } from "../drizzle/schema";
import { getDb } from "./db";

function insertedId(result: unknown): number {
  const row = Array.isArray(result) ? result[0] : result;
  const id = Number((row as { insertId?: number } | undefined)?.insertId);
  if (!id) throw new Error("Test fixture insert did not return an id");
  return id;
}

export type CoreTestFixture = {
  tenantId: number;
  businessId: number;
  warehouseId: number;
  productId: number;
  cleanup: () => Promise<void>;
};

/** Creates isolated rows and never assumes production-style ids such as Business #1. */
export async function createCoreTestFixture(
  label = "core"
): Promise<CoreTestFixture> {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("TEST_DATABASE_URL is required for DB fixtures");
  const parsed = new URL(process.env.TEST_DATABASE_URL);
  if (!parsed.pathname.toLowerCase().includes("test")) {
    throw new Error("Refusing to create fixtures outside a test database");
  }
  const db = await getDb();
  if (!db) throw new Error("Test database is not available");
  const suffix = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const tenantId = insertedId(
    await db.insert(tenants).values({
      name: `Fixture ${label}`,
      slug: `fixture-${suffix}`.slice(0, 60),
      status: "active",
    })
  );
  const businessId = insertedId(
    await db.insert(businesses).values({
      tenantId,
      name: `Fixture Business ${label}`,
      slug: `fixture-business-${suffix}`.slice(0, 50),
      baseCurrency: "EGP",
      timezone: "Africa/Cairo",
    })
  );
  const warehouseId = insertedId(
    await db.insert(warehouses).values({
      businessId,
      name: "Test Warehouse",
    })
  );
  await db
    .update(businesses)
    .set({ defaultWarehouseId: warehouseId })
    .where(eq(businesses.id, businessId));
  const productId = insertedId(
    await db.insert(products).values({
      businessId,
      name: "Test Product",
      sku: `TEST-${suffix}`.slice(0, 50),
      price: "100.00",
    })
  );

  return {
    tenantId,
    businessId,
    warehouseId,
    productId,
    cleanup: async () => {
      await db.delete(products).where(eq(products.id, productId));
      await db.delete(warehouses).where(eq(warehouses.id, warehouseId));
      await db.delete(businesses).where(eq(businesses.id, businessId));
      await db.delete(tenants).where(eq(tenants.id, tenantId));
    },
  };
}
