import { useEffect, useRef } from "react";

/**
 * جدولة تحديث آمنة (بلا WebSocket) — منطق نقي قابل للاختبار بمؤقتات مزيّفة:
 *   • لا تداخل: الطلب التالي يُجدول **بعد انتهاء** السابق (setTimeout متسلسل، لا setInterval)، و`trigger`
 *     أثناء طلب جارٍ لا يبدأ طلبًا ثانيًا.
 *   • توقف كامل والصفحة مخفية (document.hidden) أو الجهاز Offline — لا مؤقت معلّق ولا طلبات.
 *   • استئناف فوري عند الرجوع للصفحة أو عودة الاتصال.
 *   • Backoff تدريجي عند الخطأ (×2 حتى سقف)، ويعود للمعدل الطبيعي بعد أول نجاح.
 */
export type PollEnv = {
  isHidden(): boolean;
  isOnline(): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** يسجّل مستمع تغيّر الظهور/الاتصال ويعيد دالة الإلغاء. */
  onChange(fn: () => void): () => void;
};

export const browserPollEnv = (): PollEnv => ({
  isHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: h => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  onChange: fn => {
    document.addEventListener("visibilitychange", fn);
    window.addEventListener("online", fn);
    window.addEventListener("offline", fn);
    return () => {
      document.removeEventListener("visibilitychange", fn);
      window.removeEventListener("online", fn);
      window.removeEventListener("offline", fn);
    };
  },
});

export type PollOptions = { intervalMs: number; maxBackoffMs?: number; immediate?: boolean };

export class PollScheduler {
  private timer: unknown = null;
  private inFlight = false;
  private stopped = true;
  private unlisten: (() => void) | null = null;
  failures = 0;
  runs = 0;

  constructor(private task: () => Promise<unknown>, private opts: PollOptions, private env: PollEnv = browserPollEnv()) {}

  get paused() { return this.env.isHidden() || !this.env.isOnline(); }
  get busy() { return this.inFlight; }
  get scheduled() { return this.timer !== null; }

  /** المهلة التالية: الطبيعية، أو مضاعفة مع كل فشل متتالٍ حتى السقف. */
  nextDelay(): number {
    if (!this.failures) return this.opts.intervalMs;
    return Math.min(this.opts.intervalMs * 2 ** this.failures, this.opts.maxBackoffMs ?? 60_000);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.unlisten = this.env.onChange(() => this.onEnvChange());
    if (this.opts.immediate) void this.tick(); else this.schedule(this.opts.intervalMs);
  }

  stop() {
    this.stopped = true;
    this.clear();
    this.unlisten?.();
    this.unlisten = null;
  }

  /** تحديث فوري (مثلًا بعد الإرسال) — بلا تداخل مع طلب جارٍ. */
  trigger() {
    if (this.stopped || this.inFlight || this.paused) return;
    this.clear();
    void this.tick();
  }

  private onEnvChange() {
    if (this.stopped) return;
    if (this.paused) { this.clear(); return; }
    if (!this.inFlight) { this.clear(); void this.tick(); } // عودة الظهور/الاتصال = تحديث فوري
  }

  private clear() {
    if (this.timer !== null) this.env.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    this.clear();
    if (this.stopped || this.paused) return; // متوقف بالكامل حتى يعود الظهور/الاتصال
    this.timer = this.env.setTimeout(() => { this.timer = null; void this.tick(); }, ms);
  }

  private async tick() {
    if (this.stopped || this.inFlight || this.paused) return;
    this.inFlight = true;
    this.runs++;
    try {
      await this.task();
      this.failures = 0;
    } catch {
      this.failures++;
    } finally {
      this.inFlight = false;
      this.schedule(this.nextDelay());
    }
  }
}

/** Hook: يشغّل المهمة دوريًا بالشروط أعلاه؛ أحدث نسخة من المهمة دائمًا (ref) دون إعادة إنشاء الجدولة. */
export function usePoller(task: () => Promise<unknown>, opts: PollOptions & { enabled: boolean }) {
  const taskRef = useRef(task);
  taskRef.current = task;
  const schedulerRef = useRef<PollScheduler | null>(null);
  const { enabled, intervalMs, maxBackoffMs, immediate } = opts;
  useEffect(() => {
    if (!enabled) return;
    const s = new PollScheduler(() => taskRef.current(), { intervalMs, maxBackoffMs, immediate });
    schedulerRef.current = s;
    s.start();
    return () => { s.stop(); if (schedulerRef.current === s) schedulerRef.current = null; };
  }, [enabled, intervalMs, maxBackoffMs, immediate]);
  return { trigger: () => schedulerRef.current?.trigger() };
}
