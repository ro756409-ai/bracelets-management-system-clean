import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { randomBytes } from "crypto";
import { and, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb, insertOrderWithItems, createProductWithVariants } from "./db";
import {
  businessCarrierAccounts, carrierWebhookEvents, carrierWebhookInbox, inventoryMovements,
  orders, orderItems, products, productVariants,
} from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { connectCarrierAccount, PROVIDER_BOSTA } from "./carrierAccounts.service";
import { createBostaShipment } from "./bosta.service";
import { handleBostaWebhook, registerBostaWebhookRoutes } from "./bostaWebhook";
import { receiveInboxEvent } from "./carrierWebhookInbox.service";
import { normalizeBostaEvent } from "./bostaEvents";
import { deriveWebhookSecret } from "./crypto/secretBox";

/**
 * مسار استقبال ومعالجة حالات Bosta على قاعدة بيانات حقيقية — بالـpayload الرسمي
 * (`state` رقم، `timeStamp` رقم ms، `type`).
 *
 * الملف ده **مش** `*.test.ts` عن قصد: `carrierAccounts.db.test.ts` بيعمل RENAME مؤقت لجدول
 * `business_carrier_accounts` (اختبار ما قبل 0037)، وتشغيل الـsuite دي في ملف مستقل بالتوازي
 * كان هيخلّي أسرار الـwebhook «مجهولة» لحظيًا. بتتسجّل من آخر الملف ده فتشتغل بالتتابع معاه.
 */
export function registerBostaWebhookInboxDbSuite(CAN: boolean) {
  describe.runIf(CAN)("📦 Bosta webhook — استقبال الحالات (payload رسمي، DB حقيقية)", () => {
    let A: CoreTestFixture, B: CoreTestFixture, C: CoreTestFixture;
    const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const T0 = 1790000000000; // timeStamp أساس (ms)
    const orderIds: number[] = [];
    const productIds: number[] = [];
    const variantIds: number[] = [];
    let prodA = 0, varA = 0, prodB = 0, varB = 0, prodC = 0, varC = 0;
    let secretA = "", secretB = "";
    const KEY_A = `whk-A-${tag}`, KEY_B = `whk-B-${tag}`;
    const ENV_SECRET = `env-legacy-${tag}`;
    let savedEnv: Record<string, string | undefined> = {};
    let seq = 0;

    const fakeFetch = (validKey: string, calls: any[]) => (async (url: any, init: any) => {
      const auth = String(init?.headers?.Authorization ?? "");
      calls.push({ url: String(url), auth, body: init?.body ? JSON.parse(init.body) : null });
      if (auth !== validKey && auth !== `Bearer ${validKey}`) return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
      if (String(url).includes("/pickup-locations")) return new Response(JSON.stringify({ data: [{ _id: "LOC1", locationName: "المخزن" }] }), { status: 200 });
      if (String(url).endsWith("/deliveries")) return new Response(JSON.stringify({ _id: `WSHIP-${tag}-${++seq}`, trackingNumber: `9${tag}${seq}` }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const db = async () => (await getDb())!;
    const session = (tenantId: number, role: "super_admin" | "manager") => appRouter.createCaller({
      user: { id: -1, role: "admin", name: "owner" }, employee: { id: 1, role, businessId: null, tenantId, isActive: true }, tenantId,
      req: { protocol: "https", headers: {}, cookies: {} }, res: { clearCookie: () => {}, cookie: () => {} },
    } as any);
    const code = async (fn: () => Promise<any>) => { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } };

    /** أوردر مؤكد عليه شحنة بوسطة بمعرّف فريد. */
    const mkShipped = async (fx: CoreTestFixture, productId: number, variantId: number, shipmentId?: string, status = "confirmed") => {
      const n = ++seq;
      const id = await insertOrderWithItems({
        orderNumber: `W${n}-${tag}`.slice(0, 20), businessId: fx.businessId, customerName: "عميل webhook", customerPhone: "01000000001",
        governorate: "القاهرة", customerAddress: "شارع طويل رقم 10", productName: "p", quantity: 1, totalAmount: "750.00",
        source: "facebook", status,
      } as any, [{ productId, productName: "p", quantity: 1, variantId, unitPrice: 750 }]);
      orderIds.push(id);
      const sid = shipmentId ?? `SHP${n}-${tag}`;
      await (await db()).update(orders).set({ bostaShipmentId: sid, bostaStatus: "sent" }).where(eq(orders.id, id));
      return { id, sid };
    };
    const orderRow = async (id: number) => (await (await db()).select().from(orders).where(eq(orders.id, id)))[0];
    const inboxRows = async (shipmentId: string) => (await db()).select().from(carrierWebhookInbox).where(eq(carrierWebhookInbox.shipmentId, shipmentId)).orderBy(carrierWebhookInbox.id);

    /** لقطة المخزون: عدد حركات المخزون + أرصدة الـvariants — لازم ماتتغيّرش من أي webhook. */
    const stockSnapshot = async () => {
      const d = await db();
      const [m] = await d.select({ n: sql<number>`COUNT(*)` }).from(inventoryMovements).where(inArray(inventoryMovements.businessId, [A.businessId, B.businessId, C.businessId]));
      const stocks = await d.select({ id: productVariants.id, s: productVariants.currentStock }).from(productVariants).where(inArray(productVariants.id, variantIds)).orderBy(productVariants.id);
      return { movements: Number(m.n), stocks };
    };

    /** نداء المعالج مباشرة — وبيتأكد إن المخزون مااتلمسش في **كل** نداء. */
    const call = async (secret: string | undefined, body: any) => {
      const before = await stockSnapshot();
      let status = 0, json: any = null;
      const res: any = { status: (s: number) => { status = s; return res; }, json: (j: any) => { json = j; return res; } };
      await handleBostaWebhook({ headers: secret === undefined ? {} : { "x-bosta-secret": secret }, body } as any, res);
      expect(await stockSnapshot()).toEqual(before);
      return { status, json };
    };
    /** payload بشكل التوثيق الرسمي. */
    const official = (sid: string, state: number, ts: number, over: Record<string, unknown> = {}) => ({
      _id: sid, trackingNumber: 48089608, state, type: "SEND", cod: 750, timeStamp: ts,
      isConfirmedDelivery: false, businessReference: "ref", numberOfAttempts: 1, ...over,
    });

    beforeAll(async () => {
      savedEnv = {
        CARRIER_SECRETS_KEY: process.env.CARRIER_SECRETS_KEY, BOSTA_API_KEY: process.env.BOSTA_API_KEY,
        BOSTA_WEBHOOK_SECRET: process.env.BOSTA_WEBHOOK_SECRET, BOSTA_WEBHOOK_URL: process.env.BOSTA_WEBHOOK_URL,
      };
      process.env.CARRIER_SECRETS_KEY = randomBytes(32).toString("base64");
      delete process.env.BOSTA_API_KEY; delete process.env.BOSTA_WEBHOOK_SECRET; delete process.env.BOSTA_WEBHOOK_URL;
      A = await createCoreTestFixture("bwh-a"); B = await createCoreTestFixture("bwh-b"); C = await createCoreTestFixture("bwh-c");
      const mk = async (fx: CoreTestFixture, sku: string) => createProductWithVariants(fx.businessId, { name: `منتج ${sku} ${tag}` }, [{ name: "سادة", sku: `${sku}-${tag}`, currentStock: 50, price: "750" }]);
      const pa = await mk(A, "WA"), pb = await mk(B, "WB"), pc = await mk(C, "WC");
      prodA = pa.productId; varA = pa.variantIds[0]; prodB = pb.productId; varB = pb.variantIds[0]; prodC = pc.productId; varC = pc.variantIds[0];
      productIds.push(prodA, prodB, prodC); variantIds.push(varA, varB, varC);
      for (const [fx, key] of [[A, KEY_A], [B, KEY_B]] as const) {
        const r = await connectCarrierAccount({ tenantId: fx.tenantId, businessId: fx.businessId, apiKey: key, pickupLocationId: "LOC1", pickupLocationName: "المخزن", allowOpenPackageDefault: true, actorId: 1, fetchImpl: fakeFetch(key, []) });
        expect(r.ok).toBe(true);
      }
      const d = await db();
      const rows = await d.select().from(businessCarrierAccounts).where(inArray(businessCarrierAccounts.businessId, [A.businessId, B.businessId]));
      secretA = deriveWebhookSecret(PROVIDER_BOSTA, A.businessId, rows.find(r => r.businessId === A.businessId)!.webhookSalt);
      secretB = deriveWebhookSecret(PROVIDER_BOSTA, B.businessId, rows.find(r => r.businessId === B.businessId)!.webhookSalt);
    });

    afterAll(async () => {
      const d = await getDb(); if (!d) return;
      for (const [k, v] of Object.entries(savedEnv)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
      const bids = [A.businessId, B.businessId, C.businessId];
      await d.delete(carrierWebhookInbox).where(or(inArray(carrierWebhookInbox.businessId, bids), and(isNull(carrierWebhookInbox.businessId), like(carrierWebhookInbox.shipmentId, `%${tag}%`))));
      await d.delete(carrierWebhookEvents).where(inArray(carrierWebhookEvents.businessId, bids));
      await d.delete(businessCarrierAccounts).where(inArray(businessCarrierAccounts.businessId, bids));
      if (orderIds.length) { await d.delete(orderItems).where(inArray(orderItems.orderId, orderIds)); await d.delete(orders).where(inArray(orders.id, orderIds)); }
      if (productIds.length) { await d.delete(productVariants).where(inArray(productVariants.productId, productIds)); await d.delete(products).where(inArray(products.id, productIds)); }
      await C?.cleanup(); await B?.cleanup(); await A?.cleanup();
    });

    it("🔑 رحلة شحنة إرسال كاملة: 10 → 21 → 24 → 30 → 41 → 45، وكل حدث خام متسجّل بحالته", async () => {
      const { id, sid } = await mkShipped(A, prodA, varA);
      const steps: Array<[number, string, string]> = [
        [10, "confirmed", "طلب استلام (جديد)"], [21, "shipped", "تم الاستلام من النشاط"], [24, "shipped", "في مخزن بوسطة"],
        [30, "shipped", "بين فروع بوسطة"], [41, "shipped", "خرجت للتسليم"], [45, "delivered", "تم التسليم"],
      ];
      let ts = T0;
      for (const [state, expectStatus, label] of steps) {
        const r = await call(secretA, official(sid, state, ts += 1000, { isConfirmedDelivery: state === 45 }));
        expect(r.status).toBe(200); expect(r.json).toMatchObject({ ok: true, status: "processed" });
        const o = await orderRow(id);
        expect(o.status).toBe(expectStatus); expect(o.bostaStatus).toBe(label);
      }
      const o = await orderRow(id);
      expect(o.bostaTrackingNumber).toBe("48089608"); // الرقم الوارد بيتخزّن نصًا
      expect(o.needsReview).toBe(false); expect(o.bostaLastError).toBeNull();
      const rows = await inboxRows(sid);
      expect(rows.map(r => r.stateCode)).toEqual([10, 21, 24, 30, 41, 45]);
      for (const r of rows) {
        expect(r).toMatchObject({ tenantId: A.tenantId, businessId: A.businessId, provider: "bosta", shipmentId: sid, trackingNumber: "48089608", eventType: "SEND", processingStatus: "processed", orderId: id, attempts: 1, duplicateCount: 0, failureReason: null });
        expect(r.eventKey).toMatch(/^[0-9a-f]{64}$/); expect(r.receivedAt).toBeTruthy(); expect(r.processedAt).toBeTruthy();
        expect(JSON.parse(r.payloadJson)).toMatchObject({ _id: sid, state: r.stateCode, timeStamp: r.eventTimestamp }); // الخام كما وصل
      }
      expect(rows.at(-1)!.eventTimestamp).toBe(T0 + 6000);
    });

    it("🔑 45 = delivered لنوع الإرسال فقط؛ 45 لـRTO/استبدال/استرجاع لا يسلّم الأوردر", async () => {
      for (const type of ["RTO", "EXCHANGE", "CUSTOMER_RETURN_PICKUP", "SIGN_AND_RETURN", "WHATEVER"]) {
        const { id, sid } = await mkShipped(A, prodA, varA, undefined, "shipped");
        const r = await call(secretA, official(sid, 45, T0 + 100, { type }));
        expect(r.json?.status).toBe("processed");
        expect((await orderRow(id)).status).toBe("shipped");
      }
      const { id, sid } = await mkShipped(A, prodA, varA, undefined, "shipped");
      await call(secretA, official(sid, 45, T0 + 100, { type: "FXF_SEND" }));
      expect((await orderRow(id)).status).toBe("delivered");
      // تسليم بلا إثبات: delivered والنص بيوضّح
      const u = await mkShipped(A, prodA, varA, undefined, "shipped");
      await call(secretA, official(u.sid, 45, T0 + 100, { isConfirmedDelivery: false }));
      expect(await orderRow(u.id)).toMatchObject({ status: "delivered", bostaStatus: "تم التسليم بدون تأكيد استلام" });
    });

    it("🔑 46 و60 → returned (حتى بعد التسليم)، وبلا أي حركة مخزون", async () => {
      for (const state of [46, 60]) {
        const { id, sid } = await mkShipped(A, prodA, varA, undefined, "shipped");
        const r = await call(secretA, official(sid, state, T0 + 100, { type: state === 46 ? "RTO" : "SEND" }));
        expect(r.json?.status).toBe("processed");
        expect((await orderRow(id)).status).toBe("returned");
      }
      const { id, sid } = await mkShipped(A, prodA, varA);
      await call(secretA, official(sid, 45, T0 + 100));
      await call(secretA, official(sid, 46, T0 + 200));
      expect(await orderRow(id)).toMatchObject({ status: "returned", bostaStatus: "تم الإرجاع للنشاط" });
      // 45 متأخر بعد الإرجاع مايرجّعش الأوردر لـdelivered
      const late = await call(secretA, official(sid, 45, T0 + 300));
      expect(late.json?.status).toBe("ignored");
      expect(await orderRow(id)).toMatchObject({ status: "returned", bostaStatus: "تم الإرجاع للنشاط" });
    });

    it("🔑 47 Exception: الحالة تفضل كما هي، والسبب والكود يتسجّلوا", async () => {
      const { id, sid } = await mkShipped(A, prodA, varA, undefined, "shipped");
      const r = await call(secretA, official(sid, 47, T0 + 100, { exceptionReason: "العميل لا يرد", exceptionCode: 4, numberOfAttempts: 2 }));
      expect(r.json?.status).toBe("processed");
      const o = await orderRow(id);
      expect(o.status).toBe("shipped"); expect(o.bostaStatus).toBe("استثناء — محاولة غير ناجحة");
      expect(o.bostaLastError).toContain("العميل لا يرد"); expect(o.bostaLastError).toContain("كود 4");
      expect(o.needsReview).toBe(false);
      // بعدها تسليم ناجح عادي
      await call(secretA, official(sid, 45, T0 + 200));
      expect((await orderRow(id)).status).toBe("delivered");
    });

    it("🔑 48/49/100/101: مراجعة بشرية بلا تغيير حالة ولا أثر مبيعات، والسبب مايتكررش", async () => {
      const cases: Array<[number, string]> = [[48, "منتهية (Terminated)"], [49, "ملغاة في بوسطة"], [100, "مفقودة"], [101, "تالفة"]];
      for (const [state, label] of cases) {
        const { id, sid } = await mkShipped(A, prodA, varA, undefined, "shipped");
        await (await db()).update(orders).set({ reviewReason: "سبب سابق" }).where(eq(orders.id, id));
        expect((await call(secretA, official(sid, state, T0 + 100))).json?.status).toBe("processed");
        expect((await call(secretA, official(sid, state, T0 + 200))).json?.status).toBe("processed"); // نفس الحالة بوقت أحدث
        const o = await orderRow(id);
        expect(o.status).toBe("shipped"); expect(o.bostaStatus).toBe(label); expect(o.needsReview).toBe(true);
        expect(o.reviewReason).toBe(`سبب سابق | بوسطة: ${label}`);
      }
    });

    it("🔑 102–105 والكود غير المعروف: يتحفظ للمراجعة (ignored) والأوردر مايتلمسش إطلاقًا", async () => {
      for (const state of [102, 103, 104, 105, 31, 999]) {
        const { id, sid } = await mkShipped(A, prodA, varA, undefined, "shipped");
        const before = await orderRow(id);
        const r = await call(secretA, official(sid, state, T0 + 100));
        expect(r.status).toBe(200); expect(r.json?.status).toBe("ignored");
        expect(await orderRow(id)).toEqual(before);
        const [row] = await inboxRows(sid);
        expect(row).toMatchObject({ processingStatus: "ignored", stateCode: state, orderId: id, businessId: A.businessId });
        expect(row.failureReason).toContain(String(state));
      }
    });

    it("🔒 السر المفقود/المجهول = 401 ولا يتحفظ أي شيء؛ payload غير صالح بسر صحيح = 400", async () => {
      const { id, sid } = await mkShipped(A, prodA, varA);
      const before = await orderRow(id);
      for (const secret of [undefined, "", "not-a-secret", secretA.slice(0, -1), `${secretA}x`]) {
        const r = await call(secret, official(sid, 45, T0 + 100));
        expect(r.status).toBe(401); expect(r.json).toEqual({ error: "Unauthorized" });
      }
      expect(await orderRow(id)).toEqual(before);
      expect(await inboxRows(sid)).toEqual([]);
      for (const bad of [{ _id: sid }, { _id: sid, state: "Delivered" }, { state: 45 }, { _id: sid, state: { value: "Delivered" } }]) {
        const r = await call(secretA, bad);
        expect(r.status).toBe(400);
      }
      expect(await orderRow(id)).toEqual(before);
      expect(await inboxRows(sid)).toEqual([]);
    });

    it("🔒 POST فقط: أي method تاني 405، وPOST بلا سر 401 (Express حقيقي)", async () => {
      const app = express(); app.use(express.json()); registerBostaWebhookRoutes(app);
      for (const m of ["get", "put", "patch", "delete"] as const) {
        const r = await (request(app) as any)[m]("/api/webhooks/bosta");
        expect(r.status).toBe(405); expect(r.headers.allow).toBe("POST");
      }
      expect((await request(app).post("/api/webhooks/bosta").send({ _id: "x", state: 45 })).status).toBe(401);
      const { id, sid } = await mkShipped(A, prodA, varA);
      const ok = await request(app).post("/api/webhooks/bosta").set("x-bosta-secret", secretA).send(official(sid, 45, T0 + 100));
      expect(ok.status).toBe(200); expect(ok.body).toMatchObject({ ok: true, status: "processed" });
      expect(JSON.stringify(ok.body)).not.toContain(secretA);
      expect((await orderRow(id)).status).toBe("delivered");
    });

    it("🔒 عزل A/B: النشاط من السر — نفس معرّف الشحنة في نشاطين يحدّث صاحب السر فقط", async () => {
      const same = `SAME-${tag}`;
      const a = await mkShipped(A, prodA, varA, same); const b = await mkShipped(B, prodB, varB, same);
      const bBefore = await orderRow(b.id);
      // محاولة حقن businessId/tenantId من العميل: بتتجاهل
      const r = await call(secretA, { ...official(same, 45, T0 + 100), businessId: B.businessId, tenantId: B.tenantId });
      expect(r.json?.status).toBe("processed");
      expect((await orderRow(a.id)).status).toBe("delivered");
      expect(await orderRow(b.id)).toEqual(bBefore);
      const rows = await inboxRows(same);
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ businessId: A.businessId, tenantId: A.tenantId, orderId: a.id });
      // نفس الحدث بسر B = حدث نشاط B (مش مكرر) ويحدّث أوردر B فقط
      const r2 = await call(secretB, official(same, 45, T0 + 100));
      expect(r2.json).toMatchObject({ ok: true, status: "processed" }); expect(r2.json.duplicate).toBeUndefined();
      expect((await orderRow(b.id)).status).toBe("delivered");
      expect((await inboxRows(same)).map(x => x.businessId).sort()).toEqual([A.businessId, B.businessId].sort());
    });

    it("🔒 سر A مع شحنة موجودة في B فقط → unmatched داخل A، وأوردر B مايتلمسش", async () => {
      const b = await mkShipped(B, prodB, varB);
      const bBefore = await orderRow(b.id);
      const r = await call(secretA, official(b.sid, 45, T0 + 100));
      expect(r.status).toBe(200); expect(r.json?.status).toBe("unmatched");
      expect(await orderRow(b.id)).toEqual(bBefore);
      const [row] = await inboxRows(b.sid);
      expect(row).toMatchObject({ businessId: A.businessId, processingStatus: "unmatched", orderId: null });
      // قائمة أحداث B مافيهاش الحدث ده، وقائمة A فيها — وبلا الـpayload الخام
      const listB = await session(B.tenantId, "manager").carrierAccounts.webhookEvents({ businessId: B.businessId });
      expect(listB.some(e => e.shipmentId === b.sid)).toBe(false);
      const listA = await session(A.tenantId, "manager").carrierAccounts.webhookEvents({ businessId: A.businessId, statuses: ["unmatched"] });
      const mine = listA.find(e => e.shipmentId === b.sid)!;
      expect(mine.processingStatus).toBe("unmatched"); expect(mine).not.toHaveProperty("payloadJson");
      expect(mine.stateLabel).toBe("تم التسليم");
      // ومدير tenant A مايقدرش يقرا أحداث نشاط B
      expect(await code(() => session(A.tenantId, "manager").carrierAccounts.webhookEvents({ businessId: B.businessId }))).not.toBe("ok");
    });

    it("🔑 الحدث المكرر: نجاح idempotent — صف واحد، بلا تحديث ثانٍ", async () => {
      const { id, sid } = await mkShipped(A, prodA, varA);
      const payload = official(sid, 45, T0 + 100);
      expect((await call(secretA, payload)).json).toMatchObject({ ok: true, status: "processed" });
      // علامة على الأوردر: لو التكرار طبّق تحديثًا تانيًا هتتمسح
      await (await db()).update(orders).set({ bostaStatus: "علامة-اختبار" }).where(eq(orders.id, id));
      for (let i = 0; i < 3; i++) {
        const r = await call(secretA, { ...payload, cod: 1, numberOfAttempts: 9 }); // نفس (shipment+state+timeStamp)
        expect(r.status).toBe(200); expect(r.json).toEqual({ ok: true, duplicate: true, status: "processed" });
      }
      expect(await orderRow(id)).toMatchObject({ status: "delivered", bostaStatus: "علامة-اختبار" });
      const rows = await inboxRows(sid);
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ duplicateCount: 3, attempts: 1, processingStatus: "processed" });
      // timeStamp مختلف = حدث جديد فعلًا
      expect((await call(secretA, official(sid, 45, T0 + 500))).json?.duplicate).toBeUndefined();
      expect(await inboxRows(sid)).toHaveLength(2);
    });

    it("🔑 حدث اتحفظ ولم تكتمل معالجته (received) بيتكمّل على نفس الصف عند إعادة الإرسال", async () => {
      const { id, sid } = await mkShipped(A, prodA, varA);
      const payload = official(sid, 45, T0 + 100);
      const n = normalizeBostaEvent(payload); if (!n.ok) throw new Error(n.error);
      const stored = await receiveInboxEvent({ tenantId: A.tenantId, businessId: A.businessId, provider: PROVIDER_BOSTA, shipmentId: sid, trackingNumber: n.event.trackingNumber, eventKey: n.event.eventKey, stateCode: 45, eventType: "SEND", eventTimestamp: n.event.timeStamp, payload });
      expect(stored.mode).toBe("stored");
      expect((await orderRow(id)).status).toBe("confirmed"); // اتحفظ بس، لسه مااتعالجش
      const r = await call(secretA, payload);
      expect(r.json).toMatchObject({ ok: true, status: "processed" });
      expect((await orderRow(id)).status).toBe("delivered");
      const rows = await inboxRows(sid);
      expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ processingStatus: "processed", attempts: 2, duplicateCount: 1, orderId: id });
    });

    it("🔑 الأحداث خارج الترتيب: حدث أقدم مايرجّعش الحالة ولا نص الحالة", async () => {
      const { id, sid } = await mkShipped(A, prodA, varA);
      await call(secretA, official(sid, 45, T0 + 5000));
      for (const [state, extra] of [[41, {}], [24, {}], [47, { exceptionReason: "قديم", exceptionCode: 1 }], [49, {}]] as Array<[number, Record<string, unknown>]>) {
        const r = await call(secretA, official(sid, state, T0 + 1000 + state, extra));
        expect(r.status).toBe(200); expect(r.json?.status).toBe("ignored");
      }
      const o = await orderRow(id);
      expect(o).toMatchObject({ status: "delivered", bostaStatus: "تم التسليم بدون تأكيد استلام", needsReview: false, bostaLastError: null });
      const rows = await inboxRows(sid);
      expect(rows.filter(r => r.processingStatus === "ignored")).toHaveLength(4);
      // حتى من غير ترتيب زمني: shipped بوقت أحدث بعد delivered ممنوع يرجّع الحالة
      const r = await call(secretA, official(sid, 41, T0 + 9000));
      expect(r.json?.status).toBe("ignored");
      expect((await orderRow(id)).status).toBe("delivered");
    });

    it("🔒 الأوردر الملغي داخليًا مايتغيّرش من الـwebhook", async () => {
      const { id, sid } = await mkShipped(A, prodA, varA, undefined, "cancelled");
      for (const state of [21, 45, 46]) expect((await call(secretA, official(sid, state, T0 + state))).json?.status).toBe("ignored");
      expect(await orderRow(id)).toMatchObject({ status: "cancelled", bostaStatus: "sent" });
    });

    it("🔑 إعادة المعالجة: للمالك فقط، داخل نشاطه، وآمنة للتكرار", async () => {
      const sid = `LATE-${tag}`;
      const r = await call(secretA, official(sid, 45, T0 + 100));
      expect(r.json?.status).toBe("unmatched");
      const [row] = await inboxRows(sid);
      // الشحنة اتربطت بأوردر بعد وصول الحدث
      const { id } = await mkShipped(A, prodA, varA, sid);
      // مدير (مش مالك) → ممنوع؛ مالك tenant تاني → ممنوع على نشاط A، و«غير موجود» على نشاطه
      expect(await code(() => session(A.tenantId, "manager").carrierAccounts.reprocessWebhookEvent({ businessId: A.businessId, eventId: row.id }))).toBe("FORBIDDEN");
      expect(await code(() => session(B.tenantId, "super_admin").carrierAccounts.reprocessWebhookEvent({ businessId: A.businessId, eventId: row.id }))).not.toBe("ok");
      const cross = await session(B.tenantId, "super_admin").carrierAccounts.reprocessWebhookEvent({ businessId: B.businessId, eventId: row.id });
      expect(cross.ok).toBe(false);
      expect((await orderRow(id)).status).toBe("confirmed");
      // المالك
      const before = await stockSnapshot();
      const done = await session(A.tenantId, "super_admin").carrierAccounts.reprocessWebhookEvent({ businessId: A.businessId, eventId: row.id });
      expect(done).toMatchObject({ ok: true, status: "processed" });
      expect((await orderRow(id)).status).toBe("delivered");
      expect((await inboxRows(sid))[0]).toMatchObject({ processingStatus: "processed", orderId: id, attempts: 2 });
      // تكرار إعادة المعالجة: لا شيء يتعاد
      await (await db()).update(orders).set({ bostaStatus: "علامة-اختبار" }).where(eq(orders.id, id));
      const again = await session(A.tenantId, "super_admin").carrierAccounts.reprocessWebhookEvent({ businessId: A.businessId, eventId: row.id });
      expect(again).toMatchObject({ ok: true, status: "processed" });
      expect((await orderRow(id)).bostaStatus).toBe("علامة-اختبار");
      expect((await inboxRows(sid))[0].attempts).toBe(2);
      expect(await stockSnapshot()).toEqual(before);
      // حدث لسه unmatched → يفضل unmatched بلا ضرر
      const r2 = await call(secretA, official(`NOPE-${tag}`, 45, T0 + 100));
      expect(r2.json?.status).toBe("unmatched");
      const [row2] = await inboxRows(`NOPE-${tag}`);
      const still = await session(A.tenantId, "super_admin").carrierAccounts.reprocessWebhookEvent({ businessId: A.businessId, eventId: row2.id });
      expect(still).toMatchObject({ ok: true, status: "unmatched" });
    });

    it("🔑 إعادة معالجة حدث failed بتكمّله", async () => {
      const { id, sid } = await mkShipped(A, prodA, varA);
      const payload = official(sid, 45, T0 + 100);
      const n = normalizeBostaEvent(payload); if (!n.ok) throw new Error(n.error);
      const stored = await receiveInboxEvent({ tenantId: A.tenantId, businessId: A.businessId, provider: PROVIDER_BOSTA, shipmentId: sid, trackingNumber: n.event.trackingNumber, eventKey: n.event.eventKey, stateCode: 45, eventType: "SEND", eventTimestamp: n.event.timeStamp, payload });
      if (stored.mode !== "stored") throw new Error("expected stored");
      await (await db()).update(carrierWebhookInbox).set({ processingStatus: "failed", failureReason: "انقطاع مؤقت" }).where(eq(carrierWebhookInbox.id, stored.id));
      const done = await session(A.tenantId, "super_admin").carrierAccounts.reprocessWebhookEvent({ businessId: A.businessId, eventId: stored.id });
      expect(done).toMatchObject({ ok: true, status: "processed" });
      expect((await orderRow(id)).status).toBe("delivered");
      expect((await inboxRows(sid))[0]).toMatchObject({ processingStatus: "processed", failureReason: null, attempts: 2 });
    });

    it("🔒 فترة الانتقال (السر العام): نشاط بلا حساب فقط؛ شحنة غير موجودة = unmatched؛ ونشاط له حساب = 401", async () => {
      process.env.BOSTA_WEBHOOK_SECRET = ENV_SECRET;
      try {
        const c = await mkShipped(C, prodC, varC);
        const r = await call(ENV_SECRET, official(c.sid, 45, T0 + 100));
        expect(r.json).toMatchObject({ ok: true, status: "processed" });
        expect((await orderRow(c.id)).status).toBe("delivered");
        expect((await inboxRows(c.sid))[0]).toMatchObject({ businessId: C.businessId, tenantId: C.tenantId, processingStatus: "processed" });
        // شحنة مش موجودة في أي نشاط → unmatched بلا نشاط، والمكرر مايعملش صف تاني
        const ghost = `GHOST-${tag}`;
        expect((await call(ENV_SECRET, official(ghost, 45, T0 + 100))).json).toEqual({ ok: true, status: "unmatched" });
        expect((await call(ENV_SECRET, official(ghost, 45, T0 + 100))).json).toMatchObject({ ok: true, duplicate: true, status: "unmatched" });
        const ghosts = await inboxRows(ghost);
        expect(ghosts).toHaveLength(1); expect(ghosts[0]).toMatchObject({ businessId: null, tenantId: null, processingStatus: "unmatched", duplicateCount: 1 });
        // السر العام مايوصلش لأوردر نشاط له حساب شحن خاص
        const a = await mkShipped(A, prodA, varA);
        const aBefore = await orderRow(a.id);
        expect((await call(ENV_SECRET, official(a.sid, 45, T0 + 100))).status).toBe(401);
        expect(await orderRow(a.id)).toEqual(aBefore);
      } finally { delete process.env.BOSTA_WEBHOOK_SECRET; }
    });

    it("🔑 توافق خلفي: الشكل القديم state:{code} بيتقرا بالخريطة الرسمية (30 ≠ تسليم)", async () => {
      const { id, sid } = await mkShipped(A, prodA, varA);
      await call(secretA, { _id: sid, type: "SEND", state: { code: 30, value: "Delivered" }, updatedAt: "2026-09-21T10:00:00Z" });
      expect(await orderRow(id)).toMatchObject({ status: "shipped", bostaStatus: "بين فروع بوسطة" });
      await call(secretA, { _id: sid, type: "SEND", state: { code: 45 }, updatedAt: "2026-09-21T11:00:00Z" });
      expect((await orderRow(id)).status).toBe("delivered");
    });

    it("🔑 إنشاء الشحنة يسجّل الـwebhook تلقائيًا: webhookUrl + x-bosta-secret، والسر مايرجعش في النتيجة", async () => {
      const mkConfirmed = async () => {
        const n = ++seq;
        const id = await insertOrderWithItems({
          orderNumber: `WS${n}-${tag}`.slice(0, 20), businessId: A.businessId, customerName: "عميل webhook", customerPhone: "01000000001",
          governorate: "القاهرة", customerAddress: "شارع طويل رقم 10", productName: "p", quantity: 1, totalAmount: "750.00", source: "facebook", status: "confirmed",
        } as any, [{ productId: prodA, productName: "p", quantity: 1, variantId: varA, unitPrice: 750 }]);
        orderIds.push(id); return id;
      };
      const send = async () => {
        const calls: any[] = [];
        const oid = await mkConfirmed();
        const r = await createBostaShipment(oid, {}, fakeFetch(KEY_A, calls));
        expect(r.success).toBe(true);
        expect(JSON.stringify(r)).not.toContain(secretA);
        return { oid, r, body: calls.find(c => c.url.endsWith("/deliveries")).body };
      };
      const first = await send();
      expect(first.body.webhookUrl).toBe("https://matjarak.net/api/webhooks/bosta");
      expect(first.body.webhookCustomHeaders).toEqual({ "x-bosta-secret": secretA });
      // الحدث الراجع من بوسطة بنفس السر بيوصل للأوردر ده
      const back = await call(first.body.webhookCustomHeaders["x-bosta-secret"], official(first.r.shipmentId as string, 45, T0 + 100));
      expect(back.json?.status).toBe("processed");
      expect((await orderRow(first.oid)).status).toBe("delivered");
      // Staging: الرابط من البيئة (https فقط)
      process.env.BOSTA_WEBHOOK_URL = "https://staging.example.test/api/webhooks/bosta";
      try { expect((await send()).body.webhookUrl).toBe("https://staging.example.test/api/webhooks/bosta"); }
      finally { delete process.env.BOSTA_WEBHOOK_URL; }
      process.env.BOSTA_WEBHOOK_URL = "http://insecure.example.test/hook";
      try { expect((await send()).body.webhookUrl).toBe("https://matjarak.net/api/webhooks/bosta"); }
      finally { delete process.env.BOSTA_WEBHOOK_URL; }
    });

    it("🔒 لو بوسطة رجّعت السر في الرد (نجاح أو رفض): مايظهرش في اللوج ولا في رسالة الخطأ ولا على الأوردر", async () => {
      const mkConfirmed = async () => {
        const n = ++seq;
        const id = await insertOrderWithItems({
          orderNumber: `WR${n}-${tag}`.slice(0, 20), businessId: A.businessId, customerName: "عميل webhook", customerPhone: "01000000001",
          governorate: "القاهرة", customerAddress: "شارع طويل رقم 10", productName: "p", quantity: 1, totalAmount: "750.00", source: "facebook", status: "confirmed",
        } as any, [{ productId: prodA, productName: "p", quantity: 1, variantId: varA, unitPrice: 750 }]);
        orderIds.push(id); return id;
      };
      const echoFetch = (status: number) => (async (_url: any, init: any) => {
        const sent = JSON.parse(init.body);
        const body = status === 200
          ? { _id: `ECHO-${tag}-${++seq}`, trackingNumber: 777, webhookCustomHeaders: sent.webhookCustomHeaders, webhookUrl: sent.webhookUrl }
          : { webhookCustomHeaders: sent.webhookCustomHeaders, auth: init.headers.Authorization };
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
      const logged: string[] = [];
      const orig = { log: console.log, warn: console.warn, error: console.error };
      const capture = (...a: unknown[]) => { logged.push(a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
      console.log = capture; console.warn = capture; console.error = capture;
      let okRes: any, badRes: any, badId = 0;
      try {
        okRes = await createBostaShipment(await mkConfirmed(), {}, echoFetch(200));
        badId = await mkConfirmed();
        badRes = await createBostaShipment(badId, {}, echoFetch(422));
        // والـwebhook نفسه مابيطبعش السر ولا الـpayload
        await handleBostaWebhook({ headers: { "x-bosta-secret": secretA }, body: official(okRes.shipmentId, 45, T0 + 100, { businessReference: "سري-جدًا" }) } as any, { status() { return this; }, json() { return this; } } as any);
      } finally { Object.assign(console, orig); }
      expect(okRes.success).toBe(true); expect(badRes.success).toBe(false);
      const everything = [logged.join("\n"), JSON.stringify(okRes), JSON.stringify(badRes), JSON.stringify(await orderRow(badId))].join("\n");
      expect(everything).not.toContain(secretA);
      expect(everything).not.toContain(KEY_A);
      expect(everything).not.toContain("سري-جدًا");
      expect(logged.join("\n")).toContain("[REDACTED]");
      expect(String((await orderRow(badId)).bostaLastError)).toContain("[REDACTED]");
    });

    it("🔒 حقول أطول من الأعمدة لا تُسقط الاستقبال، وفشل الحفظ (500) لا يطبع الـpayload في اللوج", async () => {
      const logged: string[] = [];
      const orig = { log: console.log, warn: console.warn, error: console.error };
      const capture = (...a: unknown[]) => { logged.push(a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
      const MARK = `بيانات-عميل-${tag}`;
      const d = await db();
      const o = await mkShipped(A, prodA, varA, undefined, "shipped");
      console.log = capture; console.warn = capture; console.error = capture;
      let longType: any, longId: any, failed: any;
      try {
        // نوع أطول من العمود: الحدث يتحفظ (النوع مقصوص، الأصل في الخام) ولا يسلّم الأوردر
        longType = await call(secretA, official(o.sid, 45, T0 + 100, { type: "T".repeat(60), businessReference: MARK }));
        // معرّف أطول من أي معرّف شحنة ممكن: 400 بلا حفظ
        longId = await call(secretA, official("P".repeat(150), 45, T0 + 100, { businessReference: MARK }));
        // فشل حفظ حقيقي في القاعدة (عمود إلزامي بلا قيمة) → 500، بلا تسريب
        await d.execute(sql.raw("ALTER TABLE carrier_webhook_inbox ADD COLUMN `_probe` int NOT NULL"));
        try { failed = await call(secretA, official(o.sid, 46, T0 + 200, { businessReference: MARK })); }
        finally { await d.execute(sql.raw("ALTER TABLE carrier_webhook_inbox DROP COLUMN `_probe`")); }
      } finally { Object.assign(console, orig); }
      expect(longType.status).toBe(200); expect(longType.json?.status).toBe("processed");
      expect((await orderRow(o.id)).status).toBe("shipped");
      const [stored] = await inboxRows(o.sid);
      expect(stored.eventType).toBe("T".repeat(40)); expect(JSON.parse(stored.payloadJson).type).toBe("T".repeat(60));
      expect(longId.status).toBe(400);
      expect(failed.status).toBe(500); expect(failed.json).toEqual({ error: "Internal server error" });
      expect((await orderRow(o.id)).status).toBe("shipped"); // الحدث اللي فشل حفظه مااتطبّقش
      const all = logged.join("\n");
      expect(all).toContain("[Bosta Webhook] Error: خطأ داخلي");
      expect(all).not.toContain(MARK); expect(all).not.toContain("Failed query"); expect(all).not.toContain("TTTTT"); expect(all).not.toContain(secretA);
      // بعد رجوع الجدول: بوسطة بتعيد الإرسال والحدث بيتعالج عادي
      expect((await call(secretA, official(o.sid, 46, T0 + 200))).json?.status).toBe("processed");
      expect((await orderRow(o.id)).status).toBe("returned");
    });

    it("🛡️ قبل Migration 0039 (الجدول غير موجود): الاستقبال شغّال بلا 500، والمكرر مايتطبّقش مرتين", async () => {
      const d = await db();
      const { id, sid } = await mkShipped(A, prodA, varA);
      await d.execute(sql.raw(`RENAME TABLE carrier_webhook_inbox TO _premig_cwi_${tag}`));
      try {
        const payload = official(sid, 45, T0 + 100);
        const r = await call(secretA, payload);
        expect(r.status).toBe(200); expect(r.json).toMatchObject({ ok: true, status: "processed" });
        expect((await orderRow(id)).status).toBe("delivered");
        await d.update(orders).set({ bostaStatus: "علامة-اختبار" }).where(eq(orders.id, id));
        const dup = await call(secretA, payload);
        expect(dup.status).toBe(200); expect(dup.json).toEqual({ ok: true, duplicate: true });
        expect((await orderRow(id)).bostaStatus).toBe("علامة-اختبار");
        // السر المجهول لسه 401، والشحنة غير المطابقة 200 unmatched
        expect((await call("nope", payload)).status).toBe(401);
        expect((await call(secretA, official(`PRE-${tag}`, 45, T0 + 100))).json?.status).toBe("unmatched");
        // شاشة المراجعة وإعادة المعالجة بلا throw
        expect(await session(A.tenantId, "super_admin").carrierAccounts.webhookEvents({ businessId: A.businessId })).toEqual([]);
        const re = await session(A.tenantId, "super_admin").carrierAccounts.reprocessWebhookEvent({ businessId: A.businessId, eventId: 1 });
        expect(re.ok).toBe(false);
      } finally {
        await d.execute(sql.raw(`RENAME TABLE _premig_cwi_${tag} TO carrier_webhook_inbox`));
      }
      // بعد الرجوع: الجدول سليم وبيستقبل
      const next = await mkShipped(A, prodA, varA);
      expect((await call(secretA, official(next.sid, 45, T0 + 100))).json?.status).toBe("processed");
      expect(await inboxRows(next.sid)).toHaveLength(1);
    });

    it("🔒 ولا حركة مخزون ولا تغيير رصيد من كل أحداث الـsuite", async () => {
      const d = await db();
      const moves = await d.select({ n: sql<number>`COUNT(*)` }).from(inventoryMovements).where(inArray(inventoryMovements.orderId, orderIds));
      const baseline = Number(moves[0].n);
      // أي حركة موجودة مصدرها إنشاء الأوردرات نفسها — الـwebhook مابيضيفش (كل نداء اتحقق منه في call()).
      const o = await mkShipped(A, prodA, varA);
      for (const state of [21, 41, 47, 45, 46, 60, 49, 100, 101]) await call(secretA, official(o.sid, state, T0 + state * 10));
      const after = await d.select({ n: sql<number>`COUNT(*)` }).from(inventoryMovements).where(inArray(inventoryMovements.orderId, orderIds));
      expect(Number(after[0].n)).toBe(baseline);
    });
  });
}
