import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  ROLLBACK_SAFE_MODE, RollbackSafeBlockedError, isRollbackSafeBlocked, holdsStock, toStockMap, sameStockMap,
  assertCancelAllowed, assertConfirmAllowed, assertStatusChangeAllowed, assertStockNeutralChange,
  assertDeleteAllowed, assertReturnRestoreAllowed, assertProductReassignAllowed, type OrderStockState, type StockLine,
} from "./rollbackSafe";

/**
 * نسخة الرجوع الآمن — منطق الحواجز (بلا قاعدة) + حراس المصدر: كل دالة بتغيّر حالة/بنود أوردر
 * في db.ts بتنادي الحارس تحت قفل صف الأوردر، والويبهوك بيرد 200 بدل 500 عند الرفض.
 */
const st = (status: string, held: StockLine[] = [], uncertain: string | null = null): OrderStockState => ({
  status,
  held: new Map(held.map(l => [l.variantId != null ? `v${l.variantId}` : `p${l.productId}`, l] as [string, StockLine])),
  uncertain,
});
const blocked = (fn: () => void) => {
  try { fn(); return false; } catch (e) { expect(isRollbackSafeBlocked(e)).toBe(true); expect((e as RollbackSafeBlockedError).code).toBe("PRECONDITION_FAILED"); return true; }
};
const V1 = { productId: 10, variantId: 101, qty: 2 };
const V2 = { productId: 10, variantId: 102, qty: 1 };

describe("🛡️ Rollback-Safe — منطق الحواجز", () => {
  it("الوضع مفعّل دايمًا في النسخة دي، والرفض PRECONDITION_FAILED برسالة واضحة", () => {
    expect(ROLLBACK_SAFE_MODE).toBe(true);
    const e = new RollbackSafeBlockedError("x");
    expect(e.code).toBe("PRECONDITION_FAILED");
    expect(e.message).toContain("نسخة رجوع مؤقتة");
    expect(isRollbackSafeBlocked(new Error("x"))).toBe(false);
  });

  it("«ماسك مخزون» بالحالة أو بالحركات: مؤكد بلا حركات، مؤجل بخصم، أو حركة يدوية", () => {
    expect(holdsStock(st("new"))).toBe(false);
    expect(holdsStock(st("confirmed"))).toBe(true); // عصر قديم بلا حركات
    expect(holdsStock(st("postponed", [V1]))).toBe(true); // الحالة وحدها مش دليل
    expect(holdsStock(st("new", [], "حركة يدوية"))).toBe(true);
    expect(holdsStock(st("cancelled"))).toBe(false);
  });

  it("الإلغاء: مسموح لجديد/مؤجل بلا خصم؛ مرفوض لأي أوردر ماسك مخزون (حتى لو حالته مش مؤكد)", () => {
    expect(blocked(() => assertCancelAllowed(st("new")))).toBe(false);
    expect(blocked(() => assertCancelAllowed(st("postponed")))).toBe(false);
    for (const s of ["confirmed", "printed", "preparing", "shipped", "delivered"]) expect(blocked(() => assertCancelAllowed(st(s))), s).toBe(true);
    expect(blocked(() => assertCancelAllowed(st("postponed", [V1])))).toBe(true);
    expect(blocked(() => assertCancelAllowed(st("no_answer", [V1])))).toBe(true);
    expect(blocked(() => assertCancelAllowed(st("new", [], "صافي سالب")))).toBe(true);
  });

  it("التأكيد: ملغي/مرتجع = مرفوض دايمًا (حتى بلا حركات)، وحركات مش موثوقة = مرفوض، والجديد عادي", () => {
    expect(blocked(() => assertConfirmAllowed(st("new")))).toBe(false);
    expect(blocked(() => assertConfirmAllowed(st("postponed")))).toBe(false);
    expect(blocked(() => assertConfirmAllowed(st("cancelled")))).toBe(true);
    expect(blocked(() => assertConfirmAllowed(st("returned")))).toBe(true);
    expect(blocked(() => assertConfirmAllowed(st("new", [], "حركة يدوية")))).toBe(true);
  });

  it("تغيير الحالة المباشر: لا إلغاء لماسك، لا فتح لملغي، لا عبور لحالة خصم من غير خصم مطابق", () => {
    const lines = [V1];
    expect(blocked(() => assertStatusChangeAllowed(st("confirmed"), "cancelled", lines))).toBe(true);
    expect(blocked(() => assertStatusChangeAllowed(st("cancelled"), "new", lines))).toBe(true);
    expect(blocked(() => assertStatusChangeAllowed(st("cancelled"), "confirmed", lines))).toBe(true);
    expect(blocked(() => assertStatusChangeAllowed(st("cancelled"), "postponed", lines))).toBe(true);
    expect(blocked(() => assertStatusChangeAllowed(st("returned", [V1]), "new", lines))).toBe(true);
    expect(blocked(() => assertStatusChangeAllowed(st("returned"), "new", lines))).toBe(false); // مرتجع اترجّع مخزونه
    expect(blocked(() => assertStatusChangeAllowed(st("new"), "confirmed", lines))).toBe(true); // تأكيد بلا خصم
    expect(blocked(() => assertStatusChangeAllowed(st("new"), "shipped", lines))).toBe(true);
    expect(blocked(() => assertStatusChangeAllowed(st("postponed", [V1]), "confirmed", lines))).toBe(false); // خصم مطابق
    expect(blocked(() => assertStatusChangeAllowed(st("postponed", [V1]), "confirmed", [V1, V2]))).toBe(true); // خصم مختلف
    expect(blocked(() => assertStatusChangeAllowed(st("confirmed"), "postponed", lines))).toBe(false);
    expect(blocked(() => assertStatusChangeAllowed(st("confirmed"), "preparing", lines))).toBe(false);
    expect(blocked(() => assertStatusChangeAllowed(st("printed"), "shipped", lines))).toBe(false);
    expect(blocked(() => assertStatusChangeAllowed(st("new"), "postponed", lines))).toBe(false);
    expect(blocked(() => assertStatusChangeAllowed(st("new"), "cancelled", lines))).toBe(false);
  });

  it("تعديل البنود: نفس التركيبات والكميات (حتى بترتيب مختلف) = محايد؛ أي فرق لماسك = مرفوض؛ غير الماسك حر", () => {
    const before = [V1, V2];
    expect(sameStockMap(toStockMap(before), toStockMap([V2, V1]))).toBe(true);
    expect(blocked(() => assertStockNeutralChange(st("confirmed"), before, [V2, V1]))).toBe(false);
    expect(blocked(() => assertStockNeutralChange(st("confirmed"), before, [{ ...V1, qty: 3 }, V2]))).toBe(true);
    expect(blocked(() => assertStockNeutralChange(st("confirmed"), before, [{ ...V1, variantId: 103 }, V2]))).toBe(true);
    expect(blocked(() => assertStockNeutralChange(st("confirmed"), before, [V1]))).toBe(true);
    expect(blocked(() => assertStockNeutralChange(st("postponed", [V1, V2]), before, [V1]))).toBe(true);
    expect(blocked(() => assertStockNeutralChange(st("new"), before, [V1]))).toBe(false);
    // صنف بلا منتج مالوش أثر على المخزون (بند غير متطابق من الموقع)
    expect(sameStockMap(toStockMap([V1, { productId: null, qty: 4 }]), toStockMap([V1]))).toBe(true);
  });

  it("الحذف وتعيين المنتج: مرفوض لماسك المخزون، مسموح لجديد بلا خصم", () => {
    expect(blocked(() => assertDeleteAllowed(st("new")))).toBe(false);
    expect(blocked(() => assertDeleteAllowed(st("confirmed"), "1001"))).toBe(true);
    expect(blocked(() => assertDeleteAllowed(st("postponed", [V1])))).toBe(true);
    expect(blocked(() => assertProductReassignAllowed(st("new")))).toBe(false);
    expect(blocked(() => assertProductReassignAllowed(st("confirmed")))).toBe(true);
  });

  it("المرتجع باسترجاع: مسموح بس لمنتج بسيط واحد بنفس الكمية المخصومة؛ التركيبات = مرفوض", () => {
    expect(blocked(() => assertReturnRestoreAllowed(st("shipped", [{ productId: 20, variantId: null, qty: 2 }]), { productId: 20, quantity: 2 }))).toBe(false);
    expect(blocked(() => assertReturnRestoreAllowed(st("shipped", [V1]), { productId: 10, quantity: 2 }))).toBe(true);
    expect(blocked(() => assertReturnRestoreAllowed(st("shipped", [{ productId: 20, variantId: null, qty: 2 }]), { productId: 20, quantity: 3 }))).toBe(true);
    expect(blocked(() => assertReturnRestoreAllowed(st("shipped"), { productId: 20, quantity: 2 }))).toBe(true); // مفيش خصم مسجّل
  });
});

describe("🛡️ Rollback-Safe — حراس المصدر (كل مسار كتابة بينادي الحارس)", () => {
  const db = fs.readFileSync("server/db.ts", "utf-8");
  const body = (name: string) => {
    const i = db.indexOf(`export async function ${name}(`);
    expect(i, name).toBeGreaterThan(-1);
    const j = db.indexOf("\nexport ", i + 10);
    return db.slice(i, j === -1 ? undefined : j);
  };
  const cases: [string, string][] = [
    ["confirmOrder", "assertConfirmAllowed("],
    ["cancelOrder", "assertCancelAllowed("],
    ["updateOrder", "assertStatusChangeAllowed("],
    ["postponeOrder", "assertStatusChangeAllowed("],
    ["updateOrderWithItems", "assertStockNeutralChange("],
    ["replaceOrderItemsFromEditor", "assertStockNeutralChange("],
    ["editOrderFull", "assertHeaderEditStockNeutral("],
    ["replaceOrderItems", "assertStockNeutralChange("],
    ["editOrderWithInventory", "assertStockNeutralChange("],
    ["deleteOrder", "assertDeleteAllowed("],
    ["deleteOrders", "assertDeleteAllowed("],
    ["markOrderAsReturned", "assertReturnRestoreAllowed("],
    ["resolveOrderReviewProduct", "assertProductReassignAllowed("],
  ];
  it.each(cases)("%s بينادي %s", (fn, guard) => {
    expect(body(fn)).toContain(guard);
  });
  it("الحراس بتتنادى بعد قفل صف الأوردر (FOR UPDATE) في نفس المعاملة", () => {
    for (const fn of ["cancelOrder", "updateOrder", "postponeOrder", "updateOrderWithItems", "deleteOrder", "deleteOrders", "resolveOrderReviewProduct", "replaceOrderItems"]) {
      const b = body(fn);
      const lock = b.indexOf('.for("update")');
      expect(lock, fn).toBeGreaterThan(-1);
      expect(b.indexOf("readOrderStockState(", lock), fn).toBeGreaterThan(lock);
    }
  });
  it("تسوية محرر البنود على المنتج الأب ممنوعة (حاجز تاني قبل أي حركة)، وحارس editOrderFull قبل فرع الكمية", () => {
    const ed = body("replaceOrderItemsFromEditor");
    expect(ed.indexOf("if (moves.length > 0)")).toBeGreaterThan(-1);
    expect(ed.indexOf("if (moves.length > 0)")).toBeLessThan(ed.indexOf("for (const move of moves)"));
    const eof = body("editOrderFull");
    expect(eof.indexOf("assertHeaderEditStockNeutral(tx")).toBeGreaterThan(-1);
    expect(eof.indexOf("assertHeaderEditStockNeutral(tx")).toBeLessThan(eof.indexOf('"quantity" in orderUpdates &&'));
    // الحارس نفسه بيقفل الصف قبل ما يقرا الحركات
    const rs = fs.readFileSync("server/rollbackSafe.ts", "utf-8");
    const h = rs.slice(rs.indexOf("export async function assertHeaderEditStockNeutral"));
    expect(h.indexOf('.for("update")')).toBeGreaterThan(-1);
    expect(h.indexOf('.for("update")')).toBeLessThan(h.indexOf("readOrderStockState("));
  });
  it("ويبهوك Easy Order: الرفض بيتسجّل ويرد 200 (مش 500 فيعيد المحاولة للأبد)", () => {
    const wh = fs.readFileSync("server/easyorderWebhook.ts", "utf-8");
    expect(wh).toContain('import { isRollbackSafeBlocked } from "./rollbackSafe"');
    expect(wh).toContain('action: "status_blocked_rollback_safe"');
    expect((wh.match(/isRollbackSafeBlocked\(err\)/g) ?? []).length).toBe(2);
    // مسار الـupsert: النتيجة blocked_rollback_safe قبل فرع failed (500) ومن غير rawPayload
    const i = wh.indexOf('result.outcome === "blocked_rollback_safe"'); const j = wh.indexOf('result.outcome === "failed"');
    expect(i).toBeGreaterThan(-1); expect(i).toBeLessThan(j);
    const blk = wh.slice(i, j);
    expect(blk).toContain('action: "blocked_rollback_safe"'); expect(blk).not.toContain("rawPayload"); expect(blk).not.toContain("res.status(500)");
  });
  it("upsertEasyOrder: الرفض يتعرف بنوع الخطأ (مش نص الرسالة) وبمقارنة البصمة؛ أي خطأ تاني يفضل failed", () => {
    const svc = fs.readFileSync("server/easyorder.service.ts", "utf-8");
    expect(svc).toContain("isRollbackSafeBlocked(err) && rsExisting && rsBefore !== undefined");
    expect(svc).toContain("if (after === rsBefore)");
    expect(svc.indexOf("rsBefore = await orderWriteFingerprint(")).toBeLessThan(svc.indexOf("await updateOrderWithItems(existing.id"));
    expect(svc).not.toMatch(/message\)?\.includes\(["']نسخة رجوع/);
  });
});
