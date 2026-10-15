import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useDisplayPrefs } from "@/contexts/DisplayPrefsContext";
import {
  ACCENT_IDS, DENSITIES, DENSITY_LABELS, FONT_SCALES, FONT_SCALE_LABELS, MOTION_LABELS, MOTION_PREFS, THEME_LABELS, THEME_MODES,
  type DisplayPrefs,
} from "@/lib/displayPrefs";
import { cn } from "@/lib/utils";
import { activeBrand } from "@/lib/brandFlag";
import { accentGroupText, accentPresentation } from "@/lib/accentPresentation";

/**
 * نافذة «تخصيص العرض» (المرحلة 5) — تُفتح من الشريط العلوي. كل مجموعة = `radiogroup` بأزرار ≥44px
 * (أسهم لوحة المفاتيح تتنقل داخل المجموعة)، والتغيير يُطبَّق فورًا بلا إعادة تحميل.
 * الألوان بأسماء عربية ثابتة (لا Color Picker). الزائر يرى تنبيهًا أن إعداداته لهذه الجلسة فقط.
 */
type Key = keyof DisplayPrefs;

function OptionGroup<T extends string | number>({ id, label, hint, options, value, onChange, render }: {
  id: Key; label: string; hint?: string; options: readonly T[]; value: T; onChange: (v: T) => void; render: (v: T) => React.ReactNode;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const rtl = (document.documentElement.dir || "rtl") === "rtl";
    const step = (d: number) => { const i = (index + d + options.length) % options.length; onChange(options[i]); (e.currentTarget.parentElement?.children[i] as HTMLElement | undefined)?.focus(); };
    if (e.key === "ArrowRight") { e.preventDefault(); step(rtl ? -1 : 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(rtl ? 1 : -1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
  };
  return (
    <fieldset className="space-y-2" data-testid={`prefs-group-${id}`}>
      <legend className="text-sm font-semibold text-foreground">{label}</legend>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {options.map((opt, i) => {
          const checked = opt === value;
          return (
            <button
              key={String(opt)}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => onChange(opt)}
              onKeyDown={e => onKeyDown(e, i)}
              className={cn(
                "flex min-h-11 items-center gap-2 rounded-[var(--radius-brand-pill)] border px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                checked ? "border-primary bg-primary-soft text-primary-text" : "border-border bg-card text-muted-foreground hover:text-foreground"
              )}
              data-testid={`prefs-${id}-${String(opt)}`}
            >
              {render(opt)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function DisplayPrefsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { prefs, update, reset, canPersist, resolvedTheme, isDesktop } = useDisplayPrefs();
  const swatchMode = resolvedTheme;
  // عرض فقط حسب الهوية المطبَّقة (Matjarak 2.0) — القيمة المحفوظة لا تتغير
  const brand = activeBrand();
  const accentText = accentGroupText(brand);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* على الهاتف: الارتفاع ≤ الشاشة − 8rem فيبقى أسفل النافذة (الاستعادة/تم) فوق منطقة MobileBottomNav
          والنافذة تُمرَّر داخليًا حتى آخر عنصر؛ الحوار (z-50) فوق الشريط السفلي (z-40) في كل الأحوال. */}
      <DialogContent className="max-h-[calc(100dvh-8rem)] max-w-lg overflow-y-auto sm:max-h-[90vh]" data-readonly-safe data-testid="display-prefs-dialog">
        <DialogHeader>
          <DialogTitle>تخصيص العرض</DialogTitle>
          <DialogDescription>
            {canPersist ? "إعداداتك الشخصية — تُحفظ لحسابك على هذا الجهاز وتُطبَّق فورًا." : "لم يُسجَّل دخول: التغييرات لهذه الجلسة فقط ولن تُحفظ."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          <OptionGroup id="fontScale" label="حجم الخط" options={FONT_SCALES} value={prefs.fontScale} onChange={v => update({ fontScale: v })} render={v => <span className="font-en tabular-nums">{FONT_SCALE_LABELS[v]}</span>} />
          <OptionGroup id="theme" label="الوضع" options={THEME_MODES} value={prefs.theme} onChange={v => update({ theme: v })} render={v => THEME_LABELS[v]} />
          <OptionGroup
            id="accent" label={accentText.title} hint={accentText.hint}
            options={ACCENT_IDS} value={prefs.accent} onChange={v => update({ accent: v })}
            render={v => (
              <>
                <span className="h-4 w-4 shrink-0 rounded-full border border-border" style={{ backgroundColor: accentPresentation(v, swatchMode, brand).swatch }} aria-hidden="true" data-testid={`prefs-swatch-${v}`} />
                {accentPresentation(v, swatchMode, brand).label}
              </>
            )}
          />
          <OptionGroup id="density" label="الكثافة" hint={isDesktop ? undefined : "المدمجة تُطبَّق على الشاشات الواسعة فقط؛ على الهاتف تبقى أهداف اللمس 44px."} options={DENSITIES} value={prefs.density} onChange={v => update({ density: v })} render={v => DENSITY_LABELS[v]} />
          <OptionGroup id="motion" label="تقليل الحركة" hint="يلغي الحركات الزخرفية فقط؛ مؤشرات التحميل تبقى." options={MOTION_PREFS} value={prefs.motion} onChange={v => update({ motion: v })} render={v => MOTION_LABELS[v]} />
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="ghost" className="min-h-11 gap-1.5 md:min-h-9" onClick={reset} data-testid="prefs-reset">
            <RotateCcw className="h-4 w-4" aria-hidden="true" /> استعادة الإعدادات الافتراضية
          </Button>
          <Button type="button" className="min-h-11 md:min-h-9" onClick={() => onOpenChange(false)} data-testid="prefs-done">تم</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
