import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حارس: حذف الأوردر لازم يمسح أصنافه معاه — سبب الـ20 orphan في تدقيق D5 كان إن
 * الحذف بيمسح `orders` بس. الاختبار بيقفل على: (١) helpers الحذف بتمسح order_items
 * جوّه transaction، (٢) مفيش أي مسار بيمسح orders خام (كله بيعدّي على الـhelper).
 */
const db = fs.readFileSync("server/db.ts", "utf-8");
const routers = fs.readFileSync("server/routers.ts", "utf-8");

function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error(`مالقيتش ${signature}`);
  const rest = src.slice(start + signature.length);
  const next = rest.indexOf("\nexport ");
  return rest.slice(0, next < 0 ? rest.length : next);
}

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("🔑 حذف الأوردر بيمسح أصنافه (منع الـorphans)", () => {
  it("🔑 deleteOrder: transaction + مسح order_items قبل orders", () => {
    const body = fnBody(db, "export async function deleteOrder(");
    expect(body).toContain("db.transaction(");
    expect(body).toContain("delete(orderItems).where(eq(orderItems.orderId, id))");
    expect(body).toContain("delete(orders).where(eq(orders.id, id))");
  });

  it("🔑 deleteOrders: transaction + مسح order_items بالـinArray", () => {
    const body = fnBody(db, "export async function deleteOrders(");
    expect(body).toContain("db.transaction(");
    expect(body).toContain("delete(orderItems).where(inArray(orderItems.orderId, ids))");
    expect(body).toContain("delete(orders).where(inArray(orders.id, ids))");
  });

  it("🔑 مفيش أي مسار في routers بيمسح orders خام — كله على الـhelper", () => {
    // نشيل التعليقات عشان الإشارة للنمط القديم في التعليق ماتعدّش.
    const code = codeOnly(routers);
    expect(code).not.toMatch(/\.delete\(\s*orders\s*\)/);
  });

  it("🔑 مسارات الحذف بتستخدم deleteOrder/deleteOrders", () => {
    expect(routers).toContain("await deleteOrder(input.orderId)");
    expect(routers).toContain("await deleteOrders(ids)");
  });
});
