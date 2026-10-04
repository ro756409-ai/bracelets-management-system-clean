import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { randomBytes } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb, createEmployee, insertOrderWithItems, createProductWithVariants, setDefaultPackageImageUrl, getDefaultPackageImageUrl } from "./db";
import { businessCarrierAccounts, businessConfigurationValues, employees, orders, orderItems, products, productVariants } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { connectCarrierAccount, probeBostaKey, BOSTA_ENDPOINT_MISSING_MESSAGE, BOSTA_LIVE_BASE_URL, __resetBostaEndpointWarningForTests } from "./carrierAccounts.service";
import { createBostaShipment, fetchBostaAwb, isBostaEnabledForBusiness } from "./bosta.service";
import { registerPackageImageRoutes, STORAGE_NOT_CONFIGURED_MESSAGE } from "./packageImageUpload";
import { __resetObjectStorageClientForTests } from "./objectStorage";
import { PACKAGE_IMAGE_URL_PREFIX } from "../shared/packageImages";

/**
 * حراس البيئات المنشورة (DB حقيقية، بلا شبكة):
 *   1) صور شحن بوسطة: التخزين الدائم إلزامي خارج development/test (503، لا ملف محلي، لا مرجع).
 *   2) نداءات بوسطة (اختبار المفتاح، إنشاء الشحنة، AWB): عنوان البيئة فقط — Staging لا تنادي Live أبدًا.
 * بتتسجّل من آخر `carrierAccounts.db.test.ts` (RENAME مؤقت للجدول هناك → تتابع لا توازٍ).
 */
export function registerBostaEnvironmentDbSuite(CAN: boolean) {
  describe.runIf(CAN)("🌍 بيئات النشر — تخزين الصور وعنوان بوسطة (فشل مغلق)", () => {
    let A: CoreTestFixture;
    const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const ids = { orderIds: [] as number[], productIds: [] as number[], empIds: [] as number[] };
    let prodA = 0, varA = 0, adminA = 0, seq = 0;
    const KEY_A = `env-A-${tag}`;
    const STG = "https://stg-app.bosta.co/api/v2";
    const LIVE_HOST = new URL(BOSTA_LIVE_BASE_URL).hostname;
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mj-pkg-env-"));
    const ENV_KEYS = ["PACKAGE_IMAGE_LOCAL_DIR", "CARRIER_SECRETS_KEY", "BOSTA_API_KEY", "BOSTA_WEBHOOK_SECRET", "BOSTA_WEBHOOK_URL", "BOSTA_BASE_URL", "DEPLOY_ENV",
      "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_ENDPOINT", "S3_REGION", "S3_FORCE_PATH_STYLE"] as const;
    let savedEnv: Record<string, string | undefined> = {};
    const setEnv = (o: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(o)) { if (v == null) delete process.env[k]; else process.env[k] = v; } __resetObjectStorageClientForTests(); __resetBostaEndpointWarningForTests(); };
    const resetCase = () => setEnv({ BOSTA_BASE_URL: undefined, DEPLOY_ENV: undefined, S3_BUCKET: undefined, S3_ACCESS_KEY_ID: undefined, S3_SECRET_ACCESS_KEY: undefined, S3_ENDPOINT: undefined });

    // خادم S3 وهمي داخل العملية (PUT/GET/HEAD path-style) — يسجّل المفاتيح ويمكن إفشاله.
    const bucket = new Map<string, { body: Buffer; type: string }>();
    const putKeys: string[] = [];
    let failPut = false;
    let s3: http.Server; let s3Port = 0;
    const s3Env = () => ({ S3_BUCKET: "env-bucket", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", S3_ENDPOINT: `http://127.0.0.1:${s3Port}`, S3_REGION: "us-east-1", S3_FORCE_PATH_STYLE: "true" });

    const db = async () => (await getDb())!;
    const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
    const owner = (tenantId: number) => appRouter.createCaller({
      user: { id: 1, role: "admin", name: "owner" }, employee: null, tenantId,
      req: { protocol: "https", headers: {}, cookies: {} }, res: { clearCookie: () => {}, cookie: () => {} },
    } as any);
    const code = async (fn: () => Promise<any>) => { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } };
    const cookie = () => `employee_token=${jwt.sign({ employeeId: adminA }, process.env.JWT_SECRET as string)}`;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
    const localCount = () => (fs.existsSync(localRoot) ? fs.readdirSync(localRoot).length : 0);
    const app = () => { const a = express(); a.use(cookieParser()); registerPackageImageRoutes(a); return a; };
    const localFiles: string[] = [];

    /** fetch وهمي يسجّل كل العناوين المنادى عليها (أي مضيف) ويرد حسب الدالة. */
    const recorder = (reply: (url: string, init: any) => Response | Error) => {
      const calls: { url: string; host: string; auth: string }[] = [];
      const f = (async (url: any, init: any) => {
        const u = String(url); calls.push({ url: u, host: new URL(u).hostname, auth: String(init?.headers?.Authorization ?? "") });
        const r = reply(u, init); if (r instanceof Error) throw r; return r;
      }) as unknown as typeof fetch;
      return { calls, f };
    };
    const okReply = (url: string) => {
      if (url.includes("/pickup-locations")) return new Response(JSON.stringify({ data: [{ _id: "LOC1", locationName: "المخزن" }] }), { status: 200 });
      if (url.endsWith("/deliveries")) return new Response(JSON.stringify({ _id: `ENV-${tag}-${++seq}`, trackingNumber: `8${tag}${seq}` }), { status: 200 });
      if (url.includes("/awb")) return new Response(Buffer.from("%PDF-1.4"), { status: 200, headers: { "content-type": "application/pdf" } });
      return new Response("{}", { status: 404 });
    };
    const mkOrder = async () => {
      const n = ++seq;
      const id = await insertOrderWithItems({
        orderNumber: `EV${n}-${tag}`.slice(0, 20), businessId: A.businessId, customerName: "عميل بيئة", customerPhone: "01000000001",
        governorate: "القاهرة", customerAddress: "شارع طويل رقم 10", productName: "p", quantity: 1, totalAmount: "750.00", source: "facebook", status: "confirmed",
      } as any, [{ productId: prodA, productName: "p", quantity: 1, variantId: varA, unitPrice: 750 }]);
      ids.orderIds.push(id); return id;
    };
    const setStoredBase = async (url: string) => (await db()).update(businessCarrierAccounts).set({ apiBaseUrl: url }).where(eq(businessCarrierAccounts.businessId, A.businessId));

    beforeAll(async () => {
      savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
      s3 = http.createServer((req, res) => {
        const key = decodeURIComponent((req.url ?? "").split("?")[0]);
        if (req.method === "PUT") {
          const chunks: Buffer[] = []; req.on("data", c => chunks.push(c));
          req.on("end", () => {
            if (failPut) { res.writeHead(500, { "Content-Type": "application/xml" }).end("<Error><Code>InternalError</Code></Error>"); return; }
            bucket.set(key, { body: Buffer.concat(chunks), type: String(req.headers["content-type"] ?? "") }); putKeys.push(key);
            res.writeHead(200, { ETag: '"x"' }).end();
          });
          return;
        }
        const obj = bucket.get(key);
        if (!obj) { res.writeHead(404, { "Content-Type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>"); return; }
        res.writeHead(200, { "Content-Type": obj.type, "Content-Length": obj.body.length });
        if (req.method === "HEAD") return res.end();
        res.end(obj.body);
      });
      await new Promise<void>(r => s3.listen(0, "127.0.0.1", () => r()));
      s3Port = (s3.address() as any).port;

      process.env.CARRIER_SECRETS_KEY = randomBytes(32).toString("base64");
      process.env.PACKAGE_IMAGE_LOCAL_DIR = localRoot; // قرص محلي خاص بهذه العملية (تشغيل متوازٍ)
      delete process.env.BOSTA_API_KEY; delete process.env.BOSTA_WEBHOOK_SECRET; delete process.env.BOSTA_WEBHOOK_URL;
      resetCase();
      A = await createCoreTestFixture("env-a");
      const pa = await createProductWithVariants(A.businessId, { name: `منتج ENV ${tag}` }, [{ name: "سادة", sku: `ENV-${tag}`, currentStock: 50, price: "750" }]);
      prodA = pa.productId; varA = pa.variantIds[0]; ids.productIds.push(prodA);
      adminA = insId(await createEmployee({ name: "admin", role: "super_admin", isActive: true, tenantId: A.tenantId, businessId: null, username: `enva_${tag}` } as any));
      ids.empIds.push(adminA);
      await setDefaultPackageImageUrl(A.businessId, "https://cdn.example.com/brand-env/default.jpg", 1);
      // الربط يتم في بيئة test (عنوان Mock) — fetch محقون.
      const r = await connectCarrierAccount({ tenantId: A.tenantId, businessId: A.businessId, apiKey: KEY_A, pickupLocationId: "LOC1", pickupLocationName: "المخزن", allowOpenPackageDefault: true, actorId: 1, fetchImpl: recorder(okReply).f });
      expect(r.ok).toBe(true);
    });
    afterEach(() => { resetCase(); failPut = false; });
    afterAll(async () => {
      for (const [k, v] of Object.entries(savedEnv)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
      __resetObjectStorageClientForTests(); s3?.close();
      fs.rmSync(localRoot, { recursive: true, force: true });
      const d = await getDb(); if (!d) return;
      await d.delete(businessCarrierAccounts).where(eq(businessCarrierAccounts.businessId, A.businessId));
      await d.delete(businessConfigurationValues).where(eq(businessConfigurationValues.businessId, A.businessId));
      if (ids.orderIds.length) { await d.delete(orderItems).where(inArray(orderItems.orderId, ids.orderIds)); await d.delete(orders).where(inArray(orders.id, ids.orderIds)); }
      if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
      if (ids.productIds.length) { await d.delete(productVariants).where(inArray(productVariants.productId, ids.productIds)); await d.delete(products).where(inArray(products.id, ids.productIds)); }
      await A?.cleanup();
    });

    // ═══ 1) تخزين صور الشحن ═══
    it("🚫 production + S3 ناقص → الرفع 503 برسالة واضحة، صفر ملف محلي، ولا مرجع يُحفظ في DB", async () => {
      setEnv({ DEPLOY_ENV: "production" });
      const before = localCount();
      const dbBefore = await getDefaultPackageImageUrl(A.businessId);
      const up = await request(app()).post("/api/carrier/package-image/upload").set("Cookie", cookie()).attach("file", png, { filename: "x.png", contentType: "image/png" });
      expect(up.status).toBe(503);
      expect(up.body).toEqual({ error: STORAGE_NOT_CONFIGURED_MESSAGE });
      expect(localCount()).toBe(before);
      // محاولة حفظ مرجع لملف «مرفوع» بلا تخزين → مرفوض وDB كما هي
      const ref = `${PACKAGE_IMAGE_URL_PREFIX}t${A.tenantId}-pkg-0f1e2d3c-1111-2222-3333-444455556666.png`;
      expect(await code(() => owner(A.tenantId).carrierAccounts.setDefaultPackageImage({ businessId: A.businessId, imageUrl: ref }))).toBe("BAD_REQUEST");
      expect(await getDefaultPackageImageUrl(A.businessId)).toBe(dbBefore);
      // المسار العام لا يبحث في قرص الحاوية: 503
      expect((await request(app()).get(ref)).status).toBe(503);
    });

    it("✅ development + S3 ناقص → fallback محلي مسموح (لا تغيير في سلوك التطوير)", async () => {
      setEnv({ DEPLOY_ENV: "development" });
      const before = localCount();
      const up = await request(app()).post("/api/carrier/package-image/upload").set("Cookie", cookie()).attach("file", png, { filename: "x.png", contentType: "image/png" });
      expect(up.status).toBe(201);
      localFiles.push(up.body.url.split("/").pop());
      expect(localCount()).toBe(before + 1);
      expect((await request(app()).get(up.body.url)).status).toBe(200);
      // نفس المرجع المحلي في production بلا S3 → 503 (لا بحث صامت في قرص الحاوية)
      setEnv({ DEPLOY_ENV: "production" });
      expect((await request(app()).get(up.body.url)).status).toBe(503);
    });

    it("✅ production + S3 كامل → الرفع إلى Object Storage بمفتاح tenant-scoped، صفر ملف محلي، وReplica ثانية تقرأه؛ المرجع يُحفظ لملف موجود فقط", async () => {
      setEnv({ DEPLOY_ENV: "production", ...s3Env() });
      const before = localCount(); const puts = putKeys.length;
      const up = await request(app()).post("/api/carrier/package-image/upload").set("Cookie", cookie()).attach("file", png, { filename: "x.png", contentType: "image/png" });
      expect(up.status).toBe(201);
      const ref: string = up.body.url; const filename = ref.split("/").pop()!;
      expect(putKeys.slice(puts)).toEqual([`/env-bucket/evidence/${filename}`]);
      expect(filename.startsWith(`t${A.tenantId}-pkg-`)).toBe(true);
      expect(bucket.get(putKeys[puts])!.body.equals(png)).toBe(true);
      expect(localCount()).toBe(before);
      // Replica ثانية: عميل S3 جديد + تطبيق جديد + لا ملف محلي
      __resetObjectStorageClientForTests();
      const got = await request(app()).get(ref);
      expect(got.status).toBe(200); expect(got.headers["content-type"]).toContain("image/png"); expect(Buffer.from(got.body).equals(png)).toBe(true);
      // حفظ المرجع: موجود → يُقبل؛ غير موجود → BAD_REQUEST وDB لا تتغير
      const saved = await owner(A.tenantId).carrierAccounts.setDefaultPackageImage({ businessId: A.businessId, imageUrl: ref });
      expect(saved.ok).toBe(true);
      expect(await getDefaultPackageImageUrl(A.businessId)).toBe(ref);
      const ghost = `${PACKAGE_IMAGE_URL_PREFIX}t${A.tenantId}-pkg-ffffffff-0000-0000-0000-000000000000.png`;
      expect(await code(() => owner(A.tenantId).carrierAccounts.setDefaultPackageImage({ businessId: A.businessId, imageUrl: ghost }))).toBe("BAD_REQUEST");
      expect(await getDefaultPackageImageUrl(A.businessId)).toBe(ref);
      expect((await request(app()).get(ghost)).status).toBe(404); // الملف غير موجود فعليًا → لا 200
      await setDefaultPackageImageUrl(A.businessId, "https://cdn.example.com/brand-env/default.jpg", 1);
    });

    it("🚫 فشل putObject → 500، لا ملف محلي، ولا مرجع في DB", async () => {
      setEnv({ DEPLOY_ENV: "production", ...s3Env() });
      failPut = true;
      const before = localCount(); const puts = putKeys.length;
      const dbBefore = await getDefaultPackageImageUrl(A.businessId);
      const up = await request(app()).post("/api/carrier/package-image/upload").set("Cookie", cookie()).attach("file", png, { filename: "x.png", contentType: "image/png" });
      expect(up.status).toBe(500);
      expect(up.body.url).toBeUndefined();
      expect(JSON.stringify(up.body)).not.toMatch(/env-bucket|127\.0\.0\.1/); // لا تفاصيل تخزين للمستخدم
      expect(localCount()).toBe(before); expect(putKeys.length).toBe(puts);
      expect(await getDefaultPackageImageUrl(A.businessId)).toBe(dbBefore);
    });

    // ═══ 2) نداءات بوسطة — عنوان البيئة فقط ═══
    it("🔒 Staging + BOSTA_BASE_URL: الإنشاء وAWB واختبار المفتاح على Staging فقط — حتى لو الصف المخزّن يشير إلى Live", async () => {
      setEnv({ DEPLOY_ENV: "staging", BOSTA_BASE_URL: STG });
      await setStoredBase(BOSTA_LIVE_BASE_URL); // صف منسوخ من Production
      const { calls, f } = recorder(okReply);
      const oid = await mkOrder();
      const r = await createBostaShipment(oid, { allowToOpenPackage: true }, f);
      expect(r.success).toBe(true);
      const awb = await fetchBostaAwb(A.businessId, [r.shipmentId!], f);
      expect(awb.ok).toBe(true);
      const probe = await probeBostaKey("staging-key-xxxxxxxx", f);
      expect(probe.ok).toBe(true);
      expect(calls.length).toBe(3);
      expect(calls.every(c => c.url.startsWith(STG))).toBe(true);
      expect(calls.some(c => c.host === LIVE_HOST)).toBe(false);
      expect(calls.every(c => !c.auth.includes("staging-key") || c.host !== LIVE_HOST)).toBe(true);
    });

    it("🔒 Staging + BOSTA_BASE_URL يفشل (401/timeout): لا نداء Live، uncertain بعد timeout بلا محاولة ثانية", async () => {
      setEnv({ DEPLOY_ENV: "staging", BOSTA_BASE_URL: STG });
      const oid = await mkOrder();
      const r401 = recorder(url => url.endsWith("/deliveries") ? new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }) : okReply(url));
      const r1 = await createBostaShipment(oid, { allowToOpenPackage: true }, r401.f);
      expect(r1.success).toBe(false); expect(r1.error).toContain("HTTP 401");
      expect(r401.calls.map(c => c.host)).toEqual([new URL(STG).hostname]);
      // timeout على أوردر آخر → uncertain، وإعادة المحاولة مرفوضة بلا أي نداء لأي مضيف
      const oid2 = await mkOrder();
      const rto = recorder(() => Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }));
      expect((await createBostaShipment(oid2, { allowToOpenPackage: true }, rto.f)).success).toBe(false);
      expect(rto.calls).toHaveLength(1); expect(rto.calls[0].host).toBe(new URL(STG).hostname);
      expect((await (await db()).select().from(orders).where(eq(orders.id, oid2)))[0].bostaStatus).toBe("uncertain");
      const again = recorder(okReply);
      expect((await createBostaShipment(oid2, { allowToOpenPackage: true }, again.f)).success).toBe(false);
      expect(again.calls).toHaveLength(0);
    });

    it("🔒 Staging بلا BOSTA_BASE_URL → فشل مغلق قبل الشبكة في كل العمليات (صفر نداء)، والأوردر لا يُمس", async () => {
      setEnv({ DEPLOY_ENV: "staging", BOSTA_BASE_URL: undefined });
      const { calls, f } = recorder(okReply);
      const oid = await mkOrder();
      const r = await createBostaShipment(oid, { allowToOpenPackage: true }, f);
      expect(r).toEqual({ success: false, error: BOSTA_ENDPOINT_MISSING_MESSAGE });
      const row = (await (await db()).select().from(orders).where(eq(orders.id, oid)))[0];
      expect(row.bostaStatus).toBeNull(); expect(row.bostaShipmentId).toBeNull();
      expect(await fetchBostaAwb(A.businessId, ["SHP-1"], f)).toEqual({ ok: false, error: BOSTA_ENDPOINT_MISSING_MESSAGE });
      expect(await probeBostaKey("staging-key-xxxxxxxx", f)).toEqual({ ok: false, error: BOSTA_ENDPOINT_MISSING_MESSAGE });
      expect(await isBostaEnabledForBusiness(A.businessId)).toBe(false);
      expect(calls).toHaveLength(0);
      // ونفس الشيء لـpreview
      setEnv({ DEPLOY_ENV: "preview" });
      expect((await createBostaShipment(oid, { allowToOpenPackage: true }, f)).success).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it("🔒 Production بلا BOSTA_BASE_URL → Live فقط (الصف المخزّن v0 على أصل Live يُحترم؛ مخزّن غير Live → Live v2)", async () => {
      setEnv({ DEPLOY_ENV: "production", BOSTA_BASE_URL: undefined });
      const orig = console.warn; console.warn = () => {};
      try {
        await setStoredBase("https://app.bosta.co/api/v0");
        const r1 = recorder(okReply);
        expect((await createBostaShipment(await mkOrder(), { allowToOpenPackage: true }, r1.f)).success).toBe(true);
        expect(r1.calls.map(c => c.url)).toEqual(["https://app.bosta.co/api/v0/deliveries"]);
        await setStoredBase(STG); // صف يشير إلى Staging على Production → لا يُستخدم
        const r2 = recorder(okReply);
        expect((await createBostaShipment(await mkOrder(), { allowToOpenPackage: true }, r2.f)).success).toBe(true);
        expect(r2.calls.map(c => c.url)).toEqual([`${BOSTA_LIVE_BASE_URL}/deliveries`]);
      } finally { console.warn = orig; }
    });

    it("🔒 Production + BOSTA_BASE_URL مضبوط → هذا العنوان فقط (لا Live الافتراضي)", async () => {
      setEnv({ DEPLOY_ENV: "production", BOSTA_BASE_URL: STG });
      await setStoredBase(BOSTA_LIVE_BASE_URL);
      const { calls, f } = recorder(okReply);
      expect((await createBostaShipment(await mkOrder(), { allowToOpenPackage: true }, f)).success).toBe(true);
      expect(calls.map(c => c.url)).toEqual([`${STG}/deliveries`]);
    });
  });
}
