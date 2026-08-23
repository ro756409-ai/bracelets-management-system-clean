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
const acc = (f: string) => fs.readFileSync(`client/src/pages/accountant/${f}`, "utf-8");
const accExpenses = acc("AccExpenses.tsx");
const accGoods = acc("AccGoodsReceipt.tsx");
const accCollections = acc("AccCollections.tsx");
const accWorkshop = acc("AccWorkshop.tsx");
const accStocktake = acc("AccStocktake.tsx");

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
  it("🔑 تابات المحاسب بتنده endpoints النظام الموجودة — مفيش ledger/جدول موازي", () => {
    // كل تاب بيعيد استخدام مسار موجود:
    expect(accExpenses).toContain("trpc.accounting.expenseList");
    expect(accExpenses).toContain("trpc.accountingV2.expenseRecordSimple");
    expect(accGoods).toContain("trpc.accountingV2.purchaseReceiptCreate");
    expect(accCollections).toContain("trpc.accountingV2.dailySettlementRecord");
    expect(accWorkshop).toContain("trpc.suppliers.payment");
    expect(accWorkshop).toContain("trpc.suppliers.statement");
  });
  it("🔑 حساب الورشة على supplierLedger الموجود — مفيش ledger جديد", () => {
    // مفيش أي إنشاء جدول/كتابة خام؛ كله عبر suppliers.* + reverseMovement الآمن.
    expect(accWorkshop).toContain("trpc.suppliers.reverseMovement");
    expect(accWorkshop).not.toContain("mysqlTable");
  });
  it("🔑 الاستلام: المحاسب بينشئ ويرسل فقط — مفيش نداء approve/void", () => {
    expect(accGoods).toContain("purchaseReceiptSubmit");
    expect(accGoods).not.toContain("purchaseReceiptApprove");
    expect(accGoods).not.toContain("purchaseReceiptVoid");
  });
  it("🔑 التحصيلات: إلغاء آمن (void) مش hard delete", () => {
    expect(accCollections).toContain("trpc.accountingV2.dailySettlementVoid");
    expect(accCollections).not.toContain(".delete");
  });
  it("تاب الجرد placeholder «قيد التجهيز» (P2-C)", () => {
    expect(accStocktake).toContain("قيد التجهيز");
  });
});

describe("🔑 إصلاح الـlogout للمحاسب", () => {
  const main = fs.readFileSync("client/src/main.tsx", "utf-8");
  it("🔑 /accountant ضمن EMPLOYEE_PATHS — مايتحوّلش لـManus OAuth على UNAUTHORIZED", () => {
    const list = main.slice(main.indexOf("EMPLOYEE_PATHS"), main.indexOf("]", main.indexOf("EMPLOYEE_PATHS")));
    expect(list).toContain("/accountant");
  });
  it("🔑 القراءات اللي المحاسب محتاجها بقت authenticatedProcedure (tenant-scoped)", () => {
    const routers = fs.readFileSync("server/routers.ts", "utf-8");
    // products.list / variants.all / businesses.warehouses / employees.list
    expect(routers).toMatch(/products: router\(\{[\s\S]{0,220}list: authenticatedProcedure/);
    expect(routers).toContain("all: authenticatedProcedure");
    expect(routers).toContain("warehouses: authenticatedProcedure");
    expect(routers).toMatch(/employees: router\(\{[\s\S]{0,260}list: authenticatedProcedure/);
  });
});

/**
 * BUG: كل التابات كانت بتطلع فاضية + «مفيش نشاط متاح لحسابك» — لأن businessId كان
 * بيتاخد من currentBusinessIds (المرتبطة بالـgroup)، واللي بتبقى undefined لو النشاط
 * مالوش group. الإصلاح: المصدر بقى businesses (activeList المسطّحة، tenant-scoped).
 */
describe("🔑 اختيار النشاط في مساحة المحاسب من activeList مش الـgroup", () => {
  const workspace = fs.readFileSync("client/src/pages/AccountantWorkspace.tsx", "utf-8");

  it("🔑 businessId من businesses مش currentBusinessIds", () => {
    expect(workspace).toContain("const businessId = picked ?? options[0]?.id ?? null");
    expect(workspace).toContain("businesses ?? []");
    // مابيعتمدش على الـgroup خالص
    expect(workspace).not.toContain("currentBusinessIds");
    expect(workspace).not.toContain("scopeIds");
  });

  it("🔑 لو الـgroup فاضي (currentBusinessIds=undefined) وفيه نشاط → businessId مش null والتابات بترندر", () => {
    // نفس معادلة الحسم بالظبط، مستقلة عن أي group.
    const resolve = (picked: number | null, opts: { id: number }[]) =>
      picked ?? opts[0]?.id ?? null;
    // currentBusinessIds=undefined مالهاش أي دخل — المصدر هو activeList:
    expect(resolve(null, [{ id: 7 }])).toBe(7);   // نشاط متاح → يترندر
    expect(resolve(null, [])).toBe(null);          // مفيش أي نشاط → الرسالة تظهر (صح)
    expect(resolve(3, [{ id: 7 }])).toBe(3);        // اختيار المستخدم بيغلب
    // والحارس بيقفل على businessId==null بس، مش على الـgroup
    expect(workspace).toContain("businessId == null");
  });

  it("🔑 المنتقي بيعرض كل أنشطة الـtenant (options) مش المفلترة بالـgroup", () => {
    expect(workspace).toContain("options.length > 1");
    expect(workspace).toContain("options.map(b =>");
    expect(workspace).not.toContain("scopedBusinesses");
  });
});
