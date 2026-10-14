import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import * as XLSX from "xlsx";
import { randomBytes } from "crypto";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee, createProductWithVariants, insertOrderWithItems, setDefaultPackageImageUrl } from "./db";
import { connectCarrierAccount } from "./carrierAccounts.service";
import { createBostaShipment, mapGovToBostaCity, BOSTA_SENDABLE_STATUSES } from "./bosta.service";
import { upsertEasyOrder, reconcileEasyOrderShipping, MANUAL_ADDRESS_CONFLICT_PREFIX, type EasyOrderPayload } from "./easyorder.service";
import { registerExportRoutes, validateOrdersForShipping } from "./exportExcel";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";
import { GOVERNORATES } from "../shared/egyptGovernorates";
import { NEEDS_COMPLETION_LABEL } from "../shared/shippingReadiness";
import { COOKIE_NAME } from "@shared/const";

/**
 * اكتمال بيانات الشحن على السيرفر — عبر الـAPI مباشرة (مش الواجهة) على قاعدة مؤقتة محلية:
 *  • الإنشاء بعنوان قصير مسموح من كل المسارات؛ التأكيد مرفوض بالسبب؛ الأوردر الناقص القديم يُفتح ويُعدَّل ويُحفظ.
 *  • بوسطة: حالات مسموحة فقط + اكتمال البيانات + لا شحنة نشطة، فردي وجماعي، إعادة المحاولة بعد الفشل، والتزامن.
 *    **كل نداءات بوسطة وهمية** (fetch مزيّف) — مفيش شحنة حقيقية ولا اتصال خارجي.
 *  • EasyOrder: العنوان المصحَّح يدويًا محمي من الـwebhook/المزامنة المتكررة، بتنبيه مراجعة عند الاختلاف فقط.
 *  • شيت الشحن: الناقص يُستبعد بعدده وأسبابه، والصلاحيات كما هي.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const errOf = async (p: Promise<any>) => p.then(() => null, (e: any) => e);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const web = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { [COOKIE_NAME]: sign(id) } }, res } as any));
const portal = async (id: number) => appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any));

/** fetch وهمي لبوسطة: يسجّل النداءات، ويمكن تأخيره لاختبار التزامن. لا اتصال حقيقي أبدًا. */
let shipSeq = 0;
function fakeBosta(calls: string[], delayMs = 0) {
  return (async (url: any) => {
    const u = String(url);
    calls.push(u);
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    if (u.includes("/pickup-locations")) return new Response(JSON.stringify({ data: [{ _id: "LOC1", locationName: "المخزن" }] }), { status: 200 });
    if (u.endsWith("/deliveries")) { const n = ++shipSeq; return new Response(JSON.stringify({ _id: `SC-${process.pid}-${n}`, trackingNumber: `TSC${process.pid}${n}` }), { status: 200 }); }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}
const deliveries = (calls: string[]) => calls.filter(u => u.endsWith("/deliveries")).length;

describe.runIf(CAN)("📦 اكتمال بيانات الشحن — قواعد السيرفر", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  let prodA = 0, varA = 0;
  const savedEnv: Record<string, string | undefined> = {};
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const row = async (id: number) => (await q("SELECT * FROM orders WHERE id = ?", [id]))[0];
  const stock = async () => Number((await q("SELECT currentStock s FROM product_variants WHERE id = ?", [varA]))[0].s);
  let seq = 0;

  /** أوردر مباشر في القاعدة (لمحاكاة أوردرات قديمة/حالات محددة) — بنود حقيقية بالمنتج والتركيبة. */
  const mk = async (over: Record<string, unknown> = {}) => insertOrderWithItems({
    orderNumber: `SC${++seq}-${tmp.name}`.slice(0, 20), businessId: A.businessId, customerName: "عميل شحن", customerPhone: "01000000001",
    governorate: "القاهرة", customerAddress: "شارع طويل رقم 10", productId: prodA, variantId: varA, productName: "أسورة", quantity: 1,
    totalAmount: "300.00", source: "facebook", status: "confirmed", ...over,
  } as any, [{ productId: prodA, variantId: varA, productName: "أسورة", quantity: 1, unitPrice: 300 }]);

  beforeAll(async () => {
    for (const k of ["CARRIER_SECRETS_KEY", "BOSTA_API_KEY", "BOSTA_WEBHOOK_SECRET"]) savedEnv[k] = process.env[k];
    process.env.CARRIER_SECRETS_KEY = randomBytes(32).toString("base64");
    delete process.env.BOSTA_API_KEY; delete process.env.BOSTA_WEBHOOK_SECRET;
    tmp = await createTempSchema("shipc");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("sc-a"); B = await createCoreTestFixture("sc-b");
    const p = await createProductWithVariants(A.businessId, { name: `أسورة ${tmp.name}` }, [{ name: "سادة", sku: `SC-${tmp.name}`, currentStock: 100, price: "300" }]);
    prodA = p.productId; varA = p.variantIds[0];
    const emp = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: k, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await emp("owner", "super_admin", A); await emp("mgr", "manager", A); await emp("de", "data_entry", A); await emp("agent", "agent", A);
    await emp("ownerB", "super_admin", B);
    await setDefaultPackageImageUrl(A.businessId, "https://cdn.example.com/sc/package.jpg", 1);
    const c = await connectCarrierAccount({ tenantId: A.tenantId, businessId: A.businessId, apiKey: `sc-key-${tmp.name}`, pickupLocationId: "LOC1", pickupLocationName: "المخزن", allowOpenPackageDefault: true, actorId: 1, fetchImpl: fakeBosta([]) });
    expect(c.ok).toBe(true);
  }, 300_000);
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    __setDbForTests(null); await tmp?.drop();
  }, 120_000);

  describe("الإنشاء والتأكيد عبر الـAPI", () => {
    const createInput = (tag: string, address: string, governorate = "القاهرة") => ({
      customerName: `عميل ${tag}`, customerPhone: "01012345678", customerAddress: address, governorate,
      productId: prodA, productName: "أسورة", variantId: varA, quantity: 1, totalAmount: "300", source: "facebook", businessId: A.businessId,
    });

    it("العنوان القصير لا يمنع الحفظ في orders.create وemployeePortal.createOrder وfacebookEntry.addOrder — يُحفظ «جديد»؛ والفارغ تمامًا مرفوض", async () => {
      const r1 = await (await web(e.owner)).orders.create(createInput("c1", "شارع 5") as any);
      expect(r1.success).toBe(true);
      const [o1] = await q("SELECT status, customerAddress FROM orders WHERE orderNumber = ?", [r1.orderNumber]);
      expect([o1.status, o1.customerAddress]).toEqual(["new", "شارع 5"]);

      const r2 = await (await portal(e.mgr)).employeePortal.createOrder({ ...createInput("c2", "عنوان"), businessId: undefined } as any);
      expect(r2).toBeTruthy();
      expect((await q("SELECT COUNT(*) n FROM orders WHERE customerName = 'عميل c2' AND customerAddress = 'عنوان'"))[0].n).toBe(1);

      const r3 = await (await portal(e.de)).facebookEntry.addOrder({
        customerName: "عميل c3", customerPhone: "01012345678", governorate: "القاهرة", customerAddress: "الدقي",
        selectedProducts: [{ productId: prodA, productName: "أسورة", quantity: 1, variantId: varA, unitPrice: 300 }], totalAmount: 300,
      } as any);
      expect(r3.orderNumber).toBeTruthy();
      expect((await q("SELECT status FROM orders WHERE orderNumber = ?", [r3.orderNumber]))[0].status).toBe("new");

      expect((await errOf((await web(e.owner)).orders.create(createInput("c4", "") as any)))?.code).toBe("BAD_REQUEST");
      expect((await q("SELECT COUNT(*) n FROM orders WHERE customerName = 'عميل c4'"))[0].n).toBe(0);
    });

    it("التأكيد مرفوض على السيرفر (orders.confirm وemployeePortal.confirm) بالسبب العربي، بلا خصم مخزون ولا تغيير حالة؛ الحدود 9/10", async () => {
      const s0 = await stock();
      const short = await mk({ status: "new", customerAddress: "123456789" }); // 9 أحرف
      const err = await errOf((await web(e.owner)).orders.confirm({ orderId: short }));
      expect(String(err?.message)).toContain(NEEDS_COMPLETION_LABEL);
      expect(String(err?.message)).toContain("العنوان قصير — 10 أحرف على الأقل (الحالي 9)");
      expect([(await row(short)).status, await stock()]).toEqual(["new", s0]);

      const unknownGov = await mk({ status: "new", governorate: "ال", assignedEmployeeId: e.agent });
      const err2 = await errOf((await portal(e.agent)).employeePortal.confirm({ orderId: unknownGov }));
      expect(String(err2?.message)).toContain("المحافظة «ال» غير معروفة");
      expect([(await row(unknownGov)).status, await stock()]).toEqual(["new", s0]);

      const ten = await mk({ status: "new", customerAddress: "1234567890" }); // 10 أحرف بالضبط
      await (await web(e.owner)).orders.confirm({ orderId: ten });
      expect([(await row(ten)).status, await stock()]).toEqual(["confirmed", s0 - 1]);
    });

    it("أوردر ناقص قديم (عنوان 5 أحرف ومحافظة «غير محدد») يُفتح ويُعدَّل ويُحفظ؛ بعد الاستكمال يتأكد", async () => {
      const old = await mk({ status: "new", customerAddress: "عنوان", governorate: "غير محدد" });
      const owner = await web(e.owner);
      expect((await owner.orders.get({ id: old }))?.customerAddress).toBe("عنوان");
      await owner.orders.editOrder({ orderId: old, customerName: "عميل قديم معدَّل", notes: "حفظ بدون استكمال" });
      expect((await row(old)).customerName).toBe("عميل قديم معدَّل");
      expect(String((await errOf(owner.orders.confirm({ orderId: old })))?.message)).toContain("المحافظة غير محددة");
      await owner.orders.editOrder({ orderId: old, customerAddress: "شارع التحرير عمارة 4", governorate: "الجيزة" });
      await owner.orders.confirm({ orderId: old });
      expect((await row(old)).status).toBe("confirmed");
    });
  });

  describe("بوسطة — بوابة السيرفر (fetch وهمي بالكامل)", () => {
    it("mapGovToBostaCity: الـ27 محافظة مدعومة، وبلا مطابقة جزئية («ال»، «القاهرة الجديدة» ⇒ null)", () => {
      for (const g of GOVERNORATES) expect(mapGovToBostaCity(g), g).not.toBeNull();
      for (const g of ["ال", "القاهرة الجديدة", "مدينة نصر", "غير محدد", ""]) expect(mapGovToBostaCity(g), g).toBeNull();
      expect([...BOSTA_SENDABLE_STATUSES]).toEqual(["confirmed", "preparing", "printed"]);
    });

    it("API فردي: حالة غير مسموحة (جديد/تم الشحن/ملغي) أو بيانات ناقصة ⇒ رفض بالسبب وبلا أي نداء لبوسطة؛ المكتمل المؤكد ينجح مرة واحدة", async () => {
      const calls: string[] = []; vi.stubGlobal("fetch", fakeBosta(calls));
      const owner = await web(e.owner);
      for (const status of ["new", "shipped", "cancelled", "delivered"]) {
        const id = await mk({ status });
        const r = await owner.orders.sendToBosta({ orderId: id });
        expect([r.success, r.error], status).toEqual([false, expect.stringContaining("لا يمكن إرسال أوردر حالته")]);
        expect((await row(id)).bostaStatus, status).toBeNull(); // رفض الحالة ليس محاولة شحن فاشلة
      }
      const incomplete = await mk({ customerAddress: "شارع 5" });
      const ri = await owner.orders.sendToBosta({ orderId: incomplete });
      expect([ri.success, ri.error]).toEqual([false, expect.stringContaining(NEEDS_COMPLETION_LABEL)]);
      const badGov = await mk({ governorate: "القاهرة الجديدة" });
      expect((await owner.orders.sendToBosta({ orderId: badGov })).error).toContain("غير معروفة");
      expect(deliveries(calls)).toBe(0);

      const ok = await mk();
      const r1 = await owner.orders.sendToBosta({ orderId: ok });
      expect(r1.success).toBe(true);
      const r2 = await owner.orders.sendToBosta({ orderId: ok }); // شحنة نشطة موجودة ⇒ نجاح idempotent بلا نداء جديد
      expect([r2.success, r2.shipmentId]).toEqual([true, r1.shipmentId]);
      expect(deliveries(calls)).toBe(1);
    });

    it("API جماعي: مختلط (جديد، ناقص، قيد التحضير، مطبوع، مشحون سابقًا) ⇒ نجاح للمسموح فقط، وأسباب للباقي، ونداءان فقط لبوسطة", async () => {
      const calls: string[] = []; vi.stubGlobal("fetch", fakeBosta(calls));
      const ids = {
        fresh: await mk({ status: "new" }), incomplete: await mk({ customerAddress: "عنوان" }), preparing: await mk({ status: "preparing" }),
        printed: await mk({ status: "printed" }), already: await mk({ bostaShipmentId: `PREV-${tmp.name}`, bostaStatus: "created" }),
      };
      const r = await (await web(e.owner)).orders.bulkSendToBosta({ orderIds: Object.values(ids) });
      expect([r.success, r.failed]).toEqual([3, 2]);
      expect(r.errors.map(x => x.orderId).sort()).toEqual([ids.fresh, ids.incomplete].sort());
      expect(deliveries(calls)).toBe(2);
      expect((await row(ids.fresh)).bostaShipmentId).toBeNull();
      expect((await row(ids.incomplete)).bostaShipmentId).toBeNull();
      expect((await row(ids.already)).bostaShipmentId).toBe(`PREV-${tmp.name}`);
    });

    it("إعادة المحاولة: بعد فشل (failed) مسموحة وتنجح؛ وبعد استكمال بيانات ناقصة مسموحة؛ «جاري الإنشاء/غير مؤكد» ممنوع بلا نداء", async () => {
      const calls: string[] = [];
      const failed = await mk({ bostaStatus: "failed", bostaLastError: "timeout" });
      expect((await createBostaShipment(failed, {}, fakeBosta(calls))).success).toBe(true);
      const fixable = await mk({ customerAddress: "شارع 5" });
      expect((await createBostaShipment(fixable, {}, fakeBosta(calls))).success).toBe(false);
      expect((await row(fixable)).bostaStatus).toBe("failed");
      await (await web(e.owner)).orders.editOrder({ orderId: fixable, customerAddress: "شارع 5 بجوار البنك الأهلي" });
      expect((await createBostaShipment(fixable, {}, fakeBosta(calls))).success).toBe(true);
      expect(deliveries(calls)).toBe(2);
      for (const s of ["creating", "uncertain"]) {
        const id = await mk({ bostaStatus: s });
        expect((await createBostaShipment(id, {}, fakeBosta(calls))).success, s).toBe(false);
      }
      expect(deliveries(calls)).toBe(2);
    });

    it("تزامن: 6 إرسالات متزامنة لنفس الأوردر (API + خدمة) ⇒ نداء واحد فقط لبوسطة وشحنة واحدة", async () => {
      const calls: string[] = []; vi.stubGlobal("fetch", fakeBosta(calls, 80));
      const id = await mk();
      const owner = await web(e.owner);
      const res6 = await Promise.allSettled([
        ...Array.from({ length: 3 }, () => owner.orders.sendToBosta({ orderId: id })),
        owner.orders.bulkSendToBosta({ orderIds: [id] }),
        ...Array.from({ length: 2 }, () => createBostaShipment(id, {}, fakeBosta(calls, 80))),
      ]);
      expect(res6.filter(r => r.status === "rejected")).toEqual([]);
      expect(deliveries(calls)).toBe(1);
      expect((await row(id)).bostaShipmentId).toMatch(/^SC-/);
    });

    it("العزل: مالك شركة أخرى لا يرسل أوردر هذه الشركة، فرديًا أو جماعيًا، وبلا نداء", async () => {
      const calls: string[] = []; vi.stubGlobal("fetch", fakeBosta(calls));
      const id = await mk();
      const ownerB = await web(e.ownerB);
      expect((await errOf(ownerB.orders.sendToBosta({ orderId: id })))?.code).toMatch(/FORBIDDEN|NOT_FOUND/);
      expect((await errOf(ownerB.orders.bulkSendToBosta({ orderIds: [id] })))?.code).toMatch(/FORBIDDEN|NOT_FOUND/);
      expect([deliveries(calls), (await row(id)).bostaShipmentId]).toEqual([0, null]);
    });
  });

  describe("EasyOrder — حماية العنوان اليدوي (بلا اتصال بـEasyOrder: الـpayload يُمرَّر مباشرة)", () => {
    let t = Date.parse("2026-10-01T10:00:00Z");
    const payload = (id: string, address: string, government = "الجيزة"): EasyOrderPayload => ({
      id, full_name: "عميل إيزي", phone: "01012345678", government, address, total_cost: 350, shipping_cost: 50,
      updated_at: new Date((t += 60_000)).toISOString(), created_at: "2026-10-01T09:00:00Z",
      cart_items: [{ price: 300, quantity: 1, product: { name: "منتج غير مطابق" } }],
    });
    const up = (p: EasyOrderPayload) => upsertEasyOrder(p, { businessId: A.businessId, source: "easyorder" });

    it("reconcileEasyOrderShipping: بلا payload سابق + عنوان حالي مختلف ⇒ يُحتفظ به بتنبيه؛ محافظة معروفة لا تُستبدل بغير معروفة", () => {
      const r = reconcileEasyOrderShipping({ current: { customerAddress: "عنوان يدوي طويل", governorate: "القاهرة", externalRawPayload: null }, incoming: { customerAddress: "عنوان الموقع", governorate: "منطقة ما" } });
      expect([r.customerAddress, r.governorate, r.conflict?.startsWith(MANUAL_ADDRESS_CONFLICT_PREFIX)]).toEqual(["عنوان يدوي طويل", "القاهرة", true]);
      const same = reconcileEasyOrderShipping({ current: { customerAddress: "عنوان  الموقع", governorate: "الجيزة", externalRawPayload: JSON.stringify({ address: "قديم", government: "الجيزة" }) }, incoming: { customerAddress: "عنوان الموقع", governorate: "الجيزة" } });
      expect([same.customerAddress, same.conflict]).toEqual(["عنوان  الموقع", null]);
    });

    it("مسار كامل: تعديل يدوي ← مزامنة بنفس العنوان (صامتة) ← عنوان مختلف (يُحتفظ باليدوي + تنبيه) ← replay ← تكرار بنفس العنوان (التنبيه باقٍ) ← الموظف يحسم ← تحديث لاحق يُقبل", async () => {
      const ext = `EO-${tmp.name}`;
      const c = await up(payload(ext, "شارع النيل رقم 5 الدقي"));
      expect(c.outcome).toBe("created");
      const id = c.orderId!;
      const owner = await web(e.owner);
      const manual = "شارع النيل رقم 5 الدقي — الدور الثالث شقة 7";
      await owner.orders.editOrder({ orderId: id, customerAddress: manual });

      expect((await up(payload(ext, "شارع النيل رقم 5 الدقي"))).outcome).toBe("updated");
      let o = await row(id);
      expect([o.customerAddress, String(o.reviewReason ?? "").includes(MANUAL_ADDRESS_CONFLICT_PREFIX)]).toEqual([manual, false]);

      const p3 = payload(ext, "عنوان جديد من الموقع 123");
      const u3 = await up(p3);
      o = await row(id);
      expect([u3.outcome, u3.needsReview, o.customerAddress, Boolean(o.needsReview)]).toEqual(["updated", true, manual, true]);
      expect(o.reviewReason).toContain(MANUAL_ADDRESS_CONFLICT_PREFIX);
      expect(o.reviewReason).toContain("عنوان جديد من الموقع 123");

      expect((await up(p3)).outcome).toBe("duplicate_unchanged"); // replay نفس الـpayload
      await up(payload(ext, "عنوان جديد من الموقع 123")); // مزامنة متكررة أحدث بنفس العنوان
      o = await row(id);
      expect([o.customerAddress, (o.reviewReason.match(new RegExp(MANUAL_ADDRESS_CONFLICT_PREFIX, "g")) ?? []).length]).toEqual([manual, 1]);

      await owner.orders.editOrder({ orderId: id, customerAddress: "عنوان جديد من الموقع 123" }); // الموظف قبل العنوان القادم
      o = await row(id);
      expect(String(o.reviewReason ?? "")).not.toContain(MANUAL_ADDRESS_CONFLICT_PREFIX);

      await up(payload(ext, "عنوان أحدث من الموقع 456", "منطقة غير معروفة"));
      o = await row(id);
      expect([o.customerAddress, o.governorate]).toEqual(["عنوان أحدث من الموقع 456", "الجيزة"]); // غير يدوي ⇒ يُقبل؛ المحافظة لا تتدهور
    });

    it("بلا تعديل يدوي: تحديث العنوان من EasyOrder يُقبل بلا تنبيه", async () => {
      const ext = `EO2-${tmp.name}`;
      const id = (await up(payload(ext, "عنوان أول من الموقع 1"))).orderId!;
      await up(payload(ext, "عنوان ثاني من الموقع 2", "القاهرة"));
      const o = await row(id);
      expect([o.customerAddress, o.governorate, String(o.reviewReason ?? "").includes(MANUAL_ADDRESS_CONFLICT_PREFIX)]).toEqual(["عنوان ثاني من الموقع 2", "القاهرة", false]);
    });
  });

  describe("شيت الشحن Excel", () => {
    const app = express(); app.use(express.json()); app.use(cookieParser()); registerExportRoutes(app);
    const cookie = (id: number) => `${COOKIE_NAME}=${sign(id)}`;
    const binary = (r: any, cb: any) => { const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks))); };

    it("validateOrdersForShipping: العنوان القصير والمحافظة غير المعروفة أسباب استبعاد", () => {
      const v = validateOrdersForShipping([
        { id: 1, orderNumber: "1", customerName: "عميل", customerPhone: "01012345678", customerAddress: "شارع 5", governorate: "القاهرة" },
        { id: 2, orderNumber: "2", customerName: "عميل", customerPhone: "01012345678", customerAddress: "شارع طويل رقم 10", governorate: "ال" },
        { id: 3, orderNumber: "3", customerName: "عميل", customerPhone: "01012345678", customerAddress: "شارع طويل رقم 10", governorate: "القاهرة" },
      ]);
      expect(v.warnings.map(w => w.orderId)).toEqual([1, 2]);
    });

    it("مختلط ⇒ الصالح فقط في الشيت + ورقة «مستبعدة» بالأسباب + ترويسة العدد؛ كله ناقص ⇒ 422 بلا ملف؛ بلا جلسة ⇒ 401", async () => {
      const good = await mk({ orderNumber: `XG-${tmp.name}`.slice(0, 20) });
      const bad = await mk({ orderNumber: `XB-${tmp.name}`.slice(0, 20), customerAddress: "شارع 5" });
      const r = await request(app).get(`/api/export/shipping?orderIds=${good},${bad}`).set("Cookie", cookie(e.owner)).buffer(true).parse(binary);
      expect([r.status, r.headers["x-excluded-orders"]]).toEqual([200, "1"]);
      const wb = XLSX.read(r.body, { type: "buffer" });
      expect(wb.SheetNames).toContain("مستبعدة");
      const excluded = JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets["مستبعدة"], { header: 1 }));
      expect(excluded).toContain(`XB-${tmp.name}`.slice(0, 20));
      expect(excluded).toContain("العنوان قصير");
      const exported = wb.SheetNames.filter(n => n !== "مستبعدة").map(n => JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 }))).join();
      expect(exported).not.toContain(`XB-${tmp.name}`.slice(0, 20));

      const all = await request(app).get(`/api/export/shipping?orderIds=${bad}`).set("Cookie", cookie(e.owner));
      expect([all.status, all.body.excluded?.length]).toEqual([422, 1]);
      expect((await request(app).get(`/api/export/shipping?orderIds=${good}`)).status).toBe(401);
    });
  });
});
