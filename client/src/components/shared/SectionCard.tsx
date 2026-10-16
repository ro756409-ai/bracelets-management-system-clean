import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type SectionCardProps = {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Right-aligned controls in the card header (a toggle, a count, a small button). */
  action?: ReactNode;
  children: ReactNode;
  /** Removes the content padding — use when the card wraps a full-bleed table. */
  flush?: boolean;
  className?: string;
  contentClassName?: string;
  /** معرّف اختبار اختياري على الجذر */
  testId?: string;
};

/**
 * أسماء الـutilities في className بدون الـvariants (`brand-v2:sm:p-5` → `p-5`، `!border-0` → `border-0`) — عشان نعرف
 * المستدعي بيحدد إيه بنفسه. tailwind-merge بيسيب `brand-v2:x` جنب `x` العادية، وقواعد brand-v2 بتيجي بعدها في الـCSS،
 * فلو أضفنا افتراضيات v2 فوق اختيار المستدعي كانت هتغطي عليه (زي `border-0 shadow-none` أو حد الخطر).
 */
function callerUtilities(className?: string): string[] {
  return (className ?? "").split(/\s+/).filter(Boolean).map(token => {
    let depth = 0, start = 0;
    for (let i = 0; i < token.length; i++) {
      if (token[i] === "[") depth++;
      else if (token[i] === "]") depth--;
      else if (token[i] === ":" && depth === 0) start = i + 1;
    }
    return token.slice(start).replace(/^!/, "");
  });
}

/**
 * A titled content block. Wraps the shadcn Card with consistent padding and header
 * layout so sections stop drifting apart page to page.
 *
 * Matjarak 2.0 (1C-5C): تحت v2 فقط — حواف rounded-2xl، حد محايد خفيف، ظل --shadow-card الهادئ، وإيقاع واحد للمسافات:
 * Card الأساسي (py-6 gap-6) + حشو المحتوى (--space-card) كانوا بيعملوا فراغ مزدوج (≈36px بين الوصف والمحتوى و48px تحت).
 * تحت v2 الحشو كله من --space-card (فالكثافة المدمجة شغالة)، و16px بين الرأس والمحتوى. أي حاجة يحددها المستدعي
 * (حد/ظل/زوايا/حشو/مسافة) بتفضل له — الافتراضي ده مابيتضافش.
 */
export function SectionCard({
  title,
  description,
  icon,
  action,
  children,
  flush = false,
  className,
  contentClassName,
  testId,
}: SectionCardProps) {
  const own = callerUtilities(className);
  const owns = (re: RegExp) => own.some(u => re.test(u));
  // المستدعي اللي بيتحكم في حشو الكارت أو المسافة الرأسية بين أجزائه (زي «ملخص التشغيل» في Dashboard) يفضل على إيقاعه؛
  // gap-x-* أفقي فقط فمايعطّلش الإيقاع الرأسي
  const v2Rhythm = !owns(/^(?:p[xytbse]?-|gap-(?!x-))/);
  const hasHeader = Boolean(title || action);
  return (
    <Card
      className={cn(
        "shadow-[var(--shadow-card)]",
        !owns(/^rounded(?:-|$)/) && "brand-v2:rounded-2xl",
        !owns(/^border(?:-|$)/) && "brand-v2:border-border/70",
        !owns(/^shadow(?:-|$)/) && "brand-v2:shadow-card",
        v2Rhythm && "brand-v2:gap-0",
        // flush: المحتوى ملاصق للحواف (جدول كامل العرض) — الحشو الرأسي للكارت يفضل زي ما هو
        v2Rhythm && !flush && "brand-v2:py-0",
        className
      )}
      data-testid={testId}
    >
      {hasHeader && (
        <CardHeader
          className={cn(
            "flex flex-row items-start justify-between gap-3 space-y-0 pb-3",
            v2Rhythm && "brand-v2:px-[var(--space-card)] brand-v2:pb-4",
            v2Rhythm && !flush && "brand-v2:pt-[var(--space-card)]"
          )}
        >
          <div className="min-w-0 space-y-1 brand-v2:space-y-1.5">
            {title && (
              <CardTitle className="flex items-center gap-2 text-base brand-v2:text-[17px]">
                {icon}
                {title}
              </CardTitle>
            )}
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </CardHeader>
      )}
      <CardContent
        className={cn(
          flush ? "p-0" : "p-[var(--space-card)]",
          hasHeader && !flush && "pt-0",
          contentClassName
        )}
      >
        {children}
      </CardContent>
    </Card>
  );
}
