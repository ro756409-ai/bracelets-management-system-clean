import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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

  // Design System V2: label on top, large number below, trend last; the tinted icon tile sits
  // opposite the text (visually left in RTL) rather than leading it.
  const body = (
    <CardContent className="flex h-full items-start justify-between gap-3 p-4" data-slot="stat-card-body">
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-right">
        {/* على الهاتف: حجز سطرين للعنوان فتتطابق محاذاة القيمة وارتفاع البطاقات بين الصفوف */}
        <p className="line-clamp-2 min-h-[2lh] text-xs font-medium text-muted-foreground md:min-h-0">{label}</p>
        {loading ? (
          <Skeleton className="h-8 w-16" />
        ) : (
          // ارتفاع ثابت للسطر: الصفر الحقيقي «٠» (حرف صغير بصريًا) والأرقام الكبيرة يأخذان نفس المساحة
          <p className={cn("flex min-h-8 items-center gap-2 font-bold leading-none tabular-nums", isTextValue(value) ? "whitespace-nowrap text-lg text-muted-foreground" : "text-[26px]", !isTextValue(value) && TONE_TEXT[tone])} data-testid="stat-card-value">
            {value}
            {/* «٠» العربي يُرسم نقطة صغيرة فيبدو فراغًا: نُبقي الصفر كما هو ونضيف وصفًا مكتوبًا بجانبه (لا إخفاء ولا شرطة) */}
            {isZeroValue(value) && <span className="whitespace-nowrap text-xs font-medium text-muted-foreground" data-testid="stat-card-zero-note">لا يوجد</span>}
          </p>
        )}
        {trend && !loading && (
          // whitespace-nowrap: على شاشة ضيقة كانت "عن أمس" بتتلف على سطرين وتطوّل الكارت
          <p className="flex items-center gap-1 whitespace-nowrap text-[11px] font-medium">
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
          <p className="line-clamp-2 min-h-[2lh] text-[11px] text-muted-foreground/80 md:min-h-0" title={hint}>{hint}</p>
        )}
      </div>
      {icon && (
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-brand-md)]",
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
      <Card className={cn("h-full gap-0 py-0 shadow-[var(--shadow-card)]", className)}>{body}</Card>
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
        className
      )}
    >
      {body}
    </Card>
  );
}
