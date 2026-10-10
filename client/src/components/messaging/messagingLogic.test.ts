import { describe, it, expect, vi } from "vitest";
import { PollScheduler, type PollEnv } from "./pollScheduler";
import { isNearBottom, mergeById, mergeLatestPage, shouldStickToBottom } from "./messageStore";
import { downsampleLevels, extensionFor, pickMimeType } from "./useVoiceRecorder";

/** بيئة جدولة مزيّفة: وقت يدوي + ظهور/اتصال قابلان للتبديل. */
function fakeEnv() {
  let now = 0, seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Set<() => void>();
  const env: PollEnv & { hidden: boolean; online: boolean } = {
    hidden: false, online: true,
    isHidden: () => env.hidden,
    isOnline: () => env.online,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: h => { timers.delete(h as number); },
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return {
    env,
    pending: () => timers.size,
    nextAt: () => Math.min(...[...timers.values()].map(t => t.at)) - now,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].fn();
        await flush();
      }
      now = end;
    },
    change: async (patch: Partial<{ hidden: boolean; online: boolean }>) => { Object.assign(env, patch); listeners.forEach(l => l()); await flush(); },
  };
}
const flush = () => new Promise(r => setTimeout(r, 0));
const deferred = () => { let resolve!: () => void, reject!: (e: unknown) => void; const p = new Promise<void>((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

describe("⏱️ جدولة التحديث", () => {
  it("لا تداخل: الطلب التالي بعد انتهاء السابق، وtrigger أثناء طلب جارٍ لا يبدأ طلبًا ثانيًا", async () => {
    const f = fakeEnv();
    let active = 0, maxActive = 0, calls = 0;
    let gate = deferred();
    const s = new PollScheduler(async () => { calls++; active++; maxActive = Math.max(maxActive, active); await gate.p; active--; }, { intervalMs: 4000 }, f.env);
    s.start();
    await f.advance(4000);
    expect(calls).toBe(1); expect(s.busy).toBe(true);
    s.trigger(); s.trigger();
    await f.advance(20_000); // الطلب ما زال معلّقًا — لا مؤقت ولا طلب ثانٍ
    expect(calls).toBe(1); expect(f.pending()).toBe(0);
    gate.resolve(); await flush();
    expect(f.nextAt()).toBe(4000); // الجدولة التالية بعد الانتهاء
    gate = deferred(); gate.resolve();
    await f.advance(4000);
    expect(calls).toBe(2); expect(maxActive).toBe(1);
    s.stop();
  });

  it("توقف كامل والصفحة مخفية أو Offline، واستئناف فوري عند العودة", async () => {
    const f = fakeEnv();
    let calls = 0;
    const s = new PollScheduler(async () => { calls++; }, { intervalMs: 4000 }, f.env);
    s.start();
    await f.change({ hidden: true });
    expect(f.pending()).toBe(0);
    await f.advance(60_000);
    expect(calls).toBe(0);
    s.trigger(); await flush();
    expect(calls).toBe(0); // لا تحديث يدوي والصفحة مخفية
    await f.change({ hidden: false });
    expect(calls).toBe(1); // فورًا
    await f.change({ online: false });
    expect(f.pending()).toBe(0);
    await f.advance(60_000);
    expect(calls).toBe(1);
    await f.change({ online: true });
    expect(calls).toBe(2);
    s.stop();
    await f.change({ hidden: true }); await f.change({ hidden: false });
    expect(calls).toBe(2); // بعد stop لا شيء
  });

  it("Backoff تدريجي عند الخطأ مع سقف، والعودة للمعدل الطبيعي بعد النجاح", async () => {
    const f = fakeEnv();
    let fail = true;
    const s = new PollScheduler(async () => { if (fail) throw new Error("x"); }, { intervalMs: 4000, maxBackoffMs: 30_000 }, f.env);
    s.start();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) { await f.advance(f.nextAt()); delays.push(f.nextAt()); }
    expect(delays).toEqual([8000, 16_000, 30_000, 30_000, 30_000]);
    fail = false;
    await f.advance(f.nextAt());
    expect(f.nextAt()).toBe(4000); expect(s.failures).toBe(0);
    s.stop();
  });
});

describe("🧩 دمج الرسائل", () => {
  const m = (id: number, body = `m${id}`) => ({ id, body });
  it("بلا تكرار ومرتبة، والنسخة الأحدث تكسب (تعديل/حذف)", () => {
    const out = mergeById([m(1), m(3)], [m(3, "معدّلة"), m(2)]);
    expect(out.map(x => x.id)).toEqual([1, 2, 3]);
    expect(out[2].body).toBe("معدّلة");
  });
  it("Pagination مع وصول رسالة جديدة أثناء التحميل: لا تكرار ولا فقد", () => {
    let list = [m(50), m(60)];
    // أثناء تحميل الأقدم وصل 70 عبر الـPolling
    list = mergeLatestPage(list, [m(50), m(60), m(70)], false).messages;
    list = mergeById(list, [m(10), m(20), m(50)]); // الصفحة الأقدم (فيها تداخل)
    expect(list.map(x => x.id)).toEqual([10, 20, 50, 60, 70]);
  });
  it("كشف الفجوة: صفحة أحدث كاملة لا تحتوي أي رسالة نعرفها", () => {
    expect(mergeLatestPage([m(5), m(9)], [m(40), m(41)], true).gapAfter).toBe(9);
    expect(mergeLatestPage([m(5), m(9)], [m(9), m(40)], true).gapAfter).toBeNull();
    expect(mergeLatestPage([m(5), m(9)], [m(40)], false).gapAfter).toBeNull();
    expect(mergeLatestPage([], [m(40)], true).gapAfter).toBeNull(); // أول تحميل ليس فجوة
  });
  it("التحريك لآخر رسالة: أول فتح، أو قريب من الأسفل، أو أرسل بنفسه — وإلا لا نحرّك من يقرأ القديم", () => {
    expect(shouldStickToBottom({ firstLoad: true, nearBottom: false, sentByMe: false })).toBe(true);
    expect(shouldStickToBottom({ firstLoad: false, nearBottom: true, sentByMe: false })).toBe(true);
    expect(shouldStickToBottom({ firstLoad: false, nearBottom: false, sentByMe: true })).toBe(true);
    expect(shouldStickToBottom({ firstLoad: false, nearBottom: false, sentByMe: false })).toBe(false);
    expect(isNearBottom({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 450 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 2000, scrollTop: 200, clientHeight: 450 })).toBe(false);
  });
});

describe("🎙️ مساعدات التسجيل", () => {
  it("اختيار الصيغة: Opus/WebM أولًا، وMP4 لسفاري، وبلا دعم = فارغ", () => {
    expect(pickMimeType(t => t === "audio/webm;codecs=opus" || t === "audio/mp4")).toBe("audio/webm;codecs=opus");
    expect(pickMimeType(t => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickMimeType(() => false)).toBe("");
    expect(pickMimeType(() => { throw new Error("x"); })).toBe("");
    expect(extensionFor("audio/webm;codecs=opus")).toBe(".webm");
    expect(extensionFor("audio/ogg")).toBe(".ogg");
    expect(extensionFor("audio/mp4")).toBe(".m4a");
  });
  it("الموجة: ≤ 48 عمودًا بين 0 و1", () => {
    const w = downsampleLevels(Array.from({ length: 500 }, (_, i) => (i % 10) / 10));
    expect(w.length).toBeLessThanOrEqual(48);
    expect(Math.max(...w)).toBe(1);
    expect(w.every(v => v >= 0 && v <= 1)).toBe(true);
    expect(downsampleLevels([])).toEqual([]);
  });
});
