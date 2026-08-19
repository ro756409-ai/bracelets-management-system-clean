import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { router, permissionProcedure } from "./_core/trpc";
import {
  FINANCIAL_PERMISSIONS,
  isFinancialPermission,
  hasPermission,
  permissionsForRole,
} from "./permissions";

/**
 * التحكّم في الوصول للأقسام المالية — الحارس الحقيقي على السيرفر.
 *
 * الطلب صريح: المالك والمحاسب بس بيوصلوا للـAPIs المالية. المودريتور والتأكيدات وإدخال
 * البيانات **والمدير** ممنوعين. المدير بالذات حالة خاصة: بياخد جلسة admin صناعية عشان
 * تشغيله يفضل شغّال (يوزّع أوردرات، يبعت بوسطة، يدير موظفين)، فالحجب المالي مش بيتفرض
 * من خريطة الصلاحيات — بيتفرض في البوابة نفسها. الاختبار ده بيشغّل البوابة الحقيقية
 * (`permissionProcedure`) بجلسات مختلفة ويتأكد مين بيعدّي ومين بيترفض.
 *
 * ملاحظة: من غير DATABASE_URL بترجع `hasTenantPermission` لخريطة الصلاحيات الثابتة —
 * فالبوابة هنا بتحكم بنفس منطق الإنتاج بالظبط.
 */

// راوتر صغير بيغلّف البوابة الحقيقية: بند مالي، بند مرتبات (مالي)، بند تشغيلي.
const gate = router({
  financialRead: permissionProcedure("accounting.view").query(() => "ok" as const),
  payrollWrite: permissionProcedure("payroll.manage").query(() => "ok" as const),
  operationalRead: permissionProcedure("orders.view").query(() => "ok" as const),
});

type Ctx = { user: any; employee: any; tenantId: number | null };
const ownerCtx = (): Ctx => ({ user: { id: 1, role: "admin" }, employee: null, tenantId: 1 });
const empCtx = (role: string): Ctx => ({ user: null, employee: { id: 9, role }, tenantId: 1 });
// المدير: جلسة admin صناعية + هوية موظف حقيقية دورها manager (زي context.ts بالظبط).
const managerCtx = (): Ctx => ({ user: { id: 3, role: "admin" }, employee: { id: 3, role: "manager" }, tenantId: 1 });

async function allowed(ctx: Ctx, key: "financialRead" | "payrollWrite" | "operationalRead") {
  try {
    await gate.createCaller(ctx as any)[key]();
    return true;
  } catch (e) {
    if (e instanceof TRPCError && e.code === "FORBIDDEN") return false;
    throw e;
  }
}

describe("🔑 مين بيوصل للأقسام المالية", () => {
  it("🔑 المالك بيوصل كل حاجة", async () => {
    expect(await allowed(ownerCtx(), "financialRead")).toBe(true);
    expect(await allowed(ownerCtx(), "payrollWrite")).toBe(true);
    expect(await allowed(ownerCtx(), "operationalRead")).toBe(true);
  });

  it("🔑 المحاسب بيوصل المالي والمرتبات", async () => {
    expect(await allowed(empCtx("accountant"), "financialRead")).toBe(true);
    expect(await allowed(empCtx("accountant"), "payrollWrite")).toBe(true);
  });

  it("🔑 المدير ممنوع من المالي والمرتبات — بس تشغيله شغّال", async () => {
    expect(await allowed(managerCtx(), "financialRead")).toBe(false);
    expect(await allowed(managerCtx(), "payrollWrite")).toBe(false);
    // التشغيل مايتكسرش — المدير لسه بيعدّي على البنود غير المالية بجلسته الصناعية.
    expect(await allowed(managerCtx(), "operationalRead")).toBe(true);
  });

  it("🔑 المودريتور والتأكيدات وإدخال البيانات ممنوعين من المالي", async () => {
    for (const role of ["moderator", "order_confirmation", "data_entry"]) {
      expect(await allowed(empCtx(role), "financialRead"), `${role}/financial`).toBe(false);
      expect(await allowed(empCtx(role), "payrollWrite"), `${role}/payroll`).toBe(false);
    }
  });

  it("🔑 المودريتور والتأكيدات وإدخال البيانات بيشوفوا الأوردرات (تشغيلي)", async () => {
    for (const role of ["moderator", "order_confirmation", "data_entry"]) {
      expect(await allowed(empCtx(role), "operationalRead"), `${role}/orders`).toBe(true);
    }
  });
});

describe("🔑 تصنيف الصلاحيات المالية", () => {
  it("كل صلاحيات الحسابات والمرتبات والخزنة والإقفال متصنّفة مالية", () => {
    for (const p of [
      "accounting.view", "accounting.manage", "financial_accounts.manage",
      "payroll.view", "payroll.manage", "payroll.pay",
      "closing.approve", "treasury.transfer", "reports.view_profit",
    ] as const) {
      expect(isFinancialPermission(p), p).toBe(true);
    }
  });

  it("🔑 استلام البضاعة ومرتجعات الورشة تشغيلي مش مالي (المدير بيوصلهم)", () => {
    // عدّ قطع مش حركة فلوس — مدفوعات المورد المالية متغطّية بـaccounting.* لوحدها.
    for (const p of ["inventory_costing.view", "inventory_costing.manage", "shipping_ops.view", "orders.view"] as const) {
      expect(isFinancialPermission(p as any), p).toBe(false);
    }
  });

  it("المودريتور دور تشغيلي — مفيش أي صلاحية مالية في خريطته", () => {
    for (const p of permissionsForRole("moderator")) {
      expect(FINANCIAL_PERMISSIONS.has(p), p).toBe(false);
    }
  });

  it("المودريتور بيشتغل على الأوردرات ويتابع", () => {
    for (const p of ["orders.view", "orders.confirm", "orders.cancel", "orders.export", "employees.view"] as const) {
      expect(hasPermission("moderator", p), p).toBe(true);
    }
  });
});
