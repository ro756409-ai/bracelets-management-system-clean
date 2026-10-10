import { useSyncExternalStore } from "react";

/**
 * مشغّل صوت **واحد** لكل الصفحة (عنصر audio واحد خارج شجرة React):
 *   • تشغيل رسالة يوقف أي صوت آخر.
 *   • الـsrc يُضبط فقط عند الضغط على تشغيل رسالة **مختلفة** — لا عنصر audio داخل كل فقاعة، فالـPolling
 *     وإعادة الرسم لا يعيدان تنزيل أي ملف. preload="none".
 *   • stop() عند مغادرة المحادثة/الصفحة/تسجيل الخروج (pagehide) — ويُفرّغ الـsrc فلا يبقى اتصال مفتوح.
 *   • السرعات 1× / 1.5× / 2×.
 */
export type AudioState = { currentId: number | null; playing: boolean; loading: boolean; positionMs: number; rate: number; error: boolean };
export const RATES = [1, 1.5, 2] as const;

type Listener = () => void;
let audio: HTMLAudioElement | null = null;
let state: AudioState = { currentId: null, playing: false, loading: false, positionMs: 0, rate: 1, error: false };
const listeners = new Set<Listener>();
let srcSets = 0;

function set(patch: Partial<AudioState>) {
  state = { ...state, ...patch };
  listeners.forEach(l => l());
}

function element(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = "none";
  audio.addEventListener("playing", () => set({ playing: true, loading: false, error: false }));
  audio.addEventListener("pause", () => set({ playing: false }));
  audio.addEventListener("waiting", () => set({ loading: true }));
  audio.addEventListener("timeupdate", () => set({ positionMs: Math.round((audio?.currentTime ?? 0) * 1000) }));
  audio.addEventListener("ended", () => set({ playing: false, positionMs: 0 }));
  audio.addEventListener("error", () => { if (audio?.getAttribute("src")) set({ playing: false, loading: false, error: true }); });
  if (typeof window !== "undefined") window.addEventListener("pagehide", () => stopAudio());
  return audio;
}

export const audioController = {
  /** تشغيل/إيقاف مؤقت لرسالة. `url` مسار التشغيل المصرّح فقط. */
  toggle(id: number, url: string) {
    const a = element();
    if (state.currentId === id) {
      if (a.paused) { set({ loading: true }); void a.play().catch(() => set({ playing: false, loading: false, error: true })); }
      else a.pause();
      return;
    }
    a.pause();
    a.src = url; // مرة واحدة لكل رسالة يختارها المستخدم
    srcSets++;
    a.playbackRate = state.rate;
    set({ currentId: id, positionMs: 0, loading: true, error: false });
    void a.play().catch(() => set({ playing: false, loading: false, error: true }));
  },
  cycleRate() {
    const next = RATES[(RATES.indexOf(state.rate as (typeof RATES)[number]) + 1) % RATES.length];
    if (audio) audio.playbackRate = next;
    set({ rate: next });
  },
  /** يوقف فقط إن كانت الرسالة المعنية هي الحالية (أو أي صوت إن لم يُحدد). */
  stop(id?: number) {
    if (id != null && state.currentId !== id) return;
    stopAudio();
  },
  subscribe(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; },
  getState: () => state,
  /** للاختبارات: عدد مرات ضبط الـsrc (= عدد التنزيلات التي طلبها المستخدم). */
  __srcSets: () => srcSets,
  __reset() { stopAudio(); audio = null; srcSets = 0; state = { currentId: null, playing: false, loading: false, positionMs: 0, rate: 1, error: false }; },
};

function stopAudio() {
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    try { audio.load(); } catch { /* jsdom */ }
  }
  set({ currentId: null, playing: false, loading: false, positionMs: 0, error: false });
}

export function useAudioState(): AudioState {
  return useSyncExternalStore(audioController.subscribe, audioController.getState, audioController.getState);
}
