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
    const sub = page.slice(page.indexOf("function buildSelectedProducts"), page.indexOf("function buildSelectedProducts") + 800);
    expect(sub).toContain("variantId: it.variantId");
    expect(sub).toContain("unitPrice: it.unitPrice");
  });

  it("🔑 قائمة لكل بُعد موجود فعلًا (النوع/اللون/المقاس) — بلا اسم منتج أو براند", () => {
    expect(picker).toContain('data-testid="vop-product"');
    expect(picker).toContain("data-testid={`vop-${dim}`}");
    // الأبعاد مشتقّة من بيانات التركيبات نفسها، مش من اسم المنتج/البراند
    expect(picker).toContain("variantDimensions(productVariants)");
    expect(picker).toContain('name: "النوع"');
    // القيم بتتفلتر حسب المختار في الأبعاد الأخرى (مقاسات اللون المختار مثلًا)
    expect(picker).toContain("optionsFor(productVariants, dim, selected)");
  });

  it("🔒 ممنوع الاختيار الصامت لأول تركيبة — الإضافة لازم تركيبة محسومة", () => {
    // جاهز = منتج بسيط، أو تركيبة واحدة ووحيدة اتحسمت
    expect(picker).toContain("const ready = !!product && (!hasVariants || resolved != null)");
    // مفيش أي fallback لأول تركيبة
    expect(picker).not.toContain("productVariants[0]");
    expect(picker).not.toContain("variants[0]");
    expect(picker).toContain('if (!product || !ready) return');
  });

  it("🔒 هوية التركيبة بتتبعت في variantId — مش مركّبة جوه اسم البند", () => {
    // optionLabel وصف للعرض في المنتقي قبل الإرسال بس
    expect(picker).toContain("optionLabel: label || null");
    // الـpayload بيبعت اسم المنتج لوحده؛ تركيب الاسم+النوع بيحصل لحظة القراءة
    const sub = page.slice(
      page.indexOf("function buildSelectedProducts"),
      page.indexOf("function buildSelectedProducts") + 800
    );
    expect(sub).toContain("productName: it.productName,");
    expect(sub).not.toContain("optionLabel");
  });

  it("🔑 المخزون معروض والكمية مسقوفة بالمتاح (واجهة)", () => {
    expect(picker).toContain("availableStock");
    expect(picker).toContain("overStock");
    expect(picker).toContain("disabled={!ready || availableStock <= 0 || overStock}");
  });
});

describe("🔑 السيرفر — عزل الكتالوج + سقف المخزون", () => {
  it("🔑 catalog/products مقصورة على نشاط الموظف الواحد فقط — لا cross-business/tenant", () => {
    const cat = routers.slice(routers.indexOf("catalog: employeePortalProcedure"), routers.indexOf("catalog: employeePortalProcedure") + 500);
    expect(cat).toContain("employeeCatalogBusinessIds(empScope(ctx))");
    expect(cat).toContain("getMatchCatalog(undefined, businessIds)");
    const prod = routers.slice(routers.indexOf("products: employeePortalProcedure"), routers.indexOf("products: employeePortalProcedure") + 900);
    expect(prod).toContain("employeeCatalogBusinessIds(empScope(ctx))");
    expect(prod).toContain("inArray(products.businessId, businessIds)");
    // نطاق نشاط واحد بيمرّ من choke point العزل (scopeBusinessIds)، مش كل الـtenant.
    const helper = routers.slice(routers.indexOf("async function employeeCatalogBusinessIds"), routers.indexOf("async function employeeCatalogBusinessIds") + 400);
    expect(helper).toContain("scopeBusinessIds(ctx, {})");
  });
  it("🔑 addOrder بيتحقق من ملكية التركيبة وسقف المخزون", () => {
    const start = routers.indexOf('addOrder: requireEmployeePermission("orders.create")');
    const block = routers.slice(start, routers.indexOf("myOrders:", start));
    expect(block).toContain("getVariantById(p.variantId)");
    expect(block).toContain("أكبر من المتاح");
    // التركيبة لازم تتبع نفس المنتج — والمنتج نفسه تابع لنشاط الموظف (requireAllOwned)،
    // فتركيبة من منتج/نشاط تاني بتترفض على السيرفر مش بالواجهة بس.
    expect(block).toContain("variant.productId !== p.productId");
    expect(block).toContain('requireAllOwned(');
    // variantId بلا productId ممنوع (مافيش منتج نتحقّق ضده)
    expect(block).toContain("if (p.productId == null)");
  });
  it("🔒 مرآة الهيدر بتتبني من كتالوج النشاط — مش من نص العميل", () => {
    for (const [anchor, end] of [
      ['addOrder: requireEmployeePermission("orders.create")', "myOrders:"],
      ['updateOrder: requireEmployeePermission("orders.create")', "products: employeePortalProcedure"],
    ] as const) {
      const start = routers.indexOf(anchor);
      const block = routers.slice(start, routers.indexOf(end, start));
      expect(block, anchor).toContain("getOwnedProductNames(");
      expect(block, anchor).toContain("buildOrderHeaderName(");
      // الصياغة القديمة اللي كانت بتثق في p.productName اتشالت
      expect(block, anchor).not.toContain("`${p.productName} ×${p.quantity}`");
    }
  });
  it("🔑 parsePaste معزول بنشاط الموظف الواحد", () => {
    const b = routers.slice(routers.indexOf("parsePaste: employeePortalProcedure"), routers.indexOf("parsePaste: employeePortalProcedure") + 700);
    expect(b).toContain("employeeCatalogBusinessIds(empScope(ctx))");
    expect(b).toContain("getMatchCatalog(undefined, businessIds)");
  });
});
