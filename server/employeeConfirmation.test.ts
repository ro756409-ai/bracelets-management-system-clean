import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  hasPermission,
  permissionsForRole,
  ALL_PERMISSIONS,
  EMPLOYEE_ROLE_VALUES,
  isAdminTierRole,
} from "./permissions";

/**
 * شاشة موظف التأكيدات.
 *
 * الحسابات النقية متغطّية في `client/src/components/employee/OrderItemsEditor.test.ts`
 * و`shared/egyptLocations.test.ts`. الملف ده بيغطي الحاجات اللي مالهاش دالة نقية:
 * الصلاحيات، وحواجز الملكية، وحارس الكتابة على البنود. الحواجز بتتفحص على المصدر لأن
 * تشغيلها محتاج قاعدة بيانات مش موجودة في الساندبوكس — والاختبار بيقول ده صراحة بدل
 * ما يدّعي تغطية أعمق.
 */

const routers = fs.readFileSync("server/routers.ts", "utf-8");
const compactRouters = routers.replace(/\s+/g, " ");
const db = fs.readFileSync("server/db.ts", "utf-8");

describe("صلاحيات موظف التأكيدات — المسموح", () => {
  const role = "order_confirmation";

  it("بيشوف الأوردرات ولوحته", () => {
    expect(hasPermission(role, "orders.view")).toBe(true);
    expect(hasPermission(role, "dashboard.view")).toBe(true);
  });

  it("بيعدّل ويأكّد ويلغي", () => {
    expect(hasPermission(role, "orders.update")).toBe(true);
    expect(hasPermission(role, "orders.confirm")).toBe(true);
    expect(hasPermission(role, "orders.cancel")).toBe(true);
  });
});

describe("صلاحيات موظف التأكيدات — الممنوع", () => {
  const role = "order_confirmation";

  it("🔑 مالوش أي صلاحية شحن — لا تشغيل ولا فلوس", () => {
    expect(hasPermission(role, "shipping_ops.view")).toBe(false);
    expect(hasPermission(role, "shipping_finance.view")).toBe(false);
    expect(hasPermission(role, "shipping_finance.manage")).toBe(false);
    expect(hasPermission(role, "shipping_finance.approve")).toBe(false);
  });

  it("🔑 مايشوفش الحسابات ولا الأرباح", () => {
    expect(hasPermission(role, "accounting.view")).toBe(false);
    expect(hasPermission(role, "accounting.manage")).toBe(false);
    expect(hasPermission(role, "closing.view")).toBe(false);
    expect(hasPermission(role, "financial_accounts.view")).toBe(false);
    expect(hasPermission(role, "ad_spend.view")).toBe(false);
    expect(hasPermission(role, "payroll.view")).toBe(false);
  });

  it("🔑 مايدخلش الموظفين ولا إعدادات النشاط", () => {
    expect(hasPermission(role, "employees.view")).toBe(false);
    expect(hasPermission(role, "employees.manage")).toBe(false);
    expect(hasPermission(role, "settings.view")).toBe(false);
    expect(hasPermission(role, "settings.manage")).toBe(false);
  });

  it("مش من طبقة الإدارة — وده اللي بيمنعه من حذف أوردر", () => {
    expect(isAdminTierRole(role)).toBe(false);
  });

  it("مافيش صلاحية حذف أوردر أصلاً في القائمة — الحذف على طبقة المالك", () => {
    expect(ALL_PERMISSIONS).not.toContain("orders.delete" as never);
    expect(compactRouters).toContain("delete: ownerProcedure");
    expect(compactRouters).toContain("bulkDelete: ownerProcedure");
  });
});

describe("صلاحية تشغيل الشحن", () => {
  it("مضافة للقائمة المركزية", () => {
    expect(ALL_PERMISSIONS).toContain("shipping_ops.view");
  });

  it("🔑 موظف الشحن عنده، والإدارة عندها", () => {
    expect(hasPermission("shipping", "shipping_ops.view")).toBe(true);
    for (const role of ["super_admin", "admin", "manager"] as const) {
      expect(hasPermission(role, "shipping_ops.view")).toBe(true);
    }
  });

  it("🔑 كل باقي الأدوار ممنوعة", () => {
    const allowed = new Set(["shipping", "super_admin", "admin", "manager"]);
    for (const role of EMPLOYEE_ROLE_VALUES) {
      if (allowed.has(role)) continue;
      expect(hasPermission(role, "shipping_ops.view"), role).toBe(false);
    }
  });

  it("صلاحيات موظف الشحن القديمة ما اتشالتش", () => {
    const perms = permissionsForRole("shipping");
    expect(perms).toContain("orders.view");
    expect(perms).toContain("orders.export");
  });
});

describe("حراس شاشات الشحن على السيرفر", () => {
  it("🔑 شحنات اليوم بقت وراء الصلاحية مش وراء «موظف نشط» وبس", () => {
    expect(compactRouters).toContain(
      'todayShipments: requireEmployeePermission("shipping_ops.view")'
    );
    expect(compactRouters).not.toContain("todayShipments: employeePortalProcedure");
  });

  it("🔑 مسارات جدول الشحن ليها إجراء مخصّص محمي", () => {
    expect(compactRouters).toContain(
      'shippingRoutes: requireEmployeePermission("shipping_ops.view")'
    );
  });

  it("صفحة جدول الشحن بقت بتقرا من الإجراء المحمي", () => {
    const page = fs.readFileSync("client/src/pages/ShippingSchedule.tsx", "utf-8");
    expect(page).toContain("trpc.employeePortal.shippingRoutes.useQuery");
    // كانت بتقرا من configurationListForBusinesses — authenticatedProcedure، أي موظف.
    // الفحص على الـimport مش على النص، عشان التعليق اللي بيشرح التغيير مايعدّيش الاختبار.
    expect(page).not.toContain('from "@/hooks/useOperationalOptions"');
  });

  it("الشاشتين بيوروا رسالة منع مش صفحة فاضية", () => {
    const schedule = fs.readFileSync("client/src/pages/ShippingSchedule.tsx", "utf-8");
    const today = fs.readFileSync("client/src/pages/TodayShipments.tsx", "utf-8");
    expect(schedule).toContain("جدول الشحن مش من مهامك");
    expect(today).toContain("شحنات اليوم مش من مهامك");
  });
});

describe("حواجز الملكية", () => {
  it("🔑 الفحص بقى على طبقة الإدارة مش على كلمة manager الحرفية", () => {
    expect(compactRouters).toContain(
      "if (!isAdminTierRole(emp.role) && order.assignedEmployeeId !== emp.id)"
    );
  });

  it("مفيش فحص ملكية فاضل بالمقارنة الحرفية في بوابة الموظف", () => {
    const portal = routers.slice(routers.indexOf("employeePortal: router("));
    expect(portal).not.toContain('if (emp.role !== "manager") {');
  });

  it("🔑 سجل تعديلات أوردر مش بتاعك ممنوع — كان مفتوح لأي موظف", () => {
    expect(compactRouters).toContain(
      '"لا يمكنك عرض سجل أوردر غير مسند إليك"'
    );
  });

  it("قراءة البنود وتعديلها الاتنين وراء فحص ملكية", () => {
    expect(compactRouters).toContain('"لا يمكنك عرض بنود أوردر غير مسند إليك"');
    expect(compactRouters).toContain('"لا يمكنك تعديل بنود أوردر غير مسند إليك"');
  });
});

describe("كتابة بنود الأوردر", () => {
  it("🔑 البنود بتتكتب في order_items مش في الملاحظات", () => {
    expect(compactRouters).toContain(
      'editOrderItems: requireEmployeePermission("orders.update")'
    );
    expect(db).toContain("export async function replaceOrderItemsFromEditor");
    expect(db).toContain("await tx.insert(orderItems).values(");
  });

  it("🔑 كل بند بيحفظ variantId — مش productId وبس", () => {
    const fn = db.slice(db.indexOf("export async function replaceOrderItemsFromEditor"));
    expect(fn).toContain("variantId: line.variantId");
    expect(fn).toContain("productId: line.productId");
  });

  it("الخصم والسعر بيتحفظوا لكل بند على حدة", () => {
    const fn = db.slice(db.indexOf("export async function replaceOrderItemsFromEditor"));
    expect(fn).toContain("unitPrice: line.unitPrice.toFixed(2)");
    expect(fn).toContain("discountAmountSnapshot: fromMinorUnits(discountPerLine[i])");
  });

  it("🔑 رأس الأوردر بيتحدّث مع البنود — الشاشات القديمة بتقرا منه", () => {
    const fn = db.slice(db.indexOf("export async function replaceOrderItemsFromEditor"));
    expect(fn).toContain("await tx.update(orders).set(headerUpdates)");
    expect(fn).toContain("quantity: totalQuantity");
    expect(fn).toContain("totalAmount: fromMinorUnits(totalMinor, 2)");
  });

  it("🔑 ممنوع التعديل بعد خروج المخزون — نفس حارس المسار المحاسبي", () => {
    const fn = db.slice(db.indexOf("export async function replaceOrderItemsFromEditor"));
    expect(fn).toContain("item.stockOutQuantity > 0 || item.costCapturedAt != null");
    expect(fn).toContain("لا يمكن تعديل بنود الأوردر بعد خروج المخزون");
  });

  it("الخصم الأكبر من قيمة البند مرفوض على السيرفر مش في الواجهة بس", () => {
    const fn = db.slice(db.indexOf("export async function replaceOrderItemsFromEditor"));
    expect(fn).toContain("الخصم أكبر من قيمة البند");
  });

  it("أوردر بغير بنود مرفوض", () => {
    const fn = db.slice(db.indexOf("export async function replaceOrderItemsFromEditor"));
    expect(fn).toContain("الأوردر لازم يكون فيه بند واحد على الأقل");
  });

  it("التغيير كله جوه transaction واحدة", () => {
    const fn = db.slice(db.indexOf("export async function replaceOrderItemsFromEditor"));
    expect(fn).toContain("return db.transaction(async tx => {");
    expect(fn).toContain('.for("update")');
  });
});

/**
 * confirmOrder() بتخصم المخزون من رأس الأوردر (productId × quantity) قبل الـGo-Live.
 * تعديل البنود بيعيد كتابة الرأس، فلو مافيش تسوية بيفضل الخصم على الرقم القديم:
 * تأكيد قطعتين، تعديل لخمسة، المخزن بيطلّع خمسة والدفاتر شايفة اتنين.
 */
describe("تسوية المخزون بعد تعديل البنود", () => {
  // محدودة بالدالة نفسها: `db.slice(indexOf(...))` لوحدها بتاخد باقي الملف كله،
  // فتأكيدات الـ"not.toContain" كانت بتقع على دوال تانية مالهاش دعوة.
  const start = db.indexOf("export async function replaceOrderItemsFromEditor");
  const fn = db.slice(
    start,
    db.indexOf("\nexport async function replaceOrderItems(", start)
  );

  it("🔑 التسوية بتحصل للأوردر المؤكد بس — غير المؤكد مااتخصمش أصلاً", () => {
    expect(fn).toContain('if (order.status === "confirmed" && !business?.accountingGoLiveAt)');
  });

  it("🔑 نفس المنتج: الفرق بس", () => {
    expect(fn).toContain("const diff = totalQuantity - oldQuantity;");
    expect(fn).toContain("moves.push({ productId: oldProductId, delta: -diff })");
  });

  it("🔑 المنتج اتغيّر: القديم بيرجع كامل والجديد بيتخصم كامل", () => {
    expect(fn).toContain("moves.push({ productId: oldProductId, delta: oldQuantity })");
    expect(fn).toContain("moves.push({ productId: head.productId, delta: -totalQuantity })");
  });

  it("🔑 الحركة بتتكتب مرة واحدة — مش زي editOrderFull اللي بيحرّك المخزون مرتين", () => {
    // editOrderFull بينادي updateProductStock ثم addInventoryMovement، والتانية
    // بتنادي updateProductStock جوّاها — فالكمية بتتخصم مرتين. المسار ده بيكتب
    // صف حركة واحد وبيطبّق الفرق مرة واحدة.
    expect(fn).toContain("await tx.insert(inventoryMovements).values({");
    expect(fn).toContain("currentStock: sql`${products.currentStock} + ${move.delta}`");
    // على الكود مش على النص: التعليق اللي فوق الدالة بيشرح بق editOrderFull وبيذكر
    // اسمي الدالتين، فالفحص لازم يكون على استدعاء فعلي (`await ...(`) مش على ورودهم.
    expect(fn).not.toContain("await updateProductStock(");
    expect(fn).not.toContain("await addInventoryMovement(");
  });

  it("مخزون غير كافي بيرفض التعديل قبل ما يتكتب", () => {
    expect(fn).toContain("if (move.delta < 0 && product.currentStock < -move.delta)");
    expect(fn).toContain("المخزون غير كافي للتعديل");
  });

  it("منتج اتمسح من الكتالوج مابيكسرش التعديل", () => {
    expect(fn).toContain("if (!product) continue;");
  });

  it("🔑 التسوية جوه نفس الـtransaction — فشلها بيرجّع البنود معاها", () => {
    const block = fn.slice(fn.indexOf("if (order.status === \"confirmed\""));
    expect(block.slice(0, block.indexOf("const headerUpdates"))).not.toContain("await db.");
  });

  it("بعد Go-Live متستثناة — المخزون هناك حجز وصرف مش عمود currentStock", () => {
    expect(fn).toContain("!business?.accountingGoLiveAt");
  });
});

describe("حالات الحافة في الواجهة", () => {
  const page = fs.readFileSync("client/src/pages/EmployeeDashboard.tsx", "utf-8");

  it("🔑 تحذير «بيانات ناقصة» مايظهرش والبنود لسه بتحمّل", () => {
    expect(page).toContain("if (!orderItemsLoading) {");
  });

  it("🔑 فشل تحميل البنود بيتقال للموظف مش بيسيبه قدام زرار ميت", () => {
    expect(page).toContain("تعذّر تحميل بنود الأوردر");
    expect(page).toContain("orderItemsError");
  });

  it("🔑 قائمة الحالة عليها نفس حارس التزامن بتاع الأزرار", () => {
    const fn = page.slice(page.indexOf("function handleStatusSelect"));
    expect(fn.slice(0, fn.indexOf("\n  }"))).toContain("if (statusWriteInFlight) return;");
  });

  it("علامة الانشغال بتتحط وقت الكتابة مش وقت فتح الديالوج", () => {
    const open = page.slice(page.indexOf("const openNoAnswerDialog"));
    expect(open.slice(0, open.indexOf("\n  };"))).not.toContain("setBusyOrderId");
    expect(page).toContain("setBusyOrderId(noAnswerDialog.orderId);");
    expect(page).toContain("setBusyOrderId(order.id);\n    updateStatusMutation.mutate(");
  });

  it("كل كتابة حالة بتفضّي العلامة مهما كانت النتيجة", () => {
    expect((page.match(/onSettled: \(\) => setBusyOrderId\(null\)/g) ?? []).length).toBe(5);
  });

  it("🔑 التعديل بيتسجّل في سجل التعديلات وسجل النشاط", () => {
    const fn = db.slice(db.indexOf("export async function replaceOrderItemsFromEditor"));
    expect(fn).toContain("await tx.insert(orderEditLogs).values({");
    expect(compactRouters).toContain('action: "edit_order_items"');
  });
});

describe("الإلغاء", () => {
  it("السبب إجباري على السيرفر", () => {
    expect(compactRouters).toContain(
      'cancel: requireEmployeePermission("orders.cancel") .input( z.object({ orderId: z.number(), cancelReason: z.string().min(1).max(80)'
    );
  });

  it("🔑 الموظف والوقت والسبب بيتسجّلوا في سجل النشاط", () => {
    expect(compactRouters).toContain('action: "cancel_order"');
    expect(compactRouters).toContain("metadata: { cancelReason: input.cancelReason, notes: input.notes }");
    expect(compactRouters).toContain("performedBy: emp.id");
  });
});

describe("واجهة الشاشة", () => {
  const page = fs.readFileSync("client/src/pages/EmployeeDashboard.tsx", "utf-8");

  it("🔑 أسباب إلغاء جاهزة موجودة في الكود — القائمة كانت بتفضى لو الإعدادات فاضية", () => {
    expect(page).toContain("const DEFAULT_CANCEL_REASONS");
    expect(page).toContain("configured.length > 0");
  });

  it("🔑 «سبب آخر» ليه خانة كتابة إجبارية", () => {
    expect(page).toContain("OTHER_CANCEL_REASON");
    expect(page).toContain("cancelReasonIsOther && !cancelOtherReason.trim()");
  });

  it("منع الضغط المكرر على الإلغاء والتأجيل والتأكيد", () => {
    expect(page).toContain("if (cancelMutation.isPending) return;");
    expect(page).toContain("if (postponeMutation.isPending) return;");
    expect(page).toContain("if (statusWriteInFlight) return;");
  });

  it("🔑 تحذير قبل إغلاق نافذة فيها تعديلات مش محفوظة", () => {
    expect(page).toContain("function requestCloseEditDialog()");
    expect(page).toContain("setConfirmDiscard(true)");
    expect(page).toContain("فيه تعديلات مش محفوظة");
  });

  it("🔑 النافذة مابتتقفلش لو الحفظ فشل", () => {
    // closeEditDialog بتتنادى بعد الـawait مش في onSuccess بتاع كل mutation
    expect(page).toContain("toast.success(\"✅ تم حفظ التعديلات\");");
    const save = page.slice(page.indexOf("async function saveEdit()"));
    expect(save.slice(0, save.indexOf("\n  }"))).toContain("catch {");
  });

  it("🔑 الملاحظات بتتبعت زي ما هي — مسحها بيتحفظ مش بيتجاهَل", () => {
    expect(page).toContain("notes: editNotes,");
    expect(page).not.toContain("notes: editNotes || undefined");
  });

  it("المدينة بتتصفّر لما المحافظة تتغيّر بس", () => {
    expect(page).toContain("if (value !== editGovernorate) setEditCity(\"\");");
  });

  it("🔑 مافيش أثر للحقول القديمة بتاعة المنتج الواحد", () => {
    for (const dead of ["editProductName", "editQuantity", "editTotalAmount", "editColor", "editSize"]) {
      expect(page, dead).not.toContain(dead);
    }
  });

  it("التحقق من رقم الموبايل المصري", () => {
    expect(page).toContain("function isValidEgyptianMobile");
    expect(page).toContain("/^01[0125]\\d{8}$/");
  });
});

describe("مساحة الضغط والـRTL", () => {
  const page = fs.readFileSync("client/src/pages/EmployeeDashboard.tsx", "utf-8");
  const editor = fs.readFileSync(
    "client/src/components/employee/OrderItemsEditor.tsx",
    "utf-8"
  );

  it("🔑 أزرار القرارات ٤٤ بكسل — كانت ٣٦ وأربعة في الصف على ٣٢٠px", () => {
    const actions = page.slice(page.indexOf("{canAct && ("));
    const row = actions.slice(0, actions.indexOf("</div>"));
    expect(row).not.toContain('className="h-9');
    expect((row.match(/h-11/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("أزرار الحفظ والإلغاء ثابتة أسفل النافذة", () => {
    expect(page).toContain("grid-rows-[auto_1fr_auto]");
    expect(page).toContain("max-h-[92dvh]");
  });

  it("🔑 مافيش تمرير أفقي — الجسم بيمرّر رأسيًا بس", () => {
    expect(page).toContain("overflow-y-auto overflow-x-hidden");
  });

  it("خصائص منطقية مش يمين/شمال ثابتة — الشاشة RTL", () => {
    expect(editor).not.toMatch(/\bml-\d/);
    expect(editor).not.toMatch(/\bmr-\d/);
  });

  it("🔑 قائمة الاختيار فوق النافذة — الاتنين كانوا z-50", () => {
    const select = fs.readFileSync("client/src/components/ui/select.tsx", "utf-8");
    expect(select).toContain("relative z-[60]");
    const dialog = fs.readFileSync("client/src/components/ui/dialog.tsx", "utf-8");
    expect(dialog).toContain("z-50");
  });
});
