import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import {
  getDb, createEmployee, createProductWithVariants, insertOrderWithItems, getVariantById, getOrderItemsForOrders,
} from "./db";
import { employees, orders, orderItems, orderParseAudits, products, productVariants, inventoryMovements } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * تأكيد الأوردر وخصم المخزون من التركيبات — end-to-end بحسابات موظفين حقيقيين:
 * data_entry تدخل (لصق/يدوي) عبر facebookEntry.addOrder، وorder_confirmation تؤكد عبر
 * employeePortal.confirm. نشاطان بنفس أسماء الأنواع لإثبات العزل. الأسماء شكل الكتالوج بس.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN)("🔑 تأكيد الأوردر يخصم من التركيبات الصحيحة داخل النشاط", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const ids = { productIds: [] as number[], empIds: [] as number[], orderIds: [] as number[] };
  let entryA = 0, confirmA = 0, confirmB = 0, prodA = 0, prodB = 0;
  let vA: number[] = [], vB: number[] = [];
  const NAMES = ["آية الكرسي", "آية من سليمان", "ذكر التحصين", "سادة", "عين حورس"];
  const STOCK = [780, 930, 941, 1000, 790];
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  const caller = (employeeId: number) =>
    appRouter.createCaller({
      user: null, employee: null, tenantId: null,
      req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId }, process.env.JWT_SECRET as string) } },
      res: { clearCookie: () => {}, cookie: () => {} },
    } as any);
  const fail = async (fn: () => Promise<any>) => { try { await fn(); return { code: "ok", message: "" }; } catch (e: any) { return { code: e?.code ?? "ERR", message: String(e?.message ?? "") }; } };
  const stockOf = async (vid: number) => (await getVariantById(vid))!.currentStock;
  const CUST = { customerName: "عميل تأكيد", customerPhone: "01000000010", governorate: "القاهرة", city: "مدينة نصر", customerAddress: "شارع طويل رقم 10 الدور 2", adName: "اختبار" };

  /** أوردر بموظفة الإدخال (يدوي، بلا لصق) ثم تعيينه لموظف التأكيد. */
  async function orderVia(entryEmp: number, confirmer: number, lines: { variantId: number; quantity: number; unitPrice: number; productId?: number }[], phone = "01000000010") {
    const r = await caller(entryEmp).facebookEntry.addOrder({
      ...CUST, customerPhone: phone,
      selectedProducts: lines.map(l => ({ productId: l.productId ?? prodA, productName: "أسورة نحاس", quantity: l.quantity, variantId: l.variantId, unitPrice: l.unitPrice })),
      totalAmount: lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) + 50, shippingCost: 50,
    } as any);
    const d = (await getDb())!;
    const [o] = await d.select().from(orders).where(eq(orders.orderNumber, r.orderNumber));
    ids.orderIds.push(o.id);
    await d.update(orders).set({ assignedEmployeeId: confirmer }).where(eq(orders.id, o.id));
    return o.id;
  }
  const movesOf = async (orderId: number) => (await getDb())!.select().from(inventoryMovements).where(eq(inventoryMovements.orderId, orderId));

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("cfi-a"); B = await createCoreTestFixture("cfi-b");
    const mk = async (bid: number, p: string) => createProductWithVariants(bid, { name: "أسورة نحاس" }, NAMES.map((name, i) => ({ name, sku: `${p}-${i}-${tag}`, currentStock: STOCK[i], price: "190" })));
    const a = await mk(A.businessId, "CA"); const b = await mk(B.businessId, "CB");
    prodA = a.productId; vA = a.variantIds; prodB = b.productId; vB = b.variantIds;
    ids.productIds.push(prodA, prodB);
    entryA = insId(await createEmployee({ name: "entry A", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `cfi_e_${tag}` } as any));
    confirmA = insId(await createEmployee({ name: "confirm A", role: "order_confirmation", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `cfi_c_${tag}` } as any));
    confirmB = insId(await createEmployee({ name: "confirm B", role: "order_confirmation", isActive: true, tenantId: B.tenantId, businessId: B.businessId, username: `cfi_cb_${tag}` } as any));
    ids.empIds.push(entryA, confirmA, confirmB);
  });
  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (ids.orderIds.length) {
      await d.delete(inventoryMovements).where(inArray(inventoryMovements.orderId, ids.orderIds));
      try { await d.delete(orderParseAudits).where(inArray(orderParseAudits.orderId, ids.orderIds)); } catch { /* */ }
      await d.delete(orderItems).where(inArray(orderItems.orderId, ids.orderIds));
      await d.delete(orders).where(inArray(orders.id, ids.orderIds));
    }
    if (ids.productIds.length) {
      await d.delete(inventoryMovements).where(inArray(inventoryMovements.productId, ids.productIds));
      await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds));
      await d.delete(products).where(inArray(products.id, ids.productIds));
    }
    if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔑 موظف الأساور يؤكد أوردرًا لكل variant ظاهر بالمخزون — كل تأكيد يخصم 1 من تركيبته هو فقط", async () => {
    for (let i = 0; i < vA.length; i++) {
      const before = await Promise.all(vA.map(stockOf));
      const oid = await orderVia(entryA, confirmA, [{ variantId: vA[i], quantity: 1, unitPrice: 190 }]);
      const r = await caller(confirmA).employeePortal.confirm({ orderId: oid });
      expect(r.success).toBe(true); expect(r.needsReview).toBe(false);
      const after = await Promise.all(vA.map(stockOf));
      expect(after.map((n, j) => before[j] - n)).toEqual(vA.map((_, j) => (j === i ? 1 : 0)));
      const moves = await movesOf(oid);
      expect(moves.map(m => [m.businessId, m.productId, m.variantId, m.type, m.quantity])).toEqual([[A.businessId, prodA, vA[i], "out", 1]]);
    }
  });

  it("🔑 أوردر آية الكرسي + ذكر التحصين → يخصم من الاثنين الصحيحين، بلا لمس الباقي (يدوي = تحليل)", async () => {
    const before = await Promise.all(vA.map(stockOf));
    const oid = await orderVia(entryA, confirmA, [{ variantId: vA[0], quantity: 1, unitPrice: 200 }, { variantId: vA[2], quantity: 1, unitPrice: 200 }]);
    await caller(confirmA).employeePortal.confirm({ orderId: oid });
    const after = await Promise.all(vA.map(stockOf));
    expect(after.map((n, j) => before[j] - n)).toEqual([1, 0, 1, 0, 0]);
    // نفس الأوردر عبر اللصق (نفس البنود) → نفس الخصم
    const TXT = `الاسم: خير محمد\nالعنوان: القاهرة شارع 9\nرقم الفون(1): 01000000011\nنوع المنتج: ايه كرسي وتحصين\nعدد القطع: 2\nالسعر: 400\nالشحن: 50\nالإجمالي: 450`;
    const res = await caller(entryA).facebookEntry.parsePaste({ text: TXT });
    const r = await caller(entryA).facebookEntry.addOrder({
      ...CUST, customerPhone: "01000000011",
      selectedProducts: res.v2.lines.map(l => ({ productId: l.match!.productId, productName: "أسورة نحاس", quantity: l.quantity, variantId: l.match!.variantId!, unitPrice: l.unitPrice! })),
      totalAmount: 450, shippingCost: 50, discount: 0, rawText: TXT, parseToken: res.parseToken!, parseResult: res.v2,
    } as any);
    const d = (await getDb())!;
    const [o2] = await d.select().from(orders).where(eq(orders.orderNumber, r.orderNumber)); ids.orderIds.push(o2.id);
    await d.update(orders).set({ assignedEmployeeId: confirmA }).where(eq(orders.id, o2.id));
    const before2 = await Promise.all(vA.map(stockOf));
    await caller(confirmA).employeePortal.confirm({ orderId: o2.id });
    const after2 = await Promise.all(vA.map(stockOf));
    expect(after2.map((n, j) => before2[j] - n)).toEqual([1, 0, 1, 0, 0]);
  });

  it("🔑 نفس الـvariant في سطرين → يُجمع قبل الفحص والخصم (حركة واحدة بالمجموع)", async () => {
    const before = await stockOf(vA[3]);
    const oid = await orderVia(entryA, confirmA, [{ variantId: vA[3], quantity: 2, unitPrice: 190 }, { variantId: vA[3], quantity: 3, unitPrice: 170 }]);
    await caller(confirmA).employeePortal.confirm({ orderId: oid });
    expect(await stockOf(vA[3])).toBe(before - 5);
    const moves = await movesOf(oid);
    expect(moves.map(m => [m.variantId, m.quantity])).toEqual([[vA[3], 5]]);
  });

  it("🔒 مخزون غير كافٍ في صنف واحد → رفض كامل برسالة «المتاح من ذكر التحصين 3 والمطلوب 5»، بلا أي خصم جزئي، والأوردر يبقى new", async () => {
    const d = (await getDb())!;
    await d.update(productVariants).set({ currentStock: 3 }).where(eq(productVariants.id, vA[2]));
    const beforeK = await stockOf(vA[0]);
    const oid = await orderVia(entryA, confirmA, [{ variantId: vA[0], quantity: 1, unitPrice: 190 }, { variantId: vA[2], quantity: 5, unitPrice: 190 }]);
    const r = await fail(() => caller(confirmA).employeePortal.confirm({ orderId: oid }));
    expect(r.code).toBe("BAD_REQUEST");
    expect(r.message).toContain("المتاح من ذكر التحصين 3 والمطلوب 5");
    expect(await stockOf(vA[0])).toBe(beforeK); // الصنف الكافي ماتخصمش هو كمان
    expect(await stockOf(vA[2])).toBe(3);
    expect((await d.select().from(orders).where(eq(orders.id, oid)))[0].status).toBe("new");
    expect(await movesOf(oid)).toEqual([]);
    await d.update(productVariants).set({ currentStock: 941 }).where(eq(productVariants.id, vA[2]));
  });

  it("🔒 double-click / retry: تأكيدان متزامنان + ثالث لاحق → خصم واحد وحركة واحدة", async () => {
    const before = await stockOf(vA[4]);
    const oid = await orderVia(entryA, confirmA, [{ variantId: vA[4], quantity: 2, unitPrice: 190 }]);
    await Promise.all([caller(confirmA).employeePortal.confirm({ orderId: oid }), caller(confirmA).employeePortal.confirm({ orderId: oid })]);
    await caller(confirmA).employeePortal.confirm({ orderId: oid });
    expect(await stockOf(vA[4])).toBe(before - 2);
    expect((await movesOf(oid)).length).toBe(1);
  });

  it("🔒 variant من نشاط آخر داخل بنود أوردر A → التأكيد يُرفض ولا يخصم من B", async () => {
    const d = (await getDb())!;
    // بنود مباشرة (تجاوز فحص addOrder) لمحاكاة بيانات قديمة/ملوّثة
    const oid = await insertOrderWithItems({
      orderNumber: `CFI-X-${tag}`.slice(0, 20), businessId: A.businessId, customerName: "c", customerPhone: "01000000012", governorate: "القاهرة",
      customerAddress: "عنوان تفصيلي كافٍ", productName: "أسورة نحاس", quantity: 1, totalAmount: "240.00", source: "manual", status: "new", assignedEmployeeId: confirmA,
    } as any, [{ productId: prodA, productName: "أسورة نحاس", quantity: 1, variantId: vB[0], unitPrice: 190 }]);
    ids.orderIds.push(oid);
    const beforeB = await stockOf(vB[0]);
    const r = await fail(() => caller(confirmA).employeePortal.confirm({ orderId: oid }));
    expect(r.code).toBe("BAD_REQUEST"); expect(r.message).toContain("لا تتبع منتج");
    expect(await stockOf(vB[0])).toBe(beforeB);
    expect((await d.select().from(orders).where(eq(orders.id, oid)))[0].status).toBe("new");
  });

  it("🔒 موظف B لا يرى ولا يؤكد ولا يخصم من مخزون A", async () => {
    const before = await Promise.all(vA.map(stockOf));
    const oid = await orderVia(entryA, confirmA, [{ variantId: vA[1], quantity: 1, unitPrice: 190 }]);
    expect((await fail(() => caller(confirmB).employeePortal.confirm({ orderId: oid }))).code).not.toBe("ok");
    expect(await Promise.all(vA.map(stockOf))).toEqual(before);
    // كتالوج/مخزون B مافيهوش تركيبات A
    const catB = await caller(confirmB).facebookEntry.catalog();
    expect(catB.variants.some((v: any) => vA.includes(v.id))).toBe(false);
    const catA = await caller(entryA).facebookEntry.catalog();
    expect(catA.variants.some((v: any) => vB.includes(v.id))).toBe(false);
  });

  it("🔑 بعد التأكيد: order_items ثابتة بالتركيبات النهائية والمخزون المعروض للموظف يعكس الخصم فورًا", async () => {
    const before = await stockOf(vA[0]);
    const oid = await orderVia(entryA, confirmA, [{ variantId: vA[0], quantity: 3, unitPrice: 190 }], "01000000013");
    await caller(confirmA).employeePortal.confirm({ orderId: oid });
    const items = (await getOrderItemsForOrders([oid])).get(oid) ?? [];
    expect(items.map(i => [i.variantId, i.quantity])).toEqual([[vA[0], 3]]);
    const cat = await caller(entryA).facebookEntry.catalog();
    expect(cat.variants.find((v: any) => v.id === vA[0]).currentStock).toBe(before - 3);
  });
});
