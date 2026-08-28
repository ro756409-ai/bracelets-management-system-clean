import { describe, it, expect } from "vitest";
import fs from "fs";
import { TRPCError } from "@trpc/server";
import { router, permissionProcedure } from "./_core/trpc";

/**
 * استلام البضاعة في مساحة المحاسب: إصلاح payload الـitems + تعديل/حذف المسودة الآمن.
 *
 * الثوابت المقفولة:
 *   • الواجهة بتبعت الحقل باسم `items` (مش `lines`) زي ما الـschema مستنيه.
 *   • تعديل/حذف المسودة على inventory_costing.manage (المحاسب معاه) — مش approve.
 *   • الخدمة بترفض أي حالة غير draft (اللي حرّك مخزون مايتلمسش).
 *   • مفيش أي حركة مخزون في التعديل/الحذف.
 *   • التعديل بيحدّث نفس المسودة — مابيعملش receipt جديد.
 */

const goods = fs.readFileSync("client/src/pages/accountant/AccGoodsReceipt.tsx", "utf-8");
const svc = fs.readFileSync("server/inventoryV2.service.ts", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const code = svc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
const updateFn = code.slice(
  code.indexOf("export async function updatePurchaseReceiptDraft"),
  code.indexOf("export async function deletePurchaseReceiptDraft")
);
const deleteFn = code.slice(
  code.indexOf("export async function deletePurchaseReceiptDraft"),
  code.indexOf("export async function recordOpeningInTransit")
);

describe("🔑 payload الاستلام بيستخدم items", () => {
  it("🔑 الواجهة بتبعت items مش lines", () => {
    expect(goods).toContain("items,");        // نفس القايمة للإنشاء والتعديل
    expect(goods).not.toContain("lines:");
    expect(goods).toContain("purchaseReceiptCreate");
    expect(goods).toContain("purchaseReceiptDraftUpdate");
    expect(goods).toContain("purchaseReceiptDraftDelete");
  });
});

describe("🔑 خدمة تعديل/حذف المسودة — draft فقط، بدون مخزون", () => {
  it("🔑 التعديل بيرفض أي حالة غير draft", () => {
    expect(updateFn).toContain('receipt.status !== "draft"');
  });
  it("🔑 الحذف بيرفض أي حالة غير draft", () => {
    expect(deleteFn).toContain('receipt.status !== "draft"');
  });
  it("🔑 الحذف مافيهوش أي حركة مخزون/مالية", () => {
    for (const forbidden of ["applyStockIn", "applyStockOut", "mirrorLegacyStock", "inventoryTransactions", "inventoryBalances", "addTreasuryTransaction"]) {
      expect(deleteFn, forbidden).not.toContain(forbidden);
    }
    // بيمسح البنود ثم الرأس فقط
    expect(deleteFn).toContain("delete(purchaseReceiptItems)");
    expect(deleteFn).toContain("delete(purchaseReceipts)");
  });
  it("🔑 التعديل مافيهوش أي حركة مخزون", () => {
    for (const forbidden of ["applyStockIn", "applyStockOut", "mirrorLegacyStock", "inventoryTransactions", "inventoryBalances"]) {
      expect(updateFn, forbidden).not.toContain(forbidden);
    }
  });
  it("🔑 التعديل بيحدّث نفس المسودة — مابيعملش receipt جديد", () => {
    expect(updateFn).toContain("update(purchaseReceipts)");
    expect(updateFn).not.toContain("insert(purchaseReceipts)");
    // استبدال البنود = مسح + إدخال في purchaseReceiptItems (مش رأس جديد)
    expect(updateFn).toContain("delete(purchaseReceiptItems)");
    expect(updateFn).toContain("insert(purchaseReceiptItems)");
  });
});

describe("🔑 الصلاحية: تعديل/حذف المسودة على manage مش approve", () => {
  it("🔑 الـendpointين على inventory_costing.manage", () => {
    expect(routers).toContain('purchaseReceiptDraftUpdate: permissionProcedure("inventory_costing.manage")');
    expect(routers).toContain('purchaseReceiptDraftDelete: permissionProcedure("inventory_costing.manage")');
  });
  it("🔑 مش على inventory_costing.approve", () => {
    // مقصور على endpointي المسودة بس — بعدهم بيبدأ بلوك الجرد اللي فيه approve شرعي.
    const block = routers.slice(routers.indexOf("purchaseReceiptDraftUpdate"), routers.indexOf("stocktakeCreate"));
    expect(block).not.toContain('permissionProcedure("inventory_costing.approve")');
  });
});

// البوابة الحقيقية: المحاسب بيعدّي على manage (يقدر يعدّل/يحذف مسودة)، ومايعدّيش على approve.
const gate = router({
  draftEdit: permissionProcedure("inventory_costing.manage").query(() => "ok" as const),
  approve: permissionProcedure("inventory_costing.approve").query(() => "ok" as const),
});
const empCtx = (role: string) => ({ user: null, employee: { id: 9, role }, tenantId: 1 });
async function allowed(ctx: any, key: "draftEdit" | "approve") {
  try { await gate.createCaller(ctx)[key](); return true; }
  catch (e) { if (e instanceof TRPCError && e.code === "FORBIDDEN") return false; throw e; }
}

describe("🔑 بوابة المحاسب على تعديل/حذف المسودة", () => {
  it("🔑 المحاسب يقدر (manage) — ومايقدرش يعتمد (approve)", async () => {
    expect(await allowed(empCtx("accountant"), "draftEdit")).toBe(true);
    expect(await allowed(empCtx("accountant"), "approve")).toBe(false);
  });
});

describe("🔑 الواجهة: تعديل/حذف للمسودة فقط", () => {
  it("🔑 الأزرار بتظهر لـdraft بس، والباقي «—»", () => {
    expect(goods).toContain('const isDraft = r.status === "draft"');
    expect(goods).toContain("isDraft ? (");
    expect(goods).toContain("startEdit(r)");
    expect(goods).toContain("doDelete(r)");
  });
  it("🔑 التعديل بيحمّل السجل في الفورم (مش بيفتح فورم فاضي)", () => {
    expect(goods).toContain("const startEdit");
    expect(goods).toContain("setEditId(r.id)");
    expect(goods).toContain("receiptItems.filter(it => it.receiptId === r.id)");
  });
  it("🔑 الحذف فيه تأكيد + Refresh", () => {
    expect(goods).toContain("confirm(");
    expect(goods).toContain("del.mutate");
    expect(goods).toContain("await refresh()");
  });
});
