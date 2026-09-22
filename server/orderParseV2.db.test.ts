import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { eq, inArray, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb, createEmployee, createProductWithVariants, getOrderItemsForOrders, getOrderItems, setOrderEntryMode } from "./db";
import { buildShipmentContents } from "../shared/orderContent";
import { employees, orders, orderItems, orderParseAudits, products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { __setSegmentResolverFactoryForTests } from "./ai/segmentResolver";
import { __resetAiRateLimitForTests } from "./ai/aiRateLimit";
import { signParseToken, canonicalFingerprint, rawTextHash, PARSE_TOKEN_TTL_MS } from "./orderParse.service";

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
      { name: "آية الكرسي", sku: `${p}-K-${tag}`, currentStock: 100, price: "160" },
    ]);
    const a = await mk(A.businessId, "HA"); const b = await mk(B.businessId, "HB");
    prodA = a.productId; vA = a.variantIds; prodB = b.productId; vB = b.variantIds;
    ids.productIds.push(prodA, prodB);
    empA = insId(await createEmployee({ name: "eA", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `hop_a_${tag}` } as any));
    empB = insId(await createEmployee({ name: "eB", role: "data_entry", isActive: true, tenantId: B.tenantId, businessId: B.businessId, username: `hop_b_${tag}` } as any));
    ids.empIds.push(empA, empB);
  });
  afterAll(async () => {
    __setSegmentResolverFactoryForTests(null); __resetAiRateLimitForTests();
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

  const REAL2 = `بيدج: عتبة  التاريخ:
الاسم: سعد حماده
العنوان: المنيا مركز بني مزار ساكن في الحاج شرق النيل
رقم الفون(١): 01055414877
نوع المنتج: ذكر التحصين و آية الكرسي والساده  عدد القطع: 3
السعر: 570  الشحن: 50  الاجمالي: 620`;

  it("🔑 النص الحقيقي الثاني: 3 order items (ذكر التحصين، آية الكرسي، سادة ×1) بسعر 190، 570/50/620، ووصف بوسطة بالأنواع الثلاثة", async () => {
    const res = await caller(empA).facebookEntry.parsePaste({ text: REAL2 });
    expect(res.v2.lines.map(l => [l.match?.variantId, l.quantity, l.unitPrice])).toEqual([[vA[3], 1, 190], [vA[4], 1, 190], [vA[0], 1, 190]]);
    const r = await caller(empA).facebookEntry.addOrder({
      customerName: "سعد حماده", customerPhone: "01055414877", governorate: "المنيا", city: "بني مزار", customerAddress: "مركز بني مزار ساكن في الحاج شرق النيل", adName: "عتبة",
      selectedProducts: linesOf(res.v2), totalAmount: 620, shippingCost: 50, discount: 0,
      rawText: REAL2, parseToken: res.parseToken!, parseResult: res.v2,
    } as any);
    expect(r.success).toBe(true);
    const o = await trackOrder(r.orderNumber);
    expect(Number(o.totalAmount)).toBe(620); expect(Number(o.shippingFees)).toBe(50); expect(o.quantity).toBe(3);
    const items = (await getOrderItemsForOrders([o.id])).get(o.id) ?? [];
    expect(items.map(i => [i.variantId, i.quantity, Number(i.unitPrice)])).toEqual([[vA[3], 1, 190], [vA[4], 1, 190], [vA[0], 1, 190]]);
    expect(items.reduce((s, i) => s + Number(i.unitPrice) * i.quantity, 0)).toBe(570);
    const desc = buildShipmentContents((await getOrderItems(o.id)).map(it => ({ productName: it.productName, variantName: it.variantName, quantity: it.quantity, size: it.size, color: it.color })));
    expect(desc.description).toBe("أسورة نحاس - ذكر التحصين ×1، أسورة نحاس - آية الكرسي ×1، أسورة نحاس - سادة ×1");
    expect(desc.itemsCount).toBe(3);
  });

  it("🔑 قالب الإدخال من نشاط الجلسة فقط: A=bracelets_legacy يراه موظف A، وB بلا صف يبقى catalog_variants، والموظف لا يغيّره", async () => {
    await setOrderEntryMode(A.businessId, "bracelets_legacy", 1);
    expect((await caller(empA).facebookEntry.entryConfig()).mode).toBe("bracelets_legacy");
    expect((await caller(empB).facebookEntry.entryConfig()).mode).toBe("catalog_variants");
    // الموظف مش أدمن → مايقدرش يغيّر القالب (ولا لنشاطه ولا لغيره)
    expect((await fail(() => caller(empA).businesses.setOrderEntryMode({ businessId: A.businessId, mode: "catalog_variants" } as any))).code).not.toBe("ok");
    expect((await fail(() => caller(empA).businesses.setOrderEntryMode({ businessId: B.businessId, mode: "bracelets_legacy" } as any))).code).not.toBe("ok");
    expect((await caller(empB).facebookEntry.entryConfig()).mode).toBe("catalog_variants");
  });

  it("🔒 موانع سيرفرية (مش من الواجهة): كميات ≠ عدد القطع، سعر غير موزّع، إجمالي نهائي غلط، نوع غير محلول", async () => {
    const countBefore = (await (await getDb())!.select({ id: orders.id }).from(orders).where(eq(orders.businessId, A.businessId))).length;
    const res = await caller(empA).facebookEntry.parsePaste({ text: REAL });
    const base = { ...CUST, totalAmount: 750, shippingCost: 50, discount: 0, rawText: REAL, parseToken: res.parseToken!, parseResult: res.v2 } as any;
    const lines = linesOf(res.v2);
    // حذف سطر → مش مرفوض بسبب عدد السطور؛ المرفوض إن مجموع الكميات (3) ≠ عدد القطع (4)
    const fewer = await fail(() => caller(empA).facebookEntry.addOrder({ ...base, selectedProducts: lines.slice(0, 2), totalAmount: 575 }));
    expect(fewer.code).toBe("BAD_REQUEST"); expect(fewer.message).not.toContain("عدد السطور"); expect(fewer.message).toContain("عدد القطع");
    // نفس السطور بكمية معدّلة (2→1) → مجموع الكميات 3 ≠ عدد القطع 4
    const qty = await fail(() => caller(empA).facebookEntry.addOrder({ ...base, selectedProducts: lines.map((l: any, i: number) => (i === 0 ? { ...l, quantity: 1 } : l)), totalAmount: 575 }));
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
    expect(count.length).toBe(countBefore);
  });

  it("🔒 لا تجاوز بحذف/تعديل الـmetadata: rawText بلا توكن، توكن لنص مختلف، توكن موظف آخر — كلها مرفوضة", async () => {
    const countBefore = (await (await getDb())!.select({ id: orders.id }).from(orders).where(eq(orders.businessId, A.businessId))).length;
    const res = await caller(empA).facebookEntry.parsePaste({ text: REAL });
    const lines = linesOf(res.v2);
    const base = { ...CUST, selectedProducts: lines, totalAmount: 750, shippingCost: 50, parseResult: res.v2 } as any;
    expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, rawText: REAL }))).message).toContain("بيانات التحليل ناقصة");
    expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, parseToken: res.parseToken }))).message).toContain("بيانات التحليل ناقصة");
    expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, rawText: REAL, parseToken: res.parseToken, parseResult: undefined }))).message).toContain("بيانات التحليل ناقصة");
    // نفس التوكن مع rawText مختلف
    expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, rawText: REAL.replace("700", "400"), parseToken: res.parseToken }))).message).toContain("الرسالة تغيّرت");
    // توكن موظف/نشاط آخر
    const resB = await caller(empB).facebookEntry.parsePaste({ text: REAL });
    expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, rawText: REAL, parseToken: resB.parseToken, parseResult: resB.v2 }))).message).toContain("لا يخص هذا الموظف");
    // تعديل النتيجة في المتصفح (معرّف سطر) → البصمة مختلفة
    const tampered = structuredClone(res.v2); tampered.lines[0].match!.variantId = vA[3];
    expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, rawText: REAL, parseToken: res.parseToken, parseResult: tampered }))).message).toContain("نتيجة التحليل تغيّرت");
    // توكن منتهي (iat قبل ساعتين وثانية) بنفس البصمة
    const expired = signParseToken({ employeeId: empA, businessId: A.businessId, rawHash: rawTextHash(REAL), fp: canonicalFingerprint(res.v2), iat: Date.now() - PARSE_TOKEN_TTL_MS - 1000 });
    expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, rawText: REAL, parseToken: expired }))).message).toContain("انتهت صلاحية");
    // ولا أوردر اتكتب
    const count = await (await getDb())!.select({ id: orders.id }).from(orders).where(eq(orders.businessId, A.businessId));
    expect(count.length).toBe(countBefore);
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

  const AI_TEXT = `الاسم: عميل الذكاء\nالعنوان: القاهرة شارع 9\nرقم الفون(1): 01044444444\nنوع المنتج: ٢ سادة، 1 عين حرس\nعدد القطع: 3\nالسعر: 600 الشحن: 50 الإجمالي: 650`;

  it("🔑 deterministic unresolved → AI يحلّه (بمطابقة السيرفر داخل النشاط) → الواجهة تستلمه محلولًا → addOrder ينجح بنفس المعرّفات، بلا نداء AI ثانٍ، وaudit واحد", async () => {
    const provider = { calls: 0 };
    __setSegmentResolverFactoryForTests(() => async (segments) => {
      provider.calls++;
      return segments.map(sg => ({ segmentText: sg, intendedText: "عين حورس", quantity: null, unitPrice: null, confidence: 0.85 }));
    });
    try {
      const res = await caller(empA).facebookEntry.parsePaste({ text: AI_TEXT });
      expect(provider.calls).toBe(1);
      expect(res.v2.parseSource).toBe("mixed");
      const line = res.v2.lines[1];
      expect(line).toMatchObject({ segmentText: "عين حرس", aiAssisted: true, confidence: "ambiguous", match: { productId: prodA, variantId: vA[2] } });
      expect(res.v2.unresolvedSegments).toEqual([]);
      const lines = linesOf(res.v2);
      expect(lines.every((l: any) => l.productId === prodA)).toBe(true);
      const r = await caller(empA).facebookEntry.addOrder({
        ...CUST, customerPhone: "01044444444", selectedProducts: lines, totalAmount: 650, shippingCost: 50, discount: 0,
        rawText: AI_TEXT, parseToken: res.parseToken!, parseResult: res.v2,
      } as any);
      expect(r.success).toBe(true); expect(r.needsReview).toBe(false);
      expect(provider.calls).toBe(1); // الحفظ مااتصلش بالـAI
      const o = await trackOrder(r.orderNumber);
      const items = (await getOrderItemsForOrders([o.id])).get(o.id) ?? [];
      expect(items.map(i => [i.productId, i.variantId, i.quantity, Number(i.unitPrice)])).toEqual([[prodA, vA[0], 2, 200], [prodA, vA[2], 1, 200]]);
      const audits = await (await getDb())!.select().from(orderParseAudits).where(eq(orderParseAudits.orderId, o.id));
      expect(audits.length).toBe(1);
      expect(audits[0].parseSource).toBe("mixed");
      const rj = JSON.parse(audits[0].resultJson);
      expect(rj.client.lines[1].aiAssisted).toBe(true);
      // الموظف قبل اقتراح الـAI كما هو → ai_accepted، والسطر الحتمي → deterministic_accepted
      expect(rj.saved[1]).toMatchObject({ suggestedProductId: prodA, suggestedVariantId: vA[2], suggestedByAi: true, finalProductId: prodA, finalVariantId: vA[2], resolutionSource: "ai_accepted" });
      expect(rj.saved[0]).toMatchObject({ suggestedVariantId: vA[0], finalVariantId: vA[0], resolutionSource: "deterministic_accepted" });
    } finally { __setSegmentResolverFactoryForTests(null); }
  });

  it("🔑 AI يقترح خطأ والموظف يصحّحه لنوع آخر داخل نفس النشاط (بسعر يدوي) → يُحفظ employee_corrected بنفس التوكن، وبوسطة تأخذ النوع النهائي", async () => {
    __setSegmentResolverFactoryForTests(() => async (segments) => segments.map(sg => ({ segmentText: sg, intendedText: "عين حورس", quantity: null, unitPrice: null, confidence: 0.85 })));
    try {
      const res = await caller(empA).facebookEntry.parsePaste({ text: AI_TEXT });
      expect(res.v2.lines[1]).toMatchObject({ aiAssisted: true, confidence: "ambiguous", match: { variantId: vA[2] } });
      // الموظف يغيّر «عين حورس» (اقتراح) إلى «ذكر التحصين» ويعدّل الأسعار يدويًا: 175×2 + 250 = 600
      const lines = linesOf(res.v2).map((l: any, i: number) =>
        i === 1 ? { ...l, variantId: vA[3], unitPrice: 250, priceSource: "manual" } : { ...l, unitPrice: 175, priceSource: "manual" }
      );
      const r = await caller(empA).facebookEntry.addOrder({
        ...CUST, customerPhone: "01044444447", selectedProducts: lines, totalAmount: 650, shippingCost: 50, discount: 0,
        rawText: AI_TEXT, parseToken: res.parseToken!, parseResult: res.v2, // نفس النتيجة الموقّعة — الاقتراح الأصلي محفوظ فيها
      } as any);
      expect(r.success).toBe(true);
      const o = await trackOrder(r.orderNumber);
      const items = (await getOrderItemsForOrders([o.id])).get(o.id) ?? [];
      expect(items.map(i => [i.variantId, i.quantity, Number(i.unitPrice)])).toEqual([[vA[0], 2, 175], [vA[3], 1, 250]]); // السعر اليدوي محفوظ
      const [audit] = await (await getDb())!.select().from(orderParseAudits).where(eq(orderParseAudits.orderId, o.id));
      const rj = JSON.parse(audit.resultJson);
      expect(rj.client.lines[1].match.variantId).toBe(vA[2]); // الاقتراح الأصلي لم يتغيّر
      // الاقتراح الأصلي (AI: عين حورس) محفوظ في client.lines؛ السطر النهائي مصحَّح لنوع تاني بسعر يدوي
      expect(rj.resolution).toEqual({ status: "employee_corrected", structurallyEdited: true });
      expect(rj.saved[1]).toMatchObject({ finalVariantId: vA[3], resolutionSource: "employee_corrected", priceSource: "manual" });
      expect(rj.saved[0]).toMatchObject({ finalVariantId: vA[0], resolutionSource: "deterministic_accepted" });
      // وصف بوسطة من نفس مسار الإنتاج (getOrderItems + buildShipmentContents) = النوع النهائي، مش اقتراح الـAI
      const desc = buildShipmentContents((await getOrderItems(o.id)).map(it => ({ productName: it.productName, variantName: it.variantName, quantity: it.quantity, size: it.size, color: it.color }))).description;
      expect(desc).toBe("أسورة نحاس - سادة ×2، أسورة نحاس - ذكر التحصين ×1");
      expect(desc).not.toContain("عين حورس");
    } finally { __setSegmentResolverFactoryForTests(null); }
  });

  it("🔒 تصحيح الموظف لتركيبة من نشاط آخر، أو تركيبة لا تتبع منتج السطر → رفض", async () => {
    __setSegmentResolverFactoryForTests(() => async (segments) => segments.map(sg => ({ segmentText: sg, intendedText: "عين حورس", quantity: null, unitPrice: null, confidence: 0.85 })));
    try {
      const res = await caller(empA).facebookEntry.parsePaste({ text: AI_TEXT });
      const base = { ...CUST, customerPhone: "01044444448", totalAmount: 650, shippingCost: 50, rawText: AI_TEXT, parseToken: res.parseToken!, parseResult: res.v2 } as any;
      const lines = linesOf(res.v2);
      expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, selectedProducts: lines.map((l: any, i: number) => (i === 1 ? { ...l, variantId: vB[3] } : l)) }))).code).not.toBe("ok"); // تركيبة B على منتج A
      expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, selectedProducts: lines.map((l: any, i: number) => (i === 1 ? { ...l, productId: prodB, variantId: vB[3] } : l)) }))).code).not.toBe("ok"); // منتج B
    } finally { __setSegmentResolverFactoryForTests(null); }
  });

  it("🔒 تعديل اقتراح الـAI داخل parseResult (suggested IDs) أو استخدام تركيبة نشاط آخر → addOrder يرفض", async () => {
    __setSegmentResolverFactoryForTests(() => async (segments) => segments.map(sg => ({ segmentText: sg, intendedText: "عين حورس", quantity: null, unitPrice: null, confidence: 0.85 })));
    try {
      const res = await caller(empA).facebookEntry.parsePaste({ text: AI_TEXT });
      const lines = linesOf(res.v2);
      const base = { ...CUST, customerPhone: "01044444445", totalAmount: 650, shippingCost: 50, rawText: AI_TEXT, parseToken: res.parseToken!, parseResult: res.v2 } as any;
      const foreign = lines.map((l: any, i: number) => (i === 1 ? { ...l, productId: prodB, variantId: vB[2] } : l)); // نشاط آخر
      expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, selectedProducts: foreign }))).code).not.toBe("ok");
      const tampered = structuredClone(res.v2); tampered.lines[1].match = { productId: prodB, productName: "x", variantId: vB[2], variantName: "x" };
      expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, selectedProducts: linesOf(tampered), parseResult: tampered }))).message).toContain("نتيجة التحليل تغيّرت");
    } finally { __setSegmentResolverFactoryForTests(null); }
  });

  it("🔑 مزوّد AI غير متاح (يرمي): التحليل الحتمي يرجع unresolved، الموظف يختار النوع من نشاطه، والحفظ ينجح", async () => {
    __setSegmentResolverFactoryForTests(() => async () => { throw new Error("provider down"); });
    try {
      const res = await caller(empA).facebookEntry.parsePaste({ text: AI_TEXT });
      expect(res.v2.parseSource).toBe("deterministic");
      expect(res.v2.lines[1]).toMatchObject({ segmentText: "عين حرس", confidence: "unresolved", match: null });
      const lines = linesOf(res.v2).map((l: any, i: number) => (i === 1 ? { ...l, productId: prodA, variantId: vA[2] } : l)); // اختيار الموظف
      const r = await caller(empA).facebookEntry.addOrder({
        ...CUST, customerPhone: "01044444446", selectedProducts: lines, totalAmount: 650, shippingCost: 50, discount: 0,
        rawText: AI_TEXT, parseToken: res.parseToken!, parseResult: res.v2,
      } as any);
      expect(r.success).toBe(true);
      const o = await trackOrder(r.orderNumber);
      expect(((await getOrderItemsForOrders([o.id])).get(o.id) ?? []).map(i => i.variantId)).toEqual([vA[0], vA[2]]);
    } finally { __setSegmentResolverFactoryForTests(null); }
  });

  const PROD3 = `الاسم: خير محمد\nالعنوان: الوادي الجديد مركز الخارجة\nرقم الفون(1): 01112785429\nنوع المنتج: ايه كرسي وتحصين\nعدد القطع: 2\nالسعر: 400\nالشحن: 50\nالإجمالي: 450`;

  it("🔑 حالة Production: «ايه كرسي وتحصين» → آية الكرسي ×1 + ذكر التحصين ×1، 200 لكل سطر، 400/50/450، order_items = 2، وصف بوسطة بالنوعين (موظفة data_entry)", async () => {
    const res = await caller(empA).facebookEntry.parsePaste({ text: PROD3 });
    expect(res.v2.lines.map(l => [l.match?.variantId, l.quantity, l.unitPrice])).toEqual([[vA[4], 1, 200], [vA[3], 1, 200]]);
    const r = await caller(empA).facebookEntry.addOrder({
      ...CUST, customerPhone: "01112785429", selectedProducts: linesOf(res.v2), totalAmount: 450, shippingCost: 50, discount: 0,
      rawText: PROD3, parseToken: res.parseToken!, parseResult: res.v2,
    } as any);
    expect(r.success).toBe(true);
    const o = await trackOrder(r.orderNumber);
    expect([Number(o.totalAmount), Number(o.shippingFees), o.quantity]).toEqual([450, 50, 2]);
    const items = (await getOrderItemsForOrders([o.id])).get(o.id) ?? [];
    expect(items.map(i => [i.variantId, i.quantity, Number(i.unitPrice)])).toEqual([[vA[4], 1, 200], [vA[3], 1, 200]]);
    const desc = buildShipmentContents((await getOrderItems(o.id)).map(it => ({ productName: it.productName, variantName: it.variantName, quantity: it.quantity, size: it.size, color: it.color })));
    expect(desc.description).toBe("أسورة نحاس - آية الكرسي ×1، أسورة نحاس - ذكر التحصين ×1");
  });

  it("🔑 التحليل اقتراح: سطر واحد ×2 → الموظفة قسمته لسطرين مختلفين (parse lines=1، final=2) → الحفظ ينجح employee_corrected، والاقتراح الأصلي محفوظ", async () => {
    // رسالة بتتحلّل لسطر واحد ×2 (نفس شكل خطأ Production القديم)
    const TXT = `الاسم: خير محمد\nالعنوان: القاهرة شارع 1\nرقم الفون(1): 01112785430\nنوع المنتج: ٢ تحصين\nعدد القطع: 2\nالسعر: 400\nالشحن: 50\nالإجمالي: 450`;
    const res = await caller(empA).facebookEntry.parsePaste({ text: TXT });
    expect(res.v2.lines.map(l => [l.match?.variantId, l.quantity])).toEqual([[vA[3], 2]]);
    const split = [
      { productId: prodA, productName: "أسورة نحاس", quantity: 1, variantId: vA[4], unitPrice: 200, priceSource: "manual" },
      { productId: prodA, productName: "أسورة نحاس", quantity: 1, variantId: vA[3], unitPrice: 200, priceSource: "allocated" },
    ];
    const r = await caller(empA).facebookEntry.addOrder({
      ...CUST, customerPhone: "01112785430", selectedProducts: split, totalAmount: 450, shippingCost: 50, discount: 0,
      rawText: TXT, parseToken: res.parseToken!, parseResult: res.v2,
    } as any);
    expect(r.success).toBe(true);
    const o = await trackOrder(r.orderNumber);
    const items = (await getOrderItemsForOrders([o.id])).get(o.id) ?? [];
    expect(items.map(i => [i.variantId, i.quantity, Number(i.unitPrice)])).toEqual([[vA[4], 1, 200], [vA[3], 1, 200]]);
    const [audit] = await (await getDb())!.select().from(orderParseAudits).where(eq(orderParseAudits.orderId, o.id));
    const rj = JSON.parse(audit.resultJson);
    expect(rj.client.lines).toHaveLength(1); expect(rj.client.lines[0].match.variantId).toBe(vA[3]); // الاقتراح الأصلي كما هو
    expect(rj.resolution).toEqual({ status: "employee_corrected", structurallyEdited: true });
    expect(rj.saved.map((s: any) => [s.finalVariantId, s.resolutionSource])).toEqual([[vA[4], "employee_corrected"], [vA[3], "deterministic_accepted"]]);
    const desc = buildShipmentContents((await getOrderItems(o.id)).map(it => ({ productName: it.productName, variantName: it.variantName, quantity: it.quantity, size: it.size, color: it.color })));
    expect(desc.description).toContain("آية الكرسي ×1"); expect(desc.description).toContain("ذكر التحصين ×1");
  });

  it("🔑 إضافة/حذف/تغيير variant داخل نفس النشاط ينجح (employee_corrected)؛ variant/product من نشاط آخر يُرفض", async () => {
    const res = await caller(empA).facebookEntry.parsePaste({ text: REAL }); // 3 سطور: 2 سادة، 1 منقوش، 1 عين حورس (700)
    const base = { ...CUST, customerPhone: "01112785431", totalAmount: 750, shippingCost: 50, discount: 0, rawText: REAL, parseToken: res.parseToken!, parseResult: res.v2 } as any;
    // حذف سطر «منقوش» + تغيير «عين حورس» لـ«آية الكرسي» + إضافة سطر «ذكر التحصين» — نفس 4 قطع و700
    const edited = [
      { productId: prodA, productName: "أسورة نحاس", quantity: 2, variantId: vA[0], unitPrice: 175 },
      { productId: prodA, productName: "أسورة نحاس", quantity: 1, variantId: vA[4], unitPrice: 175 },
      { productId: prodA, productName: "أسورة نحاس", quantity: 1, variantId: vA[3], unitPrice: 175 },
    ];
    const r = await caller(empA).facebookEntry.addOrder({ ...base, selectedProducts: edited });
    expect(r.success).toBe(true);
    const o = await trackOrder(r.orderNumber);
    expect(((await getOrderItemsForOrders([o.id])).get(o.id) ?? []).map(i => i.variantId)).toEqual([vA[0], vA[4], vA[3]]);
    const rj = JSON.parse((await (await getDb())!.select().from(orderParseAudits).where(eq(orderParseAudits.orderId, o.id)))[0].resultJson);
    expect(rj.resolution.status).toBe("employee_corrected");
    // نشاط آخر → رفض (ملكية)
    const foreignV = edited.map((l, i) => (i === 1 ? { ...l, variantId: vB[4] } : l));
    expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, customerPhone: "01112785432", selectedProducts: foreignV }))).code).not.toBe("ok");
    const foreignP = edited.map((l, i) => (i === 1 ? { ...l, productId: prodB, variantId: vB[4] } : l));
    expect((await fail(() => caller(empA).facebookEntry.addOrder({ ...base, customerPhone: "01112785433", selectedProducts: foreignP }))).code).not.toBe("ok");
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
