import { describe, it, expect } from "vitest";
import fs from "fs";
import { TRPCError } from "@trpc/server";
import { router, permissionProcedure } from "./_core/trpc";
import { toMinorUnits, fromMinorUnits } from "../shared/accountingMoney";

/**
 * الجرد — P2-C.1 (عدّ/إرسال) + P2-C.2 (اعتماد).
 *
 * العدّ والإرسال (draft) مابيحركوش مخزون. الاعتماد (pending_approval → approved):
 *   • بيمرّ بمحرك التكلفة (applyStockIn/Out) ومحرك الأحداث (createBusinessEvent) الموجودين
 *     — مفيش منطق مخزون/محاسبة موازي.
 *   • delta المجمّد بيتطبّق على الرصيد الحالي (مش recompute، مش set-to-counted).
 *   • عجز = applyStockOut بالمتوسط الحالي؛ زيادة = applyStockIn بتكلفة اللقطة.
 *   • حدث immutable واحد `inventory.stocktake_approved` بمفتاح `stocktake:{id}:approved`.
 *   • الخسارة/الربح بيدخلوا الإقفال وrealized-profit من نفس الحدث (مفيش تعديل ربح مباشر).
 *   • approve على inventory_costing.approve بس + maker-checker.
 */

const svc = fs.readFileSync("server/stocktake.service.ts", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");
const sql = fs.readFileSync("drizzle/manual/stocktake.sql", "utf-8");
const closingV2 = fs.readFileSync("server/closingV2.service.ts", "utf-8");
const accountingV2 = fs.readFileSync("server/accountingV2.service.ts", "utf-8");

describe("🔑 P2-C.2: الاعتماد بيعيد استخدام المحرك الموجود (مفيش منطق موازي)", () => {
  const fn = svc.slice(svc.indexOf("export async function approveStocktake"));
  it("🔑 concurrency: delta على الرصيد الحالي — مفيش recompute/set-to-counted", () => {
    // بيستخدم differenceQuantity المجمّد كـdelta، مش بيعيد حسابه من الرصيد الحالي.
    expect(fn).toContain("line.differenceQuantity");
    expect(fn).not.toContain("countedQuantity -");
    expect(fn).not.toContain("- systemQuantity");
  });
  it("🔑 عجز=applyStockOut، زيادة=applyStockIn (نفس المحرك)", () => {
    expect(fn).toContain("applyStockOut(state, -line.differenceQuantity)");
    expect(fn).toContain("applyStockIn(state, line.differenceQuantity, line.unitCostSnapshot)");
  });
  it("🔑 transaction واحدة + FOR UPDATE للهيدر والأرصدة", () => {
    expect(fn).toContain("db.transaction");
    expect(fn.match(/\.for\("update"\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
  it("🔑 حدث immutable واحد بمفتاح ثابت — replay-safe", () => {
    expect(fn).toContain('idempotencyKey: `stocktake:${header.id}:approved`');
    expect(fn).toContain('eventType: "inventory.stocktake_approved"');
    expect(fn).toContain("if (eventResult.duplicate)");
  });
  it("🔑 الاعتماد لـpending_approval بس + UPDATE مشروط بالحالة (منع double)", () => {
    expect(fn).toContain('header.status !== "pending_approval"');
    expect(fn).toContain('eq(stocktakes.status, "pending_approval")');
    expect(fn).toContain("!== 1"); // بيتأكد إن صف واحد اتغيّر
  });
  it("🔑 maker-checker: منشئ الجلسة مايعتمدهاش إلا لو allowSelfApproval", () => {
    expect(fn).toContain("header.createdBy === input.actor.id && !input.allowSelfApproval");
  });
  it("🔑 بيكتب inventory_transactions مربوطة بالحدث والبند (traceable)", () => {
    expect(fn).toContain("businessEventId: eventId");
    expect(fn).toContain('sourceType: "stocktake_line"');
    expect(fn).toContain("sourceId: row.lineId");
  });
});

describe("🔑 الخسارة/الربح بيدخلوا من نفس business-event replay", () => {
  it("🔑 closingV2 بيشتق inventory_loss + inventory_gain من الحدث", () => {
    const block = closingV2.slice(closingV2.indexOf('case "inventory.stocktake_approved"'), closingV2.indexOf('default:'));
    expect(block).toContain('lineType: "inventory_loss"');
    expect(block).toContain('lineType: "inventory_gain"');
    expect(closingV2).toContain("- totals.inventoryLoss + totals.inventoryGain");
  });
  it("🔑 computeRealizedProfit بيعكس الخسارة (scrapLoss) والربح (inventoryGain)", () => {
    expect(accountingV2).toContain('event.eventType === "inventory.stocktake_approved"');
    expect(accountingV2).toContain("inventoryGain +=");
    expect(accountingV2).toContain("scrapLoss +\n    inventoryGain");
  });
  it("🔑 مفيش تعديل ربح مباشر — الاعتماد بيكتب حدث بس، مش أرقام ربح", () => {
    expect(svc).not.toContain("netProfit");
    expect(svc).not.toContain("realizedProfit");
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

describe("🔑 صلاحيات الجرد: view/manage للعدّ، approve للاعتماد", () => {
  it("🔑 create/lineUpdate/submit على manage", () => {
    expect(routers).toContain('stocktakeCreate: permissionProcedure("inventory_costing.manage")');
    expect(routers).toContain('stocktakeLineUpdate: permissionProcedure("inventory_costing.manage")');
    expect(routers).toContain('stocktakeSubmit: permissionProcedure("inventory_costing.manage")');
  });
  it("🔑 list/get على view", () => {
    expect(routers).toContain('stocktakeList: permissionProcedure("inventory_costing.view")');
    expect(routers).toContain('stocktakeGet: permissionProcedure("inventory_costing.view")');
  });
  it("🔑 approve على inventory_costing.approve + allowSelfApproval للمالك فقط", () => {
    expect(routers).toContain('stocktakeApprove: permissionProcedure("inventory_costing.approve")');
    const block = routers.slice(routers.indexOf("stocktakeApprove:"), routers.indexOf("stocktakeApprove:") + 700);
    expect(block).toContain("allowSelfApproval: isOwnerRole(ctx.employee?.role)");
    expect(block).toContain("requireScopedBusinessId(ctx, input.businessId)");
  });
  it("🔑 كل الـendpoints (بما فيهم approve) tenant-scoped", () => {
    const block = routers.slice(routers.indexOf("stocktakeCreate:"), routers.indexOf("returnInspectionSubmit:"));
    expect((block.match(/requireScopedBusinessId/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});

const gate = router({
  manage: permissionProcedure("inventory_costing.manage").query(() => "ok" as const),
  view: permissionProcedure("inventory_costing.view").query(() => "ok" as const),
  approve: permissionProcedure("inventory_costing.approve").query(() => "ok" as const),
});
const empCtx = (role: string) => ({ user: null, employee: { id: 9, role }, tenantId: 1 });
async function allowed(ctx: any, key: "manage" | "view" | "approve") {
  try { await gate.createCaller(ctx)[key](); return true; }
  catch (e) { if (e instanceof TRPCError && e.code === "FORBIDDEN") return false; throw e; }
}

describe("🔑 بوابة الجرد", () => {
  it("🔑 المحاسب يقدر يعدّ ويشوف — لكن مايعتمدش (فاصل maker-checker)", async () => {
    expect(await allowed(empCtx("accountant"), "manage")).toBe(true);
    expect(await allowed(empCtx("accountant"), "view")).toBe(true);
    expect(await allowed(empCtx("accountant"), "approve")).toBe(false);
  });
  it("🔑 المالك/المدير يقدروا يعتمدوا", async () => {
    for (const role of ["super_admin", "admin", "manager"]) {
      expect(await allowed(empCtx(role), "approve"), role).toBe(true);
    }
  });
  it("🔑 دور تشغيلي مرفوض من العدّ والاعتماد", async () => {
    for (const role of ["order_confirmation", "data_entry"]) {
      expect(await allowed(empCtx(role), "manage"), role).toBe(false);
      expect(await allowed(empCtx(role), "approve"), role).toBe(false);
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
