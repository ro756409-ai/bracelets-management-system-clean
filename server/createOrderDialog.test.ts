import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * نافذة «إضافة أوردر جديد» في شاشة المالك.
 *
 * الست قوايم فيها كانت بتترسم فاضية على الإنتاج. مش لسبب واحد:
 *   • خمسة منهم استعلامهم `enabled: Boolean(businessId)` والنشاط مكانش متختار.
 *   • وحتى بعد اختيار النشاط، جدول الإعدادات فاضي — نفس الجدول اللي كسر المحافظات قبل كده.
 *   • ونوع الحفر مكانش موجود في النافذة أصلاً.
 *
 * الاختبارات دي بتقفل كل واحدة على حدة، وبتقفل معاها إن حاجز ما بعد الـGo-Live
 * فضل مكانه — لإن الحل هنا كان **تخفيف** الشرط على الواجهة، والحاجز الحقيقي لازم يفضل
 * في الترانزاكشن.
 */

const page = fs.readFileSync("client/src/pages/Orders.tsx", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const db = fs.readFileSync("server/db.ts", "utf-8");
const hook = fs.readFileSync("client/src/hooks/useOrderSourceOptions.ts", "utf-8");

/** Comments stripped — a "must not contain" assertion is meaningless against prose that
 *  necessarily names the thing it explains. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const code = codeOnly(page);
/** نافذة الإنشاء وحدها — الصفحة فيها فلاتر ونافذة تعديل ليهم مصادرهم. */
const dialog = code.slice(
  code.indexOf("function CreateOrderDialog("),
  code.indexOf("function AssignDialog(")
);

describe("النشاط هو البوابة", () => {
  it("🔑 نشاط واحد → بيتختار لوحده", () => {
    expect(dialog).toContain("businesses.length !== 1");
    expect(dialog).toContain("setForm(f => ({ ...f, businessId: String(businesses[0].id) }))");
  });

  it("🔑 القوايم المعتمدة عليه بتتقفل لحد ما يتختار، مش بتترسم فاضية", () => {
    expect(dialog).toContain("const noBusiness = !businessId;");
    // شركة الشحن، نوع الشحن، نوع الدفع
    expect((dialog.match(/disabled=\{noBusiness\}/g) ?? []).length).toBe(3);
    expect((dialog.match(/noBusiness \? "اختار النشاط الأول"/g) ?? []).length).toBe(3);
  });
});

describe("القوايم اللي ليها بديل مشترك", () => {
  it("🔑 المحافظة بتقرا من الـhook المشترك مش من جدول الإعدادات", () => {
    expect(dialog).toContain("useGovernorateOptions()");
    expect(dialog).toContain("governorateOptions.values.map");
    expect(dialog).not.toContain('namespace: "governorate"');
  });

  it("🔑 المصدر كمان — وهو حقل NOT NULL فالفاضي كان بيمنع الحفظ", () => {
    expect(dialog).toContain("useOrderSourceOptions()");
    expect(dialog).toContain("sourceOptions.options.map");
    expect(dialog).not.toContain('namespace: "order_source"');
  });

  it("🔑 بديل المصدر مش مخترع — نفس القاموس اللي الشاشات بتقرا بيه دلوقتي", () => {
    expect(hook).toContain('import { ORDER_SOURCE }');
    expect(codeOnly(hook)).toContain("configured.length > 0");
    expect(codeOnly(hook)).toContain("Object.entries(ORDER_SOURCE)");
  });

  it("المضبوط في الإعدادات بيكسب البديل", () => {
    expect(codeOnly(hook)).toContain("configured.length > 0\n        ? configured");
  });
});

describe("القوايم اللي مالهاش بديل — عن قصد", () => {
  it("🔑 شركة الشحن ونوع الشحن ونوع الدفع لسه بيقروا البيانات الحقيقية", () => {
    expect(dialog).toContain("accountingV2.shippingConfiguration.useQuery");
    expect(dialog).toContain('namespace: "shipping_type"');
    expect(dialog).toContain('namespace: "payment_type"');
  });

  it("🔑 ولما تكون فاضية بتقول للمستخدم يسجّلها بدل ما تسيبه قدام قائمة فاضية", () => {
    expect((dialog.match(/<EmptyConfigHint/g) ?? []).length).toBe(3);
    expect(code).toContain("function EmptyConfigHint(");
    expect(dialog).toContain('navigate("/accounting-settings")');
  });

  it("الرسالة مابتظهرش وهي بتحمّل ولا قبل اختيار النشاط", () => {
    expect(dialog).toContain("show={!noBusiness && !shipping.isLoading &&");
    expect(dialog).toContain("show={!noBusiness && !shippingTypes.isLoading &&");
    expect(dialog).toContain("show={!noBusiness && !paymentTypes.isLoading &&");
  });
});

describe("الثلاثة دول مش شرط للحفظ", () => {
  it("🔑 مش في قايمة الحقول المطلوبة على الواجهة", () => {
    const check = dialog.slice(dialog.indexOf("const handleSubmit ="));
    const guard = check.slice(0, check.indexOf("createMutation.mutate("));
    expect(guard).toContain("!form.source");
    expect(guard).not.toContain("form.shippingProviderId");
    expect(guard).not.toContain("form.shippingType");
    expect(guard).not.toContain("form.paymentType");
  });

  it("🔑 والعقد على السيرفر بقى optional", () => {
    const i = routers.indexOf("    create: protectedProcedure");
    const input = codeOnly(routers.slice(i, routers.indexOf(".mutation(", i)));
    expect(input).toContain("projectedShippingProviderId: z.number().optional()");
    expect(input).toContain("projectedShippingType: z.string().min(1).optional()");
    expect(input).toContain("projectedPaymentType: z.string().min(1).optional()");
  });

  it("🔑 لكن الحاجز الحقيقي بعد الـGo-Live فضل مكانه", () => {
    // ده هو اللي بيمنع أوردر ناقص بيانات شحن على نشاط بدأ محاسبته فعلًا.
    const fn = db.slice(
      db.indexOf("async function createOrderInTransaction"),
      db.indexOf("export async function createOrder(")
    );
    expect(fn).toContain("isAfterGoLive &&");
    expect(fn).toContain(
      "Shipping Provider, Shipping Type and Payment Type must be selected for orders after Go-Live"
    );
  });

  it("الفاضي بيتبعت undefined مش صفر ولا نص فاضي", () => {
    const send = dialog.slice(dialog.indexOf("createMutation.mutate({"));
    const body = send.slice(0, send.indexOf("});"));
    expect(body).toContain("form.shippingProviderId ? Number(form.shippingProviderId) : undefined");
    expect(body).toContain("projectedShippingType: form.shippingType || undefined");
    expect(body).toContain("projectedPaymentType: form.paymentType || undefined");
  });
});

describe("نوع الحفر", () => {
  it("🔑 بقى موجود في نافذة الإنشاء — مكانش موجود خالص", () => {
    expect(dialog).toContain("productVariants.length > 0 &&");
    expect(dialog).toContain("نوع الحفر / المقاس");
    expect(dialog).toContain("variantLabel(v)");
  });

  it("🔑 بيتفلتر على المنتج المختار", () => {
    expect(dialog).toContain("variants.filter(v => v.productId === Number(form.productId))");
  });

  it("🔑 بيتصفّر لما المنتج يتغيّر — نوع منتج تاني كان هيتشحن غلط", () => {
    const change = dialog.slice(dialog.indexOf("const handleProductChange ="));
    expect(change.slice(0, change.indexOf("};"))).toContain('variantId: ""');
  });

  it("🔑 سعر النوع بيكسب سعر المنتج الأب", () => {
    expect(dialog).toContain("Number(selectedVariant?.price ?? selectedProduct?.price ?? 0)");
    // والكمية بتحسب على نفس السعر ده، مش على سعر المنتج
    const qty = dialog.slice(dialog.indexOf("const handleQuantityChange ="));
    expect(qty.slice(0, qty.indexOf("};"))).toContain("unitPrice ? String(unitPrice * Number(qty))");
  });

  it("🔑 بيوصل للسيرفر وبيتكتب في سطر الأوردر", () => {
    expect(dialog).toContain("variantId: form.variantId ? Number(form.variantId) : undefined");
    const i = routers.indexOf("    create: protectedProcedure");
    const proc = routers.slice(i, routers.indexOf("    update:", i));
    expect(proc).toContain("variantId: z.number().optional()");
    expect(proc).toContain("variantId: input.variantId");
  });

  it("القايمة نفسها بتتجاب للنافذتين — مفيش استعلام تاني", () => {
    expect((code.match(/trpc\.variants\.all\.useQuery/g) ?? []).length).toBe(1);
    expect(code).toContain("variants={(variantsList ?? []) as CatalogVariant[]}");
  });
});
