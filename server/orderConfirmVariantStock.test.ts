import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { eq, inArray, sql } from "drizzle-orm";
import {
  getDb, confirmOrder, createProductWithVariants, getVariantById, getVariantsByProduct, createEmployee,
} from "./db";
import { orders, products, productVariants, inventoryMovements, tenants, businesses, warehouses, employees } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * سياسة التأكيد: التأكيد **لا يُمنع أبدًا** بسبب المخزون. الخصم من **تركيبة** المنتج فقط عند
 * الكفاية (خصم كامل مرة واحدة، بلا سالب، بلا جزئي)؛ العجز/الالتباس/variant غير محلول →
 * يتأكّد بلا خصم مع needsReview + reviewReason. variantId=null يُحلّ بأمان (تطابق وحيد فقط،
 * بلا تخمين، بلا خصم من الأب). لا يمسّ نشاط الأسورة.
 */
const db = fs.readFileSync("server/db.ts", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");

// orders.orderNumber محدّد بـvarchar(20) في schema.ts. نولّد رقمًا فريدًا **داخل الحد**:
// بادئة قصيرة + طابع زمني base36 + عدّاد تصاعدي — يضمن التفرّد داخل التشغيل وبين التشغيلات
// بلا تجاوز الطول (بلا Date.now الطويل الخام). لا يمسّ schema/الإنتاج.
const ORDERNO_BASE = Date.now().toString(36).slice(-6); // 6 أحرف
let __orderSeq = 0;
function orderNo(prefix = "T"): string {
  __orderSeq += 1;
  const n = `${prefix}${ORDERNO_BASE}${__orderSeq}`;
  if (n.length > 20) throw new Error(`orderNumber test helper تجاوز 20: ${n}`);
  return n;
}

/**
 * الحقول اللي بنملأها صراحةً في insert الأوردر التجريبي. أي عمود NOT NULL بلا default في
 * جدول orders الفعلي **مش** في القائمة دي (drift زي createdBy/createdByName) بنكتشفه ديناميكيًا
 * ونملأه — عشان مانلعبش whack-a-mole مع كل تشغيل. (اختبار فقط — بلا تعديل schema/إنتاج.)
 */
const PROVIDED_ORDER_COLS = new Set([
  "id", "orderNumber", "businessId", "customerName", "customerPhone", "customerPhone2",
  "customerAddress", "governorate", "productId", "variantId", "productName", "quantity",
  "totalAmount", "status", "source", "color", "size", "notes", "createdBy", "createdByName",
  "createdAt", "updatedAt",
]);

/** أعمدة جدول orders الفعلية + الإلزامية الإضافية (drift) بقيم آمنة حسب النوع. */
async function inspectOrdersColumns(d: any): Promise<{ cols: Set<string>; extras: Record<string, any> }> {
  // d هو Drizzle DB (مش mysql2 خام) → نستخدم db.execute(sql`...`). نتيجة mysql2 = [rows, fields].
  const result = await d.execute(sql`
    SELECT COLUMN_NAME AS cn, DATA_TYPE AS dt, IS_NULLABLE AS nn, COLUMN_DEFAULT AS cd, EXTRA AS ex
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
  `);
  const rows = Array.isArray(result) ? result[0] : (result as unknown as any[]);
  const cols = new Set<string>();
  const extras: Record<string, any> = {};
  for (const r of rows as any[]) {
    cols.add(r.cn);
    const notNull = String(r.nn).toUpperCase() === "NO";
    const hasDefault = r.cd != null || /auto_increment|DEFAULT_GENERATED/i.test(String(r.ex || ""));
    if (!notNull || hasDefault || PROVIDED_ORDER_COLS.has(r.cn)) continue;
    const dt = String(r.dt).toLowerCase();
    extras[r.cn] = /int|decimal|numeric|double|float|bigint|tinyint|bit/.test(dt)
      ? 1
      : /date|time|year/.test(dt) ? new Date() : "test";
  }
  return { cols, extras };
}

describe("🔑 حراس المصدر — سياسة تأكيد/خصم المخزون", () => {
  const fn = db.slice(db.indexOf("export async function confirmOrder"), db.indexOf("export async function postponeOrder"));
  it("🔑 التأكيد لا يرمي بسبب المخزون؛ خصم عند الكفاية فقط", () => {
    expect(fn).toContain("v.currentStock >= qty"); // خصم التركيبة داخل confirmOrder
    expect(db).toContain("p.currentStock >= qty"); // خصم الأب داخل deductParentOnConfirm
    // عند العجز: تعليم مراجعة بلا خصم (بلا throw)
    expect(fn).toContain("عجز مخزون: المطلوب");
    expect(db).toContain("عجز مخزون: المطلوب");
  });
  it("🔑 يحلّ variantId=null بأمان ويحفظه؛ ملتبس/غير موجود → مراجعة بلا تخمين", () => {
    expect(fn).toContain("resolveOrderVariantInTx(tx, order)");
    expect(fn).toContain("الصنف/اللون/المقاس يحتاج مراجعة");
    expect(fn).toContain("variantId: resolvedVariantId");
  });
  it("🔑 idempotent: التأكيد المكرر بيرجع بدري بلا خصم", () => {
    expect(fn).toContain('if (order.status === "confirmed")');
  });
  it("🔑 خصم من التركيبة (product_variants) مش الأب للمنتجات متعددة الخيارات", () => {
    expect(fn).toContain("update(productVariants)");
    expect(fn).toContain("currentStock: sql`${productVariants.currentStock} - ${qty}`");
  });
  it("🔑 الراوتر بيرجّع رسالة نجاح مع تنويه العجز (مش فشل)", () => {
    expect(routers).toContain("تم تأكيد الأوردر، ويوجد عجز مخزون يحتاج مراجعة.");
  });
  it("🔒 فرع Legacy (الأساور) بالـslug → خصم من الأب، بلا لمس التركيبات", () => {
    expect(db).toContain('const LEGACY_TENANT_SLUG = "legacy-default"');
    expect(fn).toContain("isLegacyTenant");
    expect(fn).toContain("tenantRow?.slug === LEGACY_TENANT_SLUG");
    expect(fn).toContain("deductParentOnConfirm(tx, order, qty, updatedBy)");
    // فرع legacy مايلمسش product_variants (الخصم من الأب فقط عبر الـhelper).
    const legacyBlock = fn.slice(fn.indexOf("if (isLegacyTenant)"), fn.indexOf("} else {", fn.indexOf("if (isLegacyTenant)")));
    expect(legacyBlock).not.toContain("productVariants");
  });
});

const RUN = Boolean(process.env.TEST_DATABASE_URL);
describe.runIf(RUN)("🔑 تأكيد/خصم — سلوكي (matjarak_test)", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const ids = { productIds: [] as number[], orderIds: [] as number[] };
  let prodA = 0, v10 = 0, vBeg = 0, prodB = 0, vB = 0;
  let empA = 0, empB = 0; // موظفو fixture حقيقيون في نفس النشاط (لـcreatedBy/updatedBy)
  let ordCols = new Set<string>();
  let ordExtras: Record<string, any> = {};
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

  async function makeOrder(fields: any) {
    const d = await getDb(); if (!d) return 0;
    const bid = fields.businessId;
    const empId = bid === B?.businessId ? empB : empA; // موظف نفس النشاط
    const base: any = {
      orderNumber: orderNo("C"),
      customerName: "c", customerPhone: "01000000000", customerAddress: "عنوان تفصيلي كافٍ",
      governorate: "القاهرة", quantity: 1, totalAmount: "100.00", status: "new",
      source: "manual", productName: "x",
    };
    // drift: لو جدول orders الفعلي فيه createdBy/createdByName NOT NULL، نملأهم بموظف حقيقي.
    if (ordCols.has("createdBy")) base.createdBy = empId;
    if (ordCols.has("createdByName")) base.createdByName = "test-emp";
    const id = insId(await d.insert(orders).values({ ...ordExtras, ...base, ...fields } as any));
    ids.orderIds.push(id);
    return id;
  }
  const orderRow = async (id: number) => (await (await getDb())!.select().from(orders).where(eq(orders.id, id)))[0];

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("cfmA");
    B = await createCoreTestFixture("cfmB");
    ({ cols: ordCols, extras: ordExtras } = await inspectOrdersColumns(d));
    empA = insId(await createEmployee({ name: "empA", role: "order_confirmation", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `empA_${tag}` } as any));
    empB = insId(await createEmployee({ name: "empB", role: "order_confirmation", isActive: true, tenantId: B.tenantId, businessId: B.businessId, username: `empB_${tag}` } as any));
    const ra = await createProductWithVariants(A.businessId, { name: `ملابس اطفالي ${tag}` }, [
      { color: "أسود", size: "10", sku: `AFK-BLK-10-${tag}`, currentStock: 10 }, // للخصم العادي + العجز
      { color: "بيج", size: "12", sku: `AFK-BEG-12-${tag}`, currentStock: 0 },  // مخزون صفر
    ]);
    prodA = ra.productId; ids.productIds.push(prodA);
    const va = await getVariantsByProduct(prodA, { includeInactive: true });
    v10 = va.find(v => v.sku === `AFK-BLK-10-${tag}`)!.id;
    vBeg = va.find(v => v.sku === `AFK-BEG-12-${tag}`)!.id;
    const rb = await createProductWithVariants(B.businessId, { name: `أسورة ${tag}` }, [
      { color: "ذهبي", size: "M", sku: `BR-${tag}`, currentStock: 20 },
    ]);
    prodB = rb.productId; ids.productIds.push(prodB);
    vB = (await getVariantsByProduct(prodB, { includeInactive: true }))[0].id;
  });
  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (ids.orderIds.length) {
      await d.delete(inventoryMovements).where(inArray(inventoryMovements.orderId, ids.orderIds));
      await d.delete(orders).where(inArray(orders.id, ids.orderIds));
    }
    if (ids.productIds.length) {
      await d.delete(inventoryMovements).where(inArray(inventoryMovements.productId, ids.productIds));
      await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds));
      await d.delete(products).where(inArray(products.id, ids.productIds));
    }
    if (empA || empB) await d.delete(employees).where(inArray(employees.id, [empA, empB].filter(Boolean)));
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔑 مخزون 10 طلب 1 → يتأكد ويصبح 9، بلا مراجعة", async () => {
    const oid = await makeOrder({ businessId: A.businessId, productId: prodA, variantId: v10, color: "اسود", size: "10", quantity: 1 });
    const r = await confirmOrder(oid, 1, "t");
    expect((await getVariantById(v10))!.currentStock).toBe(9);
    expect(r.stockShortfall).toBe(false);
    expect((await orderRow(oid)).status).toBe("confirmed");
  });

  it("🔑 مخزون 0 طلب 1 → يتأكد، يظل 0، needsReview=true", async () => {
    const oid = await makeOrder({ businessId: A.businessId, productId: prodA, variantId: vBeg, color: "بيج", size: "12", quantity: 1 });
    const r = await confirmOrder(oid, 1, "t");
    expect((await getVariantById(vBeg))!.currentStock).toBe(0);
    const o = await orderRow(oid);
    expect(o.status).toBe("confirmed");
    expect(o.needsReview).toBe(true);
    expect(o.reviewReason).toContain("عجز مخزون");
    expect(r.stockShortfall).toBe(true);
  });

  it("🔑 مخزون 1 طلب 2 → يتأكد، يظل بلا خصم جزئي، عجز مسجّل", async () => {
    // نضبط v10 على 1 عبر أوردر يخصم 8 (9→1) ثم نطلب 2
    const drain = await makeOrder({ businessId: A.businessId, productId: prodA, variantId: v10, color: "اسود", size: "10", quantity: 8 });
    await confirmOrder(drain, 1, "t"); // 9 → 1
    expect((await getVariantById(v10))!.currentStock).toBe(1);
    const oid = await makeOrder({ businessId: A.businessId, productId: prodA, variantId: v10, color: "اسود", size: "10", quantity: 2 });
    const r = await confirmOrder(oid, 1, "t");
    expect((await getVariantById(v10))!.currentStock).toBe(1); // بلا خصم جزئي
    const o = await orderRow(oid);
    expect(o.status).toBe("confirmed");
    expect(o.reviewReason).toContain("المطلوب 2 والمتاح 1");
    expect(r.stockShortfall).toBe(true);
  });

  it("🔑 variantId=null غير قابل للمطابقة → يتأكد بلا خصم + needsReview بلا تخمين", async () => {
    const before10 = (await getVariantById(v10))!.currentStock;
    const oid = await makeOrder({ businessId: A.businessId, productId: prodA, variantId: null, color: null, size: null });
    const r = await confirmOrder(oid, 1, "t");
    const o = await orderRow(oid);
    expect(o.status).toBe("confirmed");
    expect(o.needsReview).toBe(true);
    expect(o.reviewReason).toContain("مراجعة");
    expect((await getVariantById(v10))!.currentStock).toBe(before10); // مفيش خصم من أي تركيبة
    expect(r.stockShortfall).toBe(true);
  });

  it("🔑 variantId=null قابل للحل (لون+مقاس وحيد) → يُحفظ الـvariant ويُخصم", async () => {
    const before = (await getVariantById(v10))!.currentStock;
    const oid = await makeOrder({ businessId: A.businessId, productId: prodA, variantId: null, color: "أسود", size: "من 5 إلى 10 سنين" });
    await confirmOrder(oid, 1, "t");
    expect((await getVariantById(v10))!.currentStock).toBe(before - 1);
    expect((await orderRow(oid)).variantId).toBe(v10); // اتحفظ
  });

  it("🔑 ضغط متكرر لا يخصم مرتين ولا يكرر الحركة", async () => {
    // مستقل عن ترتيب الاختبارات: نضبط مخزون التركيبة لقيمة كافية معروفة (إعداد مباشر، مش عبر
    // التأكيد) عشان التأكيد الأول يخصم فعلًا، فنُثبت أن الضغط الثاني ما يخصمش/ما يكررش الحركة.
    const d = await getDb();
    await d!.update(productVariants).set({ currentStock: 5 }).where(eq(productVariants.id, v10));
    const before = (await getVariantById(v10))!.currentStock; // = 5
    const oid = await makeOrder({ businessId: A.businessId, productId: prodA, variantId: v10, color: "اسود", size: "10", quantity: 1 });
    await confirmOrder(oid, 1, "t");
    await confirmOrder(oid, 1, "t");
    expect((await getVariantById(v10))!.currentStock).toBe(before - 1);
    const moves = await d!.select().from(inventoryMovements).where(eq(inventoryMovements.orderId, oid));
    expect(moves.length).toBe(1);
  });

  it("🔒 عزل: أوردر منتج A بـvariantId لتركيبة الأسورة B → لا خصم من B، يتأكد + مراجعة", async () => {
    const beforeB = (await getVariantById(vB))!.currentStock;
    const oid = await makeOrder({ businessId: A.businessId, productId: prodA, variantId: vB, color: "ذهبي", size: "M" });
    const r = await confirmOrder(oid, 1, "t");
    // الحارس v.productId !== order.productId → بلا خصم عابر؛ مخزون الأسورة ثابت.
    expect((await getVariantById(vB))!.currentStock).toBe(beforeB);
    const o = await orderRow(oid);
    expect(o.status).toBe("confirmed");
    expect(o.needsReview).toBe(true);
    expect(r.stockShortfall).toBe(true);
  });
});

// ── مسار الأساور/Legacy: الخصم من الأب فقط، بلا لمس التركيبات (matjarak_test) ──
describe.runIf(RUN)("🔒 مسار Legacy (الأساور) — خصم من الأب مش التركيبات", () => {
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  const tag = Date.now();
  let legacyTenantId = 0, createdLegacyTenant = false, bizId = 0, whId = 0, prodId = 0, varId = 0, empLeg = 0;
  let ordCols = new Set<string>();
  let ordExtras: Record<string, any> = {};
  const cleanupOrderIds: number[] = [];

  async function mkLegOrder(quantity: number): Promise<number> {
    const d = await getDb();
    const base: any = {
      orderNumber: orderNo("L"), businessId: bizId,
      customerName: "c", customerPhone: "01000000000", customerAddress: "عنوان تفصيلي كافٍ",
      governorate: "القاهرة", productId: prodId, variantId: varId, quantity, totalAmount: "1.00",
      status: "new", source: "manual", productName: "أسورة",
    };
    if (ordCols.has("createdBy")) base.createdBy = empLeg;
    if (ordCols.has("createdByName")) base.createdByName = "test-emp";
    const oid = insId(await d!.insert(orders).values({ ...ordExtras, ...base } as any));
    cleanupOrderIds.push(oid);
    return oid;
  }

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    ({ cols: ordCols, extras: ordExtras } = await inspectOrdersColumns(d));
    const existing = (await d.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, "legacy-default")))[0];
    if (existing) { legacyTenantId = existing.id; }
    else {
      legacyTenantId = insId(await d.insert(tenants).values({ name: "Legacy", slug: "legacy-default", status: "active" } as any));
      createdLegacyTenant = true;
    }
    bizId = insId(await d.insert(businesses).values({ tenantId: legacyTenantId, name: `LegBiz ${tag}`, slug: `legbiz-${tag}`.slice(0,50), baseCurrency: "EGP", timezone: "Africa/Cairo" } as any));
    whId = insId(await d.insert(warehouses).values({ businessId: bizId, name: "wh" } as any));
    await d.update(businesses).set({ defaultWarehouseId: whId }).where(eq(businesses.id, bizId));
    empLeg = insId(await createEmployee({ name: "empLeg", role: "order_confirmation", isActive: true, tenantId: legacyTenantId, businessId: bizId, username: `empLeg_${tag}` } as any));
    // منتج أساور: مخزون على الأب (100) + تركيبة لها مخزون (50) — زي بيانات الإنتاج.
    prodId = insId(await d.insert(products).values({ businessId: bizId, name: `أسورة نحاس ${tag}`, sku: `BR-P-${tag}`, price: "100.00", currentStock: 100 } as any));
    varId = insId(await d.insert(productVariants).values({ productId: prodId, name: "سادة", sku: `BR-V-${tag}`, price: "100.00", color: null, size: null, currentStock: 50, isActive: true } as any));
  });
  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (cleanupOrderIds.length) {
      await d.delete(inventoryMovements).where(inArray(inventoryMovements.orderId, cleanupOrderIds));
      await d.delete(orders).where(inArray(orders.id, cleanupOrderIds));
    }
    await d.delete(inventoryMovements).where(eq(inventoryMovements.productId, prodId));
    await d.delete(productVariants).where(eq(productVariants.productId, prodId));
    await d.delete(products).where(eq(products.id, prodId));
    if (empLeg) await d.delete(employees).where(eq(employees.id, empLeg));
    await d.delete(warehouses).where(eq(warehouses.id, whId));
    await d.delete(businesses).where(eq(businesses.id, bizId));
    if (createdLegacyTenant) await d.delete(tenants).where(eq(tenants.id, legacyTenantId));
  });

  it("🔒 أوردر أساور (حتى بـvariantId) يخصم من الأب فقط، والتركيبة ثابتة", async () => {
    const d = await getDb();
    const oid = await mkLegOrder(2);
    await confirmOrder(oid, empLeg, "t");
    const [p] = await d!.select().from(products).where(eq(products.id, prodId));
    const [v] = await d!.select().from(productVariants).where(eq(productVariants.id, varId));
    expect(p.currentStock).toBe(98);   // الأب: 100 → 98 (خصم 2)
    expect(v.currentStock).toBe(50);   // التركيبة ثابتة — مسار الأساور ما لمسهاش
  });

  it("🔒 نفاد مخزون الأب في legacy لا يمنع التأكيد ولا يخصم سالب", async () => {
    const d = await getDb();
    const oid = await mkLegOrder(100000);
    const r = await confirmOrder(oid, empLeg, "t");
    const [p] = await d!.select().from(products).where(eq(products.id, prodId));
    const [o] = await d!.select().from(orders).where(eq(orders.id, oid));
    expect(o.status).toBe("confirmed");
    expect(p.currentStock).toBe(98);   // بلا خصم (عجز) — مش سالب
    expect(r.stockShortfall).toBe(true);
  });
});
