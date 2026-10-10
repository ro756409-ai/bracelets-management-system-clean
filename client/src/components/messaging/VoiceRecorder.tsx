import { useRef, useState } from "react";
import { Loader2, Mic, Send, Square, Trash2, X } from "lucide-react";
import { MESSAGING_LIMITS } from "@shared/messagingSpec";
import { Button } from "@/components/ui/button";
import { completeOperation, operationIdFor } from "@/lib/operationId";
import { formatDuration } from "./format";
import { HttpError, messagingErrorText, voiceUploadUrl, type MessagingVia } from "./messagingApi";
import { RECORDER_ERROR_TEXT, extensionFor, useVoiceRecorder } from "./useVoiceRecorder";

const MAX_LABEL = formatDuration(MESSAGING_LIMITS.voiceMaxMs);

/** رفع التسجيل لمسار الصوت المصرّح — الحالة غير 2xx ترمي HttpError (رسالة عربية حسب الحالة). */
export async function uploadVoice(via: MessagingVia, input: { blob: Blob; conversationId: number; durationMs: number; operationId: string; replyToMessageId?: number; waveform?: number[] }, fetchImpl: typeof fetch = fetch) {
  const fd = new FormData();
  fd.append("conversationId", String(input.conversationId));
  fd.append("durationMs", String(Math.max(1, Math.round(input.durationMs))));
  fd.append("operationId", input.operationId);
  if (input.replyToMessageId) fd.append("replyToMessageId", String(input.replyToMessageId));
  if (input.waveform?.length) fd.append("waveform", JSON.stringify(input.waveform));
  fd.append("file", input.blob, `voice${extensionFor(input.blob.type)}`); // الاسم للامتداد فقط — السيرفر يولّد اسم التخزين
  const res = await fetchImpl(voiceUploadUrl(via), { method: "POST", body: fd, credentials: "include" });
  if (!res.ok) throw new HttpError(res.status);
  return (await res.json()) as { messageId: number; replay: boolean };
}

/**
 * زر التسجيل + لوحة التسجيل/المعاينة فوق شريط الكتابة. معرّف العملية ثابت لنفس التسجيل حتى ينجح
 * (إعادة المحاولة بعد خطأ شبكة = Replay على السيرفر، لا رسالة مكررة)؛ كل الأزرار معطلة أثناء الرفع.
 */
export function VoiceRecorder(props: { via: MessagingVia; conversationId: number; replyToMessageId?: number; disabled: boolean; onSent: () => void }) {
  const rec = useVoiceRecorder();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const session = useRef(0);
  const scope = () => `msg-voice:${props.conversationId}:${session.current}`;

  const begin = () => { session.current++; setUploadError(null); void rec.start(); };
  const send = async () => {
    if (!rec.recording || uploading) return;
    setUploading(true);
    setUploadError(null);
    const operationId = operationIdFor(scope());
    try {
      await uploadVoice(props.via, { blob: rec.recording.blob, conversationId: props.conversationId, durationMs: rec.recording.durationMs, operationId, replyToMessageId: props.replyToMessageId, waveform: rec.recording.waveform });
      completeOperation(operationId);
      rec.discard();
      props.onSent();
    } catch (e) {
      setUploadError(messagingErrorText(e));
    } finally {
      setUploading(false);
    }
  };
  const drop = () => { completeOperation(operationIdFor(scope())); setUploadError(null); rec.discard(); };

  const panelOpen = rec.phase !== "idle" || rec.error != null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="min-h-11 min-w-11 shrink-0"
        onClick={begin}
        disabled={props.disabled || rec.phase !== "idle" || uploading}
        aria-label="تسجيل رسالة صوتية"
        data-testid="voice-record"
      >
        <Mic className="h-5 w-5" aria-hidden="true" />
      </Button>
      {panelOpen && (
        <div className="absolute inset-x-2 bottom-full z-10 mb-2 rounded-[var(--radius-brand-lg)] border border-border bg-card p-3 shadow-lg" role="region" aria-label="رسالة صوتية" data-testid="voice-panel">
          {rec.error && (
            <div className="flex items-start gap-2 text-sm text-destructive" role="alert" data-testid="voice-error">
              <p className="flex-1">{RECORDER_ERROR_TEXT[rec.error]}</p>
              <Button type="button" variant="ghost" size="icon" className="min-h-11 min-w-11" onClick={() => rec.setError(null)} aria-label="إغلاق" data-readonly-safe><X className="h-4 w-4" aria-hidden="true" /></Button>
            </div>
          )}
          {rec.phase === "requesting" && <p className="text-sm text-muted-foreground" role="status">جارٍ طلب إذن الميكروفون…</p>}
          {rec.phase === "recording" && (
            <div className="flex items-center gap-2" data-testid="voice-recording">
              <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden="true" />
              <span className="flex-1 text-sm tabular-nums" role="timer" aria-live="off" aria-label="مدة التسجيل">{formatDuration(rec.elapsedMs)} / {MAX_LABEL}</span>
              <Button type="button" variant="outline" className="min-h-11 gap-1" onClick={rec.stop} data-testid="voice-stop"><Square className="h-4 w-4" aria-hidden="true" /> إيقاف</Button>
              <Button type="button" variant="ghost" size="icon" className="min-h-11 min-w-11" onClick={rec.cancel} aria-label="إلغاء التسجيل" data-testid="voice-cancel"><X className="h-4 w-4" aria-hidden="true" /></Button>
            </div>
          )}
          {rec.phase === "recorded" && rec.recording && (
            <div className="space-y-2" data-testid="voice-preview">
              <audio controls preload="metadata" src={rec.recording.url} className="h-11 w-full" aria-label="معاينة التسجيل" />
              <p className="text-xs text-muted-foreground tabular-nums">
                المدة {formatDuration(rec.recording.durationMs)} · الحجم {(rec.recording.blob.size / 1024 / 1024).toFixed(2)} ميجا · الحد {MAX_LABEL} و{MESSAGING_LIMITS.attachmentMaxBytes / 1024 / 1024} ميجا
              </p>
              {uploadError && <p className="text-sm text-destructive" role="alert" data-testid="voice-upload-error">{uploadError}</p>}
              <div className="flex gap-2">
                <Button type="button" className="min-h-11 flex-1 gap-1" onClick={() => void send()} disabled={uploading} data-testid="voice-send">
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4 -scale-x-100" aria-hidden="true" />}
                  {uploading ? "جارٍ الإرسال…" : uploadError ? "إعادة الإرسال" : "إرسال"}
                </Button>
                <Button type="button" variant="outline" className="min-h-11 gap-1" onClick={drop} disabled={uploading} data-testid="voice-discard"><Trash2 className="h-4 w-4" aria-hidden="true" /> حذف</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
