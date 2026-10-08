/**
 * حارس «قيد التنفيذ» ضد الضغط المكرر (double-click) على إجراء لكل مفتاح (orderId).
 * `isPending` من React Query يتأخر render واحدًا، فالضغطة الثانية خلال ملّي ثوانٍ كانت تمرّ؛ هذا الحارس
 * يرفضها فورًا حتى يُستدعى `done` (onSettled). لا منطق أعمال: السيرفر يبقى الحكم (idempotency هناك كما هو).
 */
export function createInFlightGuard<K>() {
  const inFlight = new Set<K>();
  return {
    /** يشغّل `fn` مرة واحدة فقط لكل مفتاح حتى `done()`؛ يُرجع false عند الرفض. */
    run(key: K, isPending: boolean, fn: (done: () => void) => void): boolean {
      if (isPending || inFlight.has(key)) return false;
      inFlight.add(key);
      let released = false;
      const done = () => { if (!released) { released = true; inFlight.delete(key); } };
      try { fn(done); } catch (e) { done(); throw e; }
      return true;
    },
    has: (key: K) => inFlight.has(key),
  };
}
