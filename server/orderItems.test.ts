import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, replaceOrderItems, getOrderItems, getOrderItemsForOrders, createOrder } from "./db";
import { orders, orderItems } from "../drizzle/schema";
import { eq } from "drizzle-orm";

/**
 * اختبارات بنود الأوردر المتعددة (order_items)
 * تتحقق من: التخزين، الجلب الفردي والجماعي، الاستبدال الكامل، وحساب إجمالي القطع
 */

describe("Order Items - بنود الأوردر المتعددة", () => {
  let testOrderId: number;

  beforeAll(async () => {
    const db = await getDb();
    if (!db) return;
    // إنشاء أوردر تجريبي
    const created = await createOrder({
      businessId: 1,
      orderNumber: `T${Date.now() % 100000000}`,
      customerName: "عميل اختبار البنود",
      customerPhone: "01000000099",
      governorate: "القاهرة",
      customerAddress: "عنوان اختبار",
      productId: 1,
      productName: "صنف مبدئي",
      quantity: 1,
      totalAmount: "100",
      source: "manual",
    } as any);
    testOrderId = created as number;
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db || !testOrderId) return;
    await db.delete(orderItems).where(eq(orderItems.orderId, testOrderId));
    await db.delete(orders).where(eq(orders.id, testOrderId));
  });

  it("يخزن عدة بنود بأعداد مستقلة ويجلبها بالترتيب", async () => {
    const db = await getDb();
    if (!db) return;

    await replaceOrderItems(testOrderId, [
      { productName: "فالله خير حافظا", quantity: 4 },
      { productName: "آية الكرسي", quantity: 4 },
      { productName: "التحصين", quantity: 4 },
    ]);

    const items = await getOrderItems(testOrderId);
    expect(items.length).toBe(3);
    expect(items[0].productName).toBe("فالله خير حافظا");
    expect(items[0].quantity).toBe(4);
    expect(items[2].productName).toBe("التحصين");
  });

  it("يحسب إجمالي القطع كمجموع كميات البنود", async () => {
    const items = await getOrderItems(testOrderId);
    const total = items.reduce((s, it) => s + (it.quantity || 0), 0);
    expect(total).toBe(12);
  });

  it("يستبدل البنود بالكامل عند التحديث (حذف القديم وإضافة الجديد)", async () => {
    const db = await getDb();
    if (!db) return;

    await replaceOrderItems(testOrderId, [
      { productName: "عين حورس", quantity: 2 },
      { productName: "كهيعص", quantity: 5 },
    ]);

    const items = await getOrderItems(testOrderId);
    expect(items.length).toBe(2);
    const total = items.reduce((s, it) => s + (it.quantity || 0), 0);
    expect(total).toBe(7);
    // التأكد أن البنود القديمة لم تعد موجودة
    expect(items.find((i) => i.productName === "فالله خير حافظا")).toBeUndefined();
  });

  it("يدعم سعر مستقل لكل بند (unitPrice)", async () => {
    const db = await getDb();
    if (!db) return;

    await replaceOrderItems(testOrderId, [
      { productName: "صنف بسعر", quantity: 3, unitPrice: 250 },
    ]);

    const items = await getOrderItems(testOrderId);
    expect(items.length).toBe(1);
    expect(Number(items[0].unitPrice)).toBe(250);
  });

  it("يجلب بنود عدة أوردرات دفعة واحدة مفهرسة حسب orderId", async () => {
    const map = await getOrderItemsForOrders([testOrderId]);
    const list = map.get(testOrderId);
    expect(list).toBeDefined();
    expect(list!.length).toBe(1);
    expect(list![0].productName).toBe("صنف بسعر");
  });

  it("يعيد خريطة فارغة عند تمرير قائمة فارغة", async () => {
    const map = await getOrderItemsForOrders([]);
    expect(map.size).toBe(0);
  });

  it("يحذف كل البنود عند تمرير قائمة فارغة لـ replaceOrderItems", async () => {
    const db = await getDb();
    if (!db) return;

    await replaceOrderItems(testOrderId, []);
    const items = await getOrderItems(testOrderId);
    expect(items.length).toBe(0);
  });
});
