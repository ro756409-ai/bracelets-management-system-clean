import { useCallback, useEffect, useRef, useState } from "react";
import { MESSAGING_LIMITS } from "@shared/messagingSpec";

/**
 * تسجيل صوتي حقيقي بـMediaRecorder. الواجهة **لا تُعتبر حارسًا** للمدة/الحجم (السيرفر يقيس الملف نفسه)، لكنها:
 *   • توقف التسجيل تلقائيًا عند 5 دقائق، وترفض ما تجاوز 10 ميجا قبل الرفع.
 *   • تعرض حالة الإذن: غير مدعوم / مرفوض / لا ميكروفون.
 *   • تنظّف دائمًا: توقف المسارات (الميكروفون)، تغلق AudioContext، تلغي المؤقت، وتحرّر Object URL عند الإلغاء
 *     أو الإرسال أو مغادرة الصفحة — لا Blob ولا رابط يبقى بعد الخروج.
 */
export type RecorderPhase = "idle" | "requesting" | "recording" | "recorded";
export type RecorderErrorKind = "unsupported" | "denied" | "no_device" | "too_big" | "failed";
export const RECORDER_ERROR_TEXT: Record<RecorderErrorKind, string> = {
  unsupported: "متصفحك لا يدعم التسجيل الصوتي. جرّب أحدث Chrome أو Safari.",
  denied: "تم رفض الوصول للميكروفون — اسمح به من إعدادات المتصفح ثم حاول مرة أخرى.",
  no_device: "لا يوجد ميكروفون متاح على هذا الجهاز.",
  too_big: "التسجيل أكبر من 10 ميجا — سجّل رسالة أقصر.",
  failed: "تعذّر التسجيل — حاول مرة أخرى.",
};

/** الصيغ بالترتيب: Chrome/Firefox/Android (WebM/Ogg Opus)، Safari/iOS (MP4/AAC). */
const PREFERRED = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4", "audio/mp4;codecs=mp4a.40.2"];

export function recorderSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as any).MediaRecorder === "function" && Boolean(navigator.mediaDevices?.getUserMedia);
}
export function pickMimeType(isSupported: (t: string) => boolean = t => (window as any).MediaRecorder?.isTypeSupported?.(t) ?? false): string {
  return PREFERRED.find(t => { try { return isSupported(t); } catch { return false; } }) ?? "";
}
export function extensionFor(type: string): ".webm" | ".ogg" | ".m4a" {
  if (/ogg/i.test(type)) return ".ogg";
  if (/mp4|aac|m4a/i.test(type)) return ".m4a";
  return ".webm";
}
/** تصغير مستويات الصوت لـ≤ 48 عمودًا بين 0 و1. */
export function downsampleLevels(levels: number[], bars = 48): number[] {
  if (!levels.length) return [];
  const out: number[] = [];
  const step = levels.length / Math.min(bars, levels.length);
  for (let i = 0; i < levels.length; i += step) {
    const slice = levels.slice(Math.floor(i), Math.max(Math.floor(i + step), Math.floor(i) + 1));
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  const max = Math.max(...out, 0.0001);
  return out.slice(0, bars).map(v => Math.round((v / max) * 100) / 100);
}

export function useVoiceRecorder() {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsedMs, setElapsed] = useState(0);
  const [error, setError] = useState<RecorderErrorKind | null>(null);
  const [recording, setRecording] = useState<{ blob: Blob; url: string; durationMs: number; waveform: number[] } | null>(null);
  const r = useRef<{ rec?: MediaRecorder; stream?: MediaStream; ctx?: AudioContext; timer?: ReturnType<typeof setInterval>; chunks: Blob[]; started: number; levels: number[]; discard: boolean }>({ chunks: [], started: 0, levels: [], discard: false });

  const releaseDevices = useCallback(() => {
    const x = r.current;
    if (x.timer) clearInterval(x.timer);
    x.timer = undefined;
    x.stream?.getTracks().forEach(t => t.stop());
    x.stream = undefined;
    void x.ctx?.close().catch(() => {});
    x.ctx = undefined;
  }, []);

  const revoke = useCallback((rec: { url: string } | null) => { if (rec?.url) URL.revokeObjectURL(rec.url); }, []);

  const stop = useCallback(() => {
    const rec = r.current.rec;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (!recorderSupported()) { setError("unsupported"); return; }
    setPhase("requesting");
    r.current.discard = false;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e: any) {
      if (r.current.discard) return; // أُلغي أثناء انتظار الإذن
      setPhase("idle");
      setError(e?.name === "NotAllowedError" || e?.name === "SecurityError" ? "denied" : e?.name === "NotFoundError" || e?.name === "OverconstrainedError" ? "no_device" : "failed");
      return;
    }
    const x = r.current;
    if (x.discard) { stream.getTracks().forEach(t => t.stop()); return; } // أُلغي أثناء انتظار الإذن: أغلق الميكروفون فورًا
    x.stream = stream; x.chunks = []; x.levels = []; x.discard = false;
    const mimeType = pickMimeType();
    let rec: MediaRecorder;
    try { rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream); }
    catch { releaseDevices(); setPhase("idle"); setError("unsupported"); return; }
    x.rec = rec;
    // مستويات الصوت للموجة (اختياري — يتجاهل الأخطاء)
    let analyser: AnalyserNode | null = null;
    try {
      const Ctx = (window as any).AudioContext ?? (window as any).webkitAudioContext;
      if (Ctx) { x.ctx = new Ctx(); analyser = x.ctx!.createAnalyser(); analyser.fftSize = 256; x.ctx!.createMediaStreamSource(stream).connect(analyser); }
    } catch { analyser = null; }
    const buf = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    rec.ondataavailable = ev => { if (ev.data && ev.data.size) x.chunks.push(ev.data); };
    rec.onstop = () => {
      const durationMs = Date.now() - x.started;
      releaseDevices();
      x.rec = undefined;
      if (x.discard) { x.chunks = []; setPhase("idle"); setElapsed(0); return; }
      const blob = new Blob(x.chunks, { type: rec.mimeType || mimeType || "audio/webm" });
      x.chunks = [];
      if (blob.size > MESSAGING_LIMITS.attachmentMaxBytes) { setPhase("idle"); setElapsed(0); setError("too_big"); return; }
      if (!blob.size) { setPhase("idle"); setElapsed(0); setError("failed"); return; }
      setRecording({ blob, url: URL.createObjectURL(blob), durationMs: Math.min(durationMs, MESSAGING_LIMITS.voiceMaxMs), waveform: downsampleLevels(x.levels) });
      setPhase("recorded");
    };
    x.started = Date.now();
    rec.start(1000);
    setElapsed(0);
    setPhase("recording");
    x.timer = setInterval(() => {
      const ms = Date.now() - x.started;
      setElapsed(ms);
      if (analyser && buf) { analyser.getByteTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128)); x.levels.push(peak / 128); }
      if (ms >= MESSAGING_LIMITS.voiceMaxMs) stop(); // إيقاف تلقائي عند 5 دقائق
    }, 200);
  }, [releaseDevices, stop]);

  /** إلغاء أثناء التسجيل (بلا معاينة). */
  const cancel = useCallback(() => {
    r.current.discard = true;
    // أثناء انتظار الإذن أو التسجيل — الإذن المتأخر يُغلق فورًا في start()
    if (r.current.rec && r.current.rec.state !== "inactive") r.current.rec.stop();
    else { releaseDevices(); setPhase("idle"); setElapsed(0); }
  }, [releaseDevices]);

  /** حذف التسجيل الجاهز (أو بعد الإرسال). */
  const discard = useCallback(() => {
    setRecording(prev => { revoke(prev); return null; });
    setPhase("idle");
    setElapsed(0);
  }, [revoke]);

  // مغادرة الصفحة/المحادثة: أوقف كل شيء وحرّر الرابط
  const recRef = useRef(recording);
  recRef.current = recording;
  useEffect(() => () => {
    r.current.discard = true;
    try { if (r.current.rec && r.current.rec.state !== "inactive") r.current.rec.stop(); } catch { /* noop */ }
    releaseDevices();
    revoke(recRef.current);
  }, [releaseDevices, revoke]);

  return { phase, elapsedMs, error, setError, recording, start, stop, cancel, discard };
}
