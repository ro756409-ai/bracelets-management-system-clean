import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import {
  isFrozenAccountingWrite,
  isAccountingModuleEnabled,
  ACCOUNTING_FROZEN_MESSAGE,
  FROZEN_ACCOUNTING_WRITE_PERMISSIONS,
} from "./permissions";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

/**
 * تجميد النظام المحاسبي الحالي: عمليات الكتابة المحاسبية متوقّفة لكل المستخدمين، الواجهة
 * مخفية، و/accountant لا يفتح. المخزون/الشحن/الأوردرات وقراءات التشغيل تفضل شغّالة، ومفيش
 * حذف بيانات/جداول/كود.
 */
const trpc = fs.readFileSync("server/_core/trpc.ts", "utf-8");
const nav = fs.readFileSync("client/src/config/navigation.ts", "utf-8");
const app = fs.readFileSync("client/src/App.tsx", "utf-8");
const login = fs.readFileSync("client/src/pages/EmployeeLogin.tsx", "utf-8");

const ADMIN_CTX = (): TrpcContext =>
  ({
    user: { id: 1, role: "admin", name: "Owner" } as any,
    employee: null,
    tenantId: 1,
    req: { protocol: "https", headers: {}, cookies: {} } as any,
    res: { clearCookie: () => {}, cookie: () => {} } as any,
  }) as any;

async function errOf(fn: () => Promise<any>): Promise<{ code?: string; message?: string }> {
  try { await fn(); return {}; } catch (e: any) { return { code: e?.code, message: e?.message }; }
}

afterEach(() => {
  process.env.ACCOUNTING_MODULE_ENABLED = "true"; // نرجّع وضع الاختبارات الافتراضي
});

describe("🔑 منطق التجميد (نقي)", () => {
  it("🔑 الافتراضي في التطبيق مجمّد (بدون env → غير مفعّل)", () => {
    const prev = process.env.ACCOUNTING_MODULE_ENABLED;
    delete process.env.ACCOUNTING_MODULE_ENABLED;
    expect(isAccountingModuleEnabled()).toBe(false);
    process.env.ACCOUNTING_MODULE_ENABLED = prev;
  });

  it("🔑 عمليات الكتابة المحاسبية مجمّدة لما النظام مطفّي", () => {
    process.env.ACCOUNTING_MODULE_ENABLED = "false";
    for (const p of [
      "accounting.manage", "financial_accounts.manage",
      "closing.create", "closing.approve", "closing.lock",
      "ad_spend.manage", "payroll.manage", "payroll.pay",
      "treasury.transfer", "settlements.create",
    ] as const) {
      expect(isFrozenAccountingWrite(p)).toBe(true);
    }
  });

  it("🔑 القراءات والمخزون والشحن التشغيلي والأوردرات مش مجمّدة (تشغيل مستمر)", () => {
    process.env.ACCOUNTING_MODULE_ENABLED = "false";
    for (const p of [
      "accounting.view", "closing.view", "financial_accounts.view", "payroll.view",
      "inventory_costing.view", "inventory_costing.manage", "inventory_costing.approve",
      "shipping_finance.view", "shipping_finance.manage", "shipping_ops.view",
      "settings.manage", "orders.create", "orders.confirm", "dashboard.view",
    ] as const) {
      expect(isFrozenAccountingWrite(p)).toBe(false);
    }
  });

  it("🔑 لما النظام مفعّل، مفيش شيء مجمّد (المنطق الداخلي محفوظ للنظام القادم)", () => {
    process.env.ACCOUNTING_MODULE_ENABLED = "true";
    for (const p of FROZEN_ACCOUNTING_WRITE_PERMISSIONS) {
      expect(isFrozenAccountingWrite(p)).toBe(false);
    }
  });
});

describe("🔑 نقطة التجميد الحقيقية (permissionProcedure)", () => {
  it("🔑 المالك برضه ممنوع من عملية محاسبية أثناء التجميد", async () => {
    process.env.ACCOUNTING_MODULE_ENABLED = "false";
    const e = await errOf(() =>
      appRouter.createCaller(ADMIN_CTX()).accountingV2.closingCreate({ businessId: 1 } as any)
    );
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toBe(ACCOUNTING_FROZEN_MESSAGE);
  });

  it("🔑 لما النظام مفعّل، رسالة التجميد ماتظهرش (المسار بيكمّل لمنطقه)", async () => {
    process.env.ACCOUNTING_MODULE_ENABLED = "true";
    const e = await errOf(() =>
      appRouter.createCaller(ADMIN_CTX()).accountingV2.closingCreate({ businessId: 1 } as any)
    );
    expect(e.message).not.toBe(ACCOUNTING_FROZEN_MESSAGE);
  });
});

describe("🔑 حراس المصدر — إخفاء وتعطيل الواجهة", () => {
  it("🔑 permissionProcedure فيه نقطة تجميد واحدة", () => {
    expect(trpc).toContain("isFrozenAccountingWrite(permission)");
    expect(trpc).toContain("ACCOUNTING_FROZEN_MESSAGE");
  });
  it("🔑 رابط الحسابات متخفي من القائمة لكل المستخدمين", () => {
    // visibleToolsLinks مابيضيفش ACCOUNTING_LINK
    const fn = nav.slice(nav.indexOf("export function visibleToolsLinks"), nav.indexOf("export function visibleToolsLinks") + 400);
    expect(fn).not.toContain("ACCOUNTING_LINK");
    expect(fn).toContain("return TOOLS_LINKS.filter");
  });
  it("🔑 كل مسارات الحسابات بتعرض صفحة قيد التطوير، و/accountant مش AccountantWorkspace", () => {
    for (const path of [
      "/accounting", "/treasury", "/expenses", "/collections", "/supplier-statements",
      "/salary-profiles", "/salary-preparation", "/payroll", "/closings", "/daily-ledger",
      "/daily-collections", "/advertising", "/accounting-settings", "/shipping-finance",
    ]) {
      expect(app).toContain(`<Route path="${path}"><AccountingDisabled /></Route>`);
    }
    // /accountant بقى صفحة آمنة مش AccountantWorkspace
    const acc = app.slice(app.indexOf('path={"/accountant"}'), app.indexOf('path={"/accountant"}') + 120);
    expect(acc).toContain("<AccountingDisabled />");
    expect(acc).not.toContain("AccountantWorkspace");
  });
  it("🔑 مسارات المخزون مش متأثرة (تفضل شغّالة)", () => {
    expect(app).toContain('<FinancialRoute permission="inventory_costing.view"><GoodsReceipt /></FinancialRoute>');
    expect(app).toContain('<FinancialRoute permission="inventory_costing.view"><Stocktake /></FinancialRoute>');
  });
  it("🔑 المحاسب مايتوجّهش لـ/accountant عند الدخول", () => {
    expect(login).toContain('setLocation("/accounting-disabled")');
    expect(login).not.toContain('setLocation("/accountant")');
  });
});

describe("🔑 لا حذف بيانات/جداول/كود داخلي", () => {
  it("🔑 خدمات وكود الحسابات الداخلي لسه موجود (مش محذوف)", () => {
    expect(fs.existsSync("server/accountingV2.service.ts")).toBe(true);
    expect(fs.existsSync("server/closingV2.service.ts")).toBe(true);
    expect(fs.existsSync("server/payrollV2.service.ts")).toBe(true);
    expect(fs.existsSync("server/expensesV2.service.ts")).toBe(true);
  });
  it("🔑 التجميد نفسه بلا migration/تعديل schema (flag فقط)", () => {
    // التجميد code-only (flag + توجيه). مفيش أي migration محاسبية. لو موجود 0036 فهو مهمة
    // منفصلة (عمود مُنشئ الأوردر لموظف الإدخال)، مش تغيير schema محاسبي.
    const migrations = fs.readdirSync("drizzle").filter(f => f.endsWith(".sql"));
    const accountingMigration = migrations.some(
      f => /accounting|expense|payroll|closing|treasury|financial/i.test(f)
    );
    expect(accountingMigration).toBe(false);
  });
});
