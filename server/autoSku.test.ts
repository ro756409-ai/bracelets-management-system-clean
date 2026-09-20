import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb, getVariantsByProduct } from "./db";
import { products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * الـSKU اختياري عند إنشاء منتج/تركيبات.
 *
 * كان إجباريًا في الواجهة والـzod، فإنشاء منتج ملابس كامل بيتوقف على رسالة «تركيبة
 * اسود 6 بلا SKU» — والتاجر مالوش أي رمز يكتبه. الرمز لسه مطلوب **داخليًا** (المسح
 * بالكاميرا وتفرّد التركيبة داخل النشاط)، فالسيرفر بيولّده: بادئة `AUTO-` ومتحقَّق
 * من تفرّده في القاعدة مع إعادة محاولة.
 */

const routers = fs.readFileSync("server/routers.ts", "utf-8");
const dbSrc = fs.readFileSync("server/db.ts", "utf-8");
const inventory = fs.readFileSync("client/src/pages/Inventory.tsx", "utf-8");

describe("🔑 حراس المصدر — SKU اختياري", () => {
  it("🔑 الـzod مابيفرضش SKU في أي مسار إنشاء", () => {
    expect(routers).not.toContain('sku: z.string().min(1, "رمز المنتج (SKU) مطلوب")');
    expect(routers).toContain("sku: z.string().optional()");
  });
  it("🔑 التوليد على السيرفر ومتحقَّق من القاعدة", () => {
    expect(dbSrc).toContain("export async function generateVariantSkus");
    expect(dbSrc).toContain("findTakenSkusInBusiness(businessId, batch)");
    expect(dbSrc).toContain("AUTO-");
    expect(routers).toContain("generateVariantSkus(");
  });
  it("🔑 الواجهة مابتوقفش الحفظ على SKU", () => {
    expect(inventory).not.toContain("بلا SKU");
    expect(inventory).not.toContain('toast.error("رمز المنتج (SKU) مطلوب")');
    expect(inventory).toContain("sku: r.sku.trim() || undefined");
  });
});

const CAN_DB = Boolean(process.env.TEST_DATABASE_URL);

describe.runIf(CAN_DB)("🔑 SKU التلقائي — سلوكي", () => {
  let A: CoreTestFixture;
  const tag = Date.now();
  const created: number[] = [];
  const caller = () =>
    appRouter.createCaller({
      user: { id: 1, role: "admin", name: "owner" },
      employee: null,
      tenantId: null,
      req: { protocol: "https", headers: {}, cookies: {} },
      res: { clearCookie: () => {}, cookie: () => {} },
    } as any);

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("sku-a");
  });
  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (created.length) {
      await d.delete(productVariants).where(inArray(productVariants.productId, created));
      await d.delete(products).where(inArray(products.id, created));
    }
    await A?.cleanup();
  });

  /** ctx بجلسة مالك على نفس الـtenant بتاع الـfixture. */
  const ownerCaller = () =>
    appRouter.createCaller({
      user: { id: 1, role: "admin", name: "owner" },
      employee: null,
      tenantId: A.tenantId,
      req: { protocol: "https", headers: {}, cookies: {} },
      res: { clearCookie: () => {}, cookie: () => {} },
    } as any);

  it("🔑 إنشاء منتج متعدد الخيارات **بلا أي SKU** ينجح", async () => {
    const res = await ownerCaller().products.createWithVariants({
      businessId: A.businessId,
      name: `بدلة اطفالي ${tag}`,
      variants: [
        { color: "اسود", size: "6", currentStock: 0, minStockLevel: 5 },
        { color: "اسود", size: "8", currentStock: 0, minStockLevel: 5 },
        { color: "بيج", size: "10", currentStock: 0, minStockLevel: 5 },
      ],
    } as any);
    created.push(res.productId);
    const vs = await getVariantsByProduct(res.productId, { includeInactive: true });
    expect(vs).toHaveLength(3);
    // 🔑 كل تركيبة ليها SKU مولَّد وفريد
    expect(vs.every(v => (v.sku ?? "").startsWith("AUTO-"))).toBe(true);
    expect(new Set(vs.map(v => v.sku)).size).toBe(3);
    // واللون والمقاس محفوظين زي ما هما
    expect(vs.map(v => `${v.color}/${v.size}`).sort()).toEqual(
      ["اسود/6", "اسود/8", "بيج/10"].sort()
    );
  });

  it("🔑 الـSKU اليدوي بيتحفظ زي ما التاجر كتبه (بعد trim)", async () => {
    const res = await ownerCaller().products.createWithVariants({
      businessId: A.businessId,
      name: `منتج يدوي ${tag}`,
      variants: [
        { color: "أحمر", size: "M", sku: `  MAN-${tag}  `, currentStock: 0, minStockLevel: 5 },
        { color: "أزرق", size: "L", currentStock: 0, minStockLevel: 5 },
      ],
    } as any);
    created.push(res.productId);
    const vs = await getVariantsByProduct(res.productId, { includeInactive: true });
    const manual = vs.find(v => v.color === "أحمر");
    const auto = vs.find(v => v.color === "أزرق");
    expect(manual?.sku).toBe(`MAN-${tag}`);
    expect(auto?.sku?.startsWith("AUTO-")).toBe(true);
  });

  it("🔒 SKU مكرر يدويًا يُرفض برسالة واضحة", async () => {
    const dup = `DUP-${tag}`;
    const first = await ownerCaller().products.createWithVariants({
      businessId: A.businessId,
      name: `منتج مكرر أ ${tag}`,
      variants: [{ color: "أخضر", size: "S", sku: dup, currentStock: 0, minStockLevel: 5 }],
    } as any);
    created.push(first.productId);

    await expect(
      ownerCaller().products.createWithVariants({
        businessId: A.businessId,
        name: `منتج مكرر ب ${tag}`,
        variants: [{ color: "أصفر", size: "S", sku: dup, currentStock: 0, minStockLevel: 5 }],
      } as any)
    ).rejects.toThrow(/مستخدم بالفعل في هذا النشاط/);
  });

  it("🔒 تكرار داخل نفس الدفعة يُرفض", async () => {
    const same = `SAME-${tag}`;
    await expect(
      ownerCaller().products.createWithVariants({
        businessId: A.businessId,
        name: `دفعة مكررة ${tag}`,
        variants: [
          { color: "أبيض", size: "S", sku: same, currentStock: 0, minStockLevel: 5 },
          { color: "أسود", size: "M", sku: same, currentStock: 0, minStockLevel: 5 },
        ],
      } as any)
    ).rejects.toThrow(/مكرر داخل التركيبات/);
  });

  it("🔑 اسم التركيبة البشري من الأبعاد — مش الـSKU المولَّد", async () => {
    const res = await ownerCaller().products.createWithVariants({
      businessId: A.businessId,
      name: `منتج عرض ${tag}`,
      variants: [{ color: "بيج", size: "10", currentStock: 0, minStockLevel: 5 }],
    } as any);
    created.push(res.productId);
    const [v] = await getVariantsByProduct(res.productId, { includeInactive: true });
    // `name` فاضي — الوصف بيتركّب من اللون والمقاس، والـSKU داخلي مش معروض كنوع
    expect(v.name ?? "").toBe("");
    expect([v.color, v.size].filter(Boolean).join(" / ")).toBe("بيج / 10");
    expect(v.sku?.startsWith("AUTO-")).toBe(true);
  });
});
