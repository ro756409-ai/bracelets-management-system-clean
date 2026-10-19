import { zonedDateTimeToUtc } from "./businessTime";

/**
 * اشتراك متجرك (النموذج التجاري المعتمد): نفس المميزات لكل المدد، بلا رسوم لكل أوردر، بلا تجربة مجانية، تجديد يدوي فقط.
 * منطق نقي (بلا قاعدة بيانات) — نفس الدوال على السيرفر (الحارس والتفعيل) وفي الواجهة (العرض).
 *
 *   • المدة بالأشهر **التقويمية** بتوقيت القاهرة من لحظة التفعيل؛ يوم غير موجود في الشهر الهدف (31 → فبراير، 29 فبراير →
 *     سنة غير كبيسة) = آخر يوم في الشهر، بنفس الساعة.
 *   • فترة سماح 72 ساعة بعد نهاية آخر فترة مدفوعة — التشغيل مستمر خلالها.
 *   • الحالة مشتقة من الفترات المدفوعة (لا عمود حالة يتحدّث بمهمة خلفية): pending_payment / active / grace / expired.
 */
export const BILLING_TIME_ZONE = "Africa/Cairo";
export const BILLING_CURRENCY = "EGP";
export const SUBSCRIPTION_GRACE_MS = 72 * 60 * 60 * 1000;

export const SUBSCRIPTION_PLANS = {
  month_1: { code: "month_1", months: 1, amount: 500 },
  month_5: { code: "month_5", months: 5, amount: 1999 },
  month_12: { code: "month_12", months: 12, amount: 3999 },
} as const;
export type SubscriptionPlanCode = keyof typeof SUBSCRIPTION_PLANS;
export const SUBSCRIPTION_PLAN_CODES = Object.keys(SUBSCRIPTION_PLANS) as SubscriptionPlanCode[];
/** الأفضل قيمة (للعرض فقط). */
export const BEST_VALUE_PLAN: SubscriptionPlanCode = "month_12";

export function planByCode(code: string): (typeof SUBSCRIPTION_PLANS)[SubscriptionPlanCode] | null {
  return (SUBSCRIPTION_PLANS as Record<string, (typeof SUBSCRIPTION_PLANS)[SubscriptionPlanCode]>)[code] ?? null;
}

/** المبلغ المطلوب للخطة بالقروش (تحقق السيرفر من المبلغ — لا يُقبل مبلغ من العميل). */
export function planAmountMinor(code: SubscriptionPlanCode): number {
  return SUBSCRIPTION_PLANS[code].amount * 100;
}

function cairoParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BILLING_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const v = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === t)?.value);
  return { year: v("year"), month: v("month"), day: v("day"), hour: v("hour"), minute: v("minute"), second: v("second") };
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** إضافة أشهر تقويمية بتوقيت القاهرة (مع حصر اليوم في آخر الشهر) — نفس الساعة والدقيقة والثانية. */
export function addCalendarMonths(start: Date, months: number): Date {
  if (!Number.isInteger(months) || months < 1) throw new Error("months must be a positive integer");
  const p = cairoParts(start);
  const total = p.month - 1 + months;
  const year = p.year + Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(p.day, daysInMonth(year, month));
  const out = zonedDateTimeToUtc({ year, month, day, hour: p.hour, minute: p.minute, second: p.second }, BILLING_TIME_ZONE);
  return new Date(out.getTime() + (start.getTime() % 1000 + 1000) % 1000);
}

export type BillingPeriod = { startsAt: Date; endsAt: Date; voidedAt?: Date | null };
export type BillingState = "pending_payment" | "active" | "grace" | "expired";
export type BillingStatus = { state: BillingState; paidUntil: Date | null; graceEndsAt: Date | null };

/** نهاية آخر فترة مدفوعة غير ملغاة. */
export function paidUntilOf(periods: readonly BillingPeriod[]): Date | null {
  let max: number | null = null;
  for (const p of periods) if (!p.voidedAt) max = max == null ? p.endsAt.getTime() : Math.max(max, p.endsAt.getTime());
  return max == null ? null : new Date(max);
}

export function computeBillingStatus(periods: readonly BillingPeriod[], now: Date): BillingStatus {
  const paidUntil = paidUntilOf(periods);
  if (!paidUntil) return { state: "pending_payment", paidUntil: null, graceEndsAt: null };
  const graceEndsAt = new Date(paidUntil.getTime() + SUBSCRIPTION_GRACE_MS);
  // فترة مستقبلية فقط (تجديد مبكر قبل أول تفعيل فعلي غير ممكن — الفترة تبدأ عند التفعيل) — النشاط = داخل أي فترة سارية.
  const t = now.getTime();
  const inPaid = periods.some(p => !p.voidedAt && p.startsAt.getTime() <= t && t < p.endsAt.getTime());
  if (inPaid || t < paidUntil.getTime()) return { state: "active", paidUntil, graceEndsAt };
  if (t < graceEndsAt.getTime()) return { state: "grace", paidUntil, graceEndsAt };
  return { state: "expired", paidUntil, graceEndsAt };
}

/**
 * بداية الفترة الجديدة عند تفعيل دفع مؤكد (القاعدة الموثّقة):
 *   • أول اشتراك: من لحظة التفعيل.
 *   • تجديد مبكر (قبل نهاية الفترة): من نهاية الفترة الحالية — المدة بتتضاف عليها.
 *   • تجديد أثناء السماح: من نهاية الفترة السابقة — وقت السماح المستخدم محسوب من المدة الجديدة (مش مجاني).
 *   • تجديد بعد انتهاء السماح: من لحظة التفعيل — مفيش رجوع بأثر رجعي لفترة ماكانش فيها تشغيل. السماح (72 ساعة) بيتمنح
 *     مرة واحدة بعد نهاية كل فترة مدفوعة، ومش بيتجدد بتأخير الدفع.
 */
export function nextPeriodStart(periods: readonly BillingPeriod[], activationAt: Date): Date {
  const paidUntil = paidUntilOf(periods);
  if (!paidUntil) return activationAt;
  if (activationAt.getTime() < paidUntil.getTime() + SUBSCRIPTION_GRACE_MS) return paidUntil;
  return activationAt;
}

export function newPeriodFor(periods: readonly BillingPeriod[], plan: SubscriptionPlanCode, activationAt: Date): { startsAt: Date; endsAt: Date } {
  const startsAt = nextPeriodStart(periods, activationAt);
  return { startsAt, endsAt: addCalendarMonths(startsAt, SUBSCRIPTION_PLANS[plan].months) };
}
