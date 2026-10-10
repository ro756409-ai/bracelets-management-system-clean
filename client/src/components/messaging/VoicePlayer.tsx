import { memo, useEffect } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { audioController, useAudioState } from "./audioController";
import { formatDuration } from "./format";
import { voiceUrl, type ChatMessage, type MessagingVia } from "./messagingApi";

/**
 * مشغّل رسالة صوتية داخل الفقاعة. لا عنصر audio هنا — المشغّل المشترك (audioController) يضبط المصدر عند
 * الضغط فقط، من المسار المصرّح (`/api/messages/voice/:id`). مذكّر بالمعرّف والحالة: التحديث الدوري لا يغيّر شيئًا.
 * عند إزالة المشغّل (تغيير المحادثة/الخروج) يتوقف صوته.
 */
export const VoicePlayer = memo(function VoicePlayer({ via, message }: { via: MessagingVia; message: ChatMessage }) {
  const st = useAudioState();
  const att = message.attachments.find(a => a.kind === "voice");
  const id = message.id;
  useEffect(() => () => audioController.stop(id), [id]);
  if (!att) return null;
  if (att.purged) {
    return <p className="text-xs italic text-muted-foreground" data-testid={`voice-expired-${id}`}>انتهت مدة حفظ هذا التسجيل (6 أشهر).</p>;
  }
  const current = st.currentId === id;
  const playing = current && st.playing;
  const loading = current && st.loading && !st.playing;
  // المدة من السيرفر (مقاسة من الملف)؛ ما دون الثانية يُعرض 0:01 لا 0:00
  const total = att.durationMs ? Math.max(att.durationMs, 1000) : 0;
  const pos = current ? Math.min(st.positionMs, total) : 0;
  const bars = Array.isArray(att.waveform) && att.waveform.length ? (att.waveform as number[]).slice(0, 48) : null;
  const progress = total ? pos / total : 0;
  return (
    <div className="flex min-w-[12rem] items-center gap-2" data-testid={`voice-${id}`}>
      <button
        type="button"
        onClick={() => audioController.toggle(id, voiceUrl(via, id))}
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={playing ? "إيقاف مؤقت" : "تشغيل الرسالة الصوتية"}
        aria-pressed={playing}
        data-readonly-safe
        data-testid={`voice-play-${id}`}
      >
        {loading ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : playing ? <Pause className="h-5 w-5" aria-hidden="true" /> : <Play className="h-5 w-5" aria-hidden="true" />}
      </button>
      <div className="min-w-0 flex-1">
        {bars ? (
          <div className="flex h-7 items-center gap-[2px]" aria-hidden="true" dir="ltr">
            {bars.map((v, i) => (
              <span key={i} className={cn("w-[3px] rounded-full", i / bars.length <= progress ? "bg-primary" : "bg-muted-foreground/40")} style={{ height: `${Math.max(12, Math.round(v * 100))}%` }} />
            ))}
          </div>
        ) : (
          <div className="h-1.5 overflow-hidden rounded-full bg-muted-foreground/25" aria-hidden="true" dir="ltr">
            <div className="h-full bg-primary" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        <div className="mt-0.5 flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
          <span>{current ? `${formatDuration(pos)} / ` : ""}{formatDuration(total)}</span>
          {current && st.error && <span className="text-destructive" role="alert">تعذّر التشغيل</span>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => audioController.cycleRate()}
        className="min-h-11 min-w-11 shrink-0 rounded-md text-xs font-semibold tabular-nums hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`سرعة التشغيل ${st.rate}×`}
        data-readonly-safe
        data-testid={`voice-rate-${id}`}
      >
        {st.rate}×
      </button>
    </div>
  );
}, (a, b) => a.via === b.via && a.message.id === b.message.id && a.message.attachments === b.message.attachments
  || (a.via === b.via && a.message.id === b.message.id && JSON.stringify(a.message.attachments) === JSON.stringify(b.message.attachments)));
