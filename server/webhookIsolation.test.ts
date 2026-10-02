import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * عزل الـwebhooks — الـbusinessId لازم يتشتق من بيانات موثّقة على السيرفر، **مش** من
 * الـpayload.
 *
 * الـwebhook بيدخل من غير جلسة ولا tenant context، فالخطر إنه يكتب في شركة غلط. القاعدة:
 * هوية الشركة تتحدد من سر مُتحقّق (EasyOrder) أو من الشحنة اللي السيرفر أنشأها (Bosta)،
 * ومحدش يبعت `businessId` في الـpayload ويتصدّق.
 *
 * دول حراس على الكود لأن التشغيل الحقيقي محتاج HTTP + DB؛ بيثبتوا إن مصدر الـbusinessId
 * هو الحاجة الموثّقة مش المدخل الخام.
 */

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
}

// ==================== EasyOrder ====================

describe("🔑 EasyOrder webhook — الشركة من السر مش من الـpayload", () => {
  const code = codeOnly(fs.readFileSync("server/easyorderWebhook.ts", "utf-8"));

  it("🔑 القناة بتتحل من السر، والـbusinessId بيتاخد منها", () => {
    expect(code).toContain("getSalesChannelByWebhookSecret(receivedSecret)");
    expect(code).toContain("channel.businessId");
  });

  it("🔑 مفيش businessId بيتقرا من الـbody/payload", () => {
    // كل استخدام لـbusinessId لازم يكون من channel — مش من body ولا payload ولا input.
    expect(code).not.toMatch(/businessId\s*[:=]\s*(body|payload|req\.body)/);
    expect(code).not.toContain("payload.businessId");
    expect(code).not.toContain("body.businessId");
  });

  it("🔑 السر غير المعروف بيترفض بـ401 قبل أي كتابة", () => {
    // من غير قناة متحلّة، الـhandler بيرجع 401 — مفيش channel = مفيش businessId = مفيش كتابة.
    expect(code).toContain("A configured channel secret is required");
    // الرفض بيجي قبل تفريع أنواع الأحداث الفعلي (`if (body?.event_type ===`).
    const guard = code.slice(0, code.indexOf("if (body?.event_type"));
    expect(guard).toContain('res.status(401)');
  });

  it("🔑 البحث عن أوردر موجود مقصور على شركة القناة", () => {
    // getOrderByExternalId(order_id, channel.businessId) — مش بالـorder_id لوحده.
    expect(code).toContain("getOrderByExternalId(payload.order_id, channel.businessId)");
  });

  it("🔑 وفيه idempotency على الحدث — مفيش تكرار", () => {
    // recordIntegrationOrderEvent بيمر على business_events اللي فيه UNIQUE(businessId, key).
    expect(code).toContain("recordIntegrationOrderEvent");
    expect(code).toContain("providerEventId");
  });
});

// ==================== Bosta ====================

describe("🔑 Bosta webhook — الشركة من الشحنة مش من الـpayload", () => {
  const code = codeOnly(fs.readFileSync("server/bostaWebhook.ts", "utf-8"));

  it("🔑 السر بيتقارن constant-time، والغياب بيرفض", () => {
    // السر بيتحوّل لـhash وبيتدوّر عليه في جدول حسابات الشحن (النشاط من السر)، والسر
    // العام (فترة الانتقال) بيتقارن constant-time.
    expect(code).toContain("findAccountByWebhookSecret(receivedSecret)");
    expect(code).toContain("safeCompare(receivedSecret, envSecret)");
    expect(code).toContain("timingSafeEqual");
    // من غير سر مضبوط في البيئة — رفض، مش تمرير.
    // غياب الهيدر = 401 فورًا؛ ومفيش مسار بيقبل طلبًا بلا سر معروف.
    expect(code).toContain('if (typeof receivedSecret !== "string" || !receivedSecret)');
    expect(code).toContain('res.status(401)');
  });

  it("🔑 الأوردر بيتلاقى بالـshipmentId/trackingNumber، والـbusinessId من الأوردر", () => {
    // order.businessId — مش من الـpayload. الشحنة هي رابط الملكية، والسيرفر هو اللي
    // أنشأها وقت الإرسال.
    // النشاط اتحدد من السر **قبل** أي قراءة أوردر، والأوردر بيتقرا بشرط النشاط.
    expect(code).toContain("where(and(eq(orders.businessId, businessId), byShipment))");
    expect(code).not.toContain("payload.businessId");
    expect(code).not.toContain("body.businessId");
    // داخل المعالج: السر أولًا، ثم التطبيق داخل النشاط المحدد.
    const handler = code.slice(code.indexOf("export async function handleBostaWebhook"));
    expect(handler.indexOf("findAccountByWebhookSecret(receivedSecret)")).toBeLessThan(handler.indexOf("processAndMark(businessId"));
  });

  it("🔑 الشحنة غير المطابقة = unmatched — مفيش تخمين ولا أوردر بيتلمس", () => {
    const apply = code.slice(code.indexOf("export async function applyBostaEvent"), code.indexOf("async function processAndMark"));
    // التحديث بيحصل بعد ما order يتلاقى — مش قبل.
    const update = apply.indexOf(".update(orders)");
    const notFound = apply.indexOf('if (!order) return { status: "unmatched"');
    expect(notFound).toBeGreaterThan(-1);
    expect(notFound).toBeLessThan(update);
    // والتحديث نفسه مقيّد بالنشاط.
    expect(apply).toContain("where(and(eq(orders.id, order.id), eq(orders.businessId, businessId)))");
  });

  it("🔒 اللوج: ولا سطر بيطبع الـpayload أو السر", () => {
    const logs = code.split("\n").filter(l => /console\.(log|warn|error)/.test(l));
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) {
      expect(l).not.toMatch(/payload\b(?!\s+rejected)/);
      expect(l).not.toContain("receivedSecret");
      expect(l).not.toContain("envSecret");
      expect(l).not.toContain("req.body");
      expect(l).not.toContain("req.headers");
    }
  });

  it("🔒 Migration 0039: جدول جديد فقط — بلا ALTER/DROP ولا لمس لجدول موجود", () => {
    const stmts = fs.readFileSync("drizzle/0039_carrier_webhook_inbox.sql", "utf-8")
      .split("\n").filter(l => !l.trim().startsWith("--")).join("\n")
      .split(";").map(x => x.trim()).filter(Boolean);
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toMatch(/^CREATE TABLE `carrier_webhook_inbox`/);
    expect(stmts[1]).toMatch(/^CREATE INDEX `cwi_business_status_idx` ON `carrier_webhook_inbox`/);
    expect(stmts[2]).toMatch(/^CREATE INDEX `cwi_shipment_idx` ON `carrier_webhook_inbox`/);
    expect(stmts.join("\n")).not.toMatch(/\b(ALTER|DROP|UPDATE|DELETE|INSERT|FOREIGN KEY)\b/i);
    expect(stmts[0]).toContain("UNIQUE(`businessId`,`provider`,`eventKey`)");
  });

  it("🔒 استقبال الحالات فقط: الـwebhook مابينادَش مسار المحاسبة V2 ولا بيلمس المخزون", () => {
    expect(code).not.toContain("processProviderWebhook(");
    expect(code).not.toContain("inventoryMovements");
    expect(code).not.toContain("currentStock");
  });

  it("🔑 وفيه idempotency على الحدث في مسار V2", () => {
    const v2 = codeOnly(fs.readFileSync("server/providerWebhookV2.service.ts", "utf-8"));
    // dedup بالـpayloadHash — الإعادة الحرفية بتترفض.
    expect(v2).toContain("payloadHash");
    expect(v2).toContain("duplicate: true");
    // والـbusinessId من الشحنة المطابقة مش من الـinput.
    expect(v2).toContain("match.businessId");
    expect(v2).not.toContain("input.businessId");
  });
});
