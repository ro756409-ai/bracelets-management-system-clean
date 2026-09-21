/**
 * حد استدعاءات الـAI لكل (موظف + نشاط) — في الذاكرة، نافذة منزلقة.
 *
 * بينطبق على **محاولات الـAI فقط** (لما يكون فيه أجزاء غير محلولة فعلًا)، مش على التحليل
 * الحتمي. تجاوز الحد = مفيش نداء للمزوّد، والنتيجة الحتمية بتترجع عادي — الصفحة ماتقفش.
 */
export const AI_RATE_LIMIT_MAX = 20;
export const AI_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

const buckets = new Map<string, number[]>();

export function aiRateKey(employeeId: number, businessId: number): string {
  return `${employeeId}:${businessId}`;
}

/** true = مسموح (وبيتسجّل)؛ false = الحد اتخطى في النافذة الحالية. */
export function allowAiCall(key: string, now: number = Date.now()): boolean {
  const cutoff = now - AI_RATE_LIMIT_WINDOW_MS;
  const times = (buckets.get(key) ?? []).filter(t => t > cutoff);
  if (times.length >= AI_RATE_LIMIT_MAX) {
    buckets.set(key, times);
    return false;
  }
  times.push(now);
  buckets.set(key, times);
  return true;
}

export function remainingAiCalls(key: string, now: number = Date.now()): number {
  const cutoff = now - AI_RATE_LIMIT_WINDOW_MS;
  return Math.max(0, AI_RATE_LIMIT_MAX - (buckets.get(key) ?? []).filter(t => t > cutoff).length);
}

/** للاختبار فقط. */
export function __resetAiRateLimitForTests(): void {
  buckets.clear();
}
