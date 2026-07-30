import { describe, it, expect } from "vitest";
import { z } from "zod";
import { EMPLOYEE_SETTABLE_ORDER_STATUSES } from "@shared/const";
import { hasPermission } from "./permissions";

/**
 * الحد اللي بيمنع موظف التأكيدات من تغيير حالة برّه الأربعة المسموح بيهم.
 *
 * الاختبار بيتعامل مع نفس القائمة اللي `employeePortal.updateStatus` بيبني منها الـ
 * z.enum — مش بيدوّر على نص في الملف. لو حد زوّد حالة في الثابت، الاختبار ده بيقع
 * فورًا بدل ما التوسعة تعدي من غير ما حد ياخد باله.
 */
describe("employee status change — الحدود المسموح بيها", () => {
  // نفس البناء بالظبط اللي في الـprocedure
  const statusSchema = z.enum(EMPLOYEE_SETTABLE_ORDER_STATUSES);

  it("يقبل الحالات الأربع المطلوبة فقط", () => {
    expect([...EMPLOYEE_SETTABLE_ORDER_STATUSES].sort()).toEqual(
      ["cancelled", "confirmed", "new", "postponed"]
    );
  });

  it.each(["new", "confirmed", "postponed", "cancelled"])("يقبل %s", (s) => {
    expect(statusSchema.safeParse(s).success).toBe(true);
  });

  // الحالات دي بتخص التشغيل والشحن — موظف التأكيدات مالوش عليها سلطة
  it.each(["printed", "preparing", "shipped", "delivered", "returned", "no_answer"])(
    "يرفض %s",
    (s) => {
      expect(statusSchema.safeParse(s).success).toBe(false);
    }
  );

  it("يرفض قيمة غير موجودة في enum الأوردر أصلاً", () => {
    expect(statusSchema.safeParse("").success).toBe(false);
    expect(statusSchema.safeParse("DROP TABLE orders").success).toBe(false);
  });

  it("دور order_confirmation عنده صلاحية orders.update اللي الـprocedure بيطلبها", () => {
    expect(hasPermission("order_confirmation", "orders.update")).toBe(true);
  });

  it("دور viewer ملوش صلاحية تغيير الحالة", () => {
    expect(hasPermission("viewer", "orders.update")).toBe(false);
  });

  it("صلاحيات المدير ما اتغيرتش", () => {
    for (const role of ["manager", "admin", "super_admin"] as const) {
      expect(hasPermission(role, "orders.update")).toBe(true);
      expect(hasPermission(role, "orders.confirm")).toBe(true);
      expect(hasPermission(role, "orders.cancel")).toBe(true);
      expect(hasPermission(role, "employees.manage")).toBe(true);
      expect(hasPermission(role, "settings.manage")).toBe(true);
    }
  });
});
