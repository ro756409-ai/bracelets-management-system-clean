import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { useI18n, type Lang } from "@/i18n";

/**
 * اختيار اللغة (v2 بس) — زر بالكرة الأرضية واسم اللغة الحالية، بيفتح قائمة صغيرة (العربية / English) بعلامة على المختار.
 * الاختيار محفوظ. Escape وضغطة برّه بيقفلوا القائمة ويرجّعوا التركيز للزر. في v1 مابيظهرش.
 */
const OPTIONS: Array<{ lang: Lang; label: string }> = [{ lang: "ar", label: "العربية" }, { lang: "en", label: "English" }];

export function LanguageToggle({ className = "" }: { className?: string }) {
  const { lang, setLang, canSwitch, t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!canSwitch) return null;
  const current = OPTIONS.find(o => o.lang === lang)!;
  return (
    <div ref={root} className={`relative ${className}`} data-readonly-safe>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t("lang.menu")}: ${current.label}`}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-brand-md)] border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="lang-toggle"
      >
        <Globe className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span lang={lang}>{current.label}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <ul role="menu" aria-label={t("lang.menu")} className="absolute end-0 top-full z-50 mt-2 min-w-40 rounded-[var(--radius-brand-md)] border border-border bg-popover p-1 shadow-lg" data-testid="lang-menu">
          {OPTIONS.map(o => (
            <li key={o.lang} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={o.lang === lang}
                lang={o.lang}
                onClick={() => { setLang(o.lang); setOpen(false); trigger.current?.focus(); }}
                className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-md px-3 text-sm ${o.lang === lang ? "bg-accent font-semibold text-accent-foreground" : "text-foreground hover:bg-muted"}`}
                data-testid={`lang-option-${o.lang}`}
              >
                {o.label}
                {o.lang === lang && <Check className="h-4 w-4" aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
