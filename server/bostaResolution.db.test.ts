import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import { drizzle } from "drizzle-orm/mysql2";
import { __setDbForTests, createProductWithVariants, insertOrderWithItems, setDefaultPackageImageUrl } from "./db";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { connectCarrierAccount } from "./carrierAccounts.service";
import { createBostaShipment } from "./bosta.service";
import {
  approveBostaReset, linkUncertainShipment, requestBostaReset, CREATING_STALE_MS,
} from "./bostaResolution.service";

/**
 * حسم شحنات بوسطة غير المؤكدة — قاعدة مؤقتة ببيانات مصطنعة، وكل نداءات بوسطة **وهمية** (fetchImpl). مفيش أي اتصال.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);

describe.runIf(CAN)("🚚 بوسطة — الرد غير الواضح + الربط وإعادة الإرسال بمراجعة", { timeout: 120_000 }, () => {
  let tmp: TempSchema; let A: CoreTestFixture; let B: CoreTestFixture;
  let pA = 0, vA = 0, pB = 0, vB = 0, seq = 0;
  const saved: Record<string, string | undefined> = {};
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const row = async (id: number) => (await q("SELECT * FROM orders WHERE id = ?", [id]))[0];
  const owner1 = { id: 9001, name: "مالك 1", role: "super_admin" };
  const owner2 = { id: 9002, name: "مالك 2", role: "super_admin" };
  const manager = { id: 9003, name: "مدير", role: "manager" };
  const KEY = `bosta-test-key-${randomBytes(4).toString("hex")}`;

  /** fetch وهمي بيعدّ نداءات /deliveries ويرجّع الرد المطلوب. */
  function fakeBosta(reply: () => Response) {
    const calls: string[] = [];
    const fn = (async (url: any, init: any) => {
      const u = String(url);
      if (u.endsWith("/pickup-locations")) return new Response(JSON.stringify({ data: [{ _id: "LOC1", locationName: "المخزن" }] }), { status: 200 });
      if (u.endsWith("/deliveries")) { calls.push(u); return reply(); }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    return { fn, calls };
  }
  async function order(fx: CoreTestFixture, productId: number, variantId: number, status = "confirmed") {
    const n = ++seq;
    return insertOrderWithItems({
      orderNumber: `BR${n}-${tmp.name.slice(-6)}`.slice(0, 20), businessId: fx.businessId, customerName: "عميل بوسطة",
      customerPhone: "01000000001", governorate: "القاهرة", customerAddress: "شارع طويل رقم 10 - الدور 2 - شقة 3",
      productName: "p", quantity: 1, totalAmount: "500.00", source: "manual", status,
    } as any, [{ productId, productName: "p", quantity: 1, variantId, unitPrice: 500 }]);
  }
  const scopeA = () => [A.businessId];

  beforeAll(async () => {
    for (const k of ["CARRIER_SECRETS_KEY", "BOSTA_API_KEY", "BOSTA_WEBHOOK_SECRET", "BOSTA_BASE_URL"]) saved[k] = process.env[k];
    process.env.CARRIER_SECRETS_KEY = randomBytes(32).toString("base64");
    delete process.env.BOSTA_API_KEY; delete process.env.BOSTA_WEBHOOK_SECRET; delete process.env.BOSTA_BASE_URL;
    tmp = await createTempSchema("bostares");
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("br-a"); B = await createCoreTestFixture("br-b");
    const a = await createProductWithVariants(A.businessId, { name: "منتج A" }, [{ name: "x", sku: `BRA-${tmp.name}`.slice(0, 50), currentStock: 50 } as any]);
    pA = a.productId; vA = a.variantIds[0];
    const b = await createProductWithVariants(B.businessId, { name: "منتج B" }, [{ name: "y", sku: `BRB-${tmp.name}`.slice(0, 50), currentStock: 50 } as any]);
    pB = b.productId; vB = b.variantIds[0];
    for (const fx of [A, B]) {
      await setDefaultPackageImageUrl(fx.businessId, `https://cdn.example.com/b${fx.businessId}/package.jpg`, 1);
      const r = await connectCarrierAccount({ tenantId: fx.tenantId, businessId: fx.businessId, apiKey: KEY, pickupLocationId: "LOC1", pickupLocationName: "المخزن", allowOpenPackageDefault: true, actorId: 1, fetchImpl: fakeBosta(() => new Response("{}")).fn });
      expect(r.ok).toBe(true);
    }
  }, 180_000);
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
    __setDbForTests(null); await tmp?.drop();
  }, 120_000);

  it("HTTP 200 من غير رقم شحنة = uncertain (مش failed)، وإعادة الإرسال مرفوضة من غير أي نداء لبوسطة", async () => {
    const id = await order(A, pA, vA);
    const first = fakeBosta(() => new Response(JSON.stringify({ data: { message: "created" } }), { status: 200 }));
    const r = await createBostaShipment(id, undefined, first.fn);
    expect(r.success).toBe(false);
    expect(first.calls).toHaveLength(1);
    expect((await row(id)).bostaStatus).toBe("uncertain");
    const again = fakeBosta(() => new Response(JSON.stringify({ _id: "NEW1", trackingNumber: "111" }), { status: 200 }));
    const r2 = await createBostaShipment(id, undefined, again.fn);
    expect(r2.success).toBe(false);
    expect(again.calls).toHaveLength(0);
    expect((await row(id)).bostaShipmentId).toBeNull();
  });

  it("الربط: بدليل، داخل النطاق، ورقم الشحنة مايتربطش بأكتر من أوردر (حتى عند تاجر تاني)", async () => {
    const id = await order(A, pA, vA);
    await q("UPDATE orders SET bostaStatus = 'uncertain' WHERE id = ?", [id]);
    await expect(linkUncertainShipment({ orderId: id, allowedBusinessIds: scopeA(), shipmentId: "SHIP-A-1", evidence: "قصير", actor: owner1 })).rejects.toThrow(/الدليل/);
    await expect(linkUncertainShipment({ orderId: id, allowedBusinessIds: [B.businessId], shipmentId: "SHIP-A-1", evidence: "مراجعة لوحة بوسطة 2026-10-19", actor: owner1 })).rejects.toThrow(/غير موجود/);
    const ok = await linkUncertainShipment({ orderId: id, allowedBusinessIds: scopeA(), shipmentId: "SHIP-A-1", trackingNumber: "48089608", evidence: "مراجعة لوحة بوسطة 2026-10-19", actor: owner1 });
    expect(ok).toEqual({ shipmentId: "SHIP-A-1", trackingNumber: "48089608" });
    expect(await row(id)).toMatchObject({ bostaShipmentId: "SHIP-A-1", bostaTrackingNumber: "48089608", bostaStatus: "sent", bostaLastError: null });
    const log = await q("SELECT action, businessId, performedBy FROM activity_logs WHERE entityId = ? AND action = 'bosta_link_shipment'", [id]);
    expect(log).toEqual([{ action: "bosta_link_shipment", businessId: A.businessId, performedBy: owner1.id }]);
    // نفس الرقم على أوردر تاني (حتى في تاجر تاني) = مرفوض
    const other = await order(B, pB, vB);
    await q("UPDATE orders SET bostaStatus = 'uncertain' WHERE id = ?", [other]);
    await expect(linkUncertainShipment({ orderId: other, allowedBusinessIds: [B.businessId], shipmentId: "SHIP-A-1", evidence: "مراجعة لوحة بوسطة 2026-10-19", actor: owner2 })).rejects.toThrow(/مربوط بأوردر تاني/);
    expect((await row(other)).bostaShipmentId).toBeNull();
    // الأوردر المربوط مايتربطش تاني
    await expect(linkUncertainShipment({ orderId: id, allowedBusinessIds: scopeA(), shipmentId: "SHIP-A-2", evidence: "مراجعة لوحة بوسطة 2026-10-19", actor: owner1 })).rejects.toThrow(/مش في حالة/);
  });

  it("الربط المتزامن لنفس الرقم على أوردرين: واحد بس ينجح", async () => {
    const o1 = await order(A, pA, vA); const o2 = await order(A, pA, vA);
    await q("UPDATE orders SET bostaStatus = 'uncertain' WHERE id IN (?, ?)", [o1, o2]);
    const rs = await Promise.allSettled([o1, o2].map(id => linkUncertainShipment({ orderId: id, allowedBusinessIds: scopeA(), shipmentId: "SHIP-RACE", evidence: "مراجعة لوحة بوسطة 2026-10-19", actor: owner1 })));
    expect(rs.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await q("SELECT COUNT(*) n FROM orders WHERE bostaShipmentId = 'SHIP-RACE'"))[0].n).toBe(1);
  });

  it("creating النشطة (حديثة) ممنوع لمسها؛ creating القديمة (+10 دقايق) قابلة للحسم", async () => {
    const id = await order(A, pA, vA);
    await q("UPDATE orders SET bostaStatus = 'creating' WHERE id = ?", [id]);
    await expect(linkUncertainShipment({ orderId: id, allowedBusinessIds: scopeA(), shipmentId: "SHIP-C-1", evidence: "مراجعة لوحة بوسطة 2026-10-19", actor: owner1 })).rejects.toThrow(/مش في حالة/);
    await expect(requestBostaReset({ orderId: id, allowedBusinessIds: scopeA(), evidence: "مراجعة لوحة بوسطة 2026-10-19", actor: manager })).rejects.toThrow(/متاح بس/);
    const later = new Date(Date.now() + CREATING_STALE_MS + 60_000);
    const r = await requestBostaReset({ orderId: id, allowedBusinessIds: scopeA(), evidence: "مراجعة لوحة بوسطة 2026-10-19", actor: manager, now: later });
    expect(r.status).toBe("reset_requested");
  });

  // ── B2 (2026-10-20): مقدّم الطلب مايعتمدش أبدًا، ومرور الوقت مابيدّيش صلاحية، والتحقق منظّم ──
  const owner3 = { id: 9004, name: "مالك 3", role: "super_admin" };
  const verification = (orderNumber: string, over: Record<string, unknown> = {}) => ({
    method: "bosta_dashboard_search" as const, searchedAt: new Date(Date.now() + 1000).toISOString(), searchQuery: `بحث ${orderNumber}`,
    resultCount: 0, screenshotUrl: "https://evidence.example.test/bosta-search.png", ...over,
  });
  const resetActions = async (id: number) => (await q("SELECT action FROM activity_logs WHERE entityId = ? AND action LIKE 'bosta_reset_%' ORDER BY id", [id])).map((x: any) => x.action);

  it("B2: طلب ← رفض (مدير/مقدّم الطلب/تاجر تاني/نص حر/تحقق ناقص) والحالة تفضل reset_requested ← مالك تاني بتحقق ← إرسال واحد", async () => {
    const id = await order(A, pA, vA);
    const num = (await row(id)).orderNumber as string;
    await q("UPDATE orders SET bostaStatus = 'uncertain' WHERE id = ?", [id]);
    await requestBostaReset({ orderId: id, allowedBusinessIds: scopeA(), evidence: "بحثت في لوحة بوسطة بالمرجع ومفيش شحنة", actor: owner1 });
    expect((await row(id)).bostaStatus).toBe("reset_requested");
    const blocked = fakeBosta(() => new Response(JSON.stringify({ _id: "X", trackingNumber: "1" }), { status: 200 }));
    expect((await createBostaShipment(id, undefined, blocked.fn)).success).toBe(false);
    expect(blocked.calls).toHaveLength(0);
    const ok = verification(num);
    await expect(approveBostaReset({ orderId: id, allowedBusinessIds: scopeA(), verification: ok, actor: manager })).rejects.toThrow(/لمالك غير مقدّم الطلب/);
    // مقدّم الطلب: مرفوض حتى بتحقق سليم وحتى بعد شهر
    for (const later of [new Date(), new Date(Date.now() + 30 * 86_400_000)])
      await expect(approveBostaReset({ orderId: id, allowedBusinessIds: scopeA(), verification: { ...ok, searchedAt: later.toISOString() }, actor: owner1, now: later })).rejects.toThrow(/مقدّم الطلب مايقدرش/);
    await expect(approveBostaReset({ orderId: id, allowedBusinessIds: [B.businessId], verification: ok, actor: owner2 })).rejects.toThrow(/غير موجود/);
    // نص حر لوحده / تحقق ناقص أو متناقض ⇒ رفض
    for (const bad of [
      undefined, { ...ok, method: "free_text" }, { ...ok, resultCount: 1 }, { ...ok, searchQuery: "بحث برقم الموبايل بس" },
      { ...ok, searchedAt: new Date(Date.now() - 86_400_000).toISOString() }, { ...ok, searchedAt: new Date(Date.now() + 86_400_000).toISOString() },
      { ...ok, screenshotUrl: "http://evidence.example.test/x.png" }, { ...ok, searchedAt: "not-a-date" },
    ]) await expect(approveBostaReset({ orderId: id, allowedBusinessIds: scopeA(), verification: bad as any, actor: owner2 }), JSON.stringify(bad)).rejects.toThrow();
    expect((await row(id)).bostaStatus).toBe("reset_requested");
    await approveBostaReset({ orderId: id, allowedBusinessIds: scopeA(), verification: ok, actor: owner2 });
    expect((await row(id)).bostaStatus).toBe("failed");
    const send = fakeBosta(() => new Response(JSON.stringify({ _id: "SHIP-R-1", trackingNumber: "99887766" }), { status: 200 }));
    expect(await createBostaShipment(id, undefined, send.fn)).toMatchObject({ success: true, shipmentId: "SHIP-R-1", trackingNumber: "99887766" });
    expect(send.calls).toHaveLength(1);
    await expect(approveBostaReset({ orderId: id, allowedBusinessIds: scopeA(), verification: ok, actor: owner2 })).rejects.toThrow(/مفيش طلب/);
    const actions = await resetActions(id);
    expect(actions[0]).toBe("bosta_reset_requested");
    expect(actions.at(-1)).toBe("bosta_reset_approved");
    expect(actions.filter((a: string) => a === "bosta_reset_denied").length).toBeGreaterThanOrEqual(10);
    expect(actions.filter((a: string) => a === "bosta_reset_approved")).toHaveLength(1);
    const [approved] = await q("SELECT metadata, performedBy FROM activity_logs WHERE entityId = ? AND action = 'bosta_reset_approved'", [id]);
    const meta = typeof approved.metadata === "string" ? JSON.parse(approved.metadata) : approved.metadata;
    expect(meta).toMatchObject({ decision: "approved", requestedBy: owner1.id, approvedBy: owner2.id, verification: { method: "bosta_dashboard_search", resultCount: 0 } });
    expect(meta.requestedAt).toBeTruthy(); expect(meta.decidedAt).toBeTruthy();
    expect(approved.performedBy).toBe(owner2.id);
  });

  it("B2: نشاط بمالك واحد ⇒ مايقدرش يعتمد طلبه مهما عدّى وقت، والطلب يفضل معلّق (مسار المنصة BLOCKED)", async () => {
    const id = await order(A, pA, vA);
    const num = (await row(id)).orderNumber as string;
    await q("UPDATE orders SET bostaStatus = 'uncertain' WHERE id = ?", [id]);
    await requestBostaReset({ orderId: id, allowedBusinessIds: scopeA(), evidence: "بحثت في لوحة بوسطة ومفيش شحنة", actor: owner1 });
    const later = new Date(Date.now() + 48 * 3600_000);
    await expect(approveBostaReset({ orderId: id, allowedBusinessIds: scopeA(), verification: verification(num, { searchedAt: later.toISOString() }), actor: owner1, now: later })).rejects.toThrow(/مقدّم الطلب/);
    expect((await row(id)).bostaStatus).toBe("reset_requested");
  });

  it("B2: طلب مالوش أثر في السجل (مايتعرفش مقدّمه) ⇒ مرفوض والحالة زي ما هي", async () => {
    const id = await order(A, pA, vA);
    const num = (await row(id)).orderNumber as string;
    await q("UPDATE orders SET bostaStatus = 'reset_requested' WHERE id = ?", [id]);
    await expect(approveBostaReset({ orderId: id, allowedBusinessIds: scopeA(), verification: verification(num), actor: owner2 })).rejects.toThrow(/مايتعرفش مين قدّم/);
    expect((await row(id)).bostaStatus).toBe("reset_requested");
  });

  it("B2: اعتمادين متزامنين من مالكين مختلفين ⇒ واحد بس ينجح وسجل اعتماد واحد", async () => {
    const id = await order(A, pA, vA);
    const num = (await row(id)).orderNumber as string;
    await q("UPDATE orders SET bostaStatus = 'uncertain' WHERE id = ?", [id]);
    await requestBostaReset({ orderId: id, allowedBusinessIds: scopeA(), evidence: "بحثت في لوحة بوسطة ومفيش شحنة", actor: owner1 });
    const rs = await Promise.allSettled([owner2, owner3].map(actor => approveBostaReset({ orderId: id, allowedBusinessIds: scopeA(), verification: verification(num), actor })));
    expect(rs.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await resetActions(id)).filter((a: string) => a === "bosta_reset_approved")).toHaveLength(1);
    expect((await row(id)).bostaStatus).toBe("failed");
  });

  it("B2: مفيش اعتماد أثناء creating (نشطة أو قديمة) — الاعتماد لطلب reset_requested بس", async () => {
    const id = await order(A, pA, vA);
    const num = (await row(id)).orderNumber as string;
    await q("UPDATE orders SET bostaStatus = 'creating' WHERE id = ?", [id]);
    await expect(approveBostaReset({ orderId: id, allowedBusinessIds: scopeA(), verification: verification(num), actor: owner2 })).rejects.toThrow(/مفيش طلب/);
    expect((await row(id)).bostaStatus).toBe("creating");
  });

  // ── B1 (2026-10-20): Staging مايتصلش بـBosta Live — الرفض قبل الحجز وقبل أي نداء ──
  it("B1: staging + عنوان Live ⇒ رفض قبل الحجز (حتى مع إرسالين متزامنين) وصفر نداء؛ AWB كمان", async () => {
    const env = { DEPLOY_ENV: process.env.DEPLOY_ENV, BOSTA_BASE_URL: process.env.BOSTA_BASE_URL, BOSTA_SANDBOX_ORIGINS: process.env.BOSTA_SANDBOX_ORIGINS, BOSTA_WEBHOOK_URL: process.env.BOSTA_WEBHOOK_URL };
    try {
      Object.assign(process.env, { DEPLOY_ENV: "staging", BOSTA_BASE_URL: "https://app.bosta.co/api/v2", BOSTA_WEBHOOK_URL: "https://staging.example.test/api/webhooks/bosta", BOSTA_SANDBOX_ORIGINS: "https://app.bosta.co" });
      const id = await order(A, pA, vA);
      const calls: string[] = [];
      const f = (async (url: any) => { calls.push(String(url)); return new Response(JSON.stringify({ _id: "LIVE!", trackingNumber: "1" }), { status: 200 }); }) as unknown as typeof fetch;
      const rs = await Promise.all([createBostaShipment(id, undefined, f), createBostaShipment(id, undefined, f)]);
      for (const r of rs) expect(r).toMatchObject({ success: false, error: expect.stringMatching(/Live/) });
      expect(calls).toHaveLength(0);
      expect(await row(id)).toMatchObject({ bostaStatus: null, bostaShipmentId: null });
      const { fetchBostaAwb } = await import("./bosta.service");
      expect((await fetchBostaAwb(A.businessId, ["SHIP-ANY"], f)).ok).toBe(false);
      expect(calls).toHaveLength(0);
    } finally { for (const [k, v] of Object.entries(env)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
  });

  it("B1: staging + Sandbox معتمد ⇒ نداء واحد للـSandbox بـredirect: error", async () => {
    const SANDBOX = "https://bosta-sandbox.example.test/api/v2";
    const env = { DEPLOY_ENV: process.env.DEPLOY_ENV, BOSTA_BASE_URL: process.env.BOSTA_BASE_URL, BOSTA_SANDBOX_ORIGINS: process.env.BOSTA_SANDBOX_ORIGINS, BOSTA_WEBHOOK_URL: process.env.BOSTA_WEBHOOK_URL };
    try {
      Object.assign(process.env, { DEPLOY_ENV: "staging", BOSTA_BASE_URL: SANDBOX, BOSTA_SANDBOX_ORIGINS: new URL(SANDBOX).origin, BOSTA_WEBHOOK_URL: "https://staging.example.test/api/webhooks/bosta" });
      const id = await order(A, pA, vA);
      const calls: Array<{ url: string; redirect?: string }> = [];
      const f = (async (url: any, init: any) => { calls.push({ url: String(url), redirect: init?.redirect }); return new Response(JSON.stringify({ _id: "SBX-1", trackingNumber: "5551" }), { status: 200 }); }) as unknown as typeof fetch;
      expect(await createBostaShipment(id, undefined, f)).toMatchObject({ success: true, shipmentId: "SBX-1" });
      expect(calls).toEqual([{ url: `${SANDBOX}/deliveries`, redirect: "error" }]);
    } finally { for (const [k, v] of Object.entries(env)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
  });

  it("المخزون مايتأثرش بأي خطوة حسم", async () => {
    const stock = async () => (await q("SELECT currentStock FROM product_variants WHERE id = ?", [vA]))[0].currentStock;
    const before = await stock();
    const id = await order(A, pA, vA, "printed");
    await q("UPDATE orders SET bostaStatus = 'uncertain' WHERE id = ?", [id]);
    await linkUncertainShipment({ orderId: id, allowedBusinessIds: scopeA(), shipmentId: "SHIP-STOCK-1", evidence: "مراجعة لوحة بوسطة 2026-10-19", actor: owner1 });
    expect(await stock()).toBe(before);
    expect((await q("SELECT COUNT(*) n FROM inventory_movements WHERE orderId = ?", [id]))[0].n).toBe(0);
  });
});
