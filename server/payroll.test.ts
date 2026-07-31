import { describe, it, expect } from "vitest";
import fs from "fs";
import { hasPermission, permissionsForRole, ALL_PERMISSIONS } from "./permissions";

/**
 * حدود وحدة الرواتب.
 *
 * الحساب نفسه متغطّى في `shared/payrollCalc.test.ts` بـ٤٣ اختبار على الدوال النقية.
 * الملف ده بيغطي الحاجات اللي مالهاش دالة نقية: الصلاحيات، وحواجز دورة الحياة اللي
 * بتمنع الدفع المزدوج. الحواجز بتتفحص على مصدر `db.ts` لأن تشغيلها بيحتاج قاعدة
 * بيانات مش موجودة في الساندبوكس — والاختبار بيقول ده صراحة بدل ما يدّعي تغطية أعمق.
 */

describe("صلاحيات الرواتب", () => {
  it("الأربع صلاحيات مضافة للقائمة المركزية", () => {
    for (const p of ["payroll.view", "payroll.manage", "payroll.approve", "payroll.pay"] as const) {
      expect(ALL_PERMISSIONS).toContain(p);
    }
  });

  it("الإدارة عندها الأربعة", () => {
    for (const role of ["super_admin", "admin", "manager"] as const) {
      expect(hasPermission(role, "payroll.view")).toBe(true);
      expect(hasPermission(role, "payroll.manage")).toBe(true);
      expect(hasPermission(role, "payroll.approve")).toBe(true);
      expect(hasPermission(role, "payroll.pay")).toBe(true);
    }
  });

  it("🔑 المحاسب بيجهّز ويدفع لكن مايعتمدش — فصل المهام", () => {
    expect(hasPermission("accountant", "payroll.view")).toBe(true);
    expect(hasPermission("accountant", "payroll.manage")).toBe(true);
    expect(hasPermission("accountant", "payroll.pay")).toBe(true);
    expect(hasPermission("accountant", "payroll.approve")).toBe(false);
  });

  it("باقي الأدوار مالهاش أي صلاحية رواتب", () => {
    const roles = ["viewer", "order_confirmation", "agent", "data_entry",
      "facebook_entry", "shipping", "scanner", "warehouse"] as const;
    for (const role of roles) {
      for (const p of ["payroll.view", "payroll.manage", "payroll.approve", "payroll.pay"] as const) {
        expect(hasPermission(role, p)).toBe(false);
      }
    }
  });

  it("صلاحيات المحاسب المحاسبية ما اتشالتش", () => {
    const perms = permissionsForRole("accountant");
    expect(perms).toContain("accounting.view");
    expect(perms).toContain("accounting.manage");
  });

  it("صلاحيات الأدوار القائمة ما اتغيرتش", () => {
    expect(hasPermission("order_confirmation", "orders.update")).toBe(true);
    expect(hasPermission("order_confirmation", "orders.confirm")).toBe(true);
    expect(hasPermission("viewer", "dashboard.view")).toBe(true);
    expect(hasPermission("warehouse", "orders.view")).toBe(true);
  });
});

describe("حواجز دورة حياة الرواتب", () => {
  const db = fs.readFileSync("server/db.ts", "utf-8");
  const payroll = db.slice(db.indexOf("// ==================== PAYROLL"));

  it("🔑 الدفع مرفوض لو فيه قيد مصروف بالفعل — الحارس ضد الدفع المزدوج", () => {
    expect(payroll).toContain("if (period.expenseId) throw new Error(\"هذه الدورة مدفوعة بالفعل\")");
  });

  it("الدفع من حالة معتمدة بس", () => {
    expect(payroll).toContain('if (period.status !== "approved")');
  });

  it("الاعتماد من مسودة بس", () => {
    expect(payroll).toContain('if (period.status !== "draft") throw new Error("لا يمكن اعتماد دورة إلا وهي مسودة")');
  });

  it("إعادة الحساب ممنوعة بعد الاعتماد", () => {
    expect(payroll).toContain("لا يمكن إعادة حساب دورة بعد اعتمادها");
  });

  it("تعديل السطور ممنوع بعد الاعتماد", () => {
    expect(payroll).toContain("لا يمكن تعديل سطور دورة بعد اعتمادها");
  });

  it("الحذف النهائي للمسودة فقط", () => {
    expect(payroll).toContain("لا يمكن حذف دورة بعد اعتمادها — استخدم الإلغاء");
  });

  it("🔑 إلغاء الدورة المدفوعة بينزّل قيدًا عكسيًا مش بيمسح", () => {
    expect(payroll).toContain("await deleteExpense(period.expenseId, actor)");
  });

  it("🔑 الإلغاء بيرجّع السُلف معلّقة", () => {
    expect(payroll).toContain('status: "pending", settledPeriodId: null');
  });

  it("سُلفة مُسوّاة مايتلغيش صرفها", () => {
    expect(payroll).toContain("لا يمكن إلغاء سُلفة تم خصمها في دورة رواتب");
  });

  it("🔑 الدفع بيستخدم الصافي مش الإجمالي — السُلف اتسجّلت مصروفًا وقت صرفها", () => {
    expect(payroll).toContain("const netTotal = toNumber(period.totalNet)");
    expect(payroll).toContain("amount: netTotal.toFixed(2)");
  });

  it("سُلفة فشل تسجيلها بترجّع مصروفها — مفيش مصروف يتيم", () => {
    expect(payroll).toContain("await deleteExpense(expense.id,");
  });
});

describe("المخطط", () => {
  const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");
  const migration = fs.readFileSync("drizzle/0033_funny_korg.sql", "utf-8");

  it("الخمس جداول موجودة", () => {
    for (const t of ["payroll_settings", "employee_salary_profiles", "payroll_periods",
      "payroll_items", "employee_advances"]) {
      expect(schema).toContain(`mysqlTable("${t}"`);
    }
  });

  it("🔑 أساس العمولة بيدعم الأربع حالات", () => {
    expect(schema).toContain('"confirmed", "prepared", "shipped", "delivered"');
  });

  it("🔑 الفهرس الفريد على (نشاط، سنة، شهر) — دورة واحدة للشهر", () => {
    expect(migration).toContain("`payroll_periods_business_period_unique` UNIQUE(`businessId`,`year`,`month`)");
  });

  it("سطر واحد لكل موظف في الدورة", () => {
    expect(migration).toContain("`payroll_items_period_employee_unique` UNIQUE(`periodId`,`employeeId`)");
  });

  it("إصدار واحد لكل تاريخ سريان", () => {
    expect(migration).toContain("`employee_salary_profiles_employee_effective_unique` UNIQUE(`employeeId`,`effectiveFrom`)");
  });

  it("🔑 لقطة ملف الراتب محفوظة على السطر", () => {
    expect(schema).toContain('profileSnapshot: text("profileSnapshot")');
    expect(schema).toContain('salaryProfileId: int("salaryProfileId")');
  });

  it("🔑 الـmigration إضافية بحتة — صفر ALTER أو DROP", () => {
    expect(migration).not.toMatch(/ALTER TABLE/i);
    expect(migration).not.toMatch(/DROP /i);
    expect(migration).not.toMatch(/MODIFY /i);
    expect((migration.match(/CREATE TABLE/g) ?? []).length).toBe(5);
  });

  it("مافيش لمس لجدول الموظفين — جدول مصادقة حيّ", () => {
    expect(migration).not.toContain("`employees`");
  });
});
