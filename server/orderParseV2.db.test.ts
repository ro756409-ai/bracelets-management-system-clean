import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { eq, inArray, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb, createEmployee, createProductWithVariants, getOrderItemsForOrders } from "./db";
import { employees, orders, orderItems, orderParseAudits, products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * Hybrid Order Parser — end-to-end على MySQL عبر appRouter/createCaller:
 * لصق → parsePaste (v2 + توكن) → addOrder (تحقق سيرفري بإعادة التحليل) → order_items + audit.
 * نشاطان بنفس أسماء الأنواع لإثبات العزل. أسماء الأنواع هنا شكل الكتالوج بس.
 */
const REAL = `بيدج: عتبة التاريخ: 20/9
الاسم: محمد جمال محمد
العنوان: القليوبية طوخ مسجد الزعايرة جانب إدارة المرور
رقم الفون(1): 01095286405
رقم الفون(2): 01094366135
نوع المنتج: ٢ سادة، 1 نقش وعين حورس
عدد القطع: 4
السعر: 700 الشحن: 50 الإجمالي: 750`;

const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN)("🔑 Hybrid Order Parser — DB", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const ids = { productIds: [] as number[], empIds: [] as number[], orderIds: [] as number[] };
  let empA = 0, empB = 0, prodA = 0, prodB = 0;
  let vA: number[] = [], vB: number[] = [];
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  const caller = (employeeId: number) =>
    appRouter.createCaller({
      user: null, employee: null, tenantId: null,
      req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId }, process.env.JWT_SECRET as string) } },
      res: { clearCookie: () => {}, cookie: () => {} },
    } as any);
  const fail = async (fn: () => Promise<any>) => { try { await fn(); return { code: "ok", message: "" }; } catch (e: any) { return { code: e?.code ?? "ERR", message: String(e?.message ?? "") }; } };
  const trackOrder = async (orderNumber: string) => {
    const [o] = await (await getDb())!.select().from(orders).where(eq(orders.orderNumber, orderNumber));
    ids.orderIds.push(o.id); return o;
  };
  const CUST = { customerName: "محمد جمال محمد", customerPhone: "01095286405", customerPhone2: "01094366135", governorate: "القليوبية", city: "طوخ", customerAddress: "مسجد الزعايرة جانب إدارة المرور", adName: "عتبة" };
  /** السطور من v2 كما الواجهة بتبعتها. */
  const linesOf = (v2: any) => v2.lines.map((l: any) => ({ productId: l.match?.productId, productName: l.match?.productName ?? l.segmentText, quantity: l.quantity, variantId: l.match?.variantId ?? undefined, unitPrice: l.unitPrice ?? 0, priceSource: l.priceSource ?? undefined }));

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("hop-a"); B = await createCoreTestFixture("hop-b");
    const mk = async (bid: number, p: string) => createProductWithVariants(bid, { name: "أسورة نحاس" }, [
      { name: "سادة", sku: `${p}-S-${tag}`, currentStock: 100, price: "160" },
      { name: "منقوش", sku: `${p}-N-${tag}`, currentStock: 100, price: "160" },
      { name: "عين حورس", sku: `${p}-H-${tag}`, currentStock: 100, price: "160" },
      { name: "ذكر التحصين", sku: `${p}-T-${tag}`, currentStock: 100, price: "160" },
    ]);
    const a = await mk(A.businessId, "HA"); const b = await mk(B.businessId, "HB");
    prodA = a.productId; vA = a.variantIds; prodB = b.productId; vB = b.variantIds;
    ids.productIds.push(prodA, prodB);
    empA = insId(await createEmployee({ name: "eA", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `hop_a_${tag}` } as any));
    empB = insId(await createEmployee({ name: "eB", role: "data_entry", isActive: true, tenantId: B.tenantId, businessId: B.businessId, username: `hop_b_${tag}` } as any));
    ids.empIds.push(empA, empB);
  });
  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (ids.orderIds.length) {
      try { await d.delete(orderParseAudits).where(inArray(orderParseAudits.orderId, ids.orderIds)); } catch { /* الجدول ممكن يكون مش موجود */ }
      await d.delete(orderItems).where(inArray(orderItems.orderId, ids.orderIds));
      await d.delete(orders).where(inArray(orders.id, ids.orderIds));
    }
    if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
    if (ids.productIds.length) { await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds)); await d.delete(products).where(inArray(products.id, ids.productIds)); }
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔑 النص الحقيقي: parsePaste يرجّع v2 (2/1/1 و175) + توكن، وaddOrder يحفظ السطور والأسعار النهائية والسجل", async () => {
    const res = await caller(empA).facebookEntry.parsePaste({ text: REAL });
    expect(res.parseToken).toBeTruthy();
    const v2 = res.v2;
    expect(v2.lines.map(l => [l.match?.variantId, l.quantity, l.unitPrice])).toEqual([[vA[0], 2, 175], [vA[1], 1, 175], [vA[2], 1, 175]]);
    expect(v2.fields.itemsTotal.value).toBe(700); expect(v2.fields.shipping.value).toBe(50); expect(v2.fields.finalTotal.value).toBe(750);
    const r = await caller(empA).facebookEntry.addOrder({
      ...CUST, selectedProducts: linesOf(v2), totalAmount: 750, shippingCost: 50, discount: 0,
      rawText: REAL, parseToken: res.parseToken!, parseResult: v2,
    } as any);
    expect(r.success).toBe(true); expect(r.needsReview).toBe(false);
    const o = await trackOrder(r.orderNumber);
    expect(o.businessId).toBe(A.businessId);
    expect(Number(o.totalAmount)).toBe(750); expect(Number(o.shippingFees)).toBe(50); expect(o.quantity).toBe(4);
    expect(o.externalRawPayload).toBe(REAL);
    const items = (await getOrderItemsForOrders([o.id])).get(o.id) ?? [];
    expect(items.map(i => [i.variantId, i.quantity, Number(i.unitPrice)])).toEqual([[vA[0], 2, 175], [vA[1], 1, 175], [vA[2], 1, 175]]);
    expect(items.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0)).toBe(700);
    const [audit] = await (await getDb())!.select().from(orderParseAudits).where(eq(orderParseAudits.orderId, o.id));
    expect(audit).toMatchObject({ tenantId: A.tenantId, businessId: A.businessId, parserVersion: "2.0", parseSource: "deterministic", rawText: REAL });
    const rj = JSON.parse(audit.resultJson);
    expect(rj.verified.fields.itemsTotal.value).toBe(700);
    expect(rj.saved.map((s: any) => s.priceSource)).toEqual(["allocated", "allocated", "allocated"]);
    expect(rj.verified.allocationPolicy).toBeTruthy();
  });

  it("🔒 موانع سيرفرية (مش من الواجهة): كميات ≠ عدد القطع، سعر غير موزّع، إجمالي نهائي غلط، نوع غير محلول", async () => {
    const res = await caller(empA).facebookEntry.parsePaste({ text: REAL });
    const base = { ...CUST, totalAmount: 750, shippingCost: 50, discount: 0, rawText: REAL, parseToken: res.parseToken!, parseResult: res.v2 } as any;
    const lines = linesOf(res.v2);
    const qty = await fail(() => caller(empA).facebookEntry.addOrder({ ...base, selectedProducts: lines.slice(0, 2), totalAmount: 575 }));
    expect(qty.code).toBe("BAD_REQUEST"); expect(qty.message).toContain("عدد القطع");
    const price = await fail(() => caller(empA).facebookEntry.addOrder({ ...base, selectedProducts: lines.map((l: any) => ({ ...l, unitPrice: 160 })), totalAmount: 690 }));
    expect(price.code).toBe("BAD_REQUEST"); expect(price.message).toContain("لا يساوي إجمالي المنتجات");
    const total = await fail(() => caller(empA).facebookEntry.addOrder({ ...base, selectedProducts: lines, totalAmount: 700 }));
    expect(total.code).toBe("BAD_REQUEST"); expect(total.message).toContain("الإجمالي النهائي");
    const unresolved = await fail(() => caller(empA).facebookEntry.addOrder({ ...base, selectedProducts: lines.map((l: any, i: number) => (i === 1 ? { ...l, productId: undefined, variantId: undefined, productName: "نقش" } : l)) }));
    expect(unresolved.code).toBe("BAD_REQUEST"); expect(unresolved.message).toContain("اختر نوع النقش");
    // ولا أوردر اتكتب من المحاولات دي
    const d = (await getDb())!;
    const count = await d.select({ id: orders.id }).from(orders).where(eq(orders.businessId, A.businessId));
    expect(count.length).toBe(1);
  });

  it("🔒 لا تجاوز بحذف/تعديل الـmetadata: rawText بلا توكن، توكن لنص مختلف، توكن موظف آخر — كلها مرفوضة", async () => {
    const res = await caller(empA).facebookEntry.parsePaste({ text: REAL });
    const lines = linesOf(res.v2);
    const base = { ...CUST, selectedProducts: lines, totalAmount: 750, shippingCost: 50 } as any;
    expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, rawText: REAL }))).message).toContain("بيانات التحليل ناقصة");
    expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, parseToken: res.parseToken }))).message).toContain("بيانات التحليل ناقصة");
    expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, rawText: REAL.replace("700", "400"), parseToken: res.parseToken }))).message).toContain("توكن التحليل غير صالح");
    const resB = await caller(empB).facebookEntry.parsePaste({ text: REAL });
    expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, rawText: REAL, parseToken: resB.parseToken }))).message).toContain("توكن التحليل غير صالح");
  });

  it("🔒 عزل: نفس أسماء الأنواع في نشاط B — تحليل B يطابق تركيبات B فقط، وA لا يقدر يحفظ بتركيبة B", async () => {
    const resB = await caller(empB).facebookEntry.parsePaste({ text: REAL });
    expect(resB.v2.lines.map(l => l.match?.variantId)).toEqual([vB[0], vB[1], vB[2]]);
    expect(resB.v2.lines.some(l => vA.includes(l.match?.variantId as number))).toBe(false);
    const resA = await caller(empA).facebookEntry.parsePaste({ text: REAL });
    const forged = linesOf(resA.v2).map((l: any, i: number) => (i === 0 ? { ...l, productId: prodB, variantId: vB[0] } : l));
    const r = await fail(() => caller(empA).facebookEntry.addOrder({ ...CUST, selectedProducts: forged, totalAmount: 750, shippingCost: 50, rawText: REAL, parseToken: resA.parseToken } as any));
    expect(r.code).not.toBe("ok");
  });

  it("🔑 الأوردر اليدوي (بلا لصق) يظل بقواعده الحالية وبلا سجل تحليل", async () => {
    const r = await caller(empA).facebookEntry.addOrder({
      ...CUST, customerPhone: "01011111111",
      selectedProducts: [{ productId: prodA, productName: "أسورة نحاس", quantity: 1, variantId: vA[3], unitPrice: 160 }],
      totalAmount: 210, shippingCost: 50,
    } as any);
    expect(r.success).toBe(true);
    const o = await trackOrder(r.orderNumber);
    expect((await (await getDb())!.select().from(orderParseAudits).where(eq(orderParseAudits.orderId, o.id))).length).toBe(0);
  });

  it("🛡️ قبل Migration 0038 (الجدول غير موجود): أوردر اللصق يتحفظ عادي، بلا 500", async () => {
    const d = (await getDb())!;
    await d.execute(sql.raw(`RENAME TABLE order_parse_audits TO _premig_opa_${tag}`));
    try {
      const res = await caller(empA).facebookEntry.parsePaste({ text: REAL });
      const r = await caller(empA).facebookEntry.addOrder({
        ...CUST, customerPhone: "01022222222", selectedProducts: linesOf(res.v2), totalAmount: 750, shippingCost: 50, discount: 0,
        rawText: REAL, parseToken: res.parseToken!, parseResult: res.v2,
      } as any);
      expect(r.success).toBe(true);
      const o = await trackOrder(r.orderNumber);
      expect(o.externalRawPayload).toBe(REAL);
      expect(((await getOrderItemsForOrders([o.id])).get(o.id) ?? []).length).toBe(3);
    } finally {
      await d.execute(sql.raw(`RENAME TABLE _premig_opa_${tag} TO order_parse_audits`));
    }
  });

  it("🔑 حساب القالب الكامل (catalog_variants) بلا تغيير: سطر لون/مقاس بسعره كما أُرسل", async () => {
    const suit = await createProductWithVariants(B.businessId, { name: "بدلة أطفال" }, [
      { name: "AFK-BLK-6", sku: `AFK-BLK-6-${tag}`, currentStock: 10, price: "450", color: "أسود", size: "6" } as any,
    ]);
    ids.productIds.push(suit.productId);
    const r = await caller(empB).facebookEntry.addOrder({
      ...CUST, customerPhone: "01033333333",
      selectedProducts: [{ productId: suit.productId, productName: "بدلة أطفال", quantity: 1, variantId: suit.variantIds[0], unitPrice: 450 }],
      totalAmount: 500, shippingCost: 50,
    } as any);
    expect(r.success).toBe(true);
    const o = await trackOrder(r.orderNumber);
    const [it] = (await getOrderItemsForOrders([o.id])).get(o.id) ?? [];
    expect([it.color, it.size, Number(it.unitPrice)]).toEqual(["أسود", "6", 450]);
  });
});
