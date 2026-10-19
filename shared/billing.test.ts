import { describe, it, expect } from "vitest";
import {
  SUBSCRIPTION_PLANS, BEST_VALUE_PLAN, SUBSCRIPTION_GRACE_MS, addCalendarMonths, computeBillingStatus, nextPeriodStart, newPeriodFor, planByCode, planAmountMinor,
} from "./billing";

/** تواريخ بتوقيت القاهرة الصريح (+02:00 شتاء، +03:00 صيف) عشان الاختبار مايعتمدش على منطقة الجهاز. */
const cairo = (iso: string) => new Date(iso);
const P = (s: string, e: string, voided = false) => ({ startsAt: cairo(s), endsAt: cairo(e), voidedAt: voided ? new Date() : null });

describe("خطط الاشتراك", () => {
  it("الأسعار والمدد المعتمدة، ونفس المميزات (لا اختلاف غير المدة والسعر)", () => {
    expect(SUBSCRIPTION_PLANS).toEqual({
      month_1: { code: "month_1", months: 1, amount: 500 },
      month_5: { code: "month_5", months: 5, amount: 1999 },
      month_12: { code: "month_12", months: 12, amount: 3999 },
    });
    expect(BEST_VALUE_PLAN).toBe("month_12");
    expect(planAmountMinor("month_5")).toBe(199900);
    expect(planByCode("month_3")).toBeNull();
  });
});

describe("الأشهر التقويمية (توقيت القاهرة)", () => {
  it("نفس اليوم والساعة بعد شهر/5/12", () => {
    const s = cairo("2026-03-15T10:30:00+02:00");
    expect(addCalendarMonths(s, 1).toISOString()).toBe(cairo("2026-04-15T10:30:00+02:00").toISOString().replace(/T08/, "T08"));
    expect(addCalendarMonths(s, 12).toISOString()).toBe(cairo("2027-03-15T10:30:00+02:00").toISOString());
  });
  it("31 يناير + شهر = آخر فبراير (28 في سنة عادية، 29 في الكبيسة)", () => {
    expect(addCalendarMonths(cairo("2027-01-31T12:00:00+02:00"), 1).toISOString()).toBe(cairo("2027-02-28T12:00:00+02:00").toISOString());
    expect(addCalendarMonths(cairo("2028-01-31T12:00:00+02:00"), 1).toISOString()).toBe(cairo("2028-02-29T12:00:00+02:00").toISOString());
  });
  it("29 فبراير + 12 شهر = 28 فبراير السنة الجاية؛ 31 أغسطس + 1 = 30 سبتمبر", () => {
    expect(addCalendarMonths(cairo("2028-02-29T09:00:00+02:00"), 12).toISOString()).toBe(cairo("2029-02-28T09:00:00+02:00").toISOString());
    expect(addCalendarMonths(cairo("2026-08-31T09:00:00+03:00"), 1).toISOString()).toBe(cairo("2026-09-30T09:00:00+03:00").toISOString());
  });
  it("الساعة بتوقيت القاهرة ثابتة حتى لو تغيّر التوقيت الصيفي بين البداية والنهاية", () => {
    const end = addCalendarMonths(cairo("2026-03-01T10:00:00+02:00"), 5);
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", hour: "2-digit", hourCycle: "h23", day: "2-digit", month: "2-digit" }).format(end);
    expect(local).toContain("10");
    expect(local).toContain("08");
  });
});

describe("حالة الاشتراك وفترة السماح 72 ساعة", () => {
  const periods = [P("2026-01-10T00:00:00+02:00", "2026-02-10T00:00:00+02:00")];
  const end = cairo("2026-02-10T00:00:00+02:00").getTime();
  it("بلا دفع = pending_payment", () => {
    expect(computeBillingStatus([], new Date()).state).toBe("pending_payment");
    expect(computeBillingStatus([P("2026-01-10T00:00:00+02:00", "2026-02-10T00:00:00+02:00", true)], new Date(end - 1)).state).toBe("pending_payment");
  });
  it("الحدود: قبل النهاية active، من النهاية grace، آخر ms في السماح grace، عند 72 ساعة بالظبط expired", () => {
    expect(computeBillingStatus(periods, new Date(end - 1)).state).toBe("active");
    expect(computeBillingStatus(periods, new Date(end)).state).toBe("grace");
    expect(computeBillingStatus(periods, new Date(end + SUBSCRIPTION_GRACE_MS - 1)).state).toBe("grace");
    const s = computeBillingStatus(periods, new Date(end + SUBSCRIPTION_GRACE_MS));
    expect(s.state).toBe("expired");
    expect(s.graceEndsAt!.getTime()).toBe(end + 72 * 3600 * 1000);
  });
});

describe("قاعدة بداية التجديد (بلا فترة مجانية متكررة)", () => {
  const periods = [P("2026-01-10T00:00:00+02:00", "2026-02-10T00:00:00+02:00")];
  const end = cairo("2026-02-10T00:00:00+02:00");
  it("أول اشتراك من لحظة التفعيل", () => {
    const at = cairo("2026-05-05T13:00:00+03:00");
    expect(nextPeriodStart([], at)).toEqual(at);
  });
  it("تجديد مبكر: المدة تتضاف على النهاية الحالية", () => {
    const r = newPeriodFor(periods, "month_1", cairo("2026-02-01T00:00:00+02:00"));
    expect(r.startsAt).toEqual(end);
    expect(r.endsAt.toISOString()).toBe(cairo("2026-03-10T00:00:00+02:00").toISOString());
  });
  it("تجديد أثناء السماح: من نهاية الفترة السابقة (السماح محسوب، مش مجاني)", () => {
    expect(nextPeriodStart(periods, new Date(end.getTime() + 48 * 3600 * 1000))).toEqual(end);
  });
  it("تجديد بعد انتهاء السماح: من لحظة التفعيل (لا أثر رجعي)", () => {
    const at = new Date(end.getTime() + SUBSCRIPTION_GRACE_MS + 1000);
    expect(nextPeriodStart(periods, at)).toEqual(at);
  });
  it("فترة ملغاة (استرداد) مابتتحسبش في نهاية الاشتراك", () => {
    const withVoid = [...periods, P("2026-02-10T00:00:00+02:00", "2026-03-10T00:00:00+02:00", true)];
    expect(computeBillingStatus(withVoid, cairo("2026-02-11T00:00:00+02:00")).state).toBe("grace");
  });
});
