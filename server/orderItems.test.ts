import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getDb,
  replaceOrderItems,
  getOrderItems,
  getOrderItemsForOrders,
  createOrder,
} from "./db";
import { orders, orderItems, productVariants } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * اختبارات بنود الأوردر المتعددة (order_items)
 * تتحقق من: التخزين، الجلب الفردي والجماعي، الاستبدال الكامل، وحساب إجمالي القطع
 */

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  "Order Items - بنود الأوردر المتعددة",
  () => {
    let testOrderId: number;
    let fixture: CoreTestFixture;

    beforeAll(async () => {
      const db = await getDb();
      if (!db) return;
      fixture = await createCoreTestFixture("order-items");
      // إنشاء أوردر تجريبي
      const created = await createOrder({
        businessId: fixture.businessId,
        orderNumber: `T${Date.now() % 100000000}`,
        customerName: "عميل اختبار البنود",
        customerPhone: "01000000099",
        governorate: "القاهرة",
        customerAddress: "عنوان اختبار",
        productId: fixture.productId,
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
      await fixture?.cleanup();
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
      expect(
        items.find(i => i.productName === "فالله خير حافظا")
      ).toBeUndefined();
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

    it("يجلب اسم نوع الحفر (variantName) لكل بند عن طريق variantId", async () => {
      const db = await getDb();
      if (!db) return;

      const variantInsert = await db.insert(productVariants).values({
        productId: fixture.productId,
        name: "آية الكرسي",
        currentStock: 0,
      });
      const variantId = (variantInsert as any).insertId as number;

      try {
        await replaceOrderItems(testOrderId, [
          { productName: "أسورة نحاس", quantity: 2, variantId },
          { productName: "منتج بدون نوع حفر", quantity: 1 },
        ]);

        const items = await getOrderItems(testOrderId);
        expect(items.length).toBe(2);
        expect(items[0].variantName).toBe("آية الكرسي");
        expect(items[1].variantName).toBeNull();

        const map = await getOrderItemsForOrders([testOrderId]);
        expect(map.get(testOrderId)?.[0].variantName).toBe("آية الكرسي");
      } finally {
        await db
          .delete(productVariants)
          .where(eq(productVariants.id, variantId));
      }
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

    it("يرفض ترك الأوردر بدون Order Items", async () => {
      await expect(replaceOrderItems(testOrderId, [])).rejects.toThrow(
        "Order Items"
      );
    });
  }
);
