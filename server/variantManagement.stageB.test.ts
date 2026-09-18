import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  createProductWithVariants,
  addVariantsToProduct,
  addVariantInventoryMovement,
  updateVariant,
  deleteVariant,
  getVariantById,
  getVariantsByProduct,
  variantHasHistory,
  isSkuTakenInBusiness,
} from "./db";
import { products, productVariants, orders, inventoryMovements } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * المرحلة B (تكملة) — إدارة variants لمنتج قائم: تعديل، تعطيل/تفعيل، إضافة تركيبات جديدة فقط،
 * حماية التاريخ من الحذف، والمخزون يمرّ حصرًا من مسار الحركات المدقّق (مش تعديل بيانات الصنف).
 */
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const db = fs.readFileSync("server/db.ts", "utf-8");

describe("🔑 حراس المصدر — إدارة variants", () => {
  it("🔑 updateVariant بيشيل currentStock (مايتجاوزش سجل الحركات)", () => {
    const fn = db.slice(
      db.indexOf("export async function updateVariant"),
      db.indexOf("export async function updateVariant") + 700
    );
    expect(fn).toContain("const { currentStock: _ignored, ...safe } = data;");
    expect(fn).toContain(".set(safe)");
  });
  it("🔑 variants.create/update بيفحصوا SKU داخل النشاط (مش عالمي)", () => {
    expect(routers).toContain("isSkuTakenInBusiness(product.businessId, rest.sku)");
    expect(routers).toContain("excludeVariantId: id");
  });
  it("🔑 variants.addToProduct موجود + products.update بيمنع مخزون منتج له تركيبات", () => {
    expect(routers).toContain("addToProduct: adminProcedure");
    expect(routers).toContain("addVariantsToProduct(");
    expect(routers).toContain("عدّل المخزون من التركيبة نفسها");
  });
});

// ── سلوكي فعلي (matjarak_test) ──
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("🔑 إدارة variants سلوكي", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const created = { productIds: [] as number[], orderIds: [] as number[] };
  let prodA = 0;
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("mgmt-a");
    B = await createCoreTestFixture("mgmt-b");
    const res = await createProductWithVariants(
      A.businessId,
      { name: `منتج إدارة ${tag}` },
      [{ color: "أسود", size: "S", sku: `M-BLK-S-${tag}`, currentStock: 0 }]
    );
    prodA = res.productId;
    created.productIds.push(prodA);
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (created.orderIds.length) await d.delete(orders).where(inArray(orders.id, created.orderIds));
    if (created.productIds.length) {
      await d.delete(inventoryMovements).where(inArray(inventoryMovements.productId, created.productIds));
      await d.delete(productVariants).where(inArray(productVariants.productId, created.productIds));
      await d.delete(products).where(inArray(products.id, created.productIds));
    }
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔑 تعديل variant موجود (SKU/سعر/تكلفة/حد أدنى)", async () => {
    const [v] = await getVariantsByProduct(prodA, { includeInactive: true });
    await updateVariant(v.id, { sku: `M-EDIT-${tag}`, price: "150.00", minStockLevel: 9 });
    const after = await getVariantById(v.id);
    expect(after?.sku).toBe(`M-EDIT-${tag}`);
    expect(Number(after?.price)).toBe(150);
    expect(after?.minStockLevel).toBe(9);
  });

  it("🔑 تعطيل ثم إعادة تفعيل التركيبة", async () => {
    const [v] = await getVariantsByProduct(prodA, { includeInactive: true });
    await updateVariant(v.id, { isActive: false });
    expect((await getVariantById(v.id))?.isActive).toBe(false);
    await updateVariant(v.id, { isActive: true });
    expect((await getVariantById(v.id))?.isActive).toBe(true);
  });

  it("🔑 إضافة لون/مقاس جديد دون تكرار القديم", async () => {
    const before = (await getVariantsByProduct(prodA, { includeInactive: true })).length;
    const res = await addVariantsToProduct(prodA, [
      { color: "أسود", size: "S", sku: `DUP-${tag}` }, // موجود مسبقًا → يُتخطّى
      { color: "أبيض", size: "M", sku: `NEW-${tag}` }, // جديد → يُضاف
    ]);
    expect(res.createdIds.length).toBe(1);
    expect(res.skipped.length).toBe(1);
    const after = (await getVariantsByProduct(prodA, { includeInactive: true })).length;
    expect(after).toBe(before + 1);
  });

  it("🔑 تحديث المخزون يسجّل inventory movement؛ وتعديل الصنف مايغيّرش المخزون", async () => {
    const [v] = await getVariantsByProduct(prodA, { includeInactive: true });
    const start = (await getVariantById(v.id))!.currentStock;
    await addVariantInventoryMovement({
      variantId: v.id, type: "in", quantity: 7, reason: "purchase", performedBy: 1,
    });
    const afterMove = await getVariantById(v.id);
    expect(afterMove!.currentStock).toBe(start + 7);
    // اتسجّلت حركة فعلًا
    const d = await getDb();
    const moves = await d!
      .select().from(inventoryMovements)
      .where(eq(inventoryMovements.variantId, v.id));
    expect(moves.length).toBeGreaterThanOrEqual(1);
    expect(moves.some(m => m.performedBy === 1 && m.quantity === 7)).toBe(true);
    // تعديل بيانات الصنف بمحاولة تمرير currentStock → يتجاهله (مايتجاوزش السجل)
    await updateVariant(v.id, { currentStock: 999, price: "10.00" } as any);
    const afterEdit = await getVariantById(v.id);
    expect(afterEdit!.currentStock).toBe(start + 7); // ماتغيّرش
    expect(Number(afterEdit!.price)).toBe(10); // باقي الحقول اتعدّلت عادي
  });

  it("🔑 منع حذف variant مرتبط ببيانات تاريخية (soft delete — الصف يفضل)", async () => {
    const [v] = await getVariantsByProduct(prodA, { includeInactive: true });
    // له حركة مخزون من الاختبار السابق → له تاريخ
    expect(await variantHasHistory(v.id)).toBe(true);
    await deleteVariant(v.id);
    const row = await getVariantById(v.id); // الصف موجود (مش حذف نهائي)
    expect(row).toBeTruthy();
    expect(row?.isActive).toBe(false);
    // وحماية عبر أوردر مرتبط كمان
    const oid = insId(await (await getDb())!.insert(orders).values({
      businessId: A.businessId, orderNumber: `MV-${tag}`,
      customerName: "c", customerPhone: "01000000000", customerAddress: "a",
      governorate: "القاهرة", productName: "p", quantity: 1, totalAmount: "1.00",
      variantId: v.id,
    } as any));
    created.orderIds.push(oid);
    expect(await variantHasHistory(v.id)).toBe(true);
  });

  it("🔑 عزل SKU: نفس الـSKU مستخدم في A، حر في B", async () => {
    const usedInA = `NEW-${tag}`; // اتعمل في A
    expect(await isSkuTakenInBusiness(A.businessId, usedInA)).toBe(true);
    expect(await isSkuTakenInBusiness(B.businessId, usedInA)).toBe(false);
    // استثناء الصنف نفسه: تعديل التركيبة بنفس SKU بتاعها مايتحسبش تكرار
    const target = (await getVariantsByProduct(prodA, { includeInactive: true }))
      .find(v => v.sku === usedInA)!;
    expect(await isSkuTakenInBusiness(A.businessId, usedInA, { excludeVariantId: target.id })).toBe(false);
  });
});
