import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { activeBrand } from "@/lib/brandFlag";
import { cn } from "@/lib/utils";

/** Semantic tone. Every colour comes from a token — never a raw Tailwind palette class. */
export type StatTone = "default" | "primary" | "success" | "warning" | "danger" | "info";

const TONE_TEXT: Record<StatTone, string> = {
  default: "text-foreground",
  primary: "text-primary",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  danger: "text-destructive",
  info: "text-[var(--info)]",
};

const TONE_ICON_BG: Record<StatTone, string> = {
  default: "bg-muted text-muted-foreground",
  primary: "bg-accent text-accent-foreground",
  success: "bg-[var(--success)]/10 text-[var(--success)]",
  warning: "bg-[var(--warning)]/10 text-[var(--warning)]",
  danger: "bg-destructive/10 text-destructive",
  info: "bg-[var(--info)]/10 text-[var(--info)]",
};

export type StatCardProps = {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tone?: StatTone;
  /** Small caption under the value (e.g. a comparison or unit). */
  hint?: string;
  /**
   * Optional trend vs. a prior period — only render this when a real comparison value exists.
   * A positive `value` reads as an increase (green + up arrow), negative as a decrease (red +
   * down arrow); `label` is the comparison period (e.g. "عن أمس").
   */
  trend?: { value: number; label?: string };
  loading?: boolean;
  /** Makes the whole card a button — used for stat tiles that apply a filter. */
  onClick?: () => void;
  /** Renders the card as visually selected; pairs with `onClick` filter tiles. */
  active?: boolean;
  className?: string;
};

/** صفر عددي حقيقي (٠ أو 0) — قيمة مثل «٠ ج.م» أو «٠%» لا تُعامل كذلك. */
const isZeroValue = (value: ReactNode) => typeof value === "string" ? /^[0٠]$/.test(value.trim()) : value === 0;
/** قيمة نصية مش رقم («غير متاح»، «—»…) — بتتعرض بحجم أصغر في سطر واحد بدل ما تتكسر على سطرين بحجم الأرقام. */
const isTextValue = (value: ReactNode) => typeof value === "string" && /[\u0600-\u06FF]/.test(value) && !/[0-9٠-٩]/.test(value);

/**
 * Matjarak 2.0 (1C-4): ملاءمة القيمة الرقمية لعرض البطاقة الفعلي — تحت v2 فقط (v1 كما هو بلا أي عنصر إضافي).
 * القياس على عنصر النص الرقمي نفسه (span داخل الـflex)، مش على الـflex اللي فيه ملاحظة الصفر:
 * 1) 28px لو أعرض جزء غير قابل للكسر (الرقم) يسع العرض المتاح — والعملة تنزل لسطرها عند المسافة كالمعتاد.
 * 2) غير كده: أكبر حجم يسع بين 28 و FIT_MIN_PX، محسوب من العرض الفعلي (مش بعدد الخانات).
 * 3) لو مايسعش حتى عند الحد الأدنى: كسر السطر بين مجموعات الخانات فقط (<wbr> بعد فاصل الآلاف) — المبلغ كامل على أكثر من سطر،
 *    الخانات الأكبر أولًا، والنسخ بلا تغيير. شبكة أمان أخيرة فقط (مجموعة واحدة أعرض من البطاقة، أو قيمة ReactNode مركّبة):
 *    overflow-wrap:anywhere. لا إخفاء ولا قص لأي جزء من المبلغ.
 * الحجم وoverflow-wrap يُكتبان على الـspan مباشرة (بلا إعادة رسم React)؛ التحديث الوحيد عبر React هو تشغيل/إيقاف <wbr>.
 * إعادة القياس فقط عند تغيّر النص/التنسيق/الخط أو العرض، وإجباريًا بعد تحميل خط.
 */
const FIT_MAX_PX = 28;
const FIT_MIN_PX = 20;

/** يضيف فرص كسر سطر بعد فواصل الآلاف (٬ أو ,) فقط — النص المرئي والمنسوخ كما هو. */
function withGroupBreaks(value: string): ReactNode {
  return value.split(/(?<=[٬,])/).map((part, i) => <Fragment key={i}>{i > 0 && <wbr />}{part}</Fragment>);
}

/** عرض أعرض جزء في `parts` بخط عنصر `el` وبحجم `px` — عنصر قياس مخفي مؤقت بنفس خصائص الخط (الوزن/العائلة/tnum). */
function widestPart(el: HTMLElement, parts: string[], px: number): number {
  const cs = getComputedStyle(el);
  const probe = document.createElement("span");
  Object.assign(probe.style, { position: "absolute", visibility: "hidden", whiteSpace: "nowrap", insetInlineStart: "0", top: "0",
    fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, fontFeatureSettings: cs.fontFeatureSettings,
    fontVariantNumeric: cs.fontVariantNumeric, letterSpacing: cs.letterSpacing, fontSize: `${px}px` });
  el.parentElement!.appendChild(probe);
  let widest = 0;
  for (const part of parts) { probe.textContent = part; widest = Math.max(widest, probe.getBoundingClientRect().width); }
  probe.remove();
  return widest;
}

/** بصمة ما يؤثر على القياس: النص (أو ترميز ReactNode بتنسيقه الداخلي) + خصائص خط عنصر الرقم. */
function fitSignature(el: HTMLElement, value: ReactNode): string {
  const cs = getComputedStyle(el);
  return [typeof value === "string" ? value : el.innerHTML, cs.fontFamily, cs.fontWeight, cs.fontStyle,
    cs.fontFeatureSettings, cs.fontVariantNumeric, cs.letterSpacing].join("|");
}

function useV2FitValue(enabled: boolean, value: ReactNode) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [breaks, setBreaks] = useState(false);
  const lastWidth = useRef(-1);
  const lastSig = useRef<string | null>(null);
  const measure = () => {
    const el = ref.current, box = el?.parentElement; if (!el || !box) return;
    const avail = box.clientWidth; if (!avail) return;
    lastWidth.current = avail;
    const text = typeof value === "string" ? value : el.textContent ?? "";
    const words = text.split(/\s+/).filter(Boolean); if (!words.length) return;
    let size = FIT_MAX_PX, needBreaks = false, anywhere = false;
    const widest = widestPart(el, words, FIT_MAX_PX);
    if (widest > avail) {
      size = Math.max(FIT_MIN_PX, Math.floor(FIT_MAX_PX * avail / widest));
      while (size > FIT_MIN_PX && widestPart(el, words, size) > avail) size--;
      if (widestPart(el, words, size) > avail) {
        // حتى عند الحد الأدنى مايسعش: كسر بين مجموعات الخانات (نص فقط)، وشبكة أمان لو مجموعة واحدة أعرض من المتاح
        const groups = typeof value === "string" ? words.flatMap(w => w.split(/(?<=[٬,])/)) : null;
        needBreaks = groups !== null;
        anywhere = groups === null || widestPart(el, groups, size) > avail;
      }
    }
    el.style.fontSize = size === FIT_MAX_PX ? "" : `${size}px`;   // 28px = الحجم الافتراضي من brand-v2:text-[28px]
    el.style.overflowWrap = anywhere ? "anywhere" : "";
    setBreaks(needBreaks);                                       // React يتجاهلها لو القيمة نفسها
  };
  // أحدث دالة قياس للمستمعات، بلا إعادة تسجيلها مع كل Render
  const measureRef = useRef(measure);
  // كل Render: قياس فقط لو النص/التنسيق/الخط اتغيّر (هوية كائن ReactNode وحدها لا تكفي)؛ العرض يتابعه ResizeObserver
  useLayoutEffect(() => {
    measureRef.current = measure;
    if (!enabled) { lastSig.current = null; return; }
    const el = ref.current; if (!el) return;
    const sig = fitSignature(el, value);
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    measure();
  });
  // تغيّر العرض ⇒ قياس؛ تحميل خط ⇒ قياس إجباري (المقاييس تتغير والنص والعرض ثابتين). مرتبطة بـenabled فقط، وتنظيف كامل عند الإزالة
  useLayoutEffect(() => {
    const box = ref.current?.parentElement; if (!enabled || !box) return;
    let alive = true;
    const force = () => { if (alive) measureRef.current(); };
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(entries => {
      if (Math.round(entries[0].contentRect.width) !== lastWidth.current) force();
    });
    ro?.observe(box);
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fonts?.addEventListener?.("loadingdone", force);
    fonts?.ready?.then(force).catch(() => {});
    return () => { alive = false; ro?.disconnect(); fonts?.removeEventListener?.("loadingdone", force); };
  }, [enabled]);
  return { ref, breaks: enabled && breaks };
}

/**
 * One number with a label. Six different stat-card styles existed across the app; this
 * is the single one. Numbers use tabular figures so columns of cards line up in RTL.
 */
export function StatCard({
  label,
  value,
  icon,
  tone = "default",
  hint,
  trend,
  loading = false,
  onClick,
  active = false,
  className,
}: StatCardProps) {
  const interactive = typeof onClick === "function";
  const numeric = !isTextValue(value);
  const fitEnabled = numeric && !loading && activeBrand() === "v2";   // enabled = عنصر الرقم معروض فعلًا
  const fit = useV2FitValue(fitEnabled, value);

  // Design System V2: label on top, large number below, trend last; the tinted icon tile sits
  // opposite the text (visually left in RTL) rather than leading it.
  const body = (
    <CardContent
      className="flex h-full items-start justify-between gap-3 p-4 max-[420px]:brand-v2:gap-2 max-[420px]:brand-v2:p-3"
      data-slot="stat-card-body"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-right brand-v2:gap-2">
        {/* على الهاتف: حجز سطرين للعنوان فتتطابق محاذاة القيمة وارتفاع البطاقات بين الصفوف */}
        <p className="line-clamp-2 min-h-[2lh] text-xs font-medium text-muted-foreground md:min-h-0">{label}</p>
        {loading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          // ارتفاع ثابت للسطر: الصفر الحقيقي «٠» (حرف صغير بصريًا) والأرقام الكبيرة يأخذان نفس المساحة
          <p className={cn("flex min-h-8 items-center gap-2 font-bold leading-none tabular-nums", isTextValue(value) ? "whitespace-nowrap text-lg text-muted-foreground" : "text-[26px] brand-v2:text-[28px]", !isTextValue(value) && TONE_TEXT[tone])} data-testid="stat-card-value">
            {/* v2: الرقم في عنصر نصي خاص به للقياس والكسر؛ v1: كما كان حرفيًا */}
            {fitEnabled ? (
              <span ref={fit.ref} className="min-w-0 max-w-full" data-slot="stat-card-number">
                {fit.breaks && typeof value === "string" ? withGroupBreaks(value) : value}
              </span>
            ) : value}
            {/* «٠» العربي يُرسم نقطة صغيرة فيبدو فراغًا: نُبقي الصفر كما هو ونضيف وصفًا مكتوبًا بجانبه (لا إخفاء ولا شرطة) */}
            {isZeroValue(value) && <span className="whitespace-nowrap text-xs font-medium text-muted-foreground" data-testid="stat-card-zero-note">لا يوجد</span>}
          </p>
        )}
        {trend && !loading && (
          // whitespace-nowrap: على شاشة ضيقة كانت "عن أمس" بتتلف على سطرين وتطوّل الكارت
          <p className="flex items-center gap-1 whitespace-nowrap text-[11px] font-medium brand-v2:text-xs">
            <span
              className={cn(
                "tabular-nums",
                trend.value > 0 ? "text-[var(--success)]" : trend.value < 0 ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {trend.value > 0 ? "↑" : trend.value < 0 ? "↓" : "–"} {Math.abs(trend.value)}%
            </span>
            {trend.label && <span className="text-muted-foreground">{trend.label}</span>}
          </p>
        )}
        {hint && !loading && (
          <p className="line-clamp-2 min-h-[2lh] text-[11px] text-muted-foreground/80 md:min-h-0 brand-v2:text-xs" title={hint}>{hint}</p>
        )}
      </div>
      {icon && (
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-brand-md)]",
            "brand-v2:rounded-xl",
            "max-[420px]:brand-v2:h-9 max-[420px]:brand-v2:w-9",
            TONE_ICON_BG[tone]
          )}
        >
          {icon}
        </span>
      )}
    </CardContent>
  );

  if (!interactive) {
    return (
      // gap-0 py-0: Card الأساسي يضيف py-6 gap-6 فوق p-4 → فراغ ≈40px أعلى وأسفل (أوضح ما يكون مع القيمة صفر)؛
      // h-full: البطاقات في صف الشبكة الواحد بنفس الارتفاع دون فراغ داخلي مزعج.
      <Card
        className={cn(
          "h-full gap-0 py-0 shadow-[var(--shadow-card)]",
          "brand-v2:rounded-2xl brand-v2:border-border/70 brand-v2:shadow-sm",
          className
        )}
      >
        {body}
      </Card>
    );
  }

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "h-full cursor-pointer gap-0 py-0 shadow-[var(--shadow-card)] transition-colors",
        "hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        active && "border-primary ring-1 ring-primary",
        // v2: الحد الخافت للبطاقة غير المحددة فقط — حتى لا يغطي brand-v2:border-border/70 على border-primary للبطاقة المحددة
        "brand-v2:rounded-2xl brand-v2:shadow-sm",
        !active && "brand-v2:border-border/70",
        "brand-v2:hover:border-primary/30 brand-v2:hover:shadow-md",
        "brand-v2:focus-visible:ring-2",
        className
      )}
    >
      {body}
    </Card>
  );
}
