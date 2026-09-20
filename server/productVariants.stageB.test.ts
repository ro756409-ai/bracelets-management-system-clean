import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  createProduct,
  createProductWithVariants,
  findTakenSkusInBusiness,
  getVariantsByProduct,
  getAllVariantsWithProduct,
  getAllProducts,
} from "./db";
import { products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * المرحلة B — نظام ألوان×مقاسات (variants). الـschema (product_variants) جاهز، فلا Migration.
 * نغطّي: التوليد، منع تكرار اللون×المقاس، تفرّد SKU داخل النشاط، الـtransaction (الكل-أو-لا-شيء)،
 * العزل بين الأنشطة، وعدم انحدار المنتج البسيط.
 */
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const db = fs.readFileSync("server/db.ts", "utf-8");

describe("🔑 حراس المصدر — createWithVariants", () => {
  it("🔑 db.createProductWithVariants بيستخدم transaction واحدة", () => {
    const fn = db.slice(
      db.indexOf("export async function createProductWithVariants"),
      db.indexOf("export async function createProductWithVariants") + 1600
    );
    expect(fn).toContain("db.transaction(async tx =>");
    expect(fn).toContain("tx.insert(products)");
    expect(fn).toContain("tx.insert(productVariants)");
    expect(fn).toContain("تركيبة مكررة داخل المنتج"); // دفاع في العمق داخل الـtx
    // هوية التركيبة = النوع+اللون+المقاس (مش لون|مقاس بس)
    expect(fn).toContain("variantIdentityKey(v)");
  });
  it("🔑 الراوتر بيفحص العزل + تكرار اللون×المقاس + تفرّد SKU داخل النشاط قبل الكتابة", () => {
    const block = routers.slice(
      routers.indexOf("createWithVariants: adminProcedure"),
      routers.indexOf("createWithVariants: adminProcedure") + 4600
    );
    expect(block).toContain("scopeBusinessIds(ctx, {");
    expect(block).toContain("findTakenSkusInBusiness(");
    expect(block).toContain("مستخدم بالفعل في هذا النشاط");
    expect(block).toContain("createProductWithVariants(");
  });
});

// ── سلوكي فعلي (matjarak_test) ──
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("🔑 variants سلوكي", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const created = { productIds: [] as number[] };

  async function countProducts(businessId: number) {
    return (await getAllProducts(businessId, [businessId], { includeInactive: true })).length;
  }

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("var-a");
    B = await createCoreTestFixture("var-b");
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (created.productIds.length) {
      await d.delete(productVariants).where(inArray(productVariants.productId, created.productIds));
      await d.delete(products).where(inArray(products.id, created.productIds));
    }
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔑 توليد: لونان × مقاسان = 4 تركيبات مربوطة بالمنتج", async () => {
    const res = await createProductWithVariants(
      A.businessId,
      { name: `بدلة كورن ${tag}` },
      [
        { color: "أسود", size: "S", sku: `A-BLK-S-${tag}`, currentStock: 3 },
        { color: "أسود", size: "M", sku: `A-BLK-M-${tag}`, currentStock: 4 },
        { color: "أبيض", size: "S", sku: `A-WHT-S-${tag}` },
        { color: "أبيض", size: "M", sku: `A-WHT-M-${tag}` },
      ]
    );
    created.productIds.push(res.productId);
    expect(res.variantIds.length).toBe(4);
    const vars = await getVariantsByProduct(res.productId, { includeInactive: true });
    expect(vars.length).toBe(4);
    expect(vars.every(v => v.productId === res.productId)).toBe(true);
    expect(new Set(vars.map(v => `${v.color}|${v.size}`)).size).toBe(4);
  });

  it("🔑 منع تكرار اللون×المقاس + الكل-أو-لا-شيء (مايتسجّلش نص منتج)", async () => {
    const before = await countProducts(A.businessId);
    await expect(
      createProductWithVariants(
        A.businessId,
        { name: `dup ${tag}` },
        [
          { color: "أحمر", size: "L", sku: `A-DUP1-${tag}` },
          { color: "أحمر", size: "L", sku: `A-DUP2-${tag}` }, // نفس اللون×المقاس
        ]
      )
    ).rejects.toThrow();
    // rollback: عدد المنتجات ما اتغيّرش، ومفيش منتج بالاسم ده
    expect(await countProducts(A.businessId)).toBe(before);
    const leaked = await getAllProducts(A.businessId, [A.businessId], { includeInactive: true });
    expect(leaked.some(p => p.name === `dup ${tag}`)).toBe(false);
  });

  it("🔑 تفرّد SKU داخل النشاط + العزل (نفس SKU حر في نشاط آخر)", async () => {
    const usedSku = `A-BLK-S-${tag}`; // من الاختبار الأول (نشاط A)
    const takenInA = await findTakenSkusInBusiness(A.businessId, [usedSku, `A-FREE-${tag}`]);
    expect(takenInA.has(usedSku.toLowerCase())).toBe(true);
    expect(takenInA.has(`a-free-${tag}`)).toBe(false);
    // نفس الـSKU مش مستخدم في نشاط B (عزل)
    const takenInB = await findTakenSkusInBusiness(B.businessId, [usedSku]);
    expect(takenInB.size).toBe(0);
  });

  it("🔑 عزل: تركيبات A مش ظاهرة في نطاق B", async () => {
    const aVars = await getAllVariantsWithProduct(undefined, [A.businessId], { includeInactive: true });
    const bVars = await getAllVariantsWithProduct(undefined, [B.businessId], { includeInactive: true });
    expect(aVars.some(v => v.sku === `A-BLK-S-${tag}`)).toBe(true);
    expect(bVars.some(v => v.sku === `A-BLK-S-${tag}`)).toBe(false);
    // نطاق فاضي → صفر (fail-closed من getAllProducts)
    expect((await getAllVariantsWithProduct(undefined, [], { includeInactive: true })).length).toBe(0);
  });

  it("🔑 المنتج البسيط لسه شغّال بلا انحدار (بلا تركيبات)", async () => {
    await createProduct({ businessId: A.businessId, name: `بسيط ${tag}`, sku: `A-SIMPLE-${tag}`, price: "50.00" } as any);
    const list = await getAllProducts(A.businessId, [A.businessId], { includeInactive: true });
    const simple = list.find(p => p.name === `بسيط ${tag}`);
    expect(simple).toBeTruthy();
    if (simple) {
      created.productIds.push(simple.id);
      expect((await getVariantsByProduct(simple.id, { includeInactive: true })).length).toBe(0);
    }
  });
});
