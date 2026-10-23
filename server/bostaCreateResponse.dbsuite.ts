import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomBytes } from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, insertOrderWithItems, createProductWithVariants } from "./db";
import { activityLogs, businessCarrierAccounts, orders, orderItems, products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { connectCarrierAccount } from "./carrierAccounts.service";
import { createBostaShipment } from "./bosta.service";

/**
 * P0 (الأوردر 14371) — إنشاء شحنة بوسطة على قاعدة بيانات حقيقية وبوسطة **mocked** بالشكلين:
 * v2 الموثّق `{ success, message, data: { _id, trackingNumber } }` وv0 المسطّح `{ _id, trackingNumber }`.
 * يغطي: 201 بالرقم في data/في الأعلى/بلا رقم، رد غير صالح، timeout، فشل حفظ بعد نجاح بوسطة، منع التكرار،
 * التزامن، عزل المتاجر (مفتاح كل نشاط لأوردراته بس)، ومسار المفتاح العام (legacy) بنفس الإصلاح.
 *
 * بتتسجّل من آخر `carrierAccounts.db.test.ts` (نفس سبب باقي ملفات .dbsuite: تتابع لا توازٍ).
 */
export function registerBostaCreateResponseDbSuite(CAN: boolean) {
  describe.runIf(CAN)("📦 Bosta — قراءة رد الإنشاء v2/v0 ومنع التكرار (DB حقيقية)", () => {
    let A: CoreTestFixture, B: CoreTestFixture, L: CoreTestFixture;
    const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const ids = { orderIds: [] as number[], productIds: [] as number[] };
    const vars: Record<string, { productId: number; variantId: number }> = {};
    const KEY_A = `cr-A-${tag}`, KEY_B = `cr-B-${tag}`, KEY_L = `cr-L-${tag}`;
    const TRIGGER = "mj_test_bosta_persist_fail";
    let savedEnv: Record<string, string | undefined> = {};
    let seq = 0;

    const db = async () => (await getDb())!;
    type Call = { url: string; auth: string; body: any };
    type Reply = () => Response | Promise<Response>;
    const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
    const v2 = (id: string, tn: string) => json(201, { success: true, message: "Done successfully.", data: { _id: id, trackingNumber: tn, message: "Delivery created successfully!" } });

    /** بوسطة mocked: مفتاح النشاط بس، والـ/deliveries بترد باللي الاختبار بيحدده. */
    const mock = (validKey: string, calls: Call[], reply: Reply) => (async (url: any, init: any) => {
      const auth = String(init?.headers?.Authorization ?? "");
      calls.push({ url: String(url), auth, body: init?.body ? JSON.parse(init.body) : null });
      if (auth !== validKey && auth !== `Bearer ${validKey}`) return new Response(JSON.stringify({ success: false, message: "User is not authorized!", data: null }), { status: 401 });
      if (String(url).includes("/pickup-locations")) return new Response(JSON.stringify({ data: [{ _id: "LOC1", locationName: "المخزن" }] }), { status: 200 });
      if (String(url).endsWith("/deliveries")) return reply();
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const deliveries = (calls: Call[]) => calls.filter(c => c.url.endsWith("/deliveries"));

    const mkOrder = async (fx: CoreTestFixture, prefix = "BV") => {
      const n = ++seq;
      const v = vars[fx.businessId];
      const id = await insertOrderWithItems({
        orderNumber: `${prefix}${n}-${tag}`.slice(0, 20), businessId: fx.businessId, customerName: "عميل اختبار", customerPhone: "01000000002",
        governorate: "القاهرة", customerAddress: "شارع طويل رقم 10", productName: "p", quantity: 1, totalAmount: "450.00",
        source: "facebook", status: "confirmed",
      } as any, [{ productId: v.productId, productName: "p", quantity: 1, variantId: v.variantId, unitPrice: 450 }]);
      ids.orderIds.push(id);
      return id;
    };
    const row = async (id: number) => (await (await db()).select().from(orders).where(eq(orders.id, id)))[0];
    const send = (id: number, f: typeof fetch) => createBostaShipment(id, { allowToOpenPackage: false }, f);

    beforeAll(async () => {
      savedEnv = {
        CARRIER_SECRETS_KEY: process.env.CARRIER_SECRETS_KEY, BOSTA_API_KEY: process.env.BOSTA_API_KEY, BOSTA_PICKUP_ADDRESS_ID: process.env.BOSTA_PICKUP_ADDRESS_ID,
        BOSTA_WEBHOOK_SECRET: process.env.BOSTA_WEBHOOK_SECRET, BOSTA_WEBHOOK_URL: process.env.BOSTA_WEBHOOK_URL, BOSTA_BASE_URL: process.env.BOSTA_BASE_URL,
      };
      process.env.CARRIER_SECRETS_KEY = randomBytes(32).toString("base64");
      for (const k of ["BOSTA_API_KEY", "BOSTA_PICKUP_ADDRESS_ID", "BOSTA_WEBHOOK_SECRET", "BOSTA_WEBHOOK_URL", "BOSTA_BASE_URL"]) delete process.env[k];
      A = await createCoreTestFixture("cr-a"); B = await createCoreTestFixture("cr-b"); L = await createCoreTestFixture("cr-l");
      for (const fx of [A, B, L]) {
        const p = await createProductWithVariants(fx.businessId, { name: `منتج ${fx.businessId} ${tag}` }, [{ name: "سادة", sku: `CR${fx.businessId}-${tag}`, currentStock: 50, price: "450" }]);
        vars[fx.businessId] = { productId: p.productId, variantId: p.variantIds[0] };
        ids.productIds.push(p.productId);
      }
      // A وB: حسابات مستقلة (مثل المتجر التالت). L: بلا أي صف — المفتاح العام بشرط تاريخ شحنات (مثل المتجر الأول).
      for (const [fx, key] of [[A, KEY_A], [B, KEY_B]] as const) {
        const r = await connectCarrierAccount({ tenantId: fx.tenantId, businessId: fx.businessId, apiKey: key, pickupLocationId: "LOC1", pickupLocationName: "المخزن", allowOpenPackageDefault: true, actorId: 1, fetchImpl: mock(key, [], json(404, {})) });
        expect(r.ok).toBe(true);
      }
      const hist = await mkOrder(L, "BH");
      await (await db()).update(orders).set({ bostaShipmentId: `HIST-${tag}`, bostaStatus: "sent" }).where(eq(orders.id, hist));
      // فشل حفظ حقيقي بعد نجاح بوسطة: trigger على أوردرات اختبار البادئة BVFAIL بس، ولحالة sent بس.
      await (await db()).execute(sql.raw(`DROP TRIGGER IF EXISTS ${TRIGGER}`));
      await (await db()).execute(sql.raw(
        `CREATE TRIGGER ${TRIGGER} BEFORE UPDATE ON orders FOR EACH ROW BEGIN ` +
        `IF NEW.orderNumber LIKE 'BVFAIL%' AND NEW.bostaStatus = 'sent' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'simulated persistence failure'; END IF; END`));
    });

    afterAll(async () => {
      const d = await getDb(); if (!d) return;
      await d.execute(sql.raw(`DROP TRIGGER IF EXISTS ${TRIGGER}`));
      for (const [k, v] of Object.entries(savedEnv)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
      const bids = [A.businessId, B.businessId, L.businessId];
      if (ids.orderIds.length) {
        await d.delete(activityLogs).where(and(eq(activityLogs.entityType, "order"), inArray(activityLogs.entityId, ids.orderIds)));
        await d.delete(orderItems).where(inArray(orderItems.orderId, ids.orderIds));
        await d.delete(orders).where(inArray(orders.id, ids.orderIds));
      }
      await d.delete(businessCarrierAccounts).where(inArray(businessCarrierAccounts.businessId, bids));
      if (ids.productIds.length) { await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds)); await d.delete(products).where(inArray(products.id, ids.productIds)); }
      await L?.cleanup(); await B?.cleanup(); await A?.cleanup();
    });

    // ── 1) الشكلين المثبتين ──
    it("✅ HTTP 201 بشكل v2 الموثّق (data._id) → sent برقم الشحنة ورقم التتبع", async () => {
      const oid = await mkOrder(A); const calls: Call[] = [];
      const r = await send(oid, mock(KEY_A, calls, v2(`V2${tag}a`, "5165840774")));
      expect(r).toMatchObject({ success: true, shipmentId: `V2${tag}a`, trackingNumber: "5165840774" });
      const o = await row(oid);
      expect([o.bostaStatus, o.bostaShipmentId, o.bostaTrackingNumber, o.bostaLastError]).toEqual(["sent", `V2${tag}a`, "5165840774", null]);
      expect(o.bostaSentAt).not.toBeNull();
      expect(deliveries(calls)).toHaveLength(1);
    });

    it("✅ HTTP 201 بالشكل المسطّح (v0) → sent كما كان", async () => {
      const oid = await mkOrder(A); const calls: Call[] = [];
      const r = await send(oid, mock(KEY_A, calls, json(201, { _id: `V0${tag}a`, trackingNumber: "7000001" })));
      expect(r).toMatchObject({ success: true, shipmentId: `V0${tag}a`, trackingNumber: "7000001" });
      expect((await row(oid)).bostaStatus).toBe("sent");
    });

    it("✅ HTTP 200 بشكل v2 → sent (مش مربوط بكود 201 بالذات)", async () => {
      const oid = await mkOrder(A);
      const r = await send(oid, mock(KEY_A, [], () => new Response(JSON.stringify({ success: true, data: { _id: `V2${tag}b`, trackingNumber: 5000002 } }), { status: 200 })));
      expect(r).toMatchObject({ success: true, shipmentId: `V2${tag}b`, trackingNumber: "5000002" });
    });

    // ── 2) منع التكرار بعد النجاح ──
    it("🔁 ضغطة تانية بعد النجاح → ترجع نفس الشحنة بصفر نداءات", async () => {
      const oid = await mkOrder(A);
      await send(oid, mock(KEY_A, [], v2(`V2${tag}c`, "5000003")));
      const again: Call[] = [];
      const r = await send(oid, mock(KEY_A, again, v2("SHOULD-NOT", "0")));
      expect(r).toMatchObject({ success: true, shipmentId: `V2${tag}c` });
      expect(deliveries(again)).toHaveLength(0);
    });

    // ── 3) ردود غامضة = uncertain + إعادة الإرسال مقفولة ──
    const uncertainCases: [string, Reply][] = [
      ["201 بلا رقم في أي مكان", json(201, { success: true, message: "Done successfully.", data: {} })],
      ["201 مع success:false ورقم", json(201, { success: false, message: "x", data: { _id: "LooksValid1" } })],
      ["201 برقمين مختلفين", json(201, { _id: "TopId12345", data: { _id: "DataId1234" } })],
      ["201 برقم بصيغة غريبة", json(201, { success: true, data: { _id: "has space" } })],
      ["201 بجسم مش JSON", () => new Response("<html>ok</html>", { status: 201 })],
      ["201 بجسم null", () => new Response("null", { status: 201 })],
    ];
    for (const [label, reply] of uncertainCases) {
      it(`🟡 ${label} → uncertain بلا رقم، والضغطة التانية مرفوضة بصفر نداءات`, async () => {
        const oid = await mkOrder(A); const calls: Call[] = [];
        const r = await send(oid, mock(KEY_A, calls, reply));
        expect(r.success).toBe(false);
        expect(r.error).toContain("غير مؤكدة");
        const o = await row(oid);
        expect([o.bostaStatus, o.bostaShipmentId]).toEqual(["uncertain", null]);
        const again: Call[] = [];
        const r2 = await send(oid, mock(KEY_A, again, v2("SHOULD-NOT", "0")));
        expect(r2.success).toBe(false);
        expect(deliveries(again)).toHaveLength(0);
        expect((await row(oid)).bostaShipmentId).toBeNull();
      });
    }

    it("🟡 رسالة 201 بلا رقم بتفضل بنفس النص (تصنيف «HTTP 2» في أمر القراءة بيعتمد عليه)", async () => {
      const oid = await mkOrder(A);
      await send(oid, mock(KEY_A, [], json(201, { success: true, data: {} })));
      expect((await row(oid)).bostaLastError).toContain("HTTP 201 بدون رقم شحنة واضح في الرد");
    });

    it("⏱️ timeout (بعد ما بوسطة ممكن تكون أنشأت) → uncertain، بلا إعادة تلقائية", async () => {
      const oid = await mkOrder(A); const calls: Call[] = [];
      const r = await send(oid, mock(KEY_A, calls, () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }));
      expect(r.success).toBe(false);
      expect(r.error).toContain("غير مؤكدة");
      expect(deliveries(calls)).toHaveLength(1);
      expect((await row(oid)).bostaStatus).toBe("uncertain");
      const again: Call[] = [];
      await send(oid, mock(KEY_A, again, v2("SHOULD-NOT", "0")));
      expect(deliveries(again)).toHaveLength(0);
    });

    it("💾 بوسطة أنشأت لكن حفظ الرقم فشل في القاعدة → uncertain، ومفيش نداء تاني", async () => {
      const oid = await mkOrder(A, "BVFAIL"); const calls: Call[] = [];
      const r = await send(oid, mock(KEY_A, calls, v2(`V2${tag}f`, "5000009")));
      expect(r.success).toBe(false);
      expect(r.error).toContain("غير مؤكدة");
      const o = await row(oid);
      expect([o.bostaStatus, o.bostaShipmentId]).toEqual(["uncertain", null]);
      const again: Call[] = [];
      await send(oid, mock(KEY_A, again, v2("SHOULD-NOT", "0")));
      expect(deliveries(calls).length + deliveries(again).length).toBe(1);
    });

    // ── 4) رفض صريح من بوسطة = failed وإعادة المحاولة آمنة ──
    it("❌ 400 بشكل خطأ v2 → failed برسالة بوسطة، والمحاولة التالية الناجحة بتتسجّل", async () => {
      const oid = await mkOrder(A); const calls: Call[] = [];
      const r = await send(oid, mock(KEY_A, calls, json(400, { success: false, message: "Product images are required when allowToOpenPackage is enabled.", errorCode: 1077, data: null })));
      expect(r.success).toBe(false);
      expect(r.error).toContain("HTTP 400");
      expect(r.error).toContain("Product images are required");
      expect((await row(oid)).bostaStatus).toBe("failed");
      const r2 = await send(oid, mock(KEY_A, calls, v2(`V2${tag}g`, "5000010")));
      expect(r2).toMatchObject({ success: true, shipmentId: `V2${tag}g` });
      expect(deliveries(calls)).toHaveLength(2);
    });

    // ── 5) التزامن ──
    it("⚡ 5 ضغطات متزامنة على نفس الأوردر → نداء واحد لبوسطة وشحنة واحدة", async () => {
      const oid = await mkOrder(A); const calls: Call[] = [];
      const slow = mock(KEY_A, calls, async () => { await new Promise(res => setTimeout(res, 150)); return v2(`V2${tag}h`, "5000011")(); });
      const results = await Promise.all(Array.from({ length: 5 }, () => send(oid, slow)));
      expect(deliveries(calls)).toHaveLength(1);
      expect(results.filter(x => x.success)).toHaveLength(1);
      for (const x of results.filter(x => !x.success)) expect(x.error).toContain("غير مؤكدة");
      expect((await row(oid)).bostaShipmentId).toBe(`V2${tag}h`);
    });

    // ── 6) عزل المتاجر ──
    it("🔒 كل أوردر بيتبعت بمفتاح نشاطه بس — مفتاح A مايتقبلش لأوردر B", async () => {
      const ob = await mkOrder(B); const callsB: Call[] = [];
      const r = await send(ob, mock(KEY_B, callsB, v2(`V2${tag}i`, "5000012")));
      expect(r.success).toBe(true);
      expect(deliveries(callsB).every(c => c.auth.endsWith(KEY_B))).toBe(true);
      const ob2 = await mkOrder(B); const onlyA: Call[] = [];
      const r2 = await send(ob2, mock(KEY_A, onlyA, v2("SHOULD-NOT", "0")));
      expect(r2.success).toBe(false);
      expect(deliveries(onlyA).every(c => c.auth.endsWith(KEY_B))).toBe(true);
      expect((await row(ob2)).bostaShipmentId).toBeNull();
    });

    // ── 7) المتجر بالمفتاح العام (legacy) — نفس الإصلاح بلا أي تغيير في الربط ──
    it("🏷️ legacy (BOSTA_API_KEY، بلا صف حساب) + رد v2 → sent، بنفس شكل الطلب القديم (pickupAddress) والمفتاح العام", async () => {
      process.env.BOSTA_API_KEY = KEY_L; process.env.BOSTA_PICKUP_ADDRESS_ID = "LEGACY-LOC";
      try {
        const oid = await mkOrder(L); const calls: Call[] = [];
        const r = await send(oid, mock(KEY_L, calls, v2(`V2${tag}l`, "5165840774")));
        expect(r).toMatchObject({ success: true, shipmentId: `V2${tag}l`, trackingNumber: "5165840774" });
        const [c] = deliveries(calls);
        expect(c.auth).toBe(KEY_L);
        expect(c.body.pickupAddress?._id).toBe("LEGACY-LOC");
        expect(c.body).not.toHaveProperty("businessLocationId");
        expect(c.body.businessReference).toBe((await row(oid)).orderNumber);
        expect((await (await db()).select().from(businessCarrierAccounts).where(eq(businessCarrierAccounts.businessId, L.businessId)))).toHaveLength(0);
      } finally { delete process.env.BOSTA_API_KEY; delete process.env.BOSTA_PICKUP_ADDRESS_ID; }
    });

    // ── 8) فتح الشحنة بلا صورة → منع قبل أي نداء (لسه شغال) ──
    it("🖼️ فتح الشحنة بلا صورة منتج ولا صورة افتراضية → رفض قبل أي نداء", async () => {
      const oid = await mkOrder(A); const calls: Call[] = [];
      const r = await createBostaShipment(oid, { allowToOpenPackage: true }, mock(KEY_A, calls, v2("SHOULD-NOT", "0")));
      expect(r.success).toBe(false);
      expect(deliveries(calls)).toHaveLength(0);
      expect((await row(oid)).bostaShipmentId).toBeNull();
    });

    // ── 9) اللوج: معرّفات وأسماء حقول بس ──
    it("🔒 سطر [Bosta] Response فيه الرقم والشكل — ومن غير اسم/هاتف/عنوان المستلم", async () => {
      const oid = await mkOrder(A);
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await send(oid, mock(KEY_A, [], json(201, { success: true, message: "ok", data: { _id: `V2${tag}k`, trackingNumber: "5000013", receiver: { phone: "01099998888", firstName: "سميرة" }, dropOffAddress: { firstLine: "عنوان سري 77" } } })));
        await send(await mkOrder(A), mock(KEY_A, [], json(201, { success: true, data: { receiver: { phone: "01099998888" } } })));
        const lines = spy.mock.calls.map(a => a.join(" ")).filter(s => s.includes("[Bosta] Response"));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain(`V2${tag}k`);
        expect(lines[0]).toContain("v2_data");
        expect(lines[1]).toContain("data=[+1]");
        for (const s of lines) expect(s).not.toMatch(/01099998888|سميرة|عنوان سري/);
      } finally { spy.mockRestore(); }
    });
  });
}
