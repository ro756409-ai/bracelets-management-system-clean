import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import {
  getDb,
  createEmployee,
  createProduct,
  createProductWithVariants,
  getOrderItemsForOrders,
} from "./db";
import { employees, orders, orderItems, products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * حالة Production حقيقية end-to-end على MySQL: لصق → تحليل → حفظ → قراءة.
 *
 * الكتالوج بنفس شكل نشاط الأساور في الإنتاج: منتج واحد بتركيبات («أسورة نحاس») +
 * منتجات بسيطة بلا تركيبات. «سادة» و«نقش» و«عين حورس» أنواع تحت الأسورة، مش منتجات.
 */
const REAL = `بيدج:عتبة  التاريخ: 20/9
الاسم :محمد جمال محمد
العنوان :القليوبيه طوخ مسجد الزعايره جانب اداره المرور
رقم الفون(١):01095286405
رقم الفون(٢):01094366135
نوع المنتج : ٢ ساده، 1 نقش وعين حورس عدد القطع: 4
السعر:  700 الشحن: 50   الاجمالي:750`;

const CAN_E2E = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN_E2E)("🔑 حالة Production الحقيقية — end-to-end", () => {
  let A: CoreTestFixture;
  const tag = Date.now();
  const ids = { productIds: [] as number[], empIds: [] as number[], orderIds: [] as number[] };
  let emp = 0;
  let braceletId = 0;
  let vPlain = 0, vEngraved = 0, vHorus = 0;
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  const caller = () =>
    appRouter.createCaller({
      user: null, employee: null, tenantId: null,
      req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId: emp }, process.env.JWT_SECRET as string) } },
      res: { clearCookie: () => {}, cookie: () => {} },
    } as any);

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("real-case");
    const br = await createProductWithVariants(A.businessId, { name: "أسورة نحاس" }, [
      { name: "سادة", sku: `RC-PLAIN-${tag}`, currentStock: 100, price: "150" },
      { name: "منقوش", sku: `RC-ENGR-${tag}`, currentStock: 100, price: "200" },
      { name: "عين حورس", sku: `RC-HORUS-${tag}`, currentStock: 100, price: "160" },
      { name: "ذكر التحصين", sku: `RC-DHIKR-${tag}`, currentStock: 100, price: "175" },
    ]);
    braceletId = br.productId;
    [vPlain, vEngraved, vHorus] = br.variantIds;
    ids.productIds.push(braceletId);
    // منتجات بسيطة بلا تركيبات — زي «مسند سيارة» و«مسن سكاكين» في الإنتاج.
    for (const [i, name] of [`مسند سيارة ${tag}`, `مسن سكاكين ${tag}`].entries()) {
      await createProduct({ businessId: A.businessId, name, sku: `RC-S${i}-${tag}`, price: "150.00" } as any);
    }
    const d2 = await getDb();
    const simple = await d2!.select().from(products).where(inArray(products.businessId, [A.businessId]));
    for (const p of simple) if (p.id !== braceletId) ids.productIds.push(p.id);

    emp = insId(await createEmployee({ name: "entry", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `rc_${tag}` } as any));
    ids.empIds.push(emp);
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (ids.orderIds.length) {
      await d.delete(orderItems).where(inArray(orderItems.orderId, ids.orderIds));
      await d.delete(orders).where(inArray(orders.id, ids.orderIds));
    }
    if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
    if (ids.productIds.length) {
      await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds));
      await d.delete(products).where(inArray(products.id, ids.productIds));
    }
    await A?.cleanup();
  });

  it("🔑 التحليل: كل الحقول + 3 أسطر بالتركيبات الصح", async () => {
    const res = await caller().facebookEntry.parsePaste({ text: REAL });
    const p = res.parsed;

    expect(p.customerName).toBe("محمد جمال محمد");
    expect(p.customerPhone).toBe("01095286405");
    expect(p.customerPhone2).toBe("01094366135");
    expect(p.customerAddress).not.toContain("0109");
    expect(p.governorate).toBe("القليوبية");
    expect(p.city).toBe("طوخ");
    expect(p.adName).toBe("عتبة");
    expect(p.itemsSubtotal).toBe(700);
    expect(p.shipping).toBe(50);
    expect(p.totalAmount).toBe(750);
    expect(p.totalMismatch).toBe(false);
    expect(p.quantity).toBe(4);

    // 3 أسطر — مفيش كارت اسمه «٢ ساده» أو «1 نقش»
    expect(res.lines).toHaveLength(3);
    expect(res.lines.map(l => l.quantity)).toEqual([2, 1, 1]);
    expect(res.lines.map(l => l.match?.variantId)).toEqual([vPlain, vEngraved, vHorus]);
    expect(res.lines.every(l => l.match?.productId === braceletId)).toBe(true);
    expect(res.lines.every(l => l.match?.productName === "أسورة نحاس")).toBe(true);
    expect(res.lines.some(l => /\d/.test(l.term))).toBe(false);

    // سعر الوحدة 175 وإجمالي الأسطر 350 + 175 + 175 = 700
    expect(res.lines.map(l => l.unitPrice)).toEqual([175, 175, 175]);
    expect(res.lines.map(l => l.unitPrice * l.quantity)).toEqual([350, 175, 175]);
    expect(res.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0)).toBe(700);
  });

  it("🔑 الحفظ: 3 order_items بكميات 2,1,1 وتركيبات صح، والهيدر مضبوط", async () => {
    const res = await caller().facebookEntry.parsePaste({ text: REAL });
    const p = res.parsed;
    const saved = await caller().facebookEntry.addOrder({
      customerName: p.customerName,
      customerPhone: p.customerPhone,
      customerPhone2: p.customerPhone2,
      governorate: p.governorate,
      city: p.city,
      customerAddress: p.customerAddress,
      adName: p.adName,
      selectedProducts: res.lines.map(l => ({
        productId: l.match!.productId,
        productName: l.match!.productName,
        quantity: l.quantity,
        variantId: l.match!.variantId!,
        unitPrice: l.unitPrice,
      })),
      totalAmount: p.totalAmount,
      shippingCost: p.shipping,
    } as any);

    const d = await getDb();
    const [row] = await d!.select().from(orders).where(inArray(orders.orderNumber, [saved.orderNumber]));
    ids.orderIds.push(row.id);

    // الهيدر
    expect(row.quantity).toBe(4);
    expect(Number(row.shippingFees)).toBe(50);
    expect(Number(row.totalAmount)).toBe(750);
    expect(row.customerPhone2).toBe("01094366135");
    expect(row.governorate).toBe("القليوبية");
    expect(row.city).toBe("طوخ");
    expect(row.adName).toBe("عتبة");
    expect(row.customerAddress).not.toContain("0109");
    expect(row.businessId).toBe(A.businessId);

    // البنود
    const items = (await getOrderItemsForOrders([row.id])).get(row.id) ?? [];
    expect(items).toHaveLength(3);
    const byVariant = new Map(items.map(i => [i.variantId, i]));
    expect(byVariant.get(vPlain)?.quantity).toBe(2);
    expect(byVariant.get(vEngraved)?.quantity).toBe(1);
    expect(byVariant.get(vHorus)?.quantity).toBe(1);
    expect(items.map(i => (i as any).variantName).sort()).toEqual(
      ["سادة", "عين حورس", "منقوش"].sort()
    );
    // مجموع صافي الأصناف = 700 بالظبط (مش شامل الشحن)
    const net = items.reduce((s, i) => s + Number(i.netAmountSnapshot ?? 0), 0);
    expect(Math.round(net * 100) / 100).toBe(700);
  });

  it("🔒 تركيبة مش متطابقة → السطر بيفضل بكميته وسعره للمراجعة", async () => {
    const res = await caller().facebookEntry.parsePaste({
      text: "نوع المنتج : ٢ ساده، 1 حاجة مش موجودة عدد القطع: 3\nالسعر: 450",
    });
    expect(res.lines).toHaveLength(2);
    const missing = res.lines.find(l => !l.match)!;
    expect(missing).toBeTruthy();
    expect(missing.quantity).toBe(1);
    expect(missing.unitPrice).toBe(150);
    expect(missing.matchReason).toBeTruthy();
  });
});
