import { useState } from "react";
import { Play, Clapperboard } from "lucide-react";
import { useI18n } from "@/i18n";
import { validCover, validYoutubeId, youtubeEmbedUrl, type LandingVideo } from "@/config/landingVideos";

/**
 * خانة فيديو 16:9. معرّف يوتيوب صالح ⇒ واجهة (غلاف + زر تشغيل) ومفيش أي طلب ليوتيوب قبل الضغط؛ بعد الضغط iframe من
 * youtube-nocookie. بلا معرّف ⇒ بديل مصمم بالعنوان والوصف (مش رابط وهمي).
 */
export function VideoSlot({ video, className = "", priority = false }: { video: LandingVideo | null; className?: string; priority?: boolean }) {
  const { lang, t } = useI18n();
  const [playing, setPlaying] = useState(false);
  if (!video) return null;
  const id = validYoutubeId(video.youtubeId);
  const cover = validCover(video.cover);
  const title = video.title[lang];
  const description = video.description[lang];
  const frame = "relative aspect-video w-full overflow-hidden rounded-[var(--radius-brand-lg,1rem)] border border-border bg-muted shadow-[var(--shadow-card)]";

  if (id && playing)
    return (
      <div className={`${frame} ${className}`} data-testid={`video-${video.slot}`}>
        <iframe
          src={youtubeEmbedUrl(id)} title={title} className="absolute inset-0 h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin" loading="lazy"
        />
      </div>
    );

  if (id)
    return (
      <figure className={`${className}`} data-testid={`video-${video.slot}`}>
        <button type="button" onClick={() => setPlaying(true)} className={`${frame} group block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`} aria-label={t("video.play", { title })}>
          {cover
            ? <img src={cover} alt="" className="absolute inset-0 h-full w-full object-cover" loading={priority ? "eager" : "lazy"} decoding="async" />
            : <span className="absolute inset-0 opacity-90" style={{ backgroundImage: "var(--gradient-brand)" }} aria-hidden="true" />}
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-card/95 text-primary shadow-lg transition-transform group-hover:scale-105"><Play className="h-7 w-7 translate-x-0.5" aria-hidden="true" /></span>
          </span>
        </button>
        <figcaption className="mt-2 text-sm text-muted-foreground"><span className="font-semibold text-foreground">{title}</span> — {description} <span className="block text-xs">{t("video.privacy")}</span></figcaption>
      </figure>
    );

  return (
    <figure className={className} data-testid={`video-${video.slot}`} data-video-pending="true">
      <div className={`${frame} flex items-center justify-center`}>
        {cover
          ? <img src={cover} alt={title} className="absolute inset-0 h-full w-full object-cover" loading={priority ? "eager" : "lazy"} decoding="async" />
          : (
            <div className="flex flex-col items-center gap-2 p-6 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden="true"><Clapperboard className="h-6 w-6" /></span>
              <span className="text-base font-semibold text-foreground">{title}</span>
              <span className="text-sm text-muted-foreground">{t("video.placeholder.body")}</span>
            </div>
          )}
      </div>
      <figcaption className="mt-2 text-sm text-muted-foreground">{description}</figcaption>
    </figure>
  );
}
