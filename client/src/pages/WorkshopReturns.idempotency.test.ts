import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * إرسال الورشة (0052): نفس عقد شاشة الإدخال المختبَر بالعرض — معرّف عملية محفوظ على الجهاز حتى النجاح (يُستهلك بمستمع
 * MutationCache في main.tsx)، ورفض CONFLICT يبدأ عملية جديدة. السلوك نفسه مختبر في operationId.test وFacebookEntry.render.test؛
 * هنا الربط (Radix Select في نموذج الورشة لا يُفتح في jsdom).
 */
const page = fs.readFileSync("client/src/pages/WorkshopReturns.tsx", "utf-8");
const main = fs.readFileSync("client/src/main.tsx", "utf-8");

describe("🔁 إرسال الورشة — معرّف العملية", () => {
  it("المعرّف محفوظ بنطاق النشاط ويُرسل مع كل محاولة", () => {
    expect(page).toContain("const sendScope = `workshop-send:${bid ?? \"none\"}`;");
    expect(page).toContain("operationId: persistentOperationIdFor(sendScope),");
  });
  it("CONFLICT فقط يبدأ عملية جديدة؛ خطأ الشبكة يُبقي المعرّف", () => {
    expect(page).toContain('onError: e => { if (e.data?.code === "CONFLICT") discardOperation(sendScope); toast.error(e.message); },');
  });
  it("النجاح يستهلك المعرّف (مستمع MutationCache)، ورسالة الإعادة واضحة", () => {
    expect(main).toContain("completeOperation((event.mutation.state.variables as { operationId?: unknown } | undefined)?.operationId);");
    expect(page).toContain("الإرسال محفوظ بالفعل — إذن");
  });
});
