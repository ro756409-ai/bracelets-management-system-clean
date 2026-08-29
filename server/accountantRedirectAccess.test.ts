import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * المحاسب دور مالي بحت: بيروح على الحسابات مباشرة بعد الـlogin، وبيُحجب عن صفحات
 * تشغيل الأوردرات/التأكيدات — مش مجرد إخفاء من الـsidebar.
 *
 * الاختبارات دي بتقفل السلوك على مستوى المصدر (زي باقي حُرّاس الواجهة في المشروع)،
 * وبتتأكد إن التصميم Client-guard: الحجب الحقيقي فضل على الـendpoints زي ما هو
 * (adminProcedure/permissionProcedure)، والقايمة المالية للأنشطة اتفتحت لجلسة الموظف
 * لأنها tenant-scoped (أسماء أنشطة بس) — من غير ما نبني synthetic-admin للمحاسب.
 */

const login = fs.readFileSync("client/src/pages/EmployeeLogin.tsx", "utf-8");
const app = fs.readFileSync("client/src/App.tsx", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const trpcCore = fs.readFileSync("server/_core/trpc.ts", "utf-8");

describe("🔑 توجيه المحاسب بعد الدخول", () => {
  it("🔑 المحاسب بيروح على /accounting مش /employee-dashboard", () => {
    const fn = login.slice(login.indexOf("Redirect based on role"));
    const body = fn.slice(0, fn.indexOf("} catch"));
    expect(body).toContain("data.employee.role === 'accountant'");
    // بعد P2-A: المحاسب بيروح مساحته المخصّصة /accountant (مش صفحة المالك /accounting).
    const branch = body.slice(body.indexOf("role === 'accountant'"));
    expect(branch.slice(0, branch.indexOf("else")))
      .toContain('setLocation("/accountant")');
  });

  it("المدير لسه بيروح على /dashboard (مغيّرناش سلوكه)", () => {
    expect(login).toContain("data.employee.role === 'manager'");
    const m = login.slice(login.indexOf("role === 'manager'"));
    expect(m.slice(0, m.indexOf("else"))).toContain('setLocation("/dashboard")');
  });
});

describe("🔑 صفحات الحسابات بتفتح للمحاسب (FinancialRoute مش ProtectedLayout)", () => {
  it("🔑 FinancialRoute بيدخّل صاحب الصلاحية مش المالك بس", () => {
    const comp = app.slice(app.indexOf("function FinancialRoute"));
    const body = comp.slice(0, comp.indexOf("function BlockFinancialUser"));
    // بيعتمد على الصلاحية من usePermissions، مش على وجود user مالك
    expect(body).toContain("usePermissions()");
    expect(body).toContain('permissions.includes(permission)');
    // جلسة موظف بصلاحيات = مصرّح لها (مش لازم user مالك)
    expect(body).toContain("Boolean(user) || permissions.length > 0");
    // اللي مالوش الصلاحية بيتحوّل، مش بيتفرجّ على قشرة فاضية
    expect(body).toContain("Redirect");
  });

  it("🔑 كل صفحات الحسابات اتغلّفت بـFinancialRoute بصلاحية الصفحة", () => {
    const routeBlock = app.slice(app.indexOf('path="/accounting"'), app.indexOf('path={"/facebook-entry"}'));
    // مفيش ProtectedLayout فاضل جوه بلوك الحسابات — كله FinancialRoute
    expect(routeBlock).not.toContain("ProtectedLayout");
    for (const perm of [
      'permission="accounting.view"',
      'permission="payroll.view"',
      'permission="ad_spend.view"',
      'permission="shipping_finance.view"',
      'permission="inventory_costing.view"',
    ]) {
      expect(routeBlock, perm).toContain(perm);
    }
  });

  it("🔑 المخزون التشغيلي (استلام/تحويل/ورشة) بصلاحية inventory_costing مش مالية", () => {
    // المدير معاه inventory_costing، فلازم صفحات المخزون دي تبقى عليها مش على accounting
    for (const path of ["/goods-receipt", "/stock-transfer", "/workshop-returns"]) {
      const r = app.slice(app.indexOf(`path="${path}"`));
      expect(r.slice(0, r.indexOf("</Route>")))
        .toContain('permission="inventory_costing.view"');
    }
  });
});

describe("🔑 المحاسب محجوب عن صفحات التشغيل", () => {
  it("🔑 BlockFinancialUser بيحوّل صاحب accounting.view غير المالك للحسابات", () => {
    const comp = app.slice(app.indexOf("function BlockFinancialUser"), app.indexOf("function Router"));
    expect(comp).toContain('user?.role !== "admin" && permissions.includes("accounting.view")');
    // بعد P2-A: التحويل بقى لمساحة المحاسب /accountant.
    expect(comp).toContain('Redirect to="/accountant"');
  });

  it("🔑 لوحات الموظفين التشغيلية متغلّفة بالحارس", () => {
    for (const path of [
      "/employee-dashboard", "/warehouse-dashboard", "/manager-dashboard",
      "/today-shipments", "/shipping-schedule", "/facebook-entry",
    ]) {
      const r = app.slice(app.indexOf(`path={"${path}"}`), app.indexOf(`path={"${path}"}`) + 200);
      expect(r, path).toContain("BlockFinancialUser");
    }
  });
});

describe("🔑 قايمة الأنشطة اتفتحت للموظف (tenant-scoped) عشان الحسابات تشتغل", () => {
  it("🔑 activeList/groups/groupsWithBusinesses بقوا authenticatedProcedure", () => {
    expect(routers).toContain("activeList: authenticatedProcedure");
    expect(routers).toContain("groups: authenticatedProcedure");
    expect(routers).toContain("groupsWithBusinesses: authenticatedProcedure");
    expect(routers).toContain("businessIdsByGroup: authenticatedProcedure");
  });

  it("🔑 النطاق على نطاق الجلسة (sessionBusinessIds) — فالموظف بيشوف نشاطه بس", () => {
    // P0: الـswitcher بقى بيمرّ من sessionBusinessIds — للمالك كل الأنشطة، للموظف نشاطه.
    const fn = routers.slice(
      routers.indexOf("activeList: authenticatedProcedure"),
      routers.indexOf("groups: authenticatedProcedure")
    );
    expect(fn).toContain("sessionBusinessIds(ctx)");
    expect(fn).not.toContain("getBusinessIdsForTenant(ctx.tenantId)");
    expect(fn).not.toContain("ctx.user");
  });

  it("🔑 الحجب المالي على السيرفر لسه زي ما هو (مغيّرناهوش)", () => {
    // المدير ممنوع من المالي، والمحاسب/المالك بس بيعدّوا — نفس البوابة القديمة
    expect(trpcCore).toContain('ctx.employee?.role === "manager" && isFinancialPermission(permission)');
    expect(trpcCore).toContain('ctx.user?.role === "admin"');
  });
});
