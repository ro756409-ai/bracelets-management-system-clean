import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * نموذج «إضافة أوردر» في /orders (orders.create) — 0052: نفس عقد شاشة الإدخال وإرسال الورشة. السلوك نفسه (حفظ المعرّف عبر
 * إعادة المحاولة وإعادة التحميل، CONFLICT بلا تغيير تلقائي، النطاق لكل تبويب) مختبر في operationId.test وFacebookEntry.render.test،
 * وعلى الخادم في operationIdempotency.db.test، وبمتصفح حقيقي محليًا؛ هنا الربط.
 */
const page = fs.readFileSync("client/src/pages/Orders.tsx", "utf-8");
const dialog = page.slice(page.indexOf("function CreateOrderDialog("));

describe("🔁 /orders — إضافة أوردر بمعرّف عملية", () => {
  it("المعرّف محفوظ بنطاق نوع العملية + الشاشة + هوية الجلسة + النشاط المختار، ويُرسل مع كل محاولة", () => {
    expect(dialog).toContain("const opScope = `order.create|orders-page|${sessionFingerprint()}|b${form.businessId || \"none\"}`;");
    expect(dialog).toContain("operationId: persistentOperationIdFor(opScope),");
  });
  it("CONFLICT لا يغيّر المعرّف (تنبيه فقط)؛ بدء عملية جديدة بزر صريح فقط", () => {
    expect(dialog).toContain('onError: (e) => { if (e.data?.code === "CONFLICT") setOpConflict(e.message); toast.error(e.message); },');
    expect(dialog).toContain("const startNewOperation = () => { discardOperation(opScope); setOpConflict(null); };");
    expect(dialog.match(/discardOperation\(/g)?.length).toBe(1);
    expect(dialog).toContain('data-testid="create-order-new"');
  });
  it("الإعادة تُعرض بوضوح", () => {
    expect(dialog).toContain("الأوردر محفوظ بالفعل — رقم");
  });
});

describe("🔁 /orders — تكرار أوردر بمعرّف عملية", () => {
  it("المعرّف محفوظ بنطاق نوع العملية + هوية الجلسة + الأوردر الأصلي، ويُرسل مع الطلب", () => {
    expect(page).toContain("const duplicateScope = (orderId: number) => `order.duplicate|${sessionFingerprint()}|o${orderId}`;");
    expect(page).toContain("duplicateOrderMutation.mutate({ orderId: pendingConfirm.orderId, operationId: persistentOperationIdFor(duplicateScope(pendingConfirm.orderId)) });");
  });
  it("CONFLICT لا يغيّر المعرّف تلقائيًا — بدء عملية جديدة بزر صريح داخل الرسالة؛ والإعادة تُعرض بوضوح", () => {
    expect(page).toContain('toast.error(e.message, { action: { label: "بدء عملية جديدة", onClick: () => discardOperation(duplicateScope(vars.orderId)) } });');
    expect(page).toContain("التكرار محفوظ بالفعل — أوردر #");
  });
});
