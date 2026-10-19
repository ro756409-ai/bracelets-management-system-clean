import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** خلية بسطرين (Theme Spec §4): سطر رئيسي 14px/600 + سطر ثانوي رمادي 12px — المنطقة/المدينة، النوع/الحجم، اليوم/الوقت… */
export type TwoLineCellProps = { primary: ReactNode; secondary?: ReactNode; align?: "start" | "end"; numeric?: boolean; className?: string };

export function TwoLineCell({ primary, secondary, align = "start", numeric = false, className }: TwoLineCellProps) {
  return (
    <div className={cn("flex min-w-0 flex-col leading-tight", align === "end" ? "items-end text-end" : "items-start text-start", numeric && "font-en tabular-nums", className)} data-testid="two-line-cell">
      {/* v2: max-w-full عشان truncate يشتغل فعلًا — جوه flex-col items-start الـspan بياخد عرض محتواه فكان العنوان الطويل بيفيض
          فوق العمود اللي جنبه. النص الكامل في title. */}
      <span className="truncate text-sm font-semibold text-foreground brand-v2:max-w-full" title={typeof primary === "string" ? primary : undefined}>{primary}</span>
      {secondary != null && secondary !== "" && <span className="truncate text-xs text-muted-foreground brand-v2:max-w-full" title={typeof secondary === "string" ? secondary : undefined}>{secondary}</span>}
    </div>
  );
}
