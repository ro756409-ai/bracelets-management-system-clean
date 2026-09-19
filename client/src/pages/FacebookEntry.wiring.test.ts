import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * شاشة الإدخال variant-based: منتج←لون←مقاس←كمية من المخزون، بلا أي منطق قديم للإسورة.
 * حراس نصّية (بيئة node) زي باقي حراس الواجهة.
 */
const page = fs.readFileSync("client/src/pages/FacebookEntry.tsx", "utf-8");
const picker = fs.readFileSync("client/src/components/orders/VariantOrderPicker.tsx", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");

describe("🔑 شاشة الإدخال — variant-based", () => {
  it("🔑 بتستخدم VariantOrderPicker والكتالوج المعزول", () => {
    expect(page).toContain("VariantOrderPicker");
    expect(page).toContain("trpc.facebookEntry.catalog.useQuery");
  });

  it("🔑 اتشال منطق الإسورة/الووتر/اللصق القديم", () => {
    for (const legacy of [
      "WATERPROOF_PRODUCT_ID", "نوع الحفر", "parseOrder", "waterproofVariants",
      "confidenceTone", "عدد الأساور",
    ]) {
      expect(page, legacy).not.toContain(legacy);
    }
  });

  it("🔑 الإرسال بيحمل variantId وسعر الوحدة لكل صنف", () => {
    const sub = page.slice(page.indexOf("function buildSelectedProducts"), page.indexOf("function buildSelectedProducts") + 400);
    expect(sub).toContain("variantId: it.variantId");
    expect(sub).toContain("unitPrice: it.unitPrice");
  });

  it("🔑 الترتيب منتج←لون←مقاس، والمقاسات بتتفلتر حسب اللون", () => {
    expect(picker).toContain('data-testid="vop-product"');
    expect(picker).toContain('data-testid="vop-color"');
    expect(picker).toContain('data-testid="vop-size"');
    // المقاسات = تركيبات اللون المختار فقط
    expect(picker).toContain("productVariants.filter(v => v.color === color)");
  });

  it("🔑 المخزون معروض والكمية مسقوفة بالمتاح (واجهة)", () => {
    expect(picker).toContain("availableStock");
    expect(picker).toContain("overStock");
    expect(picker).toContain("disabled={!ready || availableStock <= 0 || overStock}");
  });
});

describe("🔑 السيرفر — عزل الكتالوج + سقف المخزون", () => {
  it("🔑 catalog/products مقصورة على نشاط الموظف", () => {
    const cat = routers.slice(routers.indexOf("catalog: employeePortalProcedure"), routers.indexOf("catalog: employeePortalProcedure") + 260);
    expect(cat).toContain("resolveEmployeeBusinessId(empScope(ctx))");
    expect(cat).toContain("getMatchCatalog(businessId)");
  });
  it("🔑 addOrder بيتحقق من ملكية التركيبة وسقف المخزون", () => {
    const start = routers.indexOf('addOrder: requireEmployeePermission("orders.create")');
    const block = routers.slice(start, routers.indexOf("myOrders:", start));
    expect(block).toContain("getVariantById(p.variantId)");
    expect(block).toContain("أكبر من المتاح");
  });
});
