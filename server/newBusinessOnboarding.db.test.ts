import { describe, it, expect, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { and, eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { getDb, createSignupRequest, approveSignupRequest, createPlatformAdmin } from "./db";
import {
  businessConfigurationValues, businessShippingProviders, businesses, employees, memberships, orderItems, orders,
  platformAdmins, products, productVariants, shipmentChargeSnapshots, shippingProviders, signupRequests, tenants,
} from "../drizzle/schema";

/**
 * نشاط جديد تمامًا على قاعدة فارغة — بمسار المنتج نفسه (طلب تسجيل → قبول من أدمن المنصة):
 * المالك الجديد ينشئ شركة شحن ونوع شحن ونوع دفع ومنتجًا بتركيباته من داخل نموذج الأوردر،
 * ثم يحفظ أوردرًا تجريبيًا بنجاح — بلا أي بيانات افتراضية وبلا نسخة سعر شحن.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN)("🆕 نشاط جديد على قاعدة فارغة — العناصر الأربعة ثم أوردر تجريبي", () => {
  const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  let tenantId = 0, businessId = 0, ownerId = 0, platformAdminId = 0, requestId = 0;
  let tenantB = 0, businessB = 0, ownerB = 0, requestB = 0;
  const createdOrderIds: number[] = [];
  const db = async () => (await getDb())!;

  /** جلسة المالك الجديد بكوكي الموظف فقط — عبر `createContext` الحقيقي (لا حساب مالك قديم). */
  const sessionCtx = async (employeeId: number) => createContext({
    req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId }, process.env.JWT_SECRET as string) } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as any);
  const session = (employeeId: number) => {
    // caller كسول: كل نداء يحلّ الجلسة من الكوكي كما في الإنتاج.
    const lazy = new Proxy({}, {
      get: (_t, ns: string) => new Proxy({}, {
        get: (_t2, proc: string) => async (input: any) => ((await appRouter.createCaller(await sessionCtx(employeeId)) as any)[ns][proc](input)),
      }),
    });
    return lazy as ReturnType<typeof appRouter.createCaller>;
  };
  const code = async (fn: () => Promise<any>) => { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } };

  /** نفس مسار المنتج: طلب تسجيل ثم قبول → tenant + business فارغ + owner super_admin + membership. */
  const onboard = async (suffix: string) => {
    const reqId = await createSignupRequest({
      ownerName: `مالك ${suffix}`, businessName: `نشاط ${suffix} ${tag}`, phone: "01000000009",
      email: `owner-${suffix}-${tag}@example.com`, username: `owner_${suffix}_${tag}`.slice(0, 50),
      passwordHash: await bcrypt.hash("test-only-password-123", 4),
    });
    const r = await approveSignupRequest(reqId, platformAdminId);
    if (!r.ok) throw new Error(`approve failed: ${r.message}`);
    return { reqId, ...r };
  };

  beforeAll(async () => {
    platformAdminId = await createPlatformAdmin({ username: `pa_${tag}`, email: `pa-${tag}@example.com`, passwordHash: await bcrypt.hash("x".repeat(12), 4) } as any);
    const a = await onboard("a"); requestId = a.reqId; tenantId = a.tenantId; businessId = a.businessId; ownerId = a.employeeId;
    const b = await onboard("b"); requestB = b.reqId; tenantB = b.tenantId; businessB = b.businessId; ownerB = b.employeeId;
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    const bids = [businessId, businessB].filter(Boolean);
    if (createdOrderIds.length) {
      await d.delete(shipmentChargeSnapshots).where(inArray(shipmentChargeSnapshots.orderId, createdOrderIds));
      await d.delete(orderItems).where(inArray(orderItems.orderId, createdOrderIds));
      await d.delete(orders).where(inArray(orders.id, createdOrderIds));
    }
    if (bids.length) {
      const prods = await d.select({ id: products.id }).from(products).where(inArray(products.businessId, bids));
      if (prods.length) { await d.delete(productVariants).where(inArray(productVariants.productId, prods.map(p => p.id))); await d.delete(products).where(inArray(products.id, prods.map(p => p.id))); }
      await d.delete(businessConfigurationValues).where(inArray(businessConfigurationValues.businessId, bids));
      await d.delete(businessShippingProviders).where(inArray(businessShippingProviders.businessId, bids));
      await d.delete(shippingProviders).where(eq(shippingProviders.code, `شركة ${tag}`));
      await d.delete(employees).where(inArray(employees.businessId, bids));
      await d.delete(businesses).where(inArray(businesses.id, bids));
    }
    const tids = [tenantId, tenantB].filter(Boolean);
    if (tids.length) { await d.delete(memberships).where(inArray(memberships.tenantId, tids)); await d.delete(tenants).where(inArray(tenants.id, tids)); }
    await d.delete(signupRequests).where(inArray(signupRequests.id, [requestId, requestB].filter(Boolean)));
    if (platformAdminId) await d.delete(platformAdmins).where(eq(platformAdmins.id, platformAdminId));
  });

  it("🔑 بعد القبول: النشاط فارغ تمامًا (لا شركات شحن ولا أنواع ولا منتجات) — لا بيانات افتراضية تلقائية", async () => {
    const owner = session(ownerId);
    const shipping = await owner.accountingV2.shippingConfiguration({ businessId });
    expect(shipping.providers).toEqual([]);
    expect(await owner.accountingV2.configurationList({ businessId, namespace: "shipping_type", activeOnly: true })).toEqual([]);
    expect(await owner.accountingV2.configurationList({ businessId, namespace: "payment_type", activeOnly: true })).toEqual([]);
    expect((await owner.products.list({ businessId })).length).toBe(0);
  });

  it("🔑 المالك الجديد ينشئ العناصر الأربعة من نموذج الأوردر ثم يحفظ أوردرًا تجريبيًا بنجاح (بلا نسخة سعر شحن)", async () => {
    const owner = session(ownerId);
    // 1) شركة شحن — اسم واحد
    const provider = await owner.accountingV2.shippingProviderSave({ businessId, providerCode: `شركة ${tag}`, providerName: `شركة ${tag}`, displayName: `شركة ${tag}`, statusMapping: {} });
    expect(provider?.id).toBeTruthy();
    // 2) نوع شحن و3) نوع دفع — بالاسم فقط؛ المفتاح من السيرفر؛ التكرار بالاسم يرجع نفس الصف
    const st = await owner.accountingV2.configurationQuickAdd({ businessId, namespace: "shipping_type", displayName: "  توصيل   عادي " });
    expect(st.created).toBe(true); expect(st.displayName).toBe("توصيل عادي"); expect(st.configKey).toMatch(/^shipping_type-[a-z0-9]{6}$/);
    const stAgain = await owner.accountingV2.configurationQuickAdd({ businessId, namespace: "shipping_type", displayName: "توصيل عادي" });
    expect(stAgain.created).toBe(false); expect(stAgain.id).toBe(st.id);
    const pt = await owner.accountingV2.configurationQuickAdd({ businessId, namespace: "payment_type", displayName: "كاش عند الاستلام" });
    expect(pt.created).toBe(true);
    expect((await owner.accountingV2.configurationList({ businessId, namespace: "shipping_type", activeOnly: true })).map(r => r.configKey)).toEqual([st.configKey]);
    // 4) منتج بتركيباته
    const product = await owner.products.createWithVariants({
      name: `أسورة ${tag}`, businessId,
      variants: [{ name: "سادة", price: 150, currentStock: 10 }, { name: "منقوش", price: 200, currentStock: 5 }],
    });
    expect(product.productId).toBeTruthy(); expect(product.variantIds).toHaveLength(2);
    const simple = await owner.products.create({ name: `منتج بسيط ${tag}`, price: "99", currentStock: 3, businessId });
    expect(simple.id).toBeGreaterThan(0);

    // أوردر تجريبي بالعناصر الثلاثة مختارة — بلا نسخة سعر شحن (نشاط جديد قبل Go-Live) → ينجح
    const created = await owner.orders.create({
      customerName: "عميل تجريبي", customerPhone: "01000000001", customerAddress: "شارع طويل رقم 10", governorate: "القاهرة",
      productId: product.productId, productName: `أسورة ${tag}`, variantId: product.variantIds[0], quantity: 2, totalAmount: "300",
      source: "facebook", businessId,
      projectedShippingProviderId: provider!.id, projectedShippingType: st.configKey, projectedPaymentType: pt.configKey,
    });
    expect(created.success).toBe(true);
    const [row] = await (await db()).select().from(orders).where(eq(orders.orderNumber, created.orderNumber));
    createdOrderIds.push(row.id);
    expect(row.businessId).toBe(businessId);
    expect(row.projectedShippingProviderId).toBe(provider!.id);
    expect(row.projectedShippingType).toBe(st.configKey);
    expect(row.projectedPaymentType).toBe(pt.configKey);
    expect(row.status).toBe("new");
    // بلا سعر فعّال → لا لقطة متوقعة (ولا خطأ)
    expect(await (await db()).select().from(shipmentChargeSnapshots).where(eq(shipmentChargeSnapshots.orderId, row.id))).toEqual([]);
    const items = await (await db()).select().from(orderItems).where(eq(orderItems.orderId, row.id));
    expect(items).toHaveLength(1); expect(items[0].variantId).toBe(product.variantIds[0]); expect(items[0].quantity).toBe(2);
  });

  it("🔒 بعد Go-Live المحاسبي القاعدة صارمة كما هي: بلا سعر شحن فعّال → الأوردر يُرفض", async () => {
    const d = await db();
    await d.update(businesses).set({ accountingGoLiveAt: new Date(Date.now() - 60_000) }).where(eq(businesses.id, businessId));
    try {
      const owner = session(ownerId);
      const [provider] = (await owner.accountingV2.shippingConfiguration({ businessId })).providers;
      const [st] = await owner.accountingV2.configurationList({ businessId, namespace: "shipping_type", activeOnly: true });
      const [pt] = await owner.accountingV2.configurationList({ businessId, namespace: "payment_type", activeOnly: true });
      const [prod] = await owner.products.list({ businessId });
      await expect(owner.orders.create({
        customerName: "عميل تجريبي", customerPhone: "01000000001", customerAddress: "شارع طويل رقم 10", governorate: "القاهرة",
        productId: prod.id, productName: prod.name, quantity: 1, totalAmount: "150", source: "facebook", businessId,
        projectedShippingProviderId: provider.id, projectedShippingType: st.configKey, projectedPaymentType: pt.configKey,
      })).rejects.toThrow(/No effective Shipping Rate/);
    } finally {
      await d.update(businesses).set({ accountingGoLiveAt: null }).where(eq(businesses.id, businessId));
    }
  });

  it("🔒 العزل: ما أنشأه النشاط A لا يراه النشاط B، وB لا يضيف قيمًا لـA", async () => {
    const b = session(ownerB);
    expect((await b.accountingV2.shippingConfiguration({ businessId: businessB })).providers).toEqual([]);
    expect(await b.accountingV2.configurationList({ businessId: businessB, namespace: "shipping_type", activeOnly: true })).toEqual([]);
    expect((await b.products.list({ businessId: businessB })).length).toBe(0);
    expect(await code(() => b.accountingV2.configurationQuickAdd({ businessId, namespace: "payment_type", displayName: "تسلل" }))).not.toBe("ok");
    expect(await code(() => b.accountingV2.shippingConfiguration({ businessId }))).not.toBe("ok");
    const rows = await (await db()).select().from(businessConfigurationValues).where(and(eq(businessConfigurationValues.businessId, businessId), eq(businessConfigurationValues.namespace, "payment_type")));
    expect(rows.map(r => r.displayName)).toEqual(["كاش عند الاستلام"]);
  });
});
