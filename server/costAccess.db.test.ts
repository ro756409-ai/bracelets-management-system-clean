import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * BUG-01 — تكلفة المخزون (costPrice + لقطات تكلفة بنود الأوردر) لا تُقرأ ولا تُكتب بلا صلاحية:
 * المالك والمحاسب يرونها؛ المدير بالافتراضي يراها ويكتبها، والسحب لشركته يمنع فورًا (حتى بجلسة
 * الـadmin الصناعية)؛ الوكيل والمخزن وإدخال فيسبوك لا يرونها في أي مسار. وعزل الشركات كما هو.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const as = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const COST_KEYS = ["costPrice", "unitCostSnapshot", "projectedUnitCostSnapshot", "costCapturedAt"];
function hasCost(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasCost);
  if (v && typeof v === "object" && !(v instanceof Date)) return Object.entries(v as any).some(([k, x]) => COST_KEYS.includes(k) || hasCost(x));
  return false;
}

describe.runIf(CAN)("💰 BUG-01 — صلاحيات تكلفة المخزون على كل المسارات", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const emp: Record<string, number> = {};
  let variantA = 0, variantB = 0, orderA = 0, fbOrderA = 0;
  const q = (sql: string, p: any[] = []) => tmp.raw.query(sql, p);
  const override = (tenantId: number, role: string, permission: string, allowed: boolean) =>
    q("INSERT INTO tenant_role_permissions (tenantId, role, permission, isAllowed, updatedBy) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE isAllowed = VALUES(isAllowed)", [tenantId, role, permission, allowed ? 1 : 0, emp.ownerA]);
  const clear = (tenantId: number, role: string) => q("DELETE FROM tenant_role_permissions WHERE tenantId = ? AND role = ?", [tenantId, role]);

  beforeAll(async () => {
    tmp = await createTempSchema("cost_acl");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("cost-a"); B = await createCoreTestFixture("cost-b");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { emp[k] = insId(await createEmployee({ name: `${k}-c`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("ownerB", "super_admin", B); await mk("accA", "accountant", A); await mk("mgrA", "manager", A);
    await mk("agentA", "agent", A); await mk("whA", "warehouse", A); await mk("fbA", "facebook_entry", A);
    variantA = insId(await q("INSERT INTO product_variants (productId, name, price, costPrice, currentStock) VALUES (?, 'نقش A', 250, 90, 10)", [A.productId]));
    variantB = insId(await q("INSERT INTO product_variants (productId, name, price, costPrice, currentStock) VALUES (?, 'نقش B', 260, 77, 10)", [B.productId]));
    const n = String(Date.now() % 1_000_000);
    orderA = insId(await q("INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, totalAmount, status, source, assignedEmployeeId) VALUES (?, ?, 'عميل', '01000000000', 'عنوان كامل للاختبار', 'القاهرة', 'أسورة', '250.00', 'new', 'manual', ?)", [A.businessId, `CA-${n}`, emp.agentA]));
    fbOrderA = insId(await q("INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, totalAmount, status, source, lastUpdatedBy) VALUES (?, ?, 'عميل', '01000000001', 'عنوان كامل للاختبار', 'القاهرة', 'أسورة', '250.00', 'new', 'facebook', ?)", [A.businessId, `CF-${n}`, emp.fbA]));
    for (const id of [orderA, fbOrderA])
      await q("INSERT INTO order_items (orderId, productId, variantId, productName, quantity, unitPrice, unitCostSnapshot, projectedUnitCostSnapshot) VALUES (?, ?, ?, 'أسورة', 1, '250.00', '90.0000', '90.0000')", [id, A.productId, variantA]);
  }, 240_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("variants.all: المالك والمحاسب والمدير يرون التكلفة؛ الوكيل والمخزن وإدخال فيسبوك لا", async () => {
    for (const k of ["ownerA", "accA", "mgrA"]) {
      const rows = (await (await as(emp[k])).variants.all()) as any[];
      expect(rows.find(r => r.id === variantA)?.costPrice, k).toBeDefined();
    }
    for (const k of ["agentA", "whA", "fbA"]) {
      const rows = (await (await as(emp[k])).variants.all()) as any[];
      expect(rows.some(r => r.id === variantA), k).toBe(true);
      expect(hasCost(rows), k).toBe(false);
    }
  });

  it("المدير المسحوب منه inventory_costing.view: بلا تكلفة في variants.all/get/byProduct وorders.get وorderItems", async () => {
    await override(A.tenantId, "manager", "inventory_costing.view", false);
    const m = await as(emp.mgrA);
    expect(hasCost(await m.variants.all())).toBe(false);
    const one = await m.variants.get({ id: variantA });
    expect(one?.id).toBe(variantA); expect(hasCost(one)).toBe(false);
    expect(hasCost(await m.variants.byProduct({ productId: A.productId }))).toBe(false);
    const o = await m.orders.get({ id: orderA });
    expect((o as any)?.items?.length).toBe(1); expect(hasCost(o)).toBe(false);
    expect(hasCost(await m.orders.orderItems({ orderId: orderA }))).toBe(false);
    // شاشات التكلفة المحمية بالصلاحية نفسها ممنوعة عليه بعد السحب (كانت تعدّي بجلسة الـadmin الصناعية)
    expect(await code(() => m.accountingV2.stocktakeList({ businessId: A.businessId }))).toBe("FORBIDDEN");
    await clear(A.tenantId, "manager");
    // الافتراضي رجع: يرى التكلفة ويفتح الشاشة
    expect(hasCost(await (await as(emp.mgrA)).orders.get({ id: orderA }))).toBe(true);
    expect(await code(async () => (await as(emp.mgrA)).accountingV2.stocktakeList({ businessId: A.businessId }))).toBe("ok");
  });

  it("المالك يرى لقطات التكلفة في orders.get وorderItems", async () => {
    const o = await (await as(emp.ownerA)).orders.get({ id: orderA });
    expect(Number((o as any).items[0].unitCostSnapshot)).toBe(90);
    // orderItems الإداري يختار حقولًا محددة أصلًا (بلا تكلفة) — يكفي إنه يشتغل للمالك.
    const it = (await (await as(emp.ownerA)).orders.orderItems({ orderId: orderA })) as any;
    expect(it.items.length).toBe(1);
  });

  it("البوابة وشاشة الإدخال: catalog وproductVariants وorderItems وmyOrders بلا تكلفة للوكيل وإدخال فيسبوك", async () => {
    const agent = await as(emp.agentA);
    const cat = await agent.facebookEntry.catalog();
    expect((cat as any).variants.some((v: any) => v.id === variantA)).toBe(true);
    expect(hasCost(cat)).toBe(false);
    expect(hasCost(await agent.facebookEntry.productVariants({ productId: A.productId }))).toBe(false);
    const items = await agent.employeePortal.orderItems({ orderId: orderA });
    expect(hasCost(items)).toBe(false);
    const fb = await as(emp.fbA);
    const mine = (await fb.facebookEntry.myOrders({} as any)) as any[];
    expect(mine.find(o => o.id === fbOrderA)?.items?.length).toBe(1);
    expect(hasCost(mine)).toBe(false);
    expect(hasCost(await fb.facebookEntry.catalog())).toBe(false);
  });

  it("كتابة التكلفة: المدير بالافتراضي يكتب؛ بعد سحب inventory_costing.manage يُرفض، والتعديل بلا تكلفة يعدّي", async () => {
    const m = await as(emp.mgrA);
    expect(await code(() => m.variants.update({ id: variantA, costPrice: 95 }))).toBe("ok");
    await override(A.tenantId, "manager", "inventory_costing.manage", false);
    expect(await code(() => m.variants.update({ id: variantA, costPrice: 99 }))).toBe("FORBIDDEN");
    expect(await code(() => m.variants.update({ id: variantA, minStockLevel: 4 }))).toBe("ok");
    expect(await code(() => m.variants.create({ productId: A.productId, name: "جديد", costPrice: 10 } as any))).toBe("FORBIDDEN");
    expect(await code(() => m.variants.addToProduct({ productId: A.productId, variants: [{ color: "أزرق", costPrice: 10 }] } as any))).toBe("FORBIDDEN");
    expect(await code(() => m.products.createWithVariants({ name: "منتج جديد", businessId: A.businessId, variants: [{ color: "أحمر", costPrice: 5 }] } as any))).toBe("FORBIDDEN");
    const [[row]] = (await q("SELECT costPrice FROM product_variants WHERE id = ?", [variantA])) as any;
    expect(Number(row.costPrice)).toBe(95);
    await clear(A.tenantId, "manager");
    expect(await code(async () => (await as(emp.ownerA)).variants.update({ id: variantA, costPrice: 90 }))).toBe("ok");
  });

  it("عزل الشركات كما هو: لا تركيبات ولا أوردرات الشركة الأخرى", async () => {
    const a = (await (await as(emp.ownerA)).variants.all()) as any[];
    expect(a.some(r => r.id === variantB)).toBe(false);
    const b = (await (await as(emp.ownerB)).variants.all()) as any[];
    expect(b.find(r => r.id === variantB)?.costPrice).toBeDefined();
    expect(b.some(r => r.id === variantA)).toBe(false);
    expect(await code(async () => (await as(emp.ownerB)).variants.get({ id: variantA }))).not.toBe("ok");
    expect(await code(async () => (await as(emp.ownerB)).orders.get({ id: orderA }))).not.toBe("ok");
  });
});
