import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { omitCostFields, carriesCostValue, COST_FIELD_KEYS } from "./costVisibility";

/** BUG-01 — حذف حقول التكلفة من نواتج الـAPI لمن لا يملك inventory_costing.view، ومنع كتابتها. */
describe("omitCostFields", () => {
  it("يحذف costPrice من صفوف التركيبات ويبقي باقي الحقول", () => {
    const rows = [{ id: 1, sku: "A", price: "350.00", costPrice: "140.00" }, { id: 2, sku: "B", price: "320.00", costPrice: null }];
    expect(omitCostFields(rows)).toEqual([{ id: 1, sku: "A", price: "350.00" }, { id: 2, sku: "B", price: "320.00" }]);
  });
  it("يحذف لقطات التكلفة من بنود أوردر داخل الأوردر (عمق) ولا يلمس التواريخ", () => {
    const createdAt = new Date("2026-10-20T10:00:00Z");
    const order = { id: 9, createdAt, totalAmount: "700.00", items: [{ id: 1, unitPrice: "350.00", unitCostSnapshot: "140.0000", projectedUnitCostSnapshot: "141.0000", costCapturedAt: createdAt }] };
    const out = omitCostFields(order);
    expect(out).toEqual({ id: 9, createdAt, totalAmount: "700.00", items: [{ id: 1, unitPrice: "350.00" }] });
    expect(out.createdAt).toBeInstanceOf(Date);
  });
  it("يحذف التكلفة من الكتالوج { products, variants }", () => {
    const out = omitCostFields({ products: [{ id: 1, name: "أسورة" }], variants: [{ id: 5, productId: 1, costPrice: "99.00" }] });
    expect(out).toEqual({ products: [{ id: 1, name: "أسورة" }], variants: [{ id: 5, productId: 1 }] });
  });
  it("القيم الفارغة تمر كما هي", () => {
    expect(omitCostFields(undefined)).toBeUndefined();
    expect(omitCostFields(null)).toBeNull();
    expect(omitCostFields([])).toEqual([]);
  });
  it("لا يحذف تكلفة الشحن (ليست تكلفة مخزون)", () => {
    expect(omitCostFields({ projectedShippingCostSnapshot: "60.00" })).toEqual({ projectedShippingCostSnapshot: "60.00" });
    expect(COST_FIELD_KEYS).not.toContain("projectedShippingCostSnapshot");
  });
});

describe("carriesCostValue", () => {
  it("يكتشف costPrice في مدخل مباشر أو داخل variants", () => {
    expect(carriesCostValue({ id: 1, costPrice: 120 })).toBe(true);
    expect(carriesCostValue({ name: "x", variants: [{ color: "نحاسي" }, { color: "ذهبي", costPrice: 0 }] })).toBe(true);
  });
  it("المدخل بلا تكلفة أو بتكلفة undefined لا يُعتبر كتابة تكلفة", () => {
    expect(carriesCostValue({ id: 1, price: 350 })).toBe(false);
    expect(carriesCostValue({ id: 1, costPrice: undefined })).toBe(false);
    expect(carriesCostValue({ variants: [{ color: "نحاسي", price: 1 }] })).toBe(false);
  });
});

describe("BUG-01 — كل مسارات القراءة/الكتابة المكشوفة محمية (فحص ثابت)", () => {
  const code = readFileSync(resolve(__dirname, "routers.ts"), "utf8");
  const trpc = readFileSync(resolve(__dirname, "_core/trpc.ts"), "utf8");
  const block = (start: string, len = 1600) => { const i = code.indexOf(start); expect(i, start).toBeGreaterThan(-1); return code.slice(i, i + len); };
  it("variants.byProduct / all / get تمر على stripCostUnlessAllowed", () => {
    const v = block("    byProduct: protectedProcedure", 2400);
    expect(v.match(/stripCostUnlessAllowed\(ctx, await getVariantsByProduct/g)?.length).toBe(1);
    expect(v).toContain("stripCostUnlessAllowed(ctx, await getAllVariantsWithProduct(undefined, businessIds");
    expect(v).toContain('stripCostUnlessAllowed(ctx, await getVariantById(input.id))');
  });
  it("orders.get يمرر الأوردر وبنوده على الحذف", () => {
    expect(code).toContain("return stripCostUnlessAllowed(ctx, { ...order, items, contentChangedAfterShipment });");
  });
  it("orderItems (الإدارة والبوابة) + facebookEntry.myOrders/catalog/parsePaste/productVariants مغلّفة بـcostSafe", () => {
    expect(block("    orderItems: adminProcedure", 300)).toContain(".query(costSafe(async");
    // أسماء الحراس في هذا الإصدار: requireEmployeePermission / employeePortalProcedure.
    expect(block('    orderItems: requireEmployeePermission("orders.view")', 300)).toContain(".query(costSafe(async");
    expect(block("    catalog: employeePortalProcedure", 200)).toContain(".query(costSafe(async");
    expect(block("    parsePaste: employeePortalProcedure", 300)).toContain(".query(costSafe(async");
    expect(block("    productVariants: employeePortalProcedure", 300)).toContain(".query(costSafe(async");
    const portalMyOrders = code.indexOf("getOrderItemsForOrders(rows.map(o => o.id))");
    const header = code.lastIndexOf('    myOrders: requireEmployeePermission("orders.view")', portalMyOrders);
    expect(code.slice(header, portalMyOrders)).toContain(".query(costSafe(async");
  });
  it("مخزون البوابة (مفتوح لكل موظف): stockLevels/stockVariants/productsList/lowStockProducts تمر على stripCostUnlessAllowed", () => {
    expect(block("    stockLevels: employeePortalProcedure", 700)).toContain("return stripCostUnlessAllowed(ctx, await getAllProducts(undefined, businessIds));");
    expect(block("    stockVariants: employeePortalProcedure", 800)).toContain("return stripCostUnlessAllowed(ctx, await getAllVariantsWithProduct(undefined, businessIds));");
    expect(block("    productsList: employeePortalProcedure", 400)).toContain("return stripCostUnlessAllowed(ctx, await getAllProducts(emp.businessId ?? undefined));");
    expect(block("    lowStockProducts: employeePortalProcedure", 400)).toContain("return stripCostUnlessAllowed(ctx, await getLowStockProducts(emp.businessId ?? undefined));");
    // لا مسار آخر يرجّع تركيبات كاملة (كل الأعمدة) بلا حذف التكلفة
    expect(code.match(/return getAllVariantsWithProduct\(/g)).toBeNull();
    expect(code.match(/return getVariantsByProduct\(/g)).toBeNull();
    expect(code.match(/return getVariantById\(/g)).toBeNull();
  });
  it("كتابة التكلفة تحتاج inventory_costing.manage في الأربع مسارات", () => {
    expect(code.match(/await assertCanWriteCost\(ctx, input\);/g)?.length).toBe(4);
    expect(block("    createWithVariants: adminProcedure", 2200)).toContain("await assertCanWriteCost(ctx, input);");
  });
  it("permissionProcedure: المدير يخضع لتجاوزات الشركة في inventory_costing.*", () => {
    expect(trpc).toContain('if (ctx.employee?.role === "manager" && permission.startsWith("inventory_costing.")) {');
  });
});
