import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb, createEmployee, insertOrderWithItems, createProductWithVariants } from "./db";
import { businessCarrierAccounts, carrierWebhookEvents, employees, orders, orderItems, products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import {
  connectCarrierAccount,
  disconnectCarrierAccount,
  resolveBostaConnection,
  getCarrierAccountStatus,
  findAccountByWebhookSecret,
  recordWebhookEvent,
  NOT_CONNECTED_MESSAGE,
  PROVIDER_BOSTA,
  MIGRATION_0037_MISSING_MESSAGE,
  isMissingTableError,
} from "./carrierAccounts.service";
import { sql } from "drizzle-orm";
import { SHIPMENT_DESCRIPTION_LIMIT } from "../shared/orderContent";
import { createBostaShipment, clampDeposit, fetchBostaAwb } from "./bosta.service";
import { handleBostaWebhook } from "./bostaWebhook";
import { deriveWebhookSecret } from "./crypto/secretBox";

/**
 * حساب Bosta لكل نشاط — عزل، تشفير، صلاحيات، وربط بعد نجاح الاختبار فقط.
 * النداءات لبوسطة كلها **mocked**: مفيش أي اتصال حقيقي.
 */

// ── حراس المصدر ──
describe("🔒 حراس المصدر — Bosta لكل نشاط", () => {
  const svc = fs.readFileSync("server/bosta.service.ts", "utf-8");
  const routers = fs.readFileSync("server/routers.ts", "utf-8");
  const webhook = fs.readFileSync("server/bostaWebhook.ts", "utf-8");
  const acct = fs.readFileSync("server/carrierAccounts.service.ts", "utf-8");
  const client = ["client/src/components/BostaConnectDialog.tsx", "client/src/pages/OrderDetails.tsx", "client/src/pages/Orders.tsx"]
    .map(f => fs.readFileSync(f, "utf-8")).join("\n");

  it("🔒 مفيش مفتاح عام في مسار الإرسال/الطباعة", () => {
    const code = svc.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(code).not.toContain("process.env.BOSTA_API_KEY");
    expect(code).toContain("resolveBostaConnection(order.businessId)");
    expect(code).toContain("resolveBostaConnection(businessId)");
  });
  it("🔒 الـfallback العام مقيّد بالتاريخ + غياب صف الحساب — بلا businessId ثابت", () => {
    expect(acct).toContain("isNotNull(orders.bostaShipmentId)");
    expect(acct).toContain("if (row) return false;");
    expect(acct).not.toMatch(/businessId\s*===?\s*\d/);
    expect(acct).not.toContain("أسورة");
  });
  it("🔒 إجراءات الحساب أدمن بنطاق، والمفتاح مابيرجعش", () => {
    const i = routers.indexOf("carrierAccounts: router({");
    const blk = routers.slice(i, routers.indexOf("  businesses: router({", i));
    expect((blk.match(/adminProcedure/g) ?? []).length).toBe(4);
    expect((blk.match(/scopeBusinessId\(ctx, input\.businessId\)/g) ?? []).length).toBe(4);
    expect(acct).not.toContain("apiKey: row");
    expect(acct).toContain("apiKeyLast4");
  });
  it("🔒 الـwebhook: السر → hash → النشاط → الأوردر بشرط businessId", () => {
    const iSecret = webhook.indexOf("findAccountByWebhookSecret(receivedSecret)");
    const iOrder = webhook.indexOf("eq(orders.businessId, businessId), byShipment");
    expect(iSecret).toBeGreaterThan(-1);
    expect(iOrder).toBeGreaterThan(iSecret);
    expect(webhook).toContain("recordWebhookEvent(");
    expect(webhook).toContain("eq(orders.id, order.id), eq(orders.businessId, businessId)");
  });
  it("🔒 الواجهة: بلا مفتاح، بلا businessId ثابت، والأزرار بتتعطّل بسبب", () => {
    expect(client).not.toMatch(/businessId\s*===?\s*\d/);
    expect(client).toContain("bostaCanSend");
    expect(client).toContain("apiKeyLast4");
    expect(client).not.toMatch(/encryptedApiKey|\.apiKey\b(?!Last4)/);
  });
  it("🔒 فحص الهاتف المكرر مقيّد بنشاط الأوردر في الاستعلام نفسه", () => {
    const src = fs.readFileSync("server/bosta.service.ts", "utf8");
    const i = src.indexOf("let duplicatePhoneWarning");
    const block = src.slice(i, src.indexOf(".limit(1)", i));
    expect(block).toContain("eq(orders.businessId, order.businessId)");
    expect(block).toContain("eq(orders.customerPhone, order.customerPhone)");
  });

  it("🔑 clampDeposit: >0 و≤ COD", () => {
    expect(clampDeposit(50, 750)).toBe(50);
    expect(clampDeposit(50, 40)).toBe(40);
    expect(clampDeposit(0, 750)).toBeNull();
    expect(clampDeposit(undefined, 750)).toBeNull();
    expect(clampDeposit(50, 0)).toBeNull();
  });
});

const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

/** fetch وهمي: بيقبل مفتاح واحد بس، وبيسجّل كل النداءات. */
// معرّفات شحن فريدة عبر الملف كله — زي بوسطة الحقيقية؛ تكرارها كان بيخلّي البحث
// بالـshipmentId يلاقي أوردر نشاط تاني.
let shipSeq = 0;
function makeFetch(validKey: string, calls: any[]) {
  return (async (url: any, init: any) => {
    const auth = String(init?.headers?.Authorization ?? "");
    calls.push({ url: String(url), auth, body: init?.body ? JSON.parse(init.body) : null });
    const ok = auth === validKey || auth === `Bearer ${validKey}`;
    if (!ok) return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
    if (String(url).includes("/pickup-locations"))
      return new Response(JSON.stringify({ data: [{ _id: "LOC1", locationName: "المخزن الرئيسي" }, { _id: "LOC2", locationName: "الورشة" }] }), { status: 200 });
    if (String(url).endsWith("/deliveries"))
      { const n = ++shipSeq; return new Response(JSON.stringify({ _id: `SHIP-${process.pid}-${n}`, trackingNumber: `TRK${process.pid}-${n}` }), { status: 200 }); }
    if (String(url).includes("/awb"))
      return new Response(Buffer.from("%PDF-fake"), { status: 200, headers: { "content-type": "application/pdf" } });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe.runIf(CAN)("🔒 Bosta لكل نشاط — سلوكي", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const ids = { empIds: [] as number[], productIds: [] as number[], orderIds: [] as number[] };
  let empA = 0, prodA = 0, varA = 0, prodB = 0, varB = 0;
  const KEY_A = `key-A-${tag}`, KEY_B = `key-B-${tag}`;
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  let savedEnv: Record<string, string | undefined> = {};

  const owner = (tenantId: number) => appRouter.createCaller({
    user: { id: 1, role: "admin", name: "owner" }, employee: null, tenantId,
    req: { protocol: "https", headers: {}, cookies: {} }, res: { clearCookie: () => {}, cookie: () => {} },
  } as any);
  const emp = (employeeId: number) => appRouter.createCaller({
    user: null, employee: null, tenantId: null,
    req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId }, process.env.JWT_SECRET as string) } },
    res: { clearCookie: () => {}, cookie: () => {} },
  } as any);
  const code = async (fn: () => Promise<any>) => { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } };
  const mkOrder = async (businessId: number, productId: number, variantId: number, n: string) => {
    const id = await insertOrderWithItems({
      orderNumber: `BC${n}-${tag}`.slice(0, 20), businessId, customerName: "عميل بوسطة", customerPhone: "01000000001",
      governorate: "القاهرة", customerAddress: "شارع طويل رقم 10", productName: "p", quantity: 1, totalAmount: "750.00",
      source: "facebook", status: "confirmed",
    } as any, [{ productId, productName: "p", quantity: 1, variantId, unitPrice: 750 }]);
    ids.orderIds.push(id); return id;
  };

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    savedEnv = { CARRIER_SECRETS_KEY: process.env.CARRIER_SECRETS_KEY, BOSTA_API_KEY: process.env.BOSTA_API_KEY, BOSTA_WEBHOOK_SECRET: process.env.BOSTA_WEBHOOK_SECRET };
    process.env.CARRIER_SECRETS_KEY = randomBytes(32).toString("base64");
    delete process.env.BOSTA_API_KEY; delete process.env.BOSTA_WEBHOOK_SECRET;
    A = await createCoreTestFixture("bosta-a"); B = await createCoreTestFixture("bosta-b");
    const pa = await createProductWithVariants(A.businessId, { name: `منتج A ${tag}` }, [{ name: "سادة", sku: `BA-${tag}`, currentStock: 50, price: "750" }]);
    const pb = await createProductWithVariants(B.businessId, { name: `منتج B ${tag}` }, [{ name: "سادة", sku: `BB-${tag}`, currentStock: 50, price: "750" }]);
    prodA = pa.productId; varA = pa.variantIds[0]; prodB = pb.productId; varB = pb.variantIds[0];
    ids.productIds.push(prodA, prodB);
    empA = insId(await createEmployee({ name: "e", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `bca_${tag}` } as any));
    ids.empIds.push(empA);
  });
  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    for (const [k, v] of Object.entries(savedEnv)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    await d.delete(carrierWebhookEvents).where(inArray(carrierWebhookEvents.businessId, [A.businessId, B.businessId]));
    await d.delete(businessCarrierAccounts).where(inArray(businessCarrierAccounts.businessId, [A.businessId, B.businessId]));
    if (ids.orderIds.length) { await d.delete(orderItems).where(inArray(orderItems.orderId, ids.orderIds)); await d.delete(orders).where(inArray(orders.id, ids.orderIds)); }
    if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
    if (ids.productIds.length) { await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds)); await d.delete(products).where(inArray(products.id, ids.productIds)); }
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔒 نشاط جديد غير مربوط → لا إرسال ولا طباعة، برسالة واضحة، وبلا fallback", async () => {
    const oid = await mkOrder(A.businessId, prodA, varA, "1");
    expect((await getCarrierAccountStatus(A.businessId)).canSend).toBe(false);
    expect(await code(() => owner(A.tenantId).orders.sendToBosta({ orderId: oid }))).toBe("PRECONDITION_FAILED");
    const r = await createBostaShipment(oid, {}, makeFetch(KEY_A, []));
    expect(r.success).toBe(false); expect(r.error).toBe(NOT_CONNECTED_MESSAGE);
    const awb = await fetchBostaAwb(A.businessId, ["x"], makeFetch(KEY_A, []));
    expect(awb.ok).toBe(false);
  });

  it("🔒 API Key خاطئ لا يُحفظ", async () => {
    const r = await connectCarrierAccount({ tenantId: A.tenantId, businessId: A.businessId, apiKey: "wrong-key-123", pickupLocationId: null, pickupLocationName: null, allowOpenPackageDefault: true, actorId: 1, fetchImpl: makeFetch(KEY_A, []) });
    expect(r.ok).toBe(false);
    expect(await resolveBostaConnection(A.businessId)).toBeNull();
    const d = await getDb();
    expect(await d!.select().from(businessCarrierAccounts).where(eq(businessCarrierAccounts.businessId, A.businessId))).toEqual([]);
  });

  it("🔑 الربط الصحيح: يُحفظ مشفّرًا، last4 بس، ومكان الاستلام من حساب بوسطة", async () => {
    const calls: any[] = [];
    const r = await connectCarrierAccount({ tenantId: A.tenantId, businessId: A.businessId, apiKey: KEY_A, pickupLocationId: "LOC1", pickupLocationName: "المخزن الرئيسي", allowOpenPackageDefault: true, actorId: 1, fetchImpl: makeFetch(KEY_A, calls) });
    expect(r.ok && r.apiKeyLast4).toBe(KEY_A.slice(-4));
    expect(calls.some(c => c.url.includes("/pickup-locations"))).toBe(true);
    const d = await getDb();
    const [row] = await d!.select().from(businessCarrierAccounts).where(eq(businessCarrierAccounts.businessId, A.businessId));
    expect(row.status).toBe("connected");
    expect(row.encryptedApiKey).not.toContain(KEY_A);
    expect(row.apiKeyLast4).toBe(KEY_A.slice(-4));
    expect(row.apiAuthScheme).toBeTruthy(); expect(row.apiBaseUrl).toBeTruthy();
    const st = await owner(A.tenantId).carrierAccounts.status({ businessId: A.businessId });
    expect(st.canSend).toBe(true); expect(st.apiKeyLast4).toBe(KEY_A.slice(-4));
    expect(JSON.stringify(st)).not.toContain(KEY_A);
  });

  it("🔑 بعد الربط: الإرسال ينجح بمفتاح النشاط، فليكس + ديبوزيت معًا ومنفصلين، والسر في webhookCustomHeaders", async () => {
    const calls: any[] = [];
    const o1 = await mkOrder(A.businessId, prodA, varA, "2");
    const r1 = await createBostaShipment(o1, { allowToOpenPackage: true, depositAmount: 50 }, makeFetch(KEY_A, calls));
    expect(r1.success).toBe(true);
    const body = calls.find(c => c.url.endsWith("/deliveries")).body;
    expect(body.allowToOpenPackage).toBe(true);
    expect(body.escrowInfo).toEqual({ amountToBeCollected: 50 });
    expect(body.businessLocationId).toBe("LOC1");
    expect(body.webhookCustomHeaders["x-bosta-secret"]).toBeTruthy();
    expect(calls.find(c => c.url.endsWith("/deliveries")).auth).toMatch(new RegExp(`${KEY_A}$`));
    // ديبوزيت بس (بلا فليكس)
    const o2 = await mkOrder(A.businessId, prodA, varA, "3");
    const c2: any[] = []; expect((await createBostaShipment(o2, { allowToOpenPackage: false, depositAmount: 9999 }, makeFetch(KEY_A, c2))).success).toBe(true);
    const b2 = c2.find(c => c.url.endsWith("/deliveries")).body;
    expect(b2.allowToOpenPackage).toBe(false); expect(b2.escrowInfo.amountToBeCollected).toBe(750); // مسقوف بالتحصيل
    // فليكس بس
    const o3 = await mkOrder(A.businessId, prodA, varA, "4");
    const c3: any[] = []; await createBostaShipment(o3, { allowToOpenPackage: true }, makeFetch(KEY_A, c3));
    expect(c3.find(c => c.url.endsWith("/deliveries")).body.escrowInfo).toBeUndefined();
    // AWB بمفتاح النشاط
    expect((await fetchBostaAwb(A.businessId, ["SHIP-1"], makeFetch(KEY_A, []))).ok).toBe(true);
  });

  it("📦 payload بوسطة: بدلة أطفال بيج/10 + أسود/6 → اللون والمقاس والكمية لكل قطعة، وعدد القطع 2", async () => {
    // اسم البند بيتوحّد من الكتالوج وقت الحفظ (Phase A) — فالمنتج نفسه لازم اسمه «بدلة أطفال».
    const suit = await createProductWithVariants(A.businessId, { name: "بدلة أطفال" }, [{ name: "AFK", sku: `AFK-${tag}`, currentStock: 50, price: "450" }]);
    ids.productIds.push(suit.productId);
    const oid = await insertOrderWithItems({
      orderNumber: `BCS-${tag}`.slice(0, 20), businessId: A.businessId, customerName: "عميل بدلة", customerPhone: "01000000002",
      governorate: "الجيزة", customerAddress: "شارع الهرم رقم 5", productName: "بدلة أطفال", quantity: 2, totalAmount: "900.00",
      source: "facebook", status: "confirmed",
    } as any, [
      { productId: suit.productId, productName: "بدلة أطفال", quantity: 1, color: "بيج", size: "10", unitPrice: 450 },
      { productId: suit.productId, productName: "بدلة أطفال", quantity: 1, color: "أسود", size: "6", unitPrice: 450 },
    ]);
    ids.orderIds.push(oid);
    const calls: any[] = [];
    expect((await createBostaShipment(oid, {}, makeFetch(KEY_A, calls))).success).toBe(true);
    const body = calls.find(c => c.url.endsWith("/deliveries")).body;
    // الحقل اللي بيظهر على البوليصة: specs.packageDetails.description (+ itemsCount)
    expect(body.specs.packageDetails.description).toBe("بدلة أطفال (مقاس 10، لون بيج) ×1، بدلة أطفال (مقاس 6، لون أسود) ×1");
    expect(body.specs.packageDetails.itemsCount).toBe(2);
    expect(body.specs.packageDetails.description.length).toBeLessThanOrEqual(SHIPMENT_DESCRIPTION_LIMIT);
  });

  it("📦 payload بوسطة: أساور بنقشين مختلفين وكميات → كل نقش بكميته، وعدد القطع 3", async () => {
    const br = await createProductWithVariants(A.businessId, { name: "أسورة نحاس" }, [
      { name: "ذكر التحصين", sku: `BR1-${tag}`, currentStock: 50, price: "250" },
      { name: "سادة", sku: `BR2-${tag}`, currentStock: 50, price: "250" },
    ]);
    ids.productIds.push(br.productId);
    const oid = await insertOrderWithItems({
      orderNumber: `BCB-${tag}`.slice(0, 20), businessId: A.businessId, customerName: "عميل أساور", customerPhone: "01000000003",
      governorate: "القاهرة", customerAddress: "شارع النيل رقم 7", productName: "أسورة نحاس", quantity: 3, totalAmount: "800.00",
      source: "facebook", status: "confirmed",
    } as any, [
      { productId: br.productId, productName: "أسورة نحاس", quantity: 2, variantId: br.variantIds[0], unitPrice: 250 },
      { productId: br.productId, productName: "أسورة نحاس", quantity: 1, variantId: br.variantIds[1], unitPrice: 250 },
    ]);
    ids.orderIds.push(oid);
    const calls: any[] = [];
    expect((await createBostaShipment(oid, {}, makeFetch(KEY_A, calls))).success).toBe(true);
    const body = calls.find(c => c.url.endsWith("/deliveries")).body;
    expect(body.specs.packageDetails.description).toBe("أسورة نحاس - ذكر التحصين ×2، أسورة نحاس - سادة ×1");
    expect(body.specs.packageDetails.itemsCount).toBe(3);
  });

  it("🔒 تحذير الهاتف المكرر: داخل نشاط الأوردر فقط — رقم أوردر نشاط آخر لا يظهر أبدًا", async () => {
    const d = (await getDb())!;
    const PHONE = "01055555555";
    // B (نشاط/مؤسسة تانية) عنده أوردر بنفس الهاتف ومشحون بوسطة
    const ob = await insertOrderWithItems({
      orderNumber: `BPH-B-${tag}`.slice(0, 20), businessId: B.businessId, customerName: "عميل B", customerPhone: PHONE,
      governorate: "القاهرة", customerAddress: "شارع طويل رقم 10", productName: "p", quantity: 1, totalAmount: "300.00",
      source: "facebook", status: "confirmed",
    } as any, [{ productId: prodB, productName: "p", quantity: 1, variantId: varB, unitPrice: 300 }]);
    ids.orderIds.push(ob);
    await d.update(orders).set({ bostaShipmentId: `BSHIP-${tag}`, bostaStatus: "sent" }).where(eq(orders.id, ob));
    const mkA = async (n: string) => {
      const id = await insertOrderWithItems({
        orderNumber: `BPH-A${n}-${tag}`.slice(0, 20), businessId: A.businessId, customerName: "عميل A", customerPhone: PHONE,
        governorate: "القاهرة", customerAddress: "شارع طويل رقم 10", productName: "p", quantity: 1, totalAmount: "750.00",
        source: "facebook", status: "confirmed",
      } as any, [{ productId: prodA, productName: "p", quantity: 1, variantId: varA, unitPrice: 750 }]);
      ids.orderIds.push(id); return id;
    };
    // أول أوردر A بنفس الهاتف: مفيش تكرار جوه A → بلا تحذير، ورقم أوردر B لا يظهر في أي مكان
    const a1 = await mkA("1");
    const r1 = await createBostaShipment(a1, {}, makeFetch(KEY_A, []));
    expect(r1.success).toBe(true); expect(r1.warning).toBeUndefined();
    const [row1] = await d.select().from(orders).where(eq(orders.id, a1));
    expect(row1.bostaLastError ?? "").not.toContain(`BPH-B`);
    // تاني أوردر A بنفس الهاتف: التحذير يذكر أوردر A الأول فقط
    const a2 = await mkA("2");
    const r2 = await createBostaShipment(a2, {}, makeFetch(KEY_A, []));
    expect(r2.success).toBe(true);
    expect(r2.warning).toContain(`BPH-A1-${tag}`.slice(0, 20));
    expect(r2.warning).not.toContain("BPH-B");
    const [row2] = await d.select().from(orders).where(eq(orders.id, a2));
    expect(row2.bostaLastError ?? "").not.toContain("BPH-B");
  });

  it("🔒 إرسال مزدوج → شحنة واحدة", async () => {
    const oid = await mkOrder(A.businessId, prodA, varA, "5");
    const calls: any[] = [];
    const f = makeFetch(KEY_A, calls);
    const [r1, r2] = await Promise.all([createBostaShipment(oid, {}, f), createBostaShipment(oid, {}, f)]);
    expect([r1.success, r2.success].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(calls.filter(c => c.url.endsWith("/deliveries")).length).toBe(1);
  });

  it("🔒 أوردر A لا يُرسل بمفتاح B، وB (غير مربوط) مايشوفش ولا يستخدم اتصال A", async () => {
    expect(await resolveBostaConnection(B.businessId)).toBeNull();
    expect((await owner(B.tenantId).carrierAccounts.status({ businessId: B.businessId })).canSend).toBe(false);
    // أوردر B → رفض، ومفيش أي نداء بمفتاح A
    const ob = await mkOrder(B.businessId, prodB, varB, "6");
    const calls: any[] = [];
    const r = await createBostaShipment(ob, {}, makeFetch(KEY_A, calls));
    expect(r.success).toBe(false); expect(calls).toEqual([]);
    // تزوير businessId من العميل: أدمن B يطلب حالة/ربط نشاط A → FORBIDDEN
    expect(await code(() => owner(B.tenantId).carrierAccounts.status({ businessId: A.businessId }))).toBe("FORBIDDEN");
    expect(await code(() => owner(B.tenantId).carrierAccounts.connect({ businessId: A.businessId, apiKey: KEY_B }))).toBe("FORBIDDEN");
    expect(await code(() => owner(B.tenantId).carrierAccounts.disconnect({ businessId: A.businessId }))).toBe("FORBIDDEN");
    expect((await getCarrierAccountStatus(A.businessId)).canSend).toBe(true);
  });

  it("🔒 الموظف لا يربط ولا يفصل ولا يرى الحالة", async () => {
    expect(await code(() => emp(empA).carrierAccounts.connect({ businessId: A.businessId, apiKey: KEY_A }))).not.toBe("ok");
    expect(await code(() => emp(empA).carrierAccounts.disconnect({ businessId: A.businessId }))).not.toBe("ok");
    expect(await code(() => emp(empA).carrierAccounts.status({ businessId: A.businessId }))).not.toBe("ok");
  });

  it("🔒 webhook: سر نشاط A يحدّث أوردر A فقط، السر المجهول مرفوض، والمكرر لا يُطبَّق مرتين", async () => {
    const d = await getDb();
    const [row] = await d!.select().from(businessCarrierAccounts).where(eq(businessCarrierAccounts.businessId, A.businessId));
    const secretA = deriveWebhookSecret(PROVIDER_BOSTA, A.businessId, row.webhookSalt);
    expect((await findAccountByWebhookSecret(secretA))?.businessId).toBe(A.businessId);
    // شحنة لأوردر A وشحنة بنفس المعرّف لأوردر B (نشاط تاني)
    const oa = await mkOrder(A.businessId, prodA, varA, "7"); const ob = await mkOrder(B.businessId, prodB, varB, "8");
    await d!.update(orders).set({ bostaShipmentId: `SAME-${tag}`, bostaStatus: "sent" }).where(inArray(orders.id, [oa, ob]));
    const call = async (secret: string, body: any) => {
      let status = 0, json: any = null;
      const res: any = { status: (s: number) => { status = s; return res; }, json: (j: any) => { json = j; return res; } };
      await handleBostaWebhook({ headers: { "x-bosta-secret": secret }, body } as any, res);
      return { status, json };
    };
    const payload = { _id: `SAME-${tag}`, state: { code: 30, value: "Delivered" }, updatedAt: "2026-09-21T10:00:00Z" };
    expect((await call(secretA, payload)).status).toBe(200);
    const [a] = await d!.select().from(orders).where(eq(orders.id, oa)); const [b] = await d!.select().from(orders).where(eq(orders.id, ob));
    expect(a.status).toBe("delivered"); expect(b.status).not.toBe("delivered"); // أوردر B لم يُلمس
    // مكرر → duplicate بلا تطبيق
    expect((await call(secretA, payload)).json?.duplicate).toBe(true);
    // سر مجهول → 401
    expect((await call("not-a-secret", payload)).status).toBe(401);
    // سر نشاط A مايقدرش يحدّث أوردر موجود في B فقط
    const onlyB = await mkOrder(B.businessId, prodB, varB, "9");
    await d!.update(orders).set({ bostaShipmentId: `ONLYB-${tag}`, bostaStatus: "sent" }).where(eq(orders.id, onlyB));
    const r = await call(secretA, { _id: `ONLYB-${tag}`, state: { code: 30 } });
    expect(r.status).toBe(200); expect(r.json?.message).toContain("not found");
    expect((await d!.select().from(orders).where(eq(orders.id, onlyB)))[0].status).not.toBe("delivered");
    expect(await recordWebhookEvent({ businessId: A.businessId, provider: PROVIDER_BOSTA, eventHash: "h1" })).toBe(true);
    expect(await recordWebhookEvent({ businessId: A.businessId, provider: PROVIDER_BOSTA, eventHash: "h1" })).toBe(false);
    expect(await recordWebhookEvent({ businessId: B.businessId, provider: PROVIDER_BOSTA, eventHash: "h1" })).toBe(true); // نشاط تاني = حدث مختلف
  });

  it("🔒 الفصل: المفتاح NULL، الصف أثر disconnected، الإرسال ممنوع، تاريخ الشحنات باقٍ، ولا fallback", async () => {
    process.env.BOSTA_API_KEY = "GLOBAL-KEY"; // حتى لو موجود — نشاط عنده صف = مفيش fallback
    await disconnectCarrierAccount(A.businessId, 1);
    const d = await getDb();
    const [row] = await d!.select().from(businessCarrierAccounts).where(eq(businessCarrierAccounts.businessId, A.businessId));
    expect(row.status).toBe("disconnected");
    expect(row.encryptedApiKey).toBeNull(); expect(row.apiKeyLast4).toBeNull(); expect(row.encryptionIv).toBeNull(); expect(row.encryptionTag).toBeNull();
    expect(await resolveBostaConnection(A.businessId)).toBeNull();
    const shipped = await d!.select().from(orders).where(and(eq(orders.businessId, A.businessId), eq(orders.bostaStatus, "sent")));
    expect(shipped.length).toBeGreaterThan(0);
    const oid = await mkOrder(A.businessId, prodA, varA, "10");
    const calls: any[] = [];
    expect((await createBostaShipment(oid, {}, makeFetch("GLOBAL-KEY", calls))).success).toBe(false);
    expect(calls).toEqual([]);
    delete process.env.BOSTA_API_KEY;
  });

  it("🔑 الانتقال: المفتاح العام يخدم فقط نشاطًا له شحنات سابقة وبلا صف حساب؛ نشاط جديد أبدًا", async () => {
    process.env.BOSTA_API_KEY = "GLOBAL-KEY";
    // B: عنده شحنة سابقة (اتضافت فوق) ومفيش صف → legacy مسموح
    const stB = await getCarrierAccountStatus(B.businessId);
    expect(stB.status).toBe("legacy"); expect(stB.canSend).toBe(true);
    // نشاط جديد تمامًا بلا تاريخ → ممنوع
    const C = await createCoreTestFixture("bosta-c");
    try {
      expect((await getCarrierAccountStatus(C.businessId)).status).toBe("not_connected");
      expect(await resolveBostaConnection(C.businessId)).toBeNull();
    } finally { await C.cleanup(); }
    // A (عنده صف disconnected) → ممنوع رغم التاريخ
    expect((await getCarrierAccountStatus(A.businessId)).canSend).toBe(false);
    delete process.env.BOSTA_API_KEY;
  });

  it("🔑 الانتقال (صريح): نشاط جديد بلا صف لا يستخدم BOSTA_API_KEY حتى لو موجود — ولا نداء واحد", async () => {
    process.env.BOSTA_API_KEY = "GLOBAL-KEY";
    const C = await createCoreTestFixture("bosta-c2");
    try {
      const oid = await insertOrderWithItems({
        orderNumber: `BCC-${tag}`.slice(0, 20), businessId: C.businessId, customerName: "عميل جديد", customerPhone: "01000000004",
        governorate: "القاهرة", customerAddress: "شارع جديد رقم 1", productName: "منتج", quantity: 1, totalAmount: "100.00",
        source: "facebook", status: "confirmed",
      } as any, [{ productName: "منتج", quantity: 1, unitPrice: 100 }]);
      ids.orderIds.push(oid);
      const calls: any[] = [];
      const r = await createBostaShipment(oid, {}, makeFetch("GLOBAL-KEY", calls));
      expect(r.success).toBe(false); expect(r.error).toBe(NOT_CONNECTED_MESSAGE); expect(calls).toEqual([]);
      expect((await owner(C.tenantId).carrierAccounts.status({ businessId: C.businessId })).status).toBe("not_connected");
    } finally { delete process.env.BOSTA_API_KEY; await C.cleanup(); }
  });

  it("🔑 CARRIER_SECRETS_KEY غايب: الإرسال Legacy (بمفتاح البيئة) شغّال، والربط الجديد بس اللي بيترفض", async () => {
    process.env.BOSTA_API_KEY = "GLOBAL-KEY"; process.env.BOSTA_WEBHOOK_SECRET = `env-secret-${tag}`;
    const savedKey = process.env.CARRIER_SECRETS_KEY; delete process.env.CARRIER_SECRETS_KEY;
    try {
      // B: تاريخ شحن + بلا صف → legacy، ومفيش أي لمسة للمفتاح الرئيسي
      const ob = await mkOrder(B.businessId, prodB, varB, "11");
      const calls: any[] = [];
      const r = await createBostaShipment(ob, {}, makeFetch("GLOBAL-KEY", calls));
      expect(r.success).toBe(true);
      const req = calls.find(c => c.url.endsWith("/deliveries"));
      expect(req.auth).toBe("GLOBAL-KEY"); expect(req.body.businessLocationId).toBeUndefined();
      expect(req.body.webhookCustomHeaders["x-bosta-secret"]).toBe(`env-secret-${tag}`);
      // webhook بالسر العام يوصل لأوردر B (نشاط بلا صف) من غير مفتاح رئيسي
      let status = 0; const res: any = { status: (s: number) => { status = s; return res; }, json: () => res };
      await handleBostaWebhook({ headers: { "x-bosta-secret": `env-secret-${tag}` }, body: { _id: r.shipmentId, state: { code: 30 }, updatedAt: "2026-09-21T11:00:00Z" } } as any, res);
      expect(status).toBe(200);
      expect((await (await getDb())!.select().from(orders).where(eq(orders.id, ob)))[0].status).toBe("delivered");
      // الربط الجديد → رفض برسالة واضحة، بلا throw وبلا كتابة
      const c = await connectCarrierAccount({ tenantId: B.tenantId, businessId: B.businessId, apiKey: KEY_B, pickupLocationId: null, pickupLocationName: null, allowOpenPackageDefault: true, actorId: 1, fetchImpl: makeFetch(KEY_B, []) });
      expect(c.ok).toBe(false); expect((c as any).error).toContain("CARRIER_SECRETS_KEY");
      expect(await resolveBostaConnection(B.businessId)).not.toBeNull(); // لسه legacy، مفيش صف اتكتب
      expect((await getCarrierAccountStatus(B.businessId)).status).toBe("legacy");
    } finally {
      process.env.CARRIER_SECRETS_KEY = savedKey; delete process.env.BOSTA_API_KEY; delete process.env.BOSTA_WEBHOOK_SECRET;
    }
  });

  it("🛡️ قبل Migration 0037 (الجدولان غير موجودين): الحالة والإرسال Legacy والـwebhook شغّالين بلا 500، والربط يرفض برسالة", async () => {
    const d = (await getDb())!;
    process.env.BOSTA_API_KEY = "GLOBAL-KEY"; process.env.BOSTA_WEBHOOK_SECRET = `env-secret-${tag}`;
    // خطأ MySQL الحقيقي 1146 هو اللي الحارس بيتعرّف عليه
    let real: unknown = null;
    try { await d.execute(sql.raw(`SELECT 1 FROM \`no_such_table_${tag}\``)); } catch (e) { real = e; }
    expect(isMissingTableError(real)).toBe(true);
    // إخفاء الجدولين فعليًا (الملف ده الوحيد اللي بيستخدمهم؛ بيرجعوا في finally)
    await d.execute(sql.raw(`RENAME TABLE business_carrier_accounts TO _premig_bca_${tag}, carrier_webhook_events TO _premig_cwe_${tag}`));
    try {
      // صفحات الأوردرات/قنوات البيع بتسأل الحالة دي — لازم ترجع بلا throw
      const stB = await owner(B.tenantId).carrierAccounts.status({ businessId: B.businessId });
      expect(stB.status).toBe("legacy"); expect(stB.canSend).toBe(true);
      const C = await createCoreTestFixture("bosta-c3");
      try {
        const stC = await owner(C.tenantId).carrierAccounts.status({ businessId: C.businessId });
        expect(stC.status).toBe("not_connected"); expect(stC.canSend).toBe(false);
      } finally { await C.cleanup(); }
      // الإرسال من الراوتر لنشاط عنده تاريخ (الأساور في Production) بيكمل على مفتاح البيئة
      const ob = await mkOrder(B.businessId, prodB, varB, "12");
      const calls: any[] = [];
      const r = await createBostaShipment(ob, {}, makeFetch("GLOBAL-KEY", calls));
      expect(r.success).toBe(true); expect(calls.find(c => c.url.endsWith("/deliveries")).auth).toBe("GLOBAL-KEY");
      // webhook بالسر العام → 200 وتحديث (بلا idempotency لحد ما الجدول يتعمل — زي القديم)
      let status = 0; const res: any = { status: (s: number) => { status = s; return res; }, json: () => res };
      await handleBostaWebhook({ headers: { "x-bosta-secret": `env-secret-${tag}` }, body: { _id: r.shipmentId, state: { code: 30 }, updatedAt: "2026-09-21T12:00:00Z" } } as any, res);
      expect(status).toBe(200);
      expect((await d.select().from(orders).where(eq(orders.id, ob)))[0].status).toBe("delivered");
      // سر مجهول لسه 401
      let s2 = 0; const res2: any = { status: (s: number) => { s2 = s; return res2; }, json: () => res2 };
      await handleBostaWebhook({ headers: { "x-bosta-secret": "nope" }, body: { _id: "x" } } as any, res2);
      expect(s2).toBe(401);
      // الربط → رسالة الـmigration، بلا throw
      const c = await connectCarrierAccount({ tenantId: B.tenantId, businessId: B.businessId, apiKey: KEY_B, pickupLocationId: null, pickupLocationName: null, allowOpenPackageDefault: true, actorId: 1, fetchImpl: makeFetch(KEY_B, []) });
      expect(c).toEqual({ ok: false, error: MIGRATION_0037_MISSING_MESSAGE }); // الراوتر بيحوّل !ok → BAD_REQUEST
    } finally {
      await d.execute(sql.raw(`RENAME TABLE _premig_bca_${tag} TO business_carrier_accounts, _premig_cwe_${tag} TO carrier_webhook_events`));
      delete process.env.BOSTA_API_KEY; delete process.env.BOSTA_WEBHOOK_SECRET;
    }
    // بعد الرجوع: الصف بتاع A لسه موجود والجدول سليم
    expect((await getCarrierAccountStatus(A.businessId)).status).toBe("disconnected");
  });
});
