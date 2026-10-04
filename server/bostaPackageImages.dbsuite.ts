import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { and, eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb, createEmployee, insertOrderWithItems, createProductWithVariants, setDefaultPackageImageUrl } from "./db";
import {
  activityLogs, businessCarrierAccounts, businessConfigurationValues, employees,
  orders, orderItems, products, productVariants,
} from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { connectCarrierAccount } from "./carrierAccounts.service";
import { createBostaShipment, publicBaseUrl } from "./bosta.service";
import { registerPackageImageRoutes } from "./packageImageUpload";
import {
  BOSTA_DELIVERY_IMAGE_TYPE, NO_PACKAGE_IMAGE_MESSAGE, PACKAGE_IMAGE_URL_PREFIX, PRODUCT_IMAGE_NAMESPACE, productImageKey,
} from "../shared/packageImages";

/**
 * صور شحنات بوسطة («السماح بفتح الشحنة») على قاعدة بيانات حقيقية — بوسطة **mocked** بالشكل الرسمي:
 * `deliveryImages: [{ type: "ALLOW_TO_OPEN_THE_PACKAGE", images: [1..10 روابط] }]` على مستوى الشحنة.
 *
 * بتتسجّل من آخر `carrierAccounts.db.test.ts` (نفس سبب `bostaWebhookInbox.dbsuite.ts`: الملف ده
 * بيعمل RENAME مؤقت لجدول حسابات الشحن، فلازم التتابع لا التوازي).
 */
export function registerBostaPackageImagesDbSuite(CAN: boolean) {
  describe.runIf(CAN)("🖼️ Bosta — صور الشحنة: صورة المنتج → صورة البراند → منع (DB حقيقية)", () => {
    let A: CoreTestFixture, B: CoreTestFixture;
    const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const ids = { orderIds: [] as number[], productIds: [] as number[], empIds: [] as number[] };
    let prodA1 = 0, varA1 = 0, prodA2 = 0, varA2 = 0, prodB = 0, varB = 0;
    let adminA = 0, adminB = 0, entryA = 0;
    const KEY_A = `img-A-${tag}`, KEY_B = `img-B-${tag}`;
    let savedEnv: Record<string, string | undefined> = {};
    let seq = 0;
    const BRAND_A = "https://cdn.example.com/brand-a/default.jpg", BRAND_B = "https://cdn.example.com/brand-b/default.png";
    const PROD_A1 = "https://cdn.example.com/products/a1.webp";
    const uploadedFiles: string[] = [];

    const db = async () => (await getDb())!;
    const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
    const owner = (tenantId: number) => appRouter.createCaller({
      user: { id: 1, role: "admin", name: "owner" }, employee: null, tenantId,
      req: { protocol: "https", headers: {}, cookies: {} }, res: { clearCookie: () => {}, cookie: () => {} },
    } as any);
    const code = async (fn: () => Promise<any>) => { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } };
    const cookieFor = (employeeId: number) => `employee_token=${jwt.sign({ employeeId }, process.env.JWT_SECRET as string)}`;

    /** mock بوسطة: يسجّل الـbody المرسل ويرد بشحنة. */
    const fakeFetch = (validKey: string, calls: any[]) => (async (url: any, init: any) => {
      const auth = String(init?.headers?.Authorization ?? "");
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      if (auth !== validKey && auth !== `Bearer ${validKey}`) return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
      if (String(url).includes("/pickup-locations")) return new Response(JSON.stringify({ data: [{ _id: "LOC1", locationName: "المخزن" }] }), { status: 200 });
      if (String(url).endsWith("/deliveries")) return new Response(JSON.stringify({ _id: `IMG-${tag}-${++seq}`, trackingNumber: `7${tag}${seq}` }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const mkOrder = async (fx: CoreTestFixture, items: { productId: number; variantId: number; quantity: number }[]) => {
      const n = ++seq;
      const id = await insertOrderWithItems({
        orderNumber: `IM${n}-${tag}`.slice(0, 20), businessId: fx.businessId, customerName: "عميل صور", customerPhone: "01000000001",
        governorate: "القاهرة", customerAddress: "شارع طويل رقم 10", productName: "p", quantity: items.reduce((s, i) => s + i.quantity, 0), totalAmount: "750.00",
        source: "facebook", status: "confirmed",
      } as any, items.map(i => ({ productId: i.productId, productName: "p", quantity: i.quantity, variantId: i.variantId, unitPrice: 750 })));
      ids.orderIds.push(id);
      return id;
    };
    const setProductImage = async (businessId: number, productId: number, url: string) => {
      await (await db()).insert(businessConfigurationValues).values({
        businessId, namespace: PRODUCT_IMAGE_NAMESPACE, configKey: productImageKey(productId), displayName: "صورة المنتج",
        valueJson: JSON.stringify(url), sortOrder: 0, isActive: true, createdBy: 1, updatedBy: 1,
      }).onDuplicateKeyUpdate({ set: { valueJson: JSON.stringify(url), isActive: true } });
    };
    const imagesLog = async (orderId: number) => (await db()).select().from(activityLogs)
      .where(and(eq(activityLogs.action, "bosta_shipment_images"), eq(activityLogs.entityType, "order"), eq(activityLogs.entityId, orderId)));

    beforeAll(async () => {
      savedEnv = {
        CARRIER_SECRETS_KEY: process.env.CARRIER_SECRETS_KEY, BOSTA_API_KEY: process.env.BOSTA_API_KEY,
        BOSTA_WEBHOOK_SECRET: process.env.BOSTA_WEBHOOK_SECRET, BOSTA_WEBHOOK_URL: process.env.BOSTA_WEBHOOK_URL,
      };
      process.env.CARRIER_SECRETS_KEY = randomBytes(32).toString("base64");
      delete process.env.BOSTA_API_KEY; delete process.env.BOSTA_WEBHOOK_SECRET; delete process.env.BOSTA_WEBHOOK_URL;
      A = await createCoreTestFixture("img-a"); B = await createCoreTestFixture("img-b");
      const mk = async (fx: CoreTestFixture, sku: string) => createProductWithVariants(fx.businessId, { name: `منتج ${sku} ${tag}` }, [{ name: "سادة", sku: `${sku}-${tag}`, currentStock: 50, price: "750" }]);
      const a1 = await mk(A, "IA1"), a2 = await mk(A, "IA2"), b = await mk(B, "IB");
      prodA1 = a1.productId; varA1 = a1.variantIds[0]; prodA2 = a2.productId; varA2 = a2.variantIds[0]; prodB = b.productId; varB = b.variantIds[0];
      ids.productIds.push(prodA1, prodA2, prodB);
      adminA = insId(await createEmployee({ name: "admin A", role: "super_admin", isActive: true, tenantId: A.tenantId, businessId: null, username: `imga_${tag}` } as any));
      adminB = insId(await createEmployee({ name: "admin B", role: "super_admin", isActive: true, tenantId: B.tenantId, businessId: null, username: `imgb_${tag}` } as any));
      entryA = insId(await createEmployee({ name: "entry A", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `imge_${tag}` } as any));
      ids.empIds.push(adminA, adminB, entryA);
      for (const [fx, key] of [[A, KEY_A], [B, KEY_B]] as const) {
        const r = await connectCarrierAccount({ tenantId: fx.tenantId, businessId: fx.businessId, apiKey: key, pickupLocationId: "LOC1", pickupLocationName: "المخزن", allowOpenPackageDefault: true, actorId: 1, fetchImpl: fakeFetch(key, []) });
        expect(r.ok).toBe(true);
      }
    });

    afterAll(async () => {
      const d = await getDb(); if (!d) return;
      for (const [k, v] of Object.entries(savedEnv)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
      const bids = [A.businessId, B.businessId];
      for (const f of uploadedFiles) fs.rmSync(path.resolve(process.cwd(), "uploads", "package-images", f), { force: true });
      if (ids.orderIds.length) await d.delete(activityLogs).where(and(eq(activityLogs.entityType, "order"), inArray(activityLogs.entityId, ids.orderIds)));
      await d.delete(businessCarrierAccounts).where(inArray(businessCarrierAccounts.businessId, bids));
      await d.delete(businessConfigurationValues).where(inArray(businessConfigurationValues.businessId, bids));
      if (ids.orderIds.length) { await d.delete(orderItems).where(inArray(orderItems.orderId, ids.orderIds)); await d.delete(orders).where(inArray(orders.id, ids.orderIds)); }
      if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
      if (ids.productIds.length) { await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds)); await d.delete(products).where(inArray(products.id, ids.productIds)); }
      await B?.cleanup(); await A?.cleanup();
    });

    // ── 1) بلا أي صورة → منع قبل أي نداء لبوسطة ──
    it("🚫 لا صورة منتج ولا صورة براند + فتح الشحنة → الإرسال يُرفض برسالة واضحة **قبل** نداء بوسطة", async () => {
      const oid = await mkOrder(A, [{ productId: prodA1, variantId: varA1, quantity: 1 }]);
      const calls: any[] = [];
      const r = await createBostaShipment(oid, { allowToOpenPackage: true }, fakeFetch(KEY_A, calls));
      expect(r.success).toBe(false);
      expect(r.error).toBe(NO_PACKAGE_IMAGE_MESSAGE);
      expect(calls).toHaveLength(0);
      const [row] = await (await db()).select().from(orders).where(eq(orders.id, oid));
      expect(row.bostaShipmentId).toBeNull();
      // المعاينة تقول الشيء نفسه قبل الإرسال
      const p = await owner(A.tenantId).orders.bostaShipmentPreview({ orderId: oid });
      expect(p.required).toBe(true); expect(p.error).toBe(NO_PACKAGE_IMAGE_MESSAGE); expect(p.images).toEqual([]);
    });

    it("✅ بلا صورة لكن بلا فتح الشحنة → يُرسل بلا deliveryImages وallowToOpenPackage=false", async () => {
      const oid = await mkOrder(A, [{ productId: prodA1, variantId: varA1, quantity: 1 }]);
      const calls: any[] = [];
      const r = await createBostaShipment(oid, { allowToOpenPackage: false }, fakeFetch(KEY_A, calls));
      expect(r.success).toBe(true);
      const body = calls.find(c => c.url.endsWith("/deliveries"))!.body;
      expect(body.allowToOpenPackage).toBe(false);
      expect(body).not.toHaveProperty("deliveryImages");
      expect(await imagesLog(oid)).toHaveLength(0);
    });

    // ── 2) إعداد الصورة الافتراضية من الراوتر + العزل ──
    it("🔒 setDefaultPackageImage: https عام فقط؛ http/غير صورة مرفوض؛ النشاط B لا يرى صورة A", async () => {
      const oa = owner(A.tenantId), ob = owner(B.tenantId);
      expect(await code(() => oa.carrierAccounts.setDefaultPackageImage({ businessId: A.businessId, imageUrl: "http://cdn.example.com/x.jpg" }))).toBe("BAD_REQUEST");
      expect(await code(() => oa.carrierAccounts.setDefaultPackageImage({ businessId: A.businessId, imageUrl: "https://cdn.example.com/page.html" }))).toBe("BAD_REQUEST");
      // B لا يستطيع ضبط صورة لنشاط A (خارج نطاقه)
      expect(await code(() => ob.carrierAccounts.setDefaultPackageImage({ businessId: A.businessId, imageUrl: BRAND_B }))).not.toBe("ok");
      const saved = await oa.carrierAccounts.setDefaultPackageImage({ businessId: A.businessId, imageUrl: BRAND_A });
      expect(saved.publicUrl).toBe(BRAND_A);
      const sa = await oa.carrierAccounts.status({ businessId: A.businessId });
      expect(sa.defaultPackageImage).toEqual({ ref: BRAND_A, publicUrl: BRAND_A });
      const sb = await ob.carrierAccounts.status({ businessId: B.businessId });
      expect(sb.defaultPackageImage).toBeNull();
    });

    it("🔒 مرجع ملف مرفوع لتينانت آخر يُرفض (FORBIDDEN) — لا صورة نشاط آخر أبدًا", async () => {
      const foreign = `${PACKAGE_IMAGE_URL_PREFIX}t${A.tenantId}-pkg-0f1e2d3c-1111-2222-3333-444455556666.png`;
      expect(await code(() => owner(B.tenantId).carrierAccounts.setDefaultPackageImage({ businessId: B.businessId, imageUrl: foreign }))).toBe("FORBIDDEN");
      // ولا بالرابط الكامل (https + امتداد صورة = كان يمرّ كرابط خارجي)
      expect(await code(() => owner(B.tenantId).carrierAccounts.setDefaultPackageImage({ businessId: B.businessId, imageUrl: `https://matjarak.net${foreign}` }))).toBe("FORBIDDEN");
      expect(await owner(B.tenantId).carrierAccounts.status({ businessId: B.businessId }).then(s => s.defaultPackageImage)).toBeNull();
    });

    // ── 3) الإرسال بالشكل الرسمي + تسجيل المصدر ──
    it("📦 منتج واحد × 3 قطع بلا صورة منتج → صورة البراند **مرة واحدة** بالشكل الرسمي + سجل brand_default", async () => {
      const oid = await mkOrder(A, [{ productId: prodA1, variantId: varA1, quantity: 3 }]);
      const calls: any[] = [];
      const r = await createBostaShipment(oid, { allowToOpenPackage: true }, fakeFetch(KEY_A, calls));
      expect(r.success).toBe(true);
      const body = calls.find(c => c.url.endsWith("/deliveries"))!.body;
      expect(body.allowToOpenPackage).toBe(true);
      expect(body.deliveryImages).toEqual([{ type: BOSTA_DELIVERY_IMAGE_TYPE, images: [BRAND_A] }]);
      const [log] = await imagesLog(oid);
      expect(log).toBeTruthy();
      expect(log.businessId).toBe(A.businessId);
      const meta = JSON.parse(log.metadata!);
      expect(meta.sources).toEqual([{ source: "brand_default", productId: null, url: BRAND_A }]);
      expect(meta.shipmentId).toBe(r.shipmentId);
    });

    it("📦 خليط: منتج بصورة عامة + منتج بلا صورة → صورة المنتج ثم صورة البراند مرة واحدة؛ المعاينة تطابق المرسَل", async () => {
      await setProductImage(A.businessId, prodA1, PROD_A1);
      const oid = await mkOrder(A, [{ productId: prodA1, variantId: varA1, quantity: 2 }, { productId: prodA2, variantId: varA2, quantity: 1 }]);
      const preview = await owner(A.tenantId).orders.bostaShipmentPreview({ orderId: oid });
      expect(preview.error).toBeNull();
      expect(preview.images).toEqual([{ url: PROD_A1, source: "product", productId: prodA1 }, { url: BRAND_A, source: "brand_default" }]);
      const calls: any[] = [];
      const r = await createBostaShipment(oid, { allowToOpenPackage: true }, fakeFetch(KEY_A, calls));
      expect(r.success).toBe(true);
      const body = calls.find(c => c.url.endsWith("/deliveries"))!.body;
      expect(body.deliveryImages).toEqual(preview.payload);
      expect(body.deliveryImages[0].images).toEqual([PROD_A1, BRAND_A]);
      const meta = JSON.parse((await imagesLog(oid))[0].metadata!);
      expect(meta.sources.map((s: any) => s.source)).toEqual(["product", "brand_default"]);
    });

    it("📦 كل المنتجات لها صور → بلا صورة البراند، ولا تكرار لنفس المنتج", async () => {
      const oid = await mkOrder(A, [{ productId: prodA1, variantId: varA1, quantity: 1 }, { productId: prodA1, variantId: varA1, quantity: 4 }]);
      const calls: any[] = [];
      const r = await createBostaShipment(oid, { allowToOpenPackage: true }, fakeFetch(KEY_A, calls));
      expect(r.success).toBe(true);
      expect(calls.find(c => c.url.endsWith("/deliveries"))!.body.deliveryImages).toEqual([{ type: BOSTA_DELIVERY_IMAGE_TYPE, images: [PROD_A1] }]);
    });

    it("🔒 صورة منتج النشاط A لا تُستخدم لأوردر النشاط B (نفس namespace، نشاط آخر) → B بلا صورة → منع", async () => {
      // نفس configKey لمنتج A موجود عند A فقط؛ B بلا صورة افتراضية بعد.
      const oid = await mkOrder(B, [{ productId: prodB, variantId: varB, quantity: 1 }]);
      const calls: any[] = [];
      const r = await createBostaShipment(oid, { allowToOpenPackage: true }, fakeFetch(KEY_B, calls));
      expect(r.success).toBe(false); expect(r.error).toBe(NO_PACKAGE_IMAGE_MESSAGE); expect(calls).toHaveLength(0);
      // بعد ضبط صورة B الافتراضية → تُرسل صورة B لا صورة A
      await owner(B.tenantId).carrierAccounts.setDefaultPackageImage({ businessId: B.businessId, imageUrl: BRAND_B });
      const r2 = await createBostaShipment(oid, { allowToOpenPackage: true }, fakeFetch(KEY_B, calls));
      expect(r2.success).toBe(true);
      const body = calls.find(c => c.url.endsWith("/deliveries"))!.body;
      expect(body.deliveryImages[0].images).toEqual([BRAND_B]);
      expect(JSON.stringify(body)).not.toContain(BRAND_A);
      expect(JSON.stringify(body)).not.toContain(PROD_A1);
    });

    it("🔁 تغيير الصورة الافتراضية يؤثر على الشحنات الجديدة فقط — سجل الشحنة القديمة لا يتغير", async () => {
      const oid1 = await mkOrder(A, [{ productId: prodA2, variantId: varA2, quantity: 1 }]);
      const calls: any[] = [];
      expect((await createBostaShipment(oid1, { allowToOpenPackage: true }, fakeFetch(KEY_A, calls))).success).toBe(true);
      const NEW_A = "https://cdn.example.com/brand-a/v2.jpg";
      await owner(A.tenantId).carrierAccounts.setDefaultPackageImage({ businessId: A.businessId, imageUrl: NEW_A });
      const oid2 = await mkOrder(A, [{ productId: prodA2, variantId: varA2, quantity: 1 }]);
      expect((await createBostaShipment(oid2, { allowToOpenPackage: true }, fakeFetch(KEY_A, calls))).success).toBe(true);
      const bodies = calls.filter(c => c.url.endsWith("/deliveries")).map(c => c.body.deliveryImages[0].images[0]);
      expect(bodies).toEqual([BRAND_A, NEW_A]);
      expect(JSON.parse((await imagesLog(oid1))[0].metadata!).sources[0].url).toBe(BRAND_A);
      expect(JSON.parse((await imagesLog(oid2))[0].metadata!).sources[0].url).toBe(NEW_A);
      // إزالة الصورة → الإرسال الجديد يُمنع (لمنتج بلا صورة)
      await owner(A.tenantId).carrierAccounts.setDefaultPackageImage({ businessId: A.businessId, imageUrl: null });
      const oid3 = await mkOrder(A, [{ productId: prodA2, variantId: varA2, quantity: 1 }]);
      const r3 = await createBostaShipment(oid3, { allowToOpenPackage: true }, fakeFetch(KEY_A, []));
      expect(r3.success).toBe(false); expect(r3.error).toBe(NO_PACKAGE_IMAGE_MESSAGE);
      await setDefaultPackageImageUrl(A.businessId, BRAND_A, 1);
    });

    it("⚙️ بلا تمرير allowToOpenPackage → إعداد الحساب (allowOpenPackageDefault) لا true ثابتة", async () => {
      // حساب B: نعطّل الفتح افتراضيًا ونرسل بلا تمرير → لا صور مطلوبة
      const d = await db();
      await d.update(businessCarrierAccounts).set({ allowOpenPackageDefault: false }).where(eq(businessCarrierAccounts.businessId, B.businessId));
      const oid = await mkOrder(B, [{ productId: prodB, variantId: varB, quantity: 1 }]);
      const preview = await owner(B.tenantId).orders.bostaShipmentPreview({ orderId: oid });
      expect(preview.allowToOpenPackage).toBe(false); expect(preview.required).toBe(false);
      const calls: any[] = [];
      const r = await createBostaShipment(oid, undefined, fakeFetch(KEY_B, calls));
      expect(r.success).toBe(true);
      const body = calls.find(c => c.url.endsWith("/deliveries"))!.body;
      expect(body.allowToOpenPackage).toBe(false); expect(body).not.toHaveProperty("deliveryImages");
      await d.update(businessCarrierAccounts).set({ allowOpenPackageDefault: true }).where(eq(businessCarrierAccounts.businessId, B.businessId));
    });

    // ── 4) الرفع والعرض العلني ──
    it("📤 الرفع للأدمن فقط (PNG صالح) ثم يُقدَّم علنيًا بلا جلسة؛ اسم خارج النمط → 404؛ ثم يُقبل كصورة افتراضية لنفس التينانت ويُرسل برابط كامل", async () => {
      const app = express(); app.use(cookieParser()); registerPackageImageRoutes(app);
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
      // موظف إدخال بيانات → 403؛ بلا جلسة → 403
      expect((await request(app).post("/api/carrier/package-image/upload").set("Cookie", cookieFor(entryA)).attach("file", png, { filename: "x.png", contentType: "image/png" })).status).toBe(403);
      expect((await request(app).post("/api/carrier/package-image/upload").attach("file", png, { filename: "x.png", contentType: "image/png" })).status).toBe(403);
      // محتوى لا يطابق النوع → 415
      const bad = await request(app).post("/api/carrier/package-image/upload").set("Cookie", cookieFor(adminA)).attach("file", Buffer.alloc(32, 7), { filename: "x.png", contentType: "image/png" });
      expect(bad.status).toBe(415);
      const up = await request(app).post("/api/carrier/package-image/upload").set("Cookie", cookieFor(adminA)).attach("file", png, { filename: "x.png", contentType: "image/png" });
      expect(up.status).toBe(201);
      const ref: string = up.body.url;
      expect(ref.startsWith(PACKAGE_IMAGE_URL_PREFIX)).toBe(true);
      expect(ref).toMatch(new RegExp(`/t${A.tenantId}-pkg-[a-f0-9-]+\\.png$`));
      uploadedFiles.push(ref.slice(PACKAGE_IMAGE_URL_PREFIX.length));
      // عرض علني بلا أي كوكي
      const got = await request(app).get(ref);
      expect(got.status).toBe(200); expect(got.headers["content-type"]).toContain("image/png"); expect(got.headers["cache-control"]).toContain("public");
      expect((await request(app).get(`${PACKAGE_IMAGE_URL_PREFIX}..%2F..%2Fpackage.json`)).status).toBe(404);
      expect((await request(app).get(`${PACKAGE_IMAGE_URL_PREFIX}t${A.tenantId}-pkg-ffffffff-0000-0000-0000-000000000000.png`)).status).toBe(404);
      // B لا يستطيع اعتماد ملف A؛ A يعتمده ويُرسل برابط عام كامل من أصل الموقع
      expect(await code(() => owner(B.tenantId).carrierAccounts.setDefaultPackageImage({ businessId: B.businessId, imageUrl: ref }))).toBe("FORBIDDEN");
      const saved = await owner(A.tenantId).carrierAccounts.setDefaultPackageImage({ businessId: A.businessId, imageUrl: ref });
      expect(saved.publicUrl).toBe(`${publicBaseUrl()}${ref}`);
      expect(saved.publicUrl!.startsWith("https://")).toBe(true);
      const oid = await mkOrder(A, [{ productId: prodA2, variantId: varA2, quantity: 1 }]);
      const calls: any[] = [];
      expect((await createBostaShipment(oid, { allowToOpenPackage: true }, fakeFetch(KEY_A, calls))).success).toBe(true);
      expect(calls.find(c => c.url.endsWith("/deliveries"))!.body.deliveryImages).toEqual([{ type: BOSTA_DELIVERY_IMAGE_TYPE, images: [`${publicBaseUrl()}${ref}`] }]);
      await setDefaultPackageImageUrl(A.businessId, BRAND_A, 1);
    });
  });
}
