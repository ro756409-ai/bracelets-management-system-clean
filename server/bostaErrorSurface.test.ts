import { describe, it, expect } from "vitest";
import fs from "fs";
import { describeFetchError } from "./bosta.service";

/**
 * بوسطة كانت بترجّع «fetch failed» / رسالة uncertain عامة، ومفيش طريقة نحكم هل المشكلة
 * توكن ولا payload ولا شبكة. الاختبارات دي بتقفل إن السبب الحقيقي بيتطلّع:
 *   • أخطاء الشبكة: الكود اللي جوه err.cause (ENOTFOUND/ECONNREFUSED/timeout) بيظهر.
 *   • ردود HTTP: كود الحالة + رسالة بوسطة بيظهروا.
 * ومن غير ما نكسر أمان الحالة: مفيش retry تلقائي، ومفيش تحويل لـshipped إلا بشحنة مؤكدة.
 */

describe("🔑 describeFetchError بيطلّع السبب الحقيقي مش «fetch failed» بس", () => {
  it("🔑 بيضم كود الـcause (زي ENOTFOUND) للرسالة", () => {
    const err = new TypeError("fetch failed");
    (err as any).cause = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND app.bosta.co" };
    const out = describeFetchError(err);
    expect(out).toContain("fetch failed");
    expect(out).toContain("ENOTFOUND");
    expect(out).toContain("getaddrinfo ENOTFOUND app.bosta.co");
  });

  it("🔑 رفض الاتصال بيبان صريح", () => {
    const err = new TypeError("fetch failed");
    (err as any).cause = { code: "ECONNREFUSED" };
    expect(describeFetchError(err)).toContain("ECONNREFUSED");
  });

  it("timeout بيبان", () => {
    const err = new Error("The operation was aborted");
    (err as any).cause = { code: "UND_ERR_HEADERS_TIMEOUT" };
    expect(describeFetchError(err)).toContain("UND_ERR_HEADERS_TIMEOUT");
  });

  it("خطأ عادي من غير cause بيرجّع رسالته", () => {
    expect(describeFetchError(new Error("boom"))).toBe("boom");
  });

  it("قيمة مش Error مابتكسرش", () => {
    expect(describeFetchError("weird")).toBe("weird");
  });

  it("مابيكرّرش الرسالة لو الـcause بنفس النص", () => {
    const err = new Error("same");
    (err as any).cause = { message: "same" };
    expect(describeFetchError(err)).toBe("same");
  });
});

describe("🔑 مسار إرسال بوسطة بيسجّل ويرجّع السبب الحقيقي", () => {
  const svc = fs.readFileSync("server/bosta.service.ts", "utf-8");
  const code = svc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  const sendFn = code.slice(
    code.indexOf("const response = await fetch(`${BOSTA_BASE_URL}/deliveries`"),
    code.indexOf("export function isBostaEnabled")
  );

  it("🔑 catch بيرجّع التفاصيل مش UNCERTAIN_MESSAGE لوحدها", () => {
    // كان بيرجّع UNCERTAIN_MESSAGE عامة؛ دلوقتي بيلحق بيها السبب الحقيقي.
    expect(sendFn).toContain("describeFetchError(err)");
    expect(sendFn).toContain("error: `${UNCERTAIN_MESSAGE} — ${detail}`");
  });

  it("🔑 catch بيسجّل الـURL والسبب في اللوج", () => {
    expect(sendFn).toContain('console.error("[Bosta] Network/exception (uncertain):"');
    expect(sendFn).toContain("url: `${BOSTA_BASE_URL}/deliveries`");
  });

  it("🔑 رد HTTP المرفوض بيطلّع كود الحالة + رسالة بوسطة", () => {
    expect(sendFn).toContain("`HTTP ${response.status} — ${String(bodyMsg)}`");
  });

  it("🔑 أمان الحالة محفوظ: catch = uncertain، مفيش retry تلقائي ولا shipped", () => {
    // الشبكة ممكن تكون وصلت بوسطة فعلاً → uncertain بيمنع شحنة تانية. مفيش أي setTimeout/
    // إعادة نداء fetch جوه المسار، ومفيش تحويل الحالة لـshipped من غير رد مؤكد.
    expect(sendFn).toContain("bostaStatus: BOSTA_UNCERTAIN");
    expect(sendFn).not.toContain("setTimeout");
    // التحويل لـsent بيحصل بس في فرع النجاح اللي فيه responseBody._id (فوق الـcatch)
    const catchBlock = sendFn.slice(sendFn.indexOf("} catch"));
    expect(catchBlock).not.toContain('bostaStatus: "sent"');
    expect(catchBlock).not.toContain('bostaStatus: "shipped"');
  });
});
