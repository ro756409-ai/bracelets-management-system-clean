import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * نافذة تعديل الأوردر — واحدة للشاشتين.
 *
 * كان فيه تلات نسخ من نفس النافذة (Orders.tsx، AgentWorkspace.tsx، EmployeeDashboard.tsx)
 * واتفرّقوا عن بعض: نسخة المالك مكانش فيها حقل مدينة أصلًا، وكانت بتقرا المحافظات من جدول
 * إعدادات فاضي، وبتوصف السلة كلها في خانة نص واحدة.
 *
 * الاختبارات دي بتثبّت إن الشاشتين بيستخدموا نفس المكوّن، وإن الحماية على السيرفر فضلت
 * منفصلة — المشترك هو الواجهة بس.
 */

const dialog = fs.readFileSync("client/src/components/orders/OrderEditDialog.tsx", "utf-8");
const ownerPage = fs.readFileSync("client/src/pages/Orders.tsx", "utf-8");
const employeePage = fs.readFileSync("client/src/pages/EmployeeDashboard.tsx", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const compact = routers.replace(/\s+/g, " ");

describe("مكوّن واحد للشاشتين", () => {
  it("🔑 الشاشتين بيستوردوا نفس النافذة", () => {
    for (const [name, page] of [["المالك", ownerPage], ["الموظف", employeePage]] as const) {
      expect(page, name).toContain('from "@/components/orders/OrderEditDialog"');
      expect(page, name).toContain("<OrderEditDialog");
    }
  });

  it("🔑 مفيش نافذة تعديل مكتوبة على المباشر في أي صفحة", () => {
    // النسخة القديمة كانت Dialog جوه الصفحة مربوط بـ١٣ useState سايبين.
    for (const [name, page] of [["المالك", ownerPage], ["الموظف", employeePage]] as const) {
      expect(page, name).not.toContain("تعديل بيانات الأوردر");
      expect(page, name).not.toContain("<DialogTitle>تعديل");
    }
  });

  it("🔑 حقول الفورم القديمة اتشالت من الصفحتين", () => {
    const dead = [
      "editProductName", "editQuantity", "editTotalAmount", "editColor", "editSize",
      "editCustomerName", "editCustomerPhone", "editGovernorate", "editCity",
      "editShippingFees", "editAddress", "editNotes", "editEmployeeNotes",
      "editPaymentMethod", "editLines", "confirmDiscard",
    ];
    for (const field of dead) {
      expect(ownerPage, `المالك/${field}`).not.toContain(field);
      expect(employeePage, `الموظف/${field}`).not.toContain(field);
    }
  });

  it("المكوّنات المشتركة اتنقلت لمجلد مشترك", () => {
    expect(fs.existsSync("client/src/components/orders/GovernorateCitySelect.tsx")).toBe(true);
    expect(fs.existsSync("client/src/components/orders/OrderItemsEditor.tsx")).toBe(true);
    expect(fs.existsSync("client/src/components/employee/GovernorateCitySelect.tsx")).toBe(false);
    expect(fs.existsSync("client/src/components/employee/OrderItemsEditor.tsx")).toBe(false);
  });
});

describe("النافذة معزولة عن الشبكة والصلاحيات", () => {
  it("🔑 مابتعرفش حاجة عن tRPC — الصفحة بتجيب والنافذة بتعرض", () => {
    // ده اللي بيخلّي مسار المالك ومسار الموظف يفضلوا منفصلين على السيرفر رغم إن
    // الواجهة واحدة: النافذة مابتنادي endpoint، بتاخد بيانات وترجّع payload.
    expect(dialog).not.toContain("trpc.");
    expect(dialog).not.toContain("useQuery");
    expect(dialog).not.toContain("useMutation");
  });

  it("الحفظ بيرجع للصفحة عبر onSave — والفشل بيرمي", () => {
    expect(dialog).toContain("onSave: (payload: OrderEditSavePayload) => Promise<void>");
    expect(dialog).toContain("await onSave({");
    expect(dialog).toContain("} catch {");
  });

  it("🔑 النافذة مابتتقفلش إلا بعد نجاح الحفظ", () => {
    const fn = dialog.slice(dialog.indexOf("async function handleSave()"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    // close() بعد await، جوه try — يعني الفشل بيسيبها مفتوحة بالقيم المكتوبة.
    expect(body.indexOf("await onSave({")).toBeLessThan(body.indexOf("close();"));
  });
});

describe("الحماية على السيرفر فضلت منفصلة", () => {
  it("🔑 المالك على adminProcedure والموظف على صلاحية + ملكية", () => {
    expect(compact).toContain("orderItems: adminProcedure");
    expect(compact).toContain("editOrderItems: adminProcedure");
    expect(compact).toContain('orderItems: requireEmployeePermission("orders.view")');
    expect(compact).toContain('editOrderItems: requireEmployeePermission("orders.update")');
  });

  it("🔑 مسار الموظف لسه بيفحص ملكية الأوردر", () => {
    expect(compact).toContain('"لا يمكنك عرض بنود أوردر غير مسند إليك"');
    expect(compact).toContain('"لا يمكنك تعديل بنود أوردر غير مسند إليك"');
  });

  it("🔑 مسار المالك محدود بنطاق النشاط مش سايب", () => {
    const owner = routers.slice(
      routers.indexOf("    orderItems: adminProcedure"),
      routers.indexOf("    // جلب سجل تعديلات أوردر")
    );
    expect((owner.match(/requireScopedBusinessId\(ctx\.tenantId, order\.businessId\)/g) ?? []).length).toBe(2);
  });

  it("المسارين بينادوا نفس دوال قاعدة البيانات", () => {
    // مصدر واحد بيقرر إزاي البند بيتسعّر والرأس بيتحدّث والمخزون بيتسوّى.
    expect((routers.match(/replaceOrderItemsFromEditor\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((routers.match(/await getOrderItems\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("التعديل بيتسجّل في سجل النشاط من المسارين", () => {
    expect((routers.match(/action: "edit_order_items"/g) ?? []).length).toBe(2);
  });
});

describe("الشاشتين بيقروا نفس البيانات", () => {
  it("🔑 الاتنين بيقروا البنود من order_items مش من رأس الأوردر", () => {
    expect(ownerPage).toContain("trpc.orders.orderItems.useQuery");
    expect(employeePage).toContain("trpc.employeePortal.orderItems.useQuery");
  });

  it("🔑 الاتنين بيحفظوا البنود قبل الرأس", () => {
    // البنود هي اللي ممكن تترفض (خرج مخزون) وهي اللي بتعيد كتابة totalAmount، فلو
    // اتحفظت تاني كان الرأس هيتحفظ والسلة تترفض — واللي بيقرا يفتكر إن الحفظ نجح.
    for (const [name, page, fn] of [
      ["المالك", ownerPage, "async function saveOrderEdit("],
      ["الموظف", employeePage, "async function saveEdit("],
    ] as const) {
      const body = page.slice(page.indexOf(fn));
      const save = body.slice(0, body.indexOf("\n  }"));
      expect(save.indexOf("if (itemsDirty)"), name).toBeLessThan(save.indexOf("if (headerDirty)"));
    }
  });

  it("الاتنين بيبطّلوا الكاش بعد الحفظ عشان الشاشة التانية تشوف نفس الأرقام", () => {
    expect(ownerPage).toContain("utils.orders.orderItems.invalidate({ orderId })");
    expect(employeePage).toContain("utils.employeePortal.orderItems.invalidate({ orderId })");
  });

  it("🔑 الأوردر القديم اللي مالوش بنود بيتولّد له بند من الرأس في المسارين", () => {
    expect((routers.match(/derivedFromHeader: true/g) ?? []).length).toBe(2);
  });
});

describe("مشاكل شاشة المالك اللي اتصلّحت", () => {
  it("🔑 المحافظات مابقتش بتيجي من جدول الإعدادات الفاضي لوحده", () => {
    // GOVERNORATES في الصفحة لسه من useOperationalOptions، بس بقت بتتبعت للنافذة
    // كـconfiguredGovernorates، واللي بترجع للقايمة الوطنية الكاملة لو فاضية.
    expect(ownerPage).toContain("configuredGovernorates={GOVERNORATES}");
    const select = fs.readFileSync(
      "client/src/components/orders/GovernorateCitySelect.tsx", "utf-8"
    );
    expect(select).toContain("if (configured.length > 0) return configured;");
    expect(select).toContain("return GOVERNORATE_NAMES;");
  });

  it("🔑 حقل المدينة موجود دلوقتي — مكانش موجود خالص", () => {
    expect(dialog).toContain("<GovernorateCitySelect");
    expect(dialog).toContain("city: order.city ?? \"\"");
    expect(ownerPage).toContain("<OrderEditDialog");
  });

  it("🔑 المالك بقى يقدر يحط أكتر من نوع حفر في نفس الأوردر", () => {
    expect(dialog).toContain("<OrderItemsEditor");
    const editor = fs.readFileSync("client/src/components/orders/OrderItemsEditor.tsx", "utf-8");
    expect(editor).toContain("variantId");
    // كل سطر ليه مفتاح خاص بيه، والعرض بيمشي على السطور زي ما هي — مفيش تجميع حسب
    // productId، فنفس المنتج بنوعين مختلفين بيفضل سطرين. الفحص على السلوك مش على
    // كلمة في تعليق.
    expect(editor).toContain("lines.map((line, index)");
    expect(editor).toContain("key={line.key}");
    expect(editor).toContain("onChange([...lines, emptyLine()])");
  });

  it("تحذير التعديلات غير المحفوظة والتحقق من الموبايل بقوا للشاشتين", () => {
    expect(dialog).toContain("فيه تعديلات مش محفوظة");
    expect(dialog).toContain("export function isValidEgyptianMobile");
  });

  it("ملاحظات الموظف الداخلية مخفية عن شاشة المالك", () => {
    expect(ownerPage).toContain("showEmployeeNotes={false}");
    expect(dialog).toContain("{showEmployeeNotes && (");
  });
});
