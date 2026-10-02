import { describe, it, expect } from "vitest";
import fs from "fs";
import { BOSTA_STATES, normalizeBostaEvent, bostaEventKey, canAdvanceOrderStatus, type NormalizedBostaEvent } from "./bostaEvents";

/**
 * تطبيع أحداث Bosta — المصدر: التوثيق الرسمي «Get Shipment Status via Webhook».
 * الحالة رقم مباشر (`state: 45`) والوقت رقم ms (`timeStamp`) — مش `state: { code }`.
 */

/** payload على شكل مثال التوثيق الرسمي. */
const docPayload = (over: Record<string, unknown> = {}) => ({
  _id: "CvTkOcyGhw",
  trackingNumber: 48089608,
  state: 41,
  type: "SEND",
  cod: 50,
  timeStamp: 1689252908261,
  isConfirmedDelivery: false,
  deliveryPromiseDate: "2023-07-15",
  exceptionReason: null,
  exceptionCode: null,
  businessReference: "ORD-1001",
  numberOfAttempts: 1,
  ...over,
});
const ev = (over: Record<string, unknown> = {}): NormalizedBostaEvent => {
  const r = normalizeBostaEvent(docPayload(over));
  if (!r.ok) throw new Error(r.error);
  return r.event;
};

const OFFICIAL_CODES = [10, 11, 20, 21, 22, 23, 24, 25, 30, 40, 41, 45, 46, 47, 48, 49, 60, 100, 101, 102, 103, 104, 105];
const TYPES = ["SEND", "EXCHANGE", "CUSTOMER_RETURN_PICKUP", "RTO", "SIGN_AND_RETURN", "FXF_SEND"];
const FORWARD = ["SEND", "FXF_SEND"];

describe("Bosta — قراءة الـpayload الرسمي", () => {
  it("يقرأ كل حقول التوثيق: state و timeStamp أرقام مباشرة، trackingNumber رقم → نص", () => {
    const e = ev({ exceptionReason: "Customer not answering", exceptionCode: 4, isConfirmedDelivery: true });
    expect(e).toMatchObject({
      shipmentId: "CvTkOcyGhw", trackingNumber: "48089608", state: 41, timeStamp: 1689252908261,
      type: "SEND", typeKnown: true, cod: 50, isConfirmedDelivery: true, numberOfAttempts: 1,
      businessReference: "ORD-1001", exceptionReason: "Customer not answering", exceptionCode: 4,
      stateName: "Picked up", kind: "out_for_delivery", orderStatus: "shipped",
    });
    expect(e.eventId).toBe("CvTkOcyGhw:41:1689252908261");
    expect(e.eventKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("الحقول الاختيارية الغائبة = null بلا رفض", () => {
    const r = normalizeBostaEvent({ _id: "abc", state: 24, type: "SEND" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event).toMatchObject({ trackingNumber: null, timeStamp: null, cod: null, isConfirmedDelivery: null, numberOfAttempts: null, businessReference: null, exceptionReason: null, exceptionCode: null });
  });

  it("payload غير صالح بيترفض بسبب واضح", () => {
    for (const bad of [null, undefined, "x", 5, [], [docPayload()]]) expect(normalizeBostaEvent(bad).ok).toBe(false);
    const noId = normalizeBostaEvent({ state: 45, type: "SEND" });
    expect(noId).toMatchObject({ ok: false }); expect((noId as any).error).toContain("_id");
    for (const state of [undefined, null, "Delivered", {}, { value: "Delivered" }, NaN]) {
      const r = normalizeBostaEvent({ _id: "abc", state });
      expect(r.ok).toBe(false); expect((r as any).error).toContain("state");
    }
  });

  it("قيم خارج حدود التخزين: معرّف أطول من 100 أو state خارج المدى = رفض؛ وقت خارج المدى = بلا وقت؛ السبب بيتقص", () => {
    for (const bad of [{ _id: "x".repeat(101), state: 45 }, { trackingNumber: "9".repeat(101), state: 45 }, { _id: "abc", state: 1e15 }, { _id: "abc", state: -1e15 }]) {
      const r = normalizeBostaEvent(bad);
      expect(r.ok).toBe(false); expect((r as any).error).toContain("payload غير صالح");
    }
    expect(normalizeBostaEvent({ _id: "x".repeat(100), state: 45 }).ok).toBe(true);
    expect(ev({ timeStamp: 1e300 }).timeStamp).toBeNull();
    expect(ev({ timeStamp: -5 }).timeStamp).toBeNull();
    expect(ev({ state: 47, exceptionReason: "س".repeat(5000) }).exceptionReason).toHaveLength(300);
    // نوع طويل/غريب: مش إرسال، والحدث لسه صالح
    expect(ev({ state: 45, type: "T".repeat(500) })).toMatchObject({ typeKnown: false, orderStatus: null });
  });

  it("توافق خلفي آمن: state.code / status_code بيتقروا بنفس الخريطة الرسمية — مش الخريطة القديمة الغلط", () => {
    const nested = normalizeBostaEvent({ _id: "abc", type: "SEND", state: { code: 45, value: "Delivered" }, updatedAt: "2026-09-21T10:00:00Z" });
    expect(nested.ok && nested.event).toMatchObject({ state: 45, orderStatus: "delivered", timeStamp: Date.parse("2026-09-21T10:00:00Z") });
    // الكود 30 في الخريطة القديمة كان «تم التسليم» — رسميًا هو «بين الفروع».
    const thirty = normalizeBostaEvent({ _id: "abc", type: "SEND", state: { code: 30 } });
    expect(thirty.ok && thirty.event).toMatchObject({ state: 30, kind: "in_transit", orderStatus: "shipped" });
    const flat = normalizeBostaEvent({ _id: "abc", type: "SEND", status_code: "46" });
    expect(flat.ok && flat.event.orderStatus).toBe("returned");
    // وقت بالثواني (10 أرقام) → ms
    expect(ev({ timeStamp: 1689252908 }).timeStamp).toBe(1689252908000);
  });

  it("type بيتوحّد لحروف كبيرة، والنوع غير المعروف مايتعاملش كإرسال", () => {
    expect(ev({ type: "send", state: 45 }).orderStatus).toBe("delivered");
    const odd = ev({ type: "SOMETHING_NEW", state: 45 });
    expect(odd).toMatchObject({ typeKnown: false, kind: "informational", orderStatus: null });
    expect(ev({ type: undefined, state: 45 }).orderStatus).toBeNull();
  });
});

describe("Bosta — خريطة الحالات الرسمية (كل كود × كل نوع)", () => {
  it("جدول الحالات = أكواد التوثيق بالظبط، وكل نص ≤ 50 حرفًا (عمود orders.bostaStatus)", () => {
    expect(Object.keys(BOSTA_STATES).map(Number).sort((a, b) => a - b)).toEqual(OFFICIAL_CODES);
    for (const code of OFFICIAL_CODES) {
      expect(BOSTA_STATES[code].name.length).toBeGreaterThan(0);
      expect(BOSTA_STATES[code].label.length).toBeLessThanOrEqual(50);
    }
  });

  const expected = (code: number, type: string): Partial<NormalizedBostaEvent> => {
    const fwd = FORWARD.includes(type);
    const base = { orderStatus: null, flagsReview: false, storeOnly: false };
    switch (code) {
      case 10: case 11: case 20: return { ...base, kind: "awaiting_pickup" };
      case 21: return { ...base, kind: "picked_up", orderStatus: fwd ? "shipped" : null };
      case 24: case 30: return { ...base, kind: "in_transit", orderStatus: fwd ? "shipped" : null };
      case 41: return fwd ? { ...base, kind: "out_for_delivery", orderStatus: "shipped" } : { ...base, kind: "out_for_return" };
      case 45: return fwd ? { ...base, kind: "delivered", orderStatus: "delivered" } : { ...base, kind: "informational" };
      case 46: case 60: return { ...base, kind: "returned", orderStatus: "returned" };
      case 47: return { ...base, kind: "exception" };
      case 48: return { ...base, kind: "terminated", flagsReview: true };
      case 49: return { ...base, kind: "canceled", flagsReview: true };
      case 100: return { ...base, kind: "lost", flagsReview: true };
      case 101: return { ...base, kind: "damaged", flagsReview: true };
      case 102: case 103: case 104: case 105: return { ...base, kind: "needs_attention", storeOnly: true };
      default: return { ...base, kind: "informational" }; // 22/23/25/40
    }
  };
  for (const code of OFFICIAL_CODES) {
    for (const type of TYPES) {
      it(`كود ${code} (${BOSTA_STATES[code].name}) × ${type}`, () => {
        const e = ev({ state: code, type });
        expect(e).toMatchObject(expected(code, type));
        expect(e.stateName).toBe(BOSTA_STATES[code].name);
        expect(e.label.length).toBeLessThanOrEqual(50);
      });
    }
  }

  it("🔑 delivered = الكود 45 مع نوع إرسال فقط — ولا أي تركيبة تانية", () => {
    const delivered: string[] = [];
    for (const code of [...OFFICIAL_CODES, 0, 1, 31, 42, 50, 99, 106, 999])
      for (const type of [...TYPES, "UNKNOWN_TYPE"])
        if (ev({ state: code, type }).orderStatus === "delivered") delivered.push(`${code}:${type}`);
    expect(delivered).toEqual(["45:SEND", "45:FXF_SEND"]);
  });

  it("isConfirmedDelivery: الحالة 45 هي مصدر التسليم؛ false صريحة بتتوضّح في النص بلا تغيير للحالة", () => {
    expect(ev({ state: 45, isConfirmedDelivery: true })).toMatchObject({ orderStatus: "delivered", label: "تم التسليم", isConfirmedDelivery: true });
    expect(ev({ state: 45, isConfirmedDelivery: undefined })).toMatchObject({ orderStatus: "delivered", label: "تم التسليم", isConfirmedDelivery: null });
    expect(ev({ state: 45, isConfirmedDelivery: false })).toMatchObject({ orderStatus: "delivered", label: "تم التسليم بدون تأكيد استلام", isConfirmedDelivery: false });
    // العلامة لوحدها مابتعملش تسليم
    expect(ev({ state: 41, isConfirmedDelivery: true }).orderStatus).toBe("shipped");
    expect(ev({ state: 47, isConfirmedDelivery: true }).orderStatus).toBeNull();
  });

  it("41 بيعتمد على النوع: إرسال = خرجت للتسليم، غيره = خرجت للإرجاع (بلا أثر على حالة الأوردر)", () => {
    expect(ev({ state: 41, type: "SEND" })).toMatchObject({ kind: "out_for_delivery", label: "خرجت للتسليم", orderStatus: "shipped" });
    for (const type of ["RTO", "CUSTOMER_RETURN_PICKUP", "EXCHANGE", "SIGN_AND_RETURN"])
      expect(ev({ state: 41, type })).toMatchObject({ kind: "out_for_return", label: "خرجت للإرجاع للنشاط", orderStatus: null });
  });

  it("الكود غير الموثّق = unknown: يتحفظ للمراجعة بلا تخمين ولا أثر", () => {
    for (const code of [0, 1, 12, 31, 42, 50, 61, 99, 106, 200, 999, -1]) {
      expect(ev({ state: code })).toMatchObject({ kind: "unknown", stateName: "Unknown", orderStatus: null, flagsReview: false, storeOnly: true });
      expect(ev({ state: code }).label).toContain(String(code));
    }
  });
});

describe("Bosta — مفتاح الـidempotency", () => {
  it("ثابت لنفس (shipment + state + timeStamp) ومستقل عن وقت الاستقبال وباقي الحقول", () => {
    const a = ev({ state: 45 });
    const b = ev({ state: 45, cod: 999, numberOfAttempts: 3, businessReference: "غيره", trackingNumber: 111 });
    expect(a.eventKey).toBe(b.eventKey);
    expect(a.eventKey).toBe(bostaEventKey({ shipmentId: "CvTkOcyGhw", trackingNumber: null, state: 45, timeStamp: 1689252908261 }));
  });
  it("بيتغيّر بتغيّر الشحنة أو الحالة أو الوقت", () => {
    const base = ev({ state: 45 }).eventKey;
    expect(ev({ state: 46 }).eventKey).not.toBe(base);
    expect(ev({ state: 45, timeStamp: 1689252908262 }).eventKey).not.toBe(base);
    expect(ev({ state: 45, _id: "other" }).eventKey).not.toBe(base);
  });
  it("بلا _id: المفتاح على trackingNumber؛ وبلا timeStamp: مفتاح ثابت (مش وقت الاستقبال)", () => {
    const t1 = normalizeBostaEvent({ trackingNumber: 123, state: 45, type: "SEND" });
    const t2 = normalizeBostaEvent({ trackingNumber: "123", state: 45, type: "SEND" });
    const t3 = normalizeBostaEvent({ trackingNumber: 124, state: 45, type: "SEND" });
    expect(t1.ok && t2.ok && t3.ok).toBe(true);
    if (!t1.ok || !t2.ok || !t3.ok) return;
    expect(t1.event.eventKey).toBe(t2.event.eventKey);
    expect(t1.event.eventKey).not.toBe(t3.event.eventKey);
  });
  it("المصدر مابيستخدمش وقت الاستقبال في المفتاح", () => {
    const src = fs.readFileSync("server/bostaEvents.ts", "utf-8");
    expect(src).not.toContain("Date.now()");
    expect(src).not.toContain("new Date()");
  });
});

describe("Bosta — ترتيب تقدّم حالة الأوردر", () => {
  it("للأمام مسموح، وللخلف ممنوع", () => {
    for (const cur of ["new", "confirmed", "preparing", "printed", "postponed", "no_answer"]) {
      expect(canAdvanceOrderStatus(cur, "shipped")).toBe(true);
      expect(canAdvanceOrderStatus(cur, "delivered")).toBe(true);
      expect(canAdvanceOrderStatus(cur, "returned")).toBe(true);
    }
    expect(canAdvanceOrderStatus("shipped", "delivered")).toBe(true);
    expect(canAdvanceOrderStatus("shipped", "returned")).toBe(true);
    expect(canAdvanceOrderStatus("delivered", "returned")).toBe(true); // مرتجع بعد تسليم
    expect(canAdvanceOrderStatus("shipped", "shipped")).toBe(false);
    expect(canAdvanceOrderStatus("delivered", "shipped")).toBe(false);
    expect(canAdvanceOrderStatus("delivered", "delivered")).toBe(false);
    expect(canAdvanceOrderStatus("returned", "shipped")).toBe(false);
    expect(canAdvanceOrderStatus("returned", "delivered")).toBe(false);
  });
  it("الأوردر الملغي داخليًا مابيتغيّرش من الـwebhook", () => {
    for (const next of ["shipped", "delivered", "returned"] as const) expect(canAdvanceOrderStatus("cancelled", next)).toBe(false);
  });
});
