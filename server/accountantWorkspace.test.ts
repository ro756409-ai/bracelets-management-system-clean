import { describe, it, expect } from "vitest";
import fs from "fs";
import { TRPCError } from "@trpc/server";
import { router, permissionProcedure } from "./_core/trpc";
import { hasPermission, permissionsForRole, isFinancialPermission } from "./permissions";

/**
 * P2-A — مساحة المحاسب.
 *
 * الشروط اللي الاختبارات دي بتقفلها:
 *   • المحاسب بياخد `inventory_costing.manage` (يسجّل مسودة استلام) **بس مش**
 *     `inventory_costing.approve` (الاعتماد وتحريك المخزون) — فاصل أمان.
 *   • بوابة السيرفر الحقيقية بتطبّق ده: draft يعدّي، approve يترفض.
 *   • ملخص اللوحة محمي بـaccounting.view، والأدوار التشغيلية مرفوضة.
 *   • التوجيه: المحاسب بيروح /accountant (مش /employee-dashboard ولا صفحة المالك).
 *   • زراري الاعتماد/الإلغاء في الاستلام مخفية عن اللي مالوش approve.
 *   • الملخص تجميع من دوال موجودة — مفيش منطق أرصدة جديد.
 */

// ───────────────── خريطة الصلاحيات ─────────────────

describe("🔑 صلاحية المحاسب في الاستلام: manage بس مش approve", () => {
  it("🔑 المحاسب معاه inventory_costing.manage", () => {
    expect(hasPermission("accountant", "inventory_costing.manage")).toBe(true);
  });
  it("🔑 المحاسب مش معاه inventory_costing.approve", () => {
    expect(hasPermission("accountant", "inventory_costing.approve")).toBe(false);
  });
  it("المحاسب لسه معاه view", () => {
    expect(hasPermission("accountant", "inventory_costing.view")).toBe(true);
  });
  it("🔑 inventory_costing تشغيلي مش مالي (مايكسرش حجب المدير المالي)", () => {
    expect(isFinancialPermission("inventory_costing.manage")).toBe(false);
    expect(isFinancialPermission("inventory_costing.approve")).toBe(false);
  });
  it("المدير لسه معاه manage و approve (تشغيله ماتغيرش)", () => {
    expect(hasPermission("manager", "inventory_costing.manage")).toBe(true);
    expect(hasPermission("manager", "inventory_costing.approve")).toBe(true);
  });
});

// ───────────────── البوابة الحقيقية ─────────────────

const gate = router({
  draft: permissionProcedure("inventory_costing.manage").query(() => "ok" as const),
  approve: permissionProcedure("inventory_costing.approve").query(() => "ok" as const),
  summary: permissionProcedure("accounting.view").query(() => "ok" as const),
});

type Ctx = { user: any; employee: any; tenantId: number | null };
const ownerCtx = (): Ctx => ({ user: { id: 1, role: "admin" }, employee: null, tenantId: 1 });
const empCtx = (role: string): Ctx => ({ user: null, employee: { id: 9, role }, tenantId: 1 });

async function allowed(ctx: Ctx, key: "draft" | "approve" | "summary") {
  try {
    await gate.createCaller(ctx as any)[key]();
    return true;
  } catch (e) {
    if (e instanceof TRPCError && e.code === "FORBIDDEN") return false;
    throw e;
  }
}

describe("🔑 بوابة الاستلام والملخص على السيرفر", () => {
  it("🔑 المحاسب يقدر يسجّل مسودة (manage) — ومايقدرش يعتمد (approve)", async () => {
    expect(await allowed(empCtx("accountant"), "draft")).toBe(true);
    expect(await allowed(empCtx("accountant"), "approve")).toBe(false);
  });
  it("🔑 المحاسب يوصل ملخص اللوحة (accounting.view)", async () => {
    expect(await allowed(empCtx("accountant"), "summary")).toBe(true);
  });
  it("🔑 الأدوار التشغيلية مرفوضة من الملخص والاستلام", async () => {
    for (const role of ["order_confirmation", "data_entry", "moderator"]) {
      expect(await allowed(empCtx(role), "summary"), `${role}/summary`).toBe(false);
      expect(await allowed(empCtx(role), "draft"), `${role}/draft`).toBe(false);
    }
  });
  it("المالك يقدر يعمل كله", async () => {
    expect(await allowed(ownerCtx(), "draft")).toBe(true);
    expect(await allowed(ownerCtx(), "approve")).toBe(true);
    expect(await allowed(ownerCtx(), "summary")).toBe(true);
  });
});

// ───────────────── التوجيه والواجهة (source guards) ─────────────────

const app = fs.readFileSync("client/src/App.tsx", "utf-8");
const login = fs.readFileSync("client/src/pages/EmployeeLogin.tsx", "utf-8");
const goods = fs.readFileSync("client/src/pages/GoodsReceipt.tsx", "utf-8");
const workspace = fs.readFileSync("client/src/pages/AccountantWorkspace.tsx", "utf-8");
const summarySvc = fs.readFileSync("server/accountantSummary.service.ts", "utf-8");

describe("🔑 توجيه المحاسب لمساحته المخصّصة", () => {
  it("🔑 اللوجين بيوجّه accountant لـ/accountant", () => {
    const branch = login.slice(login.indexOf("role === 'accountant'"));
    expect(branch.slice(0, branch.indexOf("else"))).toContain('setLocation("/accountant")');
  });
  it("🔑 مسار /accountant موجود، bare (من غير DashboardLayout)، متحرس بـaccounting.view", () => {
    const r = app.slice(app.indexOf('path={"/accountant"}'));
    const block = r.slice(0, r.indexOf("</Route>"));
    expect(block).toContain('FinancialRoute permission="accounting.view" bare');
    expect(block).toContain("<AccountantWorkspace");
  });
  it("🔑 توجيه الهبوط للمحاسب بقى /accountant مش صفحة المالك", () => {
    // homeForPermissions + BlockFinancialUser الاتنين بيوجّهوا لـ/accountant
    const homeFn = app.slice(app.indexOf("function homeForPermissions"));
    expect(homeFn.slice(0, homeFn.indexOf("}"))).toContain('"/accountant"');
    expect(app).toContain('<Redirect to="/accountant" />');
  });
});

describe("🔑 حماية الاستلام في الواجهة + لا نظام موازي", () => {
  it("🔑 زراري الاعتماد/الإلغاء مربوطة بصلاحية approve", () => {
    expect(goods).toContain('usePermission("inventory_costing.approve")');
    expect(goods).toContain('r.status === "pending_approval" && canApprove');
    expect(goods).toContain('r.status !== "voided" && canApprove');
  });
  it("🔑 مساحة المحاسب بتعيد استخدام صفحات النظام — مفيش تكرار", () => {
    expect(workspace).toContain('from "./Expenses"');
    expect(workspace).toContain('from "./GoodsReceipt"');
    expect(workspace).toContain('from "./SalaryProfiles"');
    expect(workspace).toContain('from "./DailyCollections"');
  });
  it("تاب الجرد placeholder «قيد التجهيز» (P2-C)", () => {
    expect(workspace).toContain("قيد التجهيز");
  });
  it("🔑 الملخص تجميع من دوال موجودة — مفيش منطق أرصدة جديد", () => {
    expect(summarySvc).toContain("getTreasurySummary");
    expect(summarySvc).toContain("getSupplierDashboardTotals");
    expect(summarySvc).toContain("getFinancialAccounts");
    expect(summarySvc).toContain("getPayrollPeriods");
    // مفيش كتابة/تحريك أرصدة
    expect(summarySvc).not.toContain(".insert(");
    expect(summarySvc).not.toContain(".update(");
    expect(summarySvc).not.toContain("addTreasuryTransaction");
  });
});
