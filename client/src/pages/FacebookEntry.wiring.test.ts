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

  it("🔑 اتشال منطق الإسورة/الووتر القديم", () => {
    for (const legacy of [
      "WATERPROOF_PRODUCT_ID", "نوع الحفر", "waterproofVariants",
      "confidenceTone", "عدد الأساور",
    ]) {
      expect(page, legacy).not.toContain(legacy);
    }
  });

  it("🔑 خانة لصق رسالة العميل + تحليل تلقائي (parsePaste)", () => {
    expect(page).toContain("لصق رسالة العميل");
    expect(page).toContain("function parseAndFill");
    expect(page).toContain("utils.facebookEntry.parsePaste.fetch");
    // بيخزّن التركيبة (variantId) من نتيجة التحليل، مش نص اللون/المقاس بس
    expect(page).toContain("variantId: res.match.variantId");
    // لو مفيش تركيبة → رسالة واضحة بدل اختيار غلط
    expect(page).toContain("matchReason");
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
  it("🔑 catalog/products مقصورة على أنشطة tenant الموظف (Afandy Kids) — لا cross-tenant", () => {
    const cat = routers.slice(routers.indexOf("catalog: employeePortalProcedure"), routers.indexOf("catalog: employeePortalProcedure") + 700);
    expect(cat).toContain("getBusinessIdsForTenant(requireTenantId(emp))");
    expect(cat).toContain("getMatchCatalog(undefined, businessIds)");
    const prod = routers.slice(routers.indexOf("products: employeePortalProcedure"), routers.indexOf("products: employeePortalProcedure") + 800);
    expect(prod).toContain("getBusinessIdsForTenant(requireTenantId(emp))");
    expect(prod).toContain("inArray(products.businessId, businessIds)");
  });
  it("🔑 addOrder بيتحقق من ملكية التركيبة وسقف المخزون", () => {
    const start = routers.indexOf('addOrder: requireEmployeePermission("orders.create")');
    const block = routers.slice(start, routers.indexOf("myOrders:", start));
    expect(block).toContain("getVariantById(p.variantId)");
    expect(block).toContain("أكبر من المتاح");
  });
  it("🔑 parsePaste معزول بأنشطة tenant الموظف", () => {
    const b = routers.slice(routers.indexOf("parsePaste: employeePortalProcedure"), routers.indexOf("parsePaste: employeePortalProcedure") + 700);
    expect(b).toContain("getBusinessIdsForTenant(requireTenantId(emp))");
    expect(b).toContain("getMatchCatalog(undefined, businessIds)");
  });
});
