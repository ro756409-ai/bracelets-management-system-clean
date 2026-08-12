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
    expect(code).toContain("safeCompare(receivedSecret, expectedSecret)");
    expect(code).toContain("timingSafeEqual");
    // من غير سر مضبوط في البيئة — رفض، مش تمرير.
    expect(code).toContain('if (!expectedSecret)');
    expect(code).toContain('res.status(401)');
  });

  it("🔑 الأوردر بيتلاقى بالـshipmentId/trackingNumber، والـbusinessId من الأوردر", () => {
    // order.businessId — مش من الـpayload. الشحنة هي رابط الملكية، والسيرفر هو اللي
    // أنشأها وقت الإرسال.
    expect(code).toContain("order.businessId");
    expect(code).not.toContain("payload.businessId");
    expect(code).not.toContain("body.businessId");
  });

  it("🔑 الأوردر غير الموجود بيترفض — مفيش تخمين", () => {
    expect(code).toContain("Order not found, ignored");
    // التحديث بيحصل بعد ما order يتلاقى — مش قبل.
    const update = code.indexOf(".update(orders)");
    const notFound = code.indexOf("if (!order)");
    expect(notFound).toBeGreaterThan(-1);
    expect(notFound).toBeLessThan(update);
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
