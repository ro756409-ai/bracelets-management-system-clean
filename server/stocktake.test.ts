import { describe, it, expect } from "vitest";
import fs from "fs";
import { TRPCError } from "@trpc/server";
import { router, permissionProcedure } from "./_core/trpc";
import { toMinorUnits, fromMinorUnits } from "../shared/accountingMoney";

/**
 * الجرد — P2-C.1: جلسة/عدّ/إرسال فقط.
 *
 * الشروط المقفولة في المرحلة دي:
 *   • **مفيش اعتماد ولا حركة مخزون ولا حدث محاسبي** في الخدمة.
 *   • العدّ والإرسال للمسودة فقط (أي حالة تانية بترفض).
 *   • create/lineUpdate/submit على inventory_costing.manage؛ list/get على .view.
 *   • **مفيش endpoint اعتماد** (stocktakeApprove) في المرحلة دي.
 *   • قيمة الفرق موقّعة ومحسوبة بالـbigint (عجز سالب / زيادة موجب).
 */

const svc = fs.readFileSync("server/stocktake.service.ts", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");
const sql = fs.readFileSync("drizzle/manual/stocktake.sql", "utf-8");

describe("🔑 P2-C.1: مفيش اعتماد/حركة مخزون/محاسبة", () => {
  it("🔑 الخدمة مافيهاش أي حركة مخزون أو حدث محاسبي", () => {
    for (const forbidden of [
      "applyStockIn", "applyStockOut", "mirrorLegacyStock",
      "createBusinessEvent", "inventoryTransactions", "inventory_transactions",
      "closingV2", "computeRealizedProfit", "inventory_loss", "inventory_gain",
    ]) {
      expect(svc, forbidden).not.toContain(forbidden);
    }
  });
  it("🔑 مفيش endpoint اعتماد للجرد في المرحلة دي", () => {
    expect(routers).not.toContain("stocktakeApprove");
  });
  it("🔑 الخدمة بتلمس بس جداول الجرد ولقطة الأرصدة (قراءة)", () => {
    expect(svc).toContain("inventoryBalances"); // للقطة فقط (قراءة)
    expect(svc).toContain(".insert(stocktakes)");
    expect(svc).toContain(".insert(stocktakeLines)");
    expect(svc).not.toContain(".update(inventoryBalances)");
  });
});

describe("🔑 العدّ والإرسال للمسودة فقط", () => {
  it("🔑 updateStocktakeLine بيرفض أي حالة غير draft", () => {
    const fn = svc.slice(svc.indexOf("export async function updateStocktakeLine"), svc.indexOf("export async function submitStocktake"));
    expect(fn).toContain('header.status !== "draft"');
    expect(fn).toContain('.for("update")');
  });
  it("🔑 submitStocktake: draft → pending_approval فقط", () => {
    const fn = svc.slice(svc.indexOf("export async function submitStocktake"));
    expect(fn).toContain('header.status !== "draft"');
    expect(fn).toContain('status: "pending_approval"');
  });
  it("🔑 اللقطة بتبدأ العدّ = الدفتري (الفرق صفر لحد ما يتعدّل)", () => {
    const fn = svc.slice(svc.indexOf("export async function createStocktake"), svc.indexOf("export async function listStocktakes"));
    expect(fn).toContain("systemQuantity: balance.onHandQuantity");
    expect(fn).toContain("countedQuantity: balance.onHandQuantity");
    expect(fn).toContain("unitCostSnapshot: balance.movingAverageCost");
  });
});

describe("🔑 قيمة الفرق موقّعة (bigint)", () => {
  const diffValue = (diff: number, cost: string) => fromMinorUnits(toMinorUnits(cost) * BigInt(diff));
  it("عجز = قيمة سالبة", () => {
    expect(diffValue(-3, "10.0000")).toBe("-30.0000");
  });
  it("زيادة = قيمة موجبة", () => {
    expect(diffValue(2, "15.5000")).toBe("31.0000");
  });
  it("مفيش فرق = صفر", () => {
    expect(diffValue(0, "99.9999")).toBe("0.0000");
  });
});

// ───────────────── الصلاحيات ─────────────────

describe("🔑 صلاحيات الجرد: view/manage — مفيش approve", () => {
  it("🔑 create/lineUpdate/submit على manage", () => {
    expect(routers).toContain('stocktakeCreate: permissionProcedure("inventory_costing.manage")');
    expect(routers).toContain('stocktakeLineUpdate: permissionProcedure("inventory_costing.manage")');
    expect(routers).toContain('stocktakeSubmit: permissionProcedure("inventory_costing.manage")');
  });
  it("🔑 list/get على view", () => {
    expect(routers).toContain('stocktakeList: permissionProcedure("inventory_costing.view")');
    expect(routers).toContain('stocktakeGet: permissionProcedure("inventory_costing.view")');
  });
  it("🔑 كل الـendpoints tenant-scoped", () => {
    const block = routers.slice(routers.indexOf("stocktakeCreate:"), routers.indexOf("returnInspectionSubmit:"));
    // كل واحد بيعدي على requireScopedBusinessId
    expect((block.match(/requireScopedBusinessId/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});

const gate = router({
  manage: permissionProcedure("inventory_costing.manage").query(() => "ok" as const),
  view: permissionProcedure("inventory_costing.view").query(() => "ok" as const),
});
const empCtx = (role: string) => ({ user: null, employee: { id: 9, role }, tenantId: 1 });
async function allowed(ctx: any, key: "manage" | "view") {
  try { await gate.createCaller(ctx)[key](); return true; }
  catch (e) { if (e instanceof TRPCError && e.code === "FORBIDDEN") return false; throw e; }
}

describe("🔑 بوابة الجرد", () => {
  it("🔑 المحاسب يقدر يعدّ ويشوف", async () => {
    expect(await allowed(empCtx("accountant"), "manage")).toBe(true);
    expect(await allowed(empCtx("accountant"), "view")).toBe(true);
  });
  it("🔑 دور تشغيلي مرفوض من العدّ", async () => {
    for (const role of ["order_confirmation", "data_entry"]) {
      expect(await allowed(empCtx(role), "manage"), role).toBe(false);
    }
  });
});

describe("🔑 الجداول: additive فقط", () => {
  it("🔑 stocktakes + stocktake_lines في الـschema", () => {
    expect(schema).toContain('mysqlTable(\n  "stocktakes"');
    expect(schema).toContain('"stocktake_lines"');
  });
  it("🔑 SQL migration للجدولين الجديدين بس — مفيش ALTER لجدول موجود", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS `stocktakes`");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS `stocktake_lines`");
    expect(sql).not.toContain("ALTER TABLE");
    expect(sql).not.toContain("DROP");
  });
});
