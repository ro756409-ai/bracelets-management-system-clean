import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حراس ربط واجهة الجرد (P2-C.2 UI) — نصّية عن قصد (زي باقي حراس الواجهة في المشروع:
 * البيئة node مفيش DOM). بتقفل على:
 *   • route مستقل /stocktake تحت FinancialRoute بصلاحية inventory_costing.view.
 *   • بند "الجرد" في القائمة الجانبية (مجموعة المخزون) adminOnly.
 *   • زر الاعتماد بيظهر فقط لـpending_approval + صاحب inventory_costing.approve.
 *   • الاعتماد بيستخدم endpoint الموجود accountingV2.stocktakeApprove.
 *   • صفحة Stocktake بتعيد استخدام AccStocktake (مفيش نظام موازي) بنشاط مقيّد P0.
 */

const app = fs.readFileSync("client/src/App.tsx", "utf-8");
const nav = fs.readFileSync("client/src/config/navigation.ts", "utf-8");
const page = fs.readFileSync("client/src/pages/Stocktake.tsx", "utf-8");
const acc = fs.readFileSync("client/src/pages/accountant/AccStocktake.tsx", "utf-8");

describe("🔑 route /stocktake محمي", () => {
  it("🔑 /stocktake تحت FinancialRoute بصلاحية inventory_costing.view", () => {
    const block = app.slice(app.indexOf('path="/stocktake"'), app.indexOf('path="/stocktake"') + 220);
    expect(block).toContain('FinancialRoute permission="inventory_costing.view"');
    expect(block).toContain("<Stocktake />");
  });
  it("🔑 مش bare — تحت DashboardLayout (FinancialRoute بدون bare)", () => {
    const block = app.slice(app.indexOf('path="/stocktake"'), app.indexOf('path="/stocktake"') + 220);
    expect(block).not.toContain("bare");
  });
});

describe("🔑 بند التنقّل للجرد (config/navigation)", () => {
  const inv = nav.slice(nav.indexOf('key: "inventory"'), nav.indexOf('key: "team"'));
  it("🔑 بند الجرد → /stocktake ومقيّد بصلاحية inventory_costing.view", () => {
    expect(inv).toContain('path: "/stocktake"');
    // مش مكشوف للكل — نفس صلاحية الـroute (مش adminOnly، عشان المدير كمان يوصله).
    const line = inv.slice(inv.indexOf('path: "/stocktake"') - 60, inv.indexOf('path: "/stocktake"') + 90);
    expect(line).toContain('inventory_costing.view');
  });
  it("🔑 البند جوّه وجهة المخزون (جنب إذن الاستلام)", () => {
    expect(inv).toContain('path: "/stocktake"');
    expect(inv).toContain('path: "/goods-receipt"');
  });
});

describe("🔑 صفحة Stocktake بتعيد استخدام AccStocktake (P0-scoped)", () => {
  it("🔑 مصدر النشاط useBrandOptions (نطاق الجلسة) + AccStocktake", () => {
    expect(page).toContain("useBrandOptions");
    expect(page).toContain("<AccStocktake businessId={selectedId}");
  });
  it("🔑 مفيش أي businessId ثابت/مُمرَّر يدوي (مفيش bypass لـP0)", () => {
    expect(page).not.toMatch(/businessId=\{[0-9]+\}/);
  });
});

describe("🔑 زر الاعتماد: صلاحية + حالة", () => {
  it("🔑 canApprove من usePermission('inventory_costing.approve')", () => {
    expect(acc).toContain('usePermission("inventory_costing.approve")');
  });
  it("🔑 الزر بيظهر فقط لـpending_approval + canApprove", () => {
    expect(acc).toContain("isPendingApproval && canApprove");
    expect(acc).toContain('data?.status === "pending_approval"');
  });
  it("🔑 بيستخدم endpoint الموجود accountingV2.stocktakeApprove", () => {
    expect(acc).toContain("trpc.accountingV2.stocktakeApprove.useMutation");
  });
  it("🔑 بعد الاعتماد بيعمل invalidate للجلسة والقائمة", () => {
    const block = acc.slice(acc.indexOf("stocktakeApprove.useMutation"), acc.indexOf("stocktakeApprove.useMutation") + 500);
    expect(block).toContain("stocktakeGet.invalidate");
    expect(block).toContain("stocktakeList.invalidate");
  });
  it("🔑 إدخال الكمية للمسودة فقط (بعد الاعتماد read-only)", () => {
    // العدد الفعلي input بيظهر لـisDraft بس؛ أي حالة تانية span للعرض.
    expect(acc).toContain("isDraft ? (");
  });
});
