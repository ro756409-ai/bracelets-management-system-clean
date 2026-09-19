import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getDb, getMatchCatalog, createProductWithVariants } from "./db";
import { products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * كتالوج شاشة الإدخال (منتجات + تركيبات) لازم يعرض منتجات نشاط الموظف فقط ومش فاضي لما فيه
 * منتجات، وبلا أي تسريب من tenant تاني (الأسورة). بنختبر db.getMatchCatalog(businessIds).
 */
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("🔒 عزل كتالوج الإدخال بين نشاطين", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const created: number[] = [];

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("catA"); // Afandy
    B = await createCoreTestFixture("catB"); // الأسورة
    const ra = await createProductWithVariants(A.businessId, { name: `ملابس اطفالي ${tag}` }, [
      { color: "بيج", size: "12", sku: `A-BEG-12-${tag}`, currentStock: 5 },
    ]);
    const rb = await createProductWithVariants(B.businessId, { name: `أسورة نحاس ${tag}` }, [
      { color: "ذهبي", size: "M", sku: `B-GLD-${tag}`, currentStock: 5 },
    ]);
    created.push(ra.productId, rb.productId);
  });
  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (created.length) {
      await d.delete(productVariants).where(inArray(productVariants.productId, created));
      await d.delete(products).where(inArray(products.id, created));
    }
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔒 كتالوج Afandy: منتجاته فقط، مش فاضي، بلا منتجات الأسورة", async () => {
    const cat = await getMatchCatalog(undefined, [A.businessId]);
    expect(cat.products.length).toBeGreaterThan(0);
    expect(cat.products.every(p => p.businessId === A.businessId)).toBe(true);
    expect(cat.products.some(p => p.name === `أسورة نحاس ${tag}`)).toBe(false);
    // التركيبات كمان لنشاط A فقط
    expect(cat.variants.some(v => v.sku === `A-BEG-12-${tag}`)).toBe(true);
    expect(cat.variants.some(v => v.sku === `B-GLD-${tag}`)).toBe(false);
  });

  it("🔒 كتالوج الأسورة: منتجاته فقط، بلا منتجات Afandy", async () => {
    const cat = await getMatchCatalog(undefined, [B.businessId]);
    expect(cat.products.length).toBeGreaterThan(0);
    expect(cat.products.every(p => p.businessId === B.businessId)).toBe(true);
    expect(cat.products.some(p => p.name === `ملابس اطفالي ${tag}`)).toBe(false);
  });

  it("🔒 نطاق فاضي → صفر منتجات (fail-closed، مش الكل)", async () => {
    expect((await getMatchCatalog(undefined, [])).products.length).toBe(0);
  });
});
