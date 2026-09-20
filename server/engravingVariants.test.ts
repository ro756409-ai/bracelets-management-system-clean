import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import {
  getDb,
  createEmployee,
  createProductWithVariants,
  addVariantsToProduct,
  getMatchCatalog,
  getOrderItemsForOrders,
  variantIdentityKey,
} from "./db";
import { employees, orders, orderItems, products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { buildShipmentContents, describeShipmentLine } from "../shared/orderContent";

/**
 * المرحلة A — «نوع الحفر» رجع للأساور بلا Migration.
 * التركيبة عند الأساور بتتحدد بـ`product_variants.name` فقط (لون/مقاس فاضيين)، وعند Afandy
 * باللون+المقاس. بنغطّي: هوية التركيبة بكل الأبعاد، إن نوع حفر جديد بيتسجّل (مايتخطّاش
 * بصمت)، إن كل قطعة بتتحفظ بـvariantId الخاص بيها، رفض تركيبة من منتج تاني، والعزل بين
 * الأنشطة، وظهور نوع الحفر في بنود الأوردر (تفاصيل/طباعة/بوسطة).
 */

// ── هوية التركيبة (دالة نقية) ──
describe("🔑 هوية التركيبة = النوع + اللون + المقاس", () => {
  it("🔑 نوعان مختلفان بلا لون/مقاس = تركيبتان مختلفتان", () => {
    expect(variantIdentityKey({ name: "آية الكرسي" })).not.toBe(
      variantIdentityKey({ name: "ذكر التحصين" })
    );
  });
  it("🔑 لا انحدار: نفس اللون×المقاس بلا اسم لسه تركيبة مكررة", () => {
    expect(variantIdentityKey({ color: "أسود", size: "6" })).toBe(
      variantIdentityKey({ color: " أسود ", size: "6" })
    );
  });
  it("🔑 نفس اللون×المقاس باسمين مختلفين = تركيبتان", () => {
    expect(variantIdentityKey({ name: "منقوش", color: "ذهبي", size: "M" })).not.toBe(
      variantIdentityKey({ name: "سادة", color: "ذهبي", size: "M" })
    );
  });
});

// ── الطباعة/البوليصة وبوسطة: الوصف بيتركّب لحظة القراءة من variantName ──
describe("🔑 وصف الشحنة (بوسطة/البوليصة) بيحمل نوع الحفر لكل قطعة", () => {
  const line = (variantName: string | null, quantity = 1) => ({
    productName: "أسورة نحاس", variantName, quantity, size: null, color: null,
  });

  it("🔑 قطعتان بنقشتين → الاتنين في الوصف", () => {
    const { description, itemsCount } = buildShipmentContents([
      line("آية الكرسي"), line("ذكر التحصين"),
    ]);
    expect(description).toBe("أسورة نحاس - آية الكرسي ×1، أسورة نحاس - ذكر التحصين ×1");
    expect(itemsCount).toBe(2);
  });

  it("🔑 الاسم بيتركّب من variantName — مش محتاج snapshot في اسم البند", () => {
    expect(describeShipmentLine(line("آية الكرسي", 3))).toBe("أسورة نحاس - آية الكرسي ×3");
  });

  it("🔒 صف قديم اسمه مركّب مايتركّبش تاني على البوليصة", () => {
    expect(
      describeShipmentLine({
        productName: "أسورة نحاس - سادة", variantName: "سادة",
        quantity: 1, size: null, color: null,
      })
    ).toBe("أسورة نحاس - سادة ×1");
  });

  it("🔑 Afandy: لون/مقاس بيظهروا، وبلا نوع حفر", () => {
    expect(
      describeShipmentLine({
        productName: "بدلة كورن", variantName: null,
        quantity: 2, size: "12", color: "بيج",
      })
    ).toBe("بدلة كورن (مقاس 12، لون بيج) ×2");
  });

  it("🔑 منتج بسيط بلا تركيبة → اسمه لوحده", () => {
    expect(describeShipmentLine(line(null, 1))).toBe("أسورة نحاس ×1");
  });
});

// ── المصادر: كل الشاشات بتقرا نوع الحفر من نفس المكان (variantId → variantName) ──
describe("🔑 مصدر واحد لنوع الحفر", () => {
  const dbSrc = fs.readFileSync("server/db.ts", "utf-8");
  const bosta = fs.readFileSync("server/bosta.service.ts", "utf-8");
  const details = fs.readFileSync("client/src/pages/OrderDetails.tsx", "utf-8");

  it("🔑 getOrderItemsForOrders بتجيب variantName بالـjoin", () => {
    const fn = dbSrc.slice(
      dbSrc.indexOf("export async function getOrderItemsForOrders"),
      dbSrc.indexOf("export async function getOrderItemsForOrders") + 900
    );
    expect(fn).toContain("variantName: productVariants.name");
    expect(fn).toContain("leftJoin(productVariants");
  });
  it("🔑 بوسطة بتبني الوصف من نفس البنود", () => {
    expect(bosta).toContain("buildShipmentContents(");
    expect(bosta).toContain("variantName: it.variantName");
  });
  it("🔑 تفاصيل الأوردر بتعرض variantName لكل بند", () => {
    expect(details).toContain("it.variantName");
  });
  it("🔒 الكتابة بتشتق اسم البند من الكتالوج (مش من المتصل)", () => {
    expect(dbSrc).toContain("items = await withCatalogProductNames(tx, items);");
    expect(dbSrc).toContain("lines = await withCatalogProductNames(tx, lines);");
  });
});

const CAN_E2E = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN_E2E)("🔑 نوع الحفر — سلوكي", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const ids = { productIds: [] as number[], empIds: [] as number[], orderIds: [] as number[] };
  let braceletId = 0;
  let vAya = 0, vTahseen = 0;
  let otherProductVariant = 0;
  let deA = 0;
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);

  const caller = (employeeId: number) =>
    appRouter.createCaller({
      user: null, employee: null, tenantId: null,
      req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId }, process.env.JWT_SECRET as string) } },
      res: { clearCookie: () => {}, cookie: () => {} },
    } as any);
  async function code(fn: () => Promise<any>): Promise<string> {
    try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; }
  }

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("eng-a"); // الأساور
    B = await createCoreTestFixture("eng-b"); // نشاط تاني

    // أسورة: تركيبات بالنوع فقط (نوع الحفر) — بلا لون/مقاس
    const br = await createProductWithVariants(A.businessId, { name: `أسورة نحاس ${tag}` }, [
      { name: "آية الكرسي", sku: `ENG-AYA-${tag}`, currentStock: 10, price: "150" },
      { name: "ذكر التحصين", sku: `ENG-TAH-${tag}`, currentStock: 10, price: "150" },
    ]);
    braceletId = br.productId;
    [vAya, vTahseen] = br.variantIds;
    ids.productIds.push(braceletId);

    // منتج تاني في نفس النشاط — تركيبته مش تابعة للأسورة
    const other = await createProductWithVariants(A.businessId, { name: `منتج تاني ${tag}` }, [
      { name: "سادة", sku: `ENG-OTH-${tag}`, currentStock: 10, price: "50" },
    ]);
    otherProductVariant = other.variantIds[0];
    ids.productIds.push(other.productId);

    // منتج في النشاط B (لون/مقاس) — للعزل
    const bp = await createProductWithVariants(B.businessId, { name: `ملابس ${tag}` }, [
      { color: "بيج", size: "12", sku: `ENG-B-${tag}`, currentStock: 5, price: "200" },
    ]);
    ids.productIds.push(bp.productId);

    deA = insId(await createEmployee({ name: "entry-A", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `engA_${tag}` } as any));
    ids.empIds.push(deA);
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
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔑 نوع حفر جديد بيتسجّل فعلًا — مايتخطّاش بصمت", async () => {
    const res = await addVariantsToProduct(braceletId, [
      { name: "سورة الإخلاص", sku: `ENG-IKH-${tag}`, currentStock: 4, price: "150" },
    ]);
    expect(res.skipped).toEqual([]);
    expect(res.createdIds.length).toBe(1);
  });

  it("🔑 نوع حفر موجود بالفعل بيتخطّى (لا تكرار)", async () => {
    const res = await addVariantsToProduct(braceletId, [
      { name: "آية الكرسي", sku: `ENG-AYA-DUP-${tag}`, currentStock: 1 },
    ]);
    expect(res.createdIds).toEqual([]);
    expect(res.skipped).toContain("آية الكرسي");
  });

  it("🔑 الكتالوج بيرجّع أنواع الحفر (name) للأسورة — مصدر القائمة في الواجهة", async () => {
    const cat = await getMatchCatalog(undefined, [A.businessId]);
    const mine = cat.variants.filter(v => v.productId === braceletId);
    expect(mine.map(v => v.name).sort()).toEqual(
      ["آية الكرسي", "ذكر التحصين", "سورة الإخلاص"].sort()
    );
    // الأساور بلا لون/مقاس — فالواجهة مش هتعرض قوائم لون/مقاس ليها
    expect(mine.every(v => !v.color && !v.size)).toBe(true);
  });

  it("🔑 قطعتان بنقشتين مختلفتين + اسم ملوّث من العميل → variantId مختلف واسم كتالوجي نظيف", async () => {
    // **الاسم الجاي من العميل ملوّث عن قصد**: مركّب بنوع الحفر، وواحد منهم باسم منتج
    // تاني خالص. السيرفر لازم يتجاهلهم الاتنين ويشتق الاسم من كتالوج النشاط.
    const res = await caller(deA).facebookEntry.addOrder({
      customerName: "عميل الأساور", customerPhone: "01234567890", governorate: "القاهرة",
      customerAddress: "عنوان",
      selectedProducts: [
        { productId: braceletId, productName: `أسورة نحاس ${tag} - آية الكرسي`, quantity: 1, variantId: vAya, unitPrice: 150 },
        { productId: braceletId, productName: "اسم مزوّر خالص", quantity: 1, variantId: vTahseen, unitPrice: 150 },
      ],
      totalAmount: 300,
    } as any);
    expect(res.success).toBe(true);
    const d = await getDb();
    const [row] = await d!.select().from(orders).where(inArray(orders.orderNumber, [res.orderNumber]));
    ids.orderIds.push(row.id);

    const items = (await getOrderItemsForOrders([row.id])).get(row.id) ?? [];
    expect(items.length).toBe(2);
    // العقد الحقيقي: هوية التركيبة في variantId، مش مركّبة جوه اسم البند.
    expect(new Set(items.map(i => i.variantId)).size).toBe(2);
    expect(items.map(i => i.variantId).sort()).toEqual([vAya, vTahseen].sort());
    // نوع الحفر بيتقرا صح لكل بند (تفاصيل الأوردر بتعرض it.variantName)
    expect(items.map(i => (i as any).variantName).sort()).toEqual(
      ["آية الكرسي", "ذكر التحصين"].sort()
    );
    // اسم البند = اسم المنتج من الكتالوج لوحده (withCatalogProductNames)، عشان
    // نوع حفر قديم مايعيشش جوه النص بعد ما الموظف يغيّر النقشة.
    expect(items.every(i => i.productName === `أسورة نحاس ${tag}`)).toBe(true);

    // الطباعة/البوليصة وبوسطة: نفس البنود بتتحوّل لوصف الشحنة — النقشتان لازم يظهروا.
    const { description, itemsCount } = buildShipmentContents(
      items.map(i => ({
        productName: i.productName,
        variantName: (i as any).variantName,
        quantity: i.quantity,
        size: i.size,
        color: i.color,
      })),
      { productName: row.productName, quantity: row.quantity }
    );
    expect(description).toContain("آية الكرسي");
    expect(description).toContain("ذكر التحصين");
    expect(itemsCount).toBe(2);
  });

  it("🔒 مرآة الهيدر اسم كتالوجي نظيف — الاسم الملوّث من العميل اتجاهل", async () => {
    const d = await getDb();
    const [row] = await d!.select().from(orders).where(inArray(orders.id, [ids.orderIds[0]]));
    // مفيش نوع حفر مركّب جوه النص، ومفيش الاسم المزوّر
    expect(row.productName).not.toContain(" - ");
    expect(row.productName).not.toContain("آية الكرسي");
    expect(row.productName).not.toContain("مزوّر");
    // الاسم الكتالوجي لوحده لكل بند
    expect(row.productName).toBe(`أسورة نحاس ${tag} + أسورة نحاس ${tag}`);
  });

  it("🔒 التعديل كمان مابيثقش في اسم العميل ولا في منتج نشاط تاني", async () => {
    const orderId = ids.orderIds[0];
    await caller(deA).facebookEntry.updateOrder({
      orderId, customerName: "عميل الأساور", customerPhone: "01234567890",
      governorate: "القاهرة", customerAddress: "عنوان",
      selectedProducts: [{ productId: braceletId, productName: "اسم ملوّث - سادة", quantity: 2 }],
      totalAmount: 300,
    } as any);
    const d = await getDb();
    const [row] = await d!.select().from(orders).where(inArray(orders.id, [orderId]));
    expect(row.productName).toBe(`أسورة نحاس ${tag} ×2`);
    // منتج من نشاط تاني بيترفض (مش بيتكتب في الهيدر)
    const foreign = (await getMatchCatalog(undefined, [B.businessId])).products[0];
    expect(await code(() => caller(deA).facebookEntry.updateOrder({
      orderId, customerName: "x", customerPhone: "01234567890",
      governorate: "القاهرة", customerAddress: "y",
      selectedProducts: [{ productId: foreign.id, productName: "منتج غريب", quantity: 1 }],
      totalAmount: 100,
    } as any))).not.toBe("ok");
  });

  it("🔑 لا انحدار: أوردر منتج واحد بكمية 1 → الاسم بلا ×", async () => {
    const res = await caller(deA).facebookEntry.addOrder({
      customerName: "عميل مفرد", customerPhone: "01234567892", governorate: "القاهرة",
      customerAddress: "عنوان",
      selectedProducts: [{ productId: braceletId, productName: "أي كلام", quantity: 1, variantId: vAya, unitPrice: 150 }],
      totalAmount: 150,
    } as any);
    const d = await getDb();
    const [row] = await d!.select().from(orders).where(inArray(orders.orderNumber, [res.orderNumber]));
    ids.orderIds.push(row.id);
    expect(row.productName).toBe(`أسورة نحاس ${tag}`);
  });

  it("🔒 تركيبة تابعة لمنتج تاني بتترفض على السيرفر", async () => {
    expect(await code(() => caller(deA).facebookEntry.addOrder({
      customerName: "x", customerPhone: "01234567890", governorate: "القاهرة", customerAddress: "y",
      selectedProducts: [{ productId: braceletId, productName: "أسورة", quantity: 1, variantId: otherProductVariant }],
      totalAmount: 150,
    } as any))).toBe("BAD_REQUEST");
  });

  it("🔒 variantId بلا productId بيترفض", async () => {
    expect(await code(() => caller(deA).facebookEntry.addOrder({
      customerName: "x", customerPhone: "01234567890", governorate: "القاهرة", customerAddress: "y",
      selectedProducts: [{ productName: "أسورة", quantity: 1, variantId: vAya }],
      totalAmount: 150,
    } as any))).toBe("BAD_REQUEST");
  });

  it("🔒 موظف النشاط A مايشوفش تركيبات النشاط B", async () => {
    const cat = await caller(deA).facebookEntry.catalog();
    expect(cat.products.length).toBeGreaterThan(0);
    expect(cat.products.some(p => p.name === `ملابس ${tag}`)).toBe(false);
    expect(cat.variants.some(v => v.sku === `ENG-B-${tag}`)).toBe(false);
  });

  it("🔑 **الرحلة الكاملة**: لصق نص بنوعين → سطران بتركيبتين وسعر موزّع", async () => {
    const text = [
      "اسم العميل: Samar Hasan",
      "رقم التليفون: 01098260811",
      "العنوان: المنصورة الصفيح امام صيدلية ياسين",
      `نوع المنتج: آية الكرسي وذكر التحصين`,
      "عدد القطع: 2",
      "السعر: 400",
      "الشحن: 50 الإجمالي: 450",
    ].join("\n");

    const res = await caller(deA).facebookEntry.parsePaste({ text });

    // الأرقام: الشحن 50 مش 50450، حتى وهو في نفس سطر الإجمالي
    expect(res.parsed.shipping).toBe(50);
    expect(res.parsed.itemsSubtotal).toBe(400);
    expect(res.parsed.totalAmount).toBe(450);
    expect(res.parsed.quantity).toBe(2);
    expect(res.parsed.totalMismatch).toBe(false);
    expect(res.parsed.customerName).toBe("Samar Hasan");
    expect(res.parsed.customerPhone).toBe("01098260811");
    // المحافظة من المدينة، مش أول كلمة من العنوان
    expect(res.parsed.governorate).toBe("الدقهلية");
    expect(res.parsed.city).toBe("المنصورة");
    expect(res.parsed.customerAddress).toBe("المنصورة الصفيح امام صيدلية ياسين");

    // سطران، كل واحد بتركيبته — مش سطر واحد بيبلع النوع التاني
    expect(res.lines).toHaveLength(2);
    expect(res.lines.map(l => l.match?.variantId).sort()).toEqual([vAya, vTahseen].sort());
    expect(res.lines.every(l => l.quantity === 1)).toBe(true);
    // السعر موزّع: 400 على قطعتين
    expect(res.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0)).toBeCloseTo(400, 2);

    // والحفظ بيدّي بندين بـvariantId مختلف
    const saved = await caller(deA).facebookEntry.addOrder({
      customerName: res.parsed.customerName, customerPhone: res.parsed.customerPhone,
      governorate: res.parsed.governorate, customerAddress: res.parsed.customerAddress,
      selectedProducts: res.lines.map(l => ({
        productId: l.match!.productId, productName: l.match!.productName,
        quantity: l.quantity, variantId: l.match!.variantId!, unitPrice: l.unitPrice,
      })),
      totalAmount: res.parsed.totalAmount,
      shippingCost: res.parsed.shipping,
    } as any);
    const d = await getDb();
    const [row] = await d!.select().from(orders).where(inArray(orders.orderNumber, [saved.orderNumber]));
    ids.orderIds.push(row.id);
    const items = (await getOrderItemsForOrders([row.id])).get(row.id) ?? [];
    expect(items).toHaveLength(2);
    expect(new Set(items.map(i => i.variantId)).size).toBe(2);
    expect(row.quantity).toBe(2);
  });

  it("🔒 نص لا يطابق أي منتج → مفيش اختيار تلقائي", async () => {
    const res = await caller(deA).facebookEntry.parsePaste({
      text: "نوع المنتج: حاجة مش موجودة خالص\nعدد القطع: 1",
    });
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].match).toBeNull();
    expect(res.lines[0].matchReason).toBeTruthy();
  });

  it("🔑 المخزون مش مانع: كمية 2 والمتاح 1 → تتسجّل 2 بلا أي خصم", async () => {
    const d = await getDb();
    // نخلّي تركيبة «آية الكرسي» متاحها 1 بالظبط
    await d!.update(productVariants).set({ currentStock: 1 }).where(inArray(productVariants.id, [vAya]));
    const before = (await d!.select().from(productVariants).where(inArray(productVariants.id, [vAya])))[0];
    expect(before.currentStock).toBe(1);

    const res = await caller(deA).facebookEntry.addOrder({
      customerName: "عميل كمية", customerPhone: "01234567893", governorate: "القاهرة",
      customerAddress: "عنوان",
      selectedProducts: [{ productId: braceletId, productName: "أسورة", quantity: 2, variantId: vAya, unitPrice: 150 }],
      totalAmount: 300,
    } as any);
    expect(res.success).toBe(true);

    const [row] = await d!.select().from(orders).where(inArray(orders.orderNumber, [res.orderNumber]));
    ids.orderIds.push(row.id);
    // الكمية اتحفظت 2 — مفيش قصّ صامت لمتاح المخزون
    const items = (await getOrderItemsForOrders([row.id])).get(row.id) ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(2);
    expect(row.quantity).toBe(2);
    // ومفيش خصم وقت الإدخال — الخصم بيحصل في confirmOrder بس
    const after = (await d!.select().from(productVariants).where(inArray(productVariants.id, [vAya])))[0];
    expect(after.currentStock).toBe(1);
  });

  it("🔑 منتج بسيط (بلا تركيبات) لسه بيتسجّل بلا variantId", async () => {
    const res = await caller(deA).facebookEntry.addOrder({
      customerName: "عميل بسيط", customerPhone: "01234567891", governorate: "القاهرة",
      customerAddress: "عنوان",
      selectedProducts: [{ productId: A.productId, productName: "Test Product", quantity: 1 }],
      totalAmount: 100,
    } as any);
    expect(res.success).toBe(true);
    const d = await getDb();
    const [row] = await d!.select().from(orders).where(inArray(orders.orderNumber, [res.orderNumber]));
    ids.orderIds.push(row.id);
    const items = (await getOrderItemsForOrders([row.id])).get(row.id) ?? [];
    expect(items.length).toBe(1);
    expect(items[0].variantId ?? null).toBeNull();
  });
});
