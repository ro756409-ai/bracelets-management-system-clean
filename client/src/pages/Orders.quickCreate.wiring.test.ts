import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حراس نصّية (بيئة node): روابط «القيم الفاضية» في نافذة إضافة الأوردر لازم تفتح نوافذ الإضافة
 * فوق النموذج — لا تذهب إلى `/accounting-settings` (صفحة النظام المحاسبي المجمّد).
 */
const orders = fs.readFileSync("client/src/pages/Orders.tsx", "utf-8");
const quick = fs.readFileSync("client/src/components/orders/QuickCreateDialogs.tsx", "utf-8");

describe("🔑 نافذة إضافة الأوردر — الإضافة من داخل النموذج لا من صفحة المحاسبة المقفولة", () => {
  it("🔑 لا توجيه إلى /accounting-settings من نافذة الأوردر", () => {
    expect(orders).not.toContain('navigate("/accounting-settings")');
    expect(orders).not.toContain("goToSettings");
  });
  it("🔑 العناصر الأربعة لها نافذة إضافة متداخلة + زر «+» + رابط «أضفها الآن» عند الفراغ", () => {
    expect(orders).toContain("<QuickShippingProviderDialog");
    expect(orders).toContain('namespace="shipping_type"');
    expect(orders).toContain('namespace="payment_type"');
    expect(orders).toContain("<QuickProductDialog");
    for (const label of ["إضافة شركة شحن", "إضافة نوع شحن", "إضافة نوع دفع", "إضافة منتج"]) expect(orders).toContain(`label="${label}"`);
    expect(orders).toContain('label="منتجات" onGo={() => setQuick("product")}');
    expect(orders).toContain("أضفها الآن");
  });
  it("🔑 بعد الحفظ: تُعاد القائمة ثم تُختار القيمة فورًا (بلا refresh وبلا فقدان المكتوب — setForm يحافظ على باقي الحقول)", () => {
    expect(quick).toContain("await utils.accountingV2.shippingConfiguration.invalidate({ businessId })");
    expect(quick).toContain("await utils.accountingV2.configurationList.invalidate({ businessId, namespace, activeOnly: true })");
    expect(quick).toContain("utils.products.list.invalidate(), utils.variants.all.invalidate()");
    // onCreated بعد الـinvalidate (الـawait قبلها) ثم onClose — فالقيمة موجودة في القائمة لحظة اختيارها
    for (const m of quick.matchAll(/await onCreated\(/g)) expect(m.index).toBeGreaterThan(0);
    expect((quick.match(/await onCreated\(/g) ?? []).length).toBe(4);
    expect(orders).toContain("onCreated={row => setForm(f => ({ ...f, shippingProviderId: String(row.id) }))}");
    expect(orders).toContain("onCreated={row => setForm(f => ({ ...f, shippingType: row.configKey }))}");
    expect(orders).toContain("onCreated={row => setForm(f => ({ ...f, paymentType: row.configKey }))}");
  });
  it("🔑 لا بيانات افتراضية تلقائية: النوافذ تحفظ فقط بما يكتبه المستخدم", () => {
    expect(quick).not.toMatch(/mutate\(\{[^}]*displayName:\s*"[^"]+"/); // لا اسم ثابت في أي نداء حفظ
    expect(quick).toContain('if (!trimmed) return toast.error("اكتب اسم شركة الشحن")');
  });
});
